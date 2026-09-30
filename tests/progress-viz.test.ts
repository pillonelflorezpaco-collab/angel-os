import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { setClock } from "../gateway/clock.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { proposeNamedAction } from "../skills/system/apiActions.js";
import { readProgressOverview } from "../skills/system/today.js";
import { buildCalendar, levelOf, LEVELS } from "../progress/calendar.js";
import { buildTimeline, buildMap } from "../progress/timeline.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
registerSkillActions();
const { app } = await import("../api/server.js");

const NOW = new Date("2026-10-06T15:00:00Z"); // a Tuesday
const ev = (iso: string, type = "TASK_COMPLETED") => ({ occurredAt: new Date(iso), type });

describe("activity calendar (pure)", () => {
  it("shade buckets are over real counts; zero is its own level; the legend matches the function", () => {
    expect([0, 1, 2, 3, 4, 6, 7, 40].map(levelOf)).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
    expect(LEVELS.map((l) => levelOf(l.min))).toEqual([0, 1, 2, 3, 4]); // each legend entry starts where the function says it does
  });
  it("one entry per local day, oldest first, including empty days; counts per type; time zone decides the day", () => {
    const events = [ev("2026-10-06T10:00:00Z"), ev("2026-10-06T11:00:00Z", "DECISION"), ev("2026-10-04T23:30:00Z", "MEMORY_CREATED"), ev("2026-08-01T10:00:00Z"), ev("2026-10-07T01:00:00Z")];
    const c = buildCalendar(events, NOW, "UTC", 7);
    expect(c.days).toHaveLength(7);
    expect([c.from, c.to]).toEqual(["2026-09-30", "2026-10-06"]);
    expect(c.days.map((d) => d.day)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]);
    expect(c.days[6]).toMatchObject({ total: 2, level: 2, weekday: 2, byType: { TASK_COMPLETED: 1, DECISION: 1 } });
    expect(c.days[4]).toMatchObject({ total: 1, level: 1, byType: { MEMORY_CREATED: 1 } });
    expect(c.days[5]).toMatchObject({ total: 0, level: 0, byType: {} }); // nothing recorded: stated, not judged
    expect(c.total).toBe(3); // the August and the future events are outside the window
    expect(c.activeDays).toBe(2);
    // 23:30 UTC on the 4th is already the 5th in Tokyo
    const tokyo = buildCalendar(events, NOW, "Asia/Tokyo", 7);
    expect(tokyo.days.find((d) => d.byType.MEMORY_CREATED)!.day).toBe("2026-10-05");
    expect(JSON.stringify(c)).not.toMatch(/score|percent|streak|%/i);
  });
});

describe("timeline and map (pure)", () => {
  const st = (iso: string, basis: string, total: number, current = "x") => ({ createdAt: new Date(iso), basis, current, evidenceSummary: { supports: total, contradicts: 0, context: 0, total } });
  it("points are the recorded states in date order with their evidence counts; the range is first record → now; nothing is interpolated", () => {
    const t = buildTimeline([{ id: "a1", title: "Daily system", states: [st("2026-10-03T00:00:00Z", "EVIDENCED", 2, "later"), st("2026-09-20T00:00:00Z", "INITIAL", 0, "start")] }, { id: "a2", title: "Empty", states: [] }], NOW);
    expect(t.lines[0].points.map((p) => [p.basis, p.evidenceCount, p.current])).toEqual([["INITIAL", 0, "start"], ["EVIDENCED", 2, "later"]]);
    expect(t.lines[1].points).toEqual([]);
    expect(t.from).toBe("2026-09-20T00:00:00.000Z");
    expect(t.to).toBe(NOW.toISOString());
    expect(buildTimeline([], NOW)).toEqual({ from: NOW.toISOString(), to: NOW.toISOString(), lines: [] });
    expect(buildTimeline([{ id: "a", title: "t", states: [st("2026-10-01T00:00:00Z", "INITIAL", 0, "y".repeat(500))] }], NOW).lines[0].points[0].current.length).toBeLessThanOrEqual(141);
  });
  it("the map keeps every project (with real task counts), under its goal or under none", () => {
    const m = buildMap([{ id: "g1", title: "Goal", horizon: "LONG" }, { id: "g2", title: "Empty goal", horizon: "SHORT" }],
      [{ id: "p1", name: "P1", status: "ACTIVE", goalId: "g1", tasks: { open: 2, done: 3, cancelled: 1 } }, { id: "p2", name: "P2", status: "ACTIVE", goalId: null, tasks: { open: 0, done: 0, cancelled: 0 } }, { id: "p3", name: "P3", status: "PAUSED", goalId: "gone", tasks: { open: 1, done: 0, cancelled: 0 } }]);
    expect(m.goals[0].projects).toEqual([{ id: "p1", name: "P1", status: "ACTIVE", done: 3, open: 2 }]);
    expect(m.goals[1].projects).toEqual([]);
    expect(m.unassigned.map((p) => p.name)).toEqual(["P2", "P3"]);
    expect(JSON.stringify(m)).not.toMatch(/percent|score|%/i);
  });
});

describe("progress overview (real database, skill, API)", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  let authB: { Authorization: string };
  const db = () => getDb();
  const idA = () => identityFor(a, "GUIDEHUB");
  const READS: [string, string, string][] = [
    ["system.tasks", "angel:tasks", "READ"], ["system.life", "angel:life", "LIFE_READ"], ["system.future", "angel:future", "FUTURE_READ"], ["system.today", "angel:today", "PROGRESS_READ"],
  ];
  const ok = async (skill: string, action: string, params: unknown, who = idA()) => { const r = await proposeNamedAction(who, skill, action, params); expect(r.status, JSON.stringify(r)).toBe("EXECUTED"); return r.data as any; };

  beforeAll(async () => {
    a = (await createPrincipal("Viz A", "UTC")).id;
    b = (await createPrincipal("Viz B", "UTC")).id;
    for (const p of [a, b]) {
      for (const [s, r, x] of READS) await grant(p, JARVIS_AGENT_KEY, s, r, x, "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
    const t = getApiTokenService();
    authA = { Authorization: `Bearer ${(await t.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    authB = { Authorization: `Bearer ${(await t.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "b" })).token}` };
  });
  afterEach(() => setClock(null));
  afterAll(async () => { setClock(null); await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("draws only what was recorded: real activity per day, real states with evidence counts, real projects with task counts — for the caller only", async () => {
    const goal = await ok("system.life", "GOAL_CREATE", { title: "Ship Angel OS" });
    const project = await ok("system.life", "PROJECT_CREATE", { name: "Cockpit", goalId: goal.id });
    const t1 = await ok("system.tasks", "CREATE_TASK", { title: "T1", projectId: project.id });
    await ok("system.tasks", "CREATE_TASK", { title: "T2", projectId: project.id });
    await ok("system.tasks", "TASK_COMPLETE", { taskId: t1.id });
    const asp = await ok("system.future", "ASPIRATION_CREATE", { title: "Daily system", current: "built", desired: "used" });
    const g2 = await db().goal.create({ data: { principalId: a, title: "g" } });
    const res = await db().result.create({ data: { principalId: a, subjectKind: "GOAL", subjectId: g2.id, statement: "done" } });
    await ok("system.future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "cockpit shipped", desired: "used", evidence: [{ sourceKind: "RESULT", sourceId: res.id, stance: "SUPPORTS" }] });
    await ok("system.tasks", "CREATE_TASK", { title: "B private" }, identityFor(b, "GUIDEHUB"));
    const d = (await readProgressOverview(idA())).data as any;
    expect(d.calendar.days).toHaveLength(84);
    expect(d.calendar.days.at(-1).total).toBeGreaterThanOrEqual(1); // today has the completion (and the states) recorded
    expect(d.calendar.days.at(-1).byType.TASK_COMPLETED).toBe(1);
    const line = d.timeline.lines.find((l: any) => l.title === "Daily system");
    expect(line.points.map((p: any) => [p.basis, p.evidenceCount])).toEqual([["INITIAL", 0], ["EVIDENCED", 1]]);
    expect(d.map.goals.find((g: any) => g.title === "Ship Angel OS").projects).toEqual([{ id: project.id, name: "Cockpit", status: "ACTIVE", done: 1, open: 1 }]);
    expect(JSON.stringify(d)).not.toContain("B private");
    expect(d.levels).toHaveLength(5);
    expect(d.note).toMatch(/Nothing is scored, averaged or projected/);
  });

  it("the timeline is capped so a large list of aspirations can't flood the picture", async () => {
    const c = (await createPrincipal("Many aspirations")).id;
    try {
      for (const [sk, r, x] of READS) await grant(c, JARVIS_AGENT_KEY, sk, r, x, "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => x.skillKey === "system.future" && x.category === "WRITE")) await grant(c, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
      for (let n = 0; n < 10; n++) await ok("system.future", "ASPIRATION_CREATE", { title: `A${n}`, current: "c", desired: "d" }, identityFor(c, "GUIDEHUB"));
      expect(((await readProgressOverview(identityFor(c, "GUIDEHUB"))).data as any).timeline.lines).toHaveLength(8);
    } finally { await deletePrincipal(c); }
  });

  it("a domain the caller can't read is named as withheld and the rest is still drawn; without PROGRESS_READ nothing is returned", async () => {
    const c = (await createPrincipal("Partial viz")).id;
    try {
      await grant(c, JARVIS_AGENT_KEY, "system.today", "angel:today", "PROGRESS_READ", "READ");
      const r = await readProgressOverview(identityFor(c, "GUIDEHUB"));
      expect(r.status).toBe("EXECUTED");
      expect((r.data as any).withheld).toEqual(expect.arrayContaining(["life", "future self"]));
      expect((r.data as any).calendar.days).toHaveLength(84);
    } finally { await deletePrincipal(c); }
    const d = (await createPrincipal("No perm viz")).id;
    try { expect((await readProgressOverview(identityFor(d, "GUIDEHUB"))).status).toBe("DENIED"); } finally { await deletePrincipal(d); }
    expect((await readProgressOverview(undefined as any)).status).toBe("FAILED");
  });

  it("HTTP: needs a token, is read-only, takes no principal from the client, and never shows another person's data", async () => {
    expect((await request(app).get("/api/progress/overview")).status).toBe(401);
    expect((await request(app).post("/api/progress/overview").set(authA).send({})).status).toBe(404);
    expect((await request(app).get("/api/progress/overview?principalId=" + b).set(authA)).status).toBe(400);
    const mine = await request(app).get("/api/progress/overview").set(authA);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).toContain("Daily system");
    expect(JSON.stringify((await request(app).get("/api/progress/overview").set(authB)).body)).not.toContain("Daily system");
  });
});
