import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { ActivityType } from "@prisma/client";
import { getDb, disconnectDb } from "../db/client/index.js";
import { recordActivity, listActivities, summarizeActivities } from "../activity/service.js";
import { listActivity, summarizeActivity, SKILL_KEY as ACTIVITY_SKILL, RESOURCE as ACTIVITY_RESOURCE } from "../skills/system/activity.js";
import { remember, SKILL_KEY as MEMORY_SKILL, RESOURCE as MEMORY_RESOURCE } from "../skills/system/memory.js";
import { listAuditLog } from "../gateway/index.js";
import { createIdentity, runWithIdentity } from "../identity/index.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import { localRangeBounds } from "../core/time.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

const BOGOTA = "America/Bogota";

describe("activity model", () => {
  it("has the eleven life-history event types", () => {
    expect(Object.keys(ActivityType).sort()).toEqual(
      ["ACHIEVEMENT", "DECISION", "GOAL_PROGRESS", "HABIT_COMPLETED", "KNOWLEDGE_ADDED", "LEARNING_SESSION", "MEETING", "MEMORY_CREATED", "QUEST_COMPLETED", "REMINDER_DELIVERED", "TASK_COMPLETED"].sort()
    );
  });
});

describe("activity vs audit are separate systems", () => {
  let a: string;
  const agentKey = JARVIS_AGENT_KEY;
  const idFor = (principalId: string, interfaceSource: "TELEGRAM" | "GUIDEHUB" = "GUIDEHUB") =>
    createIdentity({ principalId, interfaceSource, authMethod: "api_token", requestId: `r-${Math.random().toString(36).slice(2)}` });

  beforeAll(async () => {
    a = (await createPrincipal("Activity Sep Principal", BOGOTA)).id;
  });
  afterAll(async () => {
    await deletePrincipal(a);
  });

  it("a permitted action writes BOTH an audit row and an activity row", async () => {
    await grant(a, agentKey, MEMORY_SKILL, MEMORY_RESOURCE, "MEMORY_WRITE", "WRITE");
    const identity = idFor(a, "TELEGRAM");
    const secret = "activity-sep-secret-content-8841";
    const result = await runWithIdentity(identity, () =>
      remember(identity, { type: "FACT", content: secret, source: "test" })
    );
    expect(result.status).toBe("EXECUTED");

    const audit = (await listAuditLog(a, 50)).filter((r) => r.requestId === identity.requestId);
    expect(audit.map((r) => r.eventType)).toContain("ACTION_EXECUTION_SUCCEEDED"); // remember is an ActionDefinition

    const activity = await getDb().activity.findMany({ where: { principalId: a, type: "MEMORY_CREATED" } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ refType: "memory", interfaceSource: "TELEGRAM", summary: "Remembered a fact" });
    // references the memory instead of copying it
    expect(JSON.stringify(activity)).not.toContain(secret);
    expect(activity[0].refId).toBeTruthy();
  });

  it("a DENIED action writes audit but NO activity", async () => {
    const b = (await createPrincipal("Activity Denied Principal")).id;
    const result = await remember(idFor(b), { type: "FACT", content: "should not exist", source: "test" });
    expect(result.status).toBe("DENIED");
    expect((await listAuditLog(b, 10)).map((r) => r.eventType)).toContain("ACTION_DENIED");
    expect(await getDb().activity.count({ where: { principalId: b } })).toBe(0);
    await deletePrincipal(b);
  });

  it("reading activity is audited but never becomes activity itself", async () => {
    await grant(a, agentKey, ACTIVITY_SKILL, ACTIVITY_RESOURCE, "ACTIVITY_READ", "READ");
    const before = await getDb().activity.count({ where: { principalId: a } });
    const auditBefore = await getDb().auditLog.count({ where: { principalId: a } });
    await listActivity({ principalId: a, agentKey, range: "today" });
    expect(await getDb().activity.count({ where: { principalId: a } })).toBe(before);
    expect(await getDb().auditLog.count({ where: { principalId: a } })).toBeGreaterThan(auditBefore);
  });

  it("the two records have different shapes and never share rows", async () => {
    const audit = (await getDb().auditLog.findFirstOrThrow({ where: { principalId: a } })) as Record<string, unknown>;
    const activity = (await getDb().activity.findFirstOrThrow({ where: { principalId: a } })) as Record<string, unknown>;
    expect(audit).toHaveProperty("eventType");
    expect(audit).toHaveProperty("result");
    expect(audit).not.toHaveProperty("summary");
    expect(activity).toHaveProperty("summary");
    expect(activity).not.toHaveProperty("eventType");
    expect(activity).not.toHaveProperty("result");
    expect(audit.id).not.toBe(activity.id);
  });

  it("an activity write failure never fails (or hides) the action that already succeeded", async () => {
    // nonexistent principal → foreign-key violation inside recordActivity
    await expect(recordActivity({ principalId: "00000000-0000-0000-0000-00000000dead", type: "ACHIEVEMENT", summary: "x" })).resolves.toBeUndefined();
  });

  it("rejects an invalid life-area slug without recording or throwing", async () => {
    const before = await getDb().activity.count({ where: { principalId: a } });
    await recordActivity({ principalId: a, type: "LEARNING_SESSION", summary: "bad area", area: "Not A Slug!" });
    expect(await getDb().activity.count({ where: { principalId: a } })).toBe(before);
  });

  it("outside an interface request the interface is null; inside, it comes from the identity", async () => {
    await recordActivity({ principalId: a, type: "ACHIEVEMENT", summary: "no interface" });
    await runWithIdentity(idFor(a, "TELEGRAM"), () => recordActivity({ principalId: a, type: "ACHIEVEMENT", summary: "with interface" }));
    const rows = await getDb().activity.findMany({ where: { principalId: a, type: "ACHIEVEMENT" } });
    expect(rows.find((r) => r.summary === "no interface")?.interfaceSource).toBeNull();
    expect(rows.find((r) => r.summary === "with interface")?.interfaceSource).toBe("TELEGRAM");
  });
});

describe("activity reads: permission, isolation, ranges", () => {
  let a: string;
  let b: string;
  const agentKey = JARVIS_AGENT_KEY;
  // Tuesday 2026-09-29 09:00 in Bogota (UTC-5) = 14:00Z
  const NOW = new Date("2026-09-29T14:00:00Z");

  beforeAll(async () => {
    a = (await createPrincipal("Activity Range A", BOGOTA)).id;
    b = (await createPrincipal("Activity Range B", BOGOTA)).id;
    const rows: [string, string, Date, string | undefined][] = [
      ["Sunday night (previous week)", "ACHIEVEMENT", new Date("2026-09-28T04:00:00Z"), undefined], // Sun 27th 23:00 Bogota
      ["Monday just after midnight", "HABIT_COMPLETED", new Date("2026-09-28T05:30:00Z"), "fitness"], // Mon 28th 00:30
      ["Monday evening", "LEARNING_SESSION", new Date("2026-09-29T02:00:00Z"), "learning"], // Mon 28th 21:00 -> yesterday
      ["This morning", "LEARNING_SESSION", new Date("2026-09-29T13:00:00Z"), "learning"], // Tue 29th 08:00 -> today
      ["Tomorrow", "MEETING", new Date("2026-09-30T13:00:00Z"), undefined],
    ];
    for (const [summary, type, occurredAt, area] of rows) {
      await getDb().activity.create({ data: { principalId: a, type: type as ActivityType, summary, occurredAt, area } });
    }
    await getDb().activity.create({ data: { principalId: b, type: "ACHIEVEMENT", summary: "B-only secret achievement", occurredAt: NOW } });
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await deletePrincipal(a);
    await deletePrincipal(b);
    await disconnectDb();
  });

  it("without a permission row, reads are DENIED and return no data", async () => {
    const result = await listActivity({ principalId: a, agentKey, range: "week" });
    expect(result.status).toBe("DENIED");
    expect(result.data).toBeUndefined();
    expect((await summarizeActivity({ principalId: a, agentKey, range: "week" })).status).toBe("DENIED");
  });

  it("with the permission: today / yesterday / week are computed in the user's timezone", async () => {
    await grant(a, agentKey, ACTIVITY_SKILL, ACTIVITY_RESOURCE, "ACTIVITY_READ", "READ");
    await grant(b, agentKey, ACTIVITY_SKILL, ACTIVITY_RESOURCE, "ACTIVITY_READ", "READ");
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });

    const summaries = async (range: "today" | "yesterday" | "week") =>
      ((await listActivity({ principalId: a, agentKey, range })).data as { summary: string }[]).map((r) => r.summary).sort();

    expect(await summaries("today")).toEqual(["This morning"]);
    expect(await summaries("yesterday")).toEqual(["Monday evening", "Monday just after midnight"]);
    // the week starts Monday 00:00 Bogota: Sunday 23:00 is out, Monday 00:30 is in, tomorrow is out
    expect(await summaries("week")).toEqual(["Monday evening", "Monday just after midnight", "This morning"]);
  });

  it("the week boundary is Monday 00:00 in the user's zone, not the server's", () => {
    const { start, end } = localRangeBounds(NOW, BOGOTA, "week");
    expect(start.toISOString()).toBe("2026-09-28T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-30T05:00:00.000Z");
    // on a Monday, the week starts that same day
    expect(localRangeBounds(new Date("2026-09-28T15:00:00Z"), BOGOTA, "week").start.toISOString()).toBe("2026-09-28T05:00:00.000Z");
    // on a Sunday, it started six days earlier
    expect(localRangeBounds(new Date("2026-10-04T15:00:00Z"), BOGOTA, "week").start.toISOString()).toBe("2026-09-28T05:00:00.000Z");
  });

  it("summaries count by type and by area", async () => {
    const week = localRangeBounds(NOW, BOGOTA, "week");
    const s = await summarizeActivities(a, { from: week.start, to: week.end });
    expect(s).toEqual({ total: 3, byType: { HABIT_COMPLETED: 1, LEARNING_SESSION: 2 }, byArea: { fitness: 1, learning: 2 } });
  });

  it("principal isolation: A never sees B's activity and vice versa", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const asA = JSON.stringify((await listActivity({ principalId: a, agentKey, range: "today" })).data);
    const asB = JSON.stringify((await listActivity({ principalId: b, agentKey, range: "today" })).data);
    expect(asA).not.toContain("B-only secret achievement");
    expect(asB).toContain("B-only secret achievement");
    expect(asB).not.toContain("This morning");
  });

  it("limit is clamped", async () => {
    const week = localRangeBounds(NOW, BOGOTA, "week");
    expect(await listActivities(a, { from: week.start, to: week.end }, { limit: 1 })).toHaveLength(1);
    expect((await listActivities(a, { from: week.start, to: week.end }, { limit: 100000 })).length).toBeLessThanOrEqual(100);
  });

  it("Jarvis answers 'What happened today?' and 'What have I done this week?' from the same skill", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    await grant(a, JARVIS_AGENT_KEY, ACTIVITY_SKILL, ACTIVITY_RESOURCE, "ACTIVITY_READ", "READ");
    const jarvis = new JarvisCore();
    const today = await jarvis.handle({ principalId: a, input: "What happened today?" });
    expect(today.message).toMatch(/^Today — 1 activity:\n• 08:00 /);
    const week = await jarvis.handle({ principalId: a, input: "What have I done this week?" });
    expect(week.message).toContain("This week: 3 recorded.");
    expect(week.message).toContain("learning ×2");
  });
});
