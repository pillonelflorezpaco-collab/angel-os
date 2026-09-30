import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { proposeNamedAction } from "../skills/system/apiActions.js";
import { readOpenLoops, readBadges } from "../skills/system/today.js";
import { evaluateBadges, streaks, type Facts } from "../progress/badges.js";
import { buildLoops, type LoopInput } from "../progress/loops.js";
import { parseIntent } from "../core/router/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
registerSkillActions();
const { app } = await import("../api/server.js");

const ZERO: Facts = { tasksDone: 0, questsCompleted: 0, decisionsRecorded: 0, decisionsReviewed: 0, learningSessions: 0, learningMinutes: 0, observations: 0, experimentsClosed: 0, experimentsRejected: 0, lessons: 0, experiences: 0, statesEvidenced: 0, objectivesMet: 0, routineCheckIns: 0, activityDays: [] };
const NOW = new Date("2026-10-06T12:00:00Z");
const H = 3_600_000;

describe("factual badges (pure)", () => {
  it("streaks: consecutive recorded days only; a gap breaks the run; today or yesterday keeps it alive", () => {
    expect(streaks([], "2026-10-06")).toEqual({ current: 0, longest: 0, endsToday: false });
    expect(streaks(["2026-10-04", "2026-10-05", "2026-10-06"], "2026-10-06")).toEqual({ current: 3, longest: 3, endsToday: true });
    expect(streaks(["2026-10-04", "2026-10-05"], "2026-10-06")).toEqual({ current: 2, longest: 2, endsToday: false }); // yesterday: still alive
    expect(streaks(["2026-10-01", "2026-10-02", "2026-10-05"], "2026-10-06")).toMatchObject({ current: 1, longest: 2 });
    expect(streaks(["2026-10-01", "2026-10-02"], "2026-10-06").current).toBe(0); // broken
    expect(streaks(["2026-10-06", "2026-10-06"], "2026-10-06").longest).toBe(1); // duplicates are one day
    expect(streaks(["2026-02-28", "2026-03-01"], "2026-03-01").longest).toBe(2); // month boundary
  });

  it("zero is a valid state: nothing recorded, nothing earned, and every badge states its rule and its count", () => {
    const { badges } = evaluateBadges(ZERO, "2026-10-06");
    expect(badges.length).toBeGreaterThanOrEqual(15);
    for (const b of badges) { expect(b.earned, b.key).toBe(false); expect(b.have, b.key).toBe(0); expect(b.need, b.key).toBeGreaterThan(0); expect(b.statement.length, b.key).toBeGreaterThan(8); }
    expect(new Set(badges.map((b) => b.key)).size).toBe(badges.length);
  });

  it("a badge is earned exactly at its threshold — on real counts only", () => {
    const at = (f: Partial<Facts>) => Object.fromEntries(evaluateBadges({ ...ZERO, ...f }, "2026-10-06").badges.map((b) => [b.key, b.earned]));
    expect(at({ tasksDone: 9 })["tasks-10"]).toBe(false);
    expect(at({ tasksDone: 10 })["tasks-10"]).toBe(true);
    expect(at({ tasksDone: 10 })["tasks-50"]).toBe(false);
    expect(at({ learningMinutes: 599 })["study-10h"]).toBe(false);
    expect(at({ learningMinutes: 600 })["study-10h"]).toBe(true);
    expect(at({ experimentsRejected: 1 })["honest-negative"]).toBe(true);
    expect(at({ decisionsRecorded: 1 })["first-look-back"]).toBe(false); // recording is not reviewing
    expect(at({ activityDays: ["2026-10-04", "2026-10-05", "2026-10-06"] })).toMatchObject({ "streak-3": true, "streak-7": false });
  });

  it("no score, level, XP, points or percentage exists anywhere in a badge report", () => {
    const { badges } = evaluateBadges({ ...ZERO, tasksDone: 60, decisionsRecorded: 3 }, "2026-10-06");
    expect(JSON.stringify(badges)).not.toMatch(/\b(xp|level|score|points?|rank|percent)\b|%/i);
    expect(Object.keys(badges[0]).sort()).toEqual(["earned", "have", "key", "need", "statement", "title"]);
  });
});

describe("open loops (pure)", () => {
  const base: LoopInput = { now: NOW, tasks: [], reminders: [], decisionsDue: [], aspirations: [], experiments: [], objectives: [], cardsDue: 0, routines: [] };
  it("nothing open → nothing listed (no invented priorities)", () => {
    expect(buildLoops(base)).toEqual({ NOW: [], NEXT: [], OPEN: [] });
  });
  it("groups by what is actually true of each item, each with its reason; sorted by date", () => {
    const l = buildLoops({ ...base,
      tasks: [
        { id: "t1", title: "Overdue", status: "TODO", dueAt: new Date(NOW.getTime() - 2 * H) },
        { id: "t2", title: "Tomorrow", status: "IN_PROGRESS", dueAt: new Date(NOW.getTime() + 5 * H) },
        { id: "t3", title: "This week", status: "TODO", dueAt: new Date(NOW.getTime() + 3 * 24 * H) },
        { id: "t4", title: "Later", status: "TODO", dueAt: new Date(NOW.getTime() + 30 * 24 * H) },
        { id: "t5", title: "Undated", status: "TODO", dueAt: null },
        { id: "t6", title: "Done", status: "DONE", dueAt: new Date(NOW.getTime() - H) },
        { id: "t7", title: "Cancelled", status: "CANCELLED", dueAt: null },
      ],
      reminders: [{ id: "r1", message: "Call John", remindAt: new Date(NOW.getTime() + 2 * H), status: "PENDING" }, { id: "r2", message: "Sent already", remindAt: new Date(NOW.getTime() - H), status: "SENT" }],
      decisionsDue: [{ id: "d1", title: "Hire?", reviewAt: new Date(NOW.getTime() - 24 * H) }],
      cardsDue: 3,
      aspirations: [
        { id: "a1", title: "Daily system", nextTask: { id: "t5", title: "Undated", status: "TODO" }, nextQuest: null },
        { id: "a2", title: "Fitness", nextTask: null, nextQuest: null },
        { id: "a3", title: "Closed next", nextTask: { id: "x", title: "Finished", status: "DONE" }, nextQuest: null },
      ],
      experiments: [{ id: "e1", hypothesis: "Mornings work", status: "OBSERVED" }, { id: "e2", hypothesis: "Done", status: "REJECTED" }],
      objectives: [{ id: "o1", title: "Talk 10 min", status: "ACTIVE", evidence: { total: 0 } }, { id: "o2", title: "Met", status: "MET", evidence: { total: 2 } }],
    });
    expect(new Set(l.NOW.map((x) => x.title))).toEqual(new Set(["Overdue", "Tomorrow", "Call John", "Hire?", "3 recall cards due"]));
    expect(l.NOW[0].title).toBe("Hire?"); // earliest date first
    expect(l.NEXT.map((x) => x.title).sort()).toEqual(["This week", "Undated"]); // due within 7 days + the aspiration's next task
    expect(l.OPEN.map((x) => x.title).sort()).toEqual(["Closed next", "Fitness", "Later", "Mornings work", "Talk 10 min"]);
    expect(JSON.stringify(l)).not.toMatch(/Sent already|Cancelled|"Done"|Met|Finished/);
    for (const x of [...l.NOW, ...l.NEXT, ...l.OPEN]) expect(x.why.length, x.title).toBeGreaterThan(10);
    expect(l.OPEN.find((x) => x.title === "Talk 10 min")!.why).toMatch(/no evidence recorded/);
    expect(l.OPEN.find((x) => x.title === "Fitness")!.why).toMatch(/no open next action/);
  });
  it("a task that is an aspiration's next action is listed once, as that", () => {
    const l = buildLoops({ ...base, tasks: [{ id: "t5", title: "Undated", status: "TODO", dueAt: null }], aspirations: [{ id: "a1", title: "A", nextTask: { id: "t5", title: "Undated", status: "TODO" }, nextQuest: null }] });
    expect([...l.NOW, ...l.NEXT, ...l.OPEN].filter((x) => x.title === "Undated")).toHaveLength(1);
    expect(l.NEXT[0].kind).toBe("NEXT_ACTION");
  });
  it("groups are capped so a huge backlog can't flood the screen", () => {
    const tasks = Array.from({ length: 30 }, (_, n) => ({ id: `t${n}`, title: `T${n}`, status: "TODO", dueAt: null }));
    expect(buildLoops({ ...base, tasks }).OPEN).toHaveLength(8);
  });
});

describe("what matters + badges through the skills, Jarvis and the API (real database)", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  let authB: { Authorization: string };
  const db = () => getDb();
  const idA = () => identityFor(a, "GUIDEHUB");
  const jarvis = new JarvisCore();
  const READS: [string, string, string][] = [
    ["system.tasks", "angel:tasks", "READ"], ["system.life", "angel:life", "LIFE_READ"], ["system.future", "angel:future", "FUTURE_READ"], ["system.learning", "angel:learning", "LEARNING_READ"],
    ["system.decisions", "angel:decisions", "DECISION_READ"], ["system.activity", "angel:activity", "ACTIVITY_READ"], ["system.today", "angel:today", "TODAY_READ"], ["system.routines", "angel:routines", "ROUTINE_READ"], ["system.today", "angel:today", "PROGRESS_READ"],
  ];
  const ok = async (skill: string, action: string, params: unknown, who = idA()) => { const r = await proposeNamedAction(who, skill, action, params); expect(r.status, JSON.stringify(r)).toBe("EXECUTED"); return r.data as any; };

  beforeAll(async () => {
    a = (await createPrincipal("Today A")).id;
    b = (await createPrincipal("Today B")).id;
    for (const p of [a, b]) {
      for (const [s, r, x] of READS) await grant(p, JARVIS_AGENT_KEY, s, r, x, "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
    const t = getApiTokenService();
    authA = { Authorization: `Bearer ${(await t.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    authB = { Authorization: `Bearer ${(await t.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "b" })).token}` };
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("assembles real open loops with reasons, only for the caller; an empty life says so", async () => {
    const empty = (await readOpenLoops(idA())).data as any;
    expect([empty.NOW, empty.NEXT, empty.OPEN].flat()).toEqual([]);
    const task = await ok("system.tasks", "CREATE_TASK", { title: "Buy shoes" });
    const asp = await ok("system.future", "ASPIRATION_CREATE", { title: "Run a 10k", current: "c", desired: "d", nextTaskId: task.id });
    await ok("system.future", "ASPIRATION_CREATE", { title: "Sleep better", current: "c", desired: "d" });
    await ok("system.learning", "EXPERIMENT_CREATE", { hypothesis: "Morning study sticks", method: "m" });
    await ok("system.decisions", "DECISION_RECORD", { title: "Old decision", decision: "d", reviewAt: new Date(Date.now() - 86_400_000).toISOString() });
    await ok("system.tasks", "CREATE_TASK", { title: "B-only secret task" }, identityFor(b, "GUIDEHUB"));
    const d = (await readOpenLoops(idA())).data as any;
    expect(d.NOW.map((x: any) => x.title)).toContain("Old decision");
    expect(d.NEXT.find((x: any) => x.title === "Buy shoes")).toMatchObject({ kind: "NEXT_ACTION", ref: { type: "task", id: task.id } });
    expect(d.OPEN.map((x: any) => x.title).sort()).toEqual(["Morning study sticks", "Sleep better"]);
    expect(JSON.stringify(d)).not.toContain("B-only secret task");
    expect(asp.id).toBeTruthy();
  });

  it("a domain the caller may not read is named as withheld, not silently dropped, and the rest still works", async () => {
    const c = (await createPrincipal("Partial")).id;
    try {
      for (const [s, r, x] of READS.filter(([, , x]) => x !== "LEARNING_READ")) await grant(c, JARVIS_AGENT_KEY, s, r, x, "READ");
      const d = (await readOpenLoops(identityFor(c, "GUIDEHUB"))).data as any;
      expect(d.withheld).toEqual(expect.arrayContaining(["experiments", "objectives", "learning"]));
      expect((await readOpenLoops(identityFor(c, "GUIDEHUB"))).status).toBe("EXECUTED");
    } finally { await deletePrincipal(c); }
  });

  it("without TODAY_READ / PROGRESS_READ nothing is returned; no identity is refused", async () => {
    const c = (await createPrincipal("No perms")).id;
    try {
      expect((await readOpenLoops(identityFor(c, "GUIDEHUB"))).status).toBe("DENIED");
      expect((await readBadges(identityFor(c, "GUIDEHUB"))).status).toBe("DENIED");
    } finally { await deletePrincipal(c); }
    expect((await readOpenLoops(undefined as any)).status).toBe("FAILED");
    expect((await readBadges({ principalId: a } as any)).status).toBe("FAILED");
  });

  it("Jarvis answers 'what matters' (English and French) from the same loops; nothing invented for an empty life", async () => {
    expect(parseIntent("What matters today?").name).toBe("today.loops");
    expect(parseIntent("qu'est-ce qui compte aujourd'hui").name).toBe("today.loops");
    expect(parseIntent("what matters more to me, tea or coffee").name).toBe("today.loops"); // a known limit of phrase matching; it only ever lists real open items
    const r = await jarvis.handle({ principalId: a, input: "What matters today?", identity: idA() });
    expect(r.status).toBe("EXECUTED");
    expect(r.message).toMatch(/Due now:\n• Old decision — The look-back date/);
    expect(r.message).toMatch(/Coming up:\n• Buy shoes — The next action you set for “Run a 10k”\./);
    const fresh = (await createPrincipal("Fresh")).id;
    try {
      for (const [s, rr, x] of READS) await grant(fresh, JARVIS_AGENT_KEY, s, rr, x, "READ");
      const e = await jarvis.handle({ principalId: fresh, input: "what matters today", identity: identityFor(fresh, "GUIDEHUB") });
      expect(e.message).toBe("Nothing open is waiting on you right now.");
    } finally { await deletePrincipal(fresh); }
    expect((await jarvis.handle({ principalId: a, input: "what matters today" })).status).toBe("FAILED");
  });

  it("badges follow what was really recorded: a look-back earns 'first look-back', recording alone does not", async () => {
    const before = (await readBadges(idA())).data as any;
    const earned = (k: string, r: any) => r.badges.find((x: any) => x.key === k).earned;
    expect(earned("first-decision", before)).toBe(true); // "Old decision" above
    expect(earned("first-look-back", before)).toBe(false);
    const dec = await db().decision.findFirstOrThrow({ where: { principalId: a, title: "Old decision" } });
    await ok("system.decisions", "DECISION_REVIEW", { decisionId: dec.id, outcome: "It went fine." });
    const after = (await readBadges(idA())).data as any;
    expect(earned("first-look-back", after)).toBe(true);
    expect(after.counts.decisionsReviewed).toBe(1);
    expect(after.streak.longest).toBeGreaterThanOrEqual(1); // activity was recorded today
    expect(JSON.stringify(after.badges)).not.toMatch(/\b(xp|level|score|points?)\b|%/i);
    const other = (await readBadges(identityFor(b, "GUIDEHUB"))).data as any;
    expect(other.counts.decisionsReviewed).toBe(0); // B's numbers are B's own
  });

  it("HTTP: both routes need a token, return the caller's own data, and are read-only", async () => {
    for (const p of ["/api/today/loops", "/api/progress/badges"]) {
      expect((await request(app).get(p)).status, p).toBe(401);
      expect((await request(app).post(p).set(authA).send({})).status, p).toBe(404); // no mutation is exposed
    }
    const loops = await request(app).get("/api/today/loops").set(authA);
    expect(loops.status).toBe(200);
    expect(JSON.stringify(loops.body)).toContain("Buy shoes");
    const theirs = await request(app).get("/api/today/loops").set(authB);
    expect(JSON.stringify(theirs.body)).not.toContain("Buy shoes");
    expect((await request(app).get("/api/progress/badges?principalId=" + b).set(authA)).status).toBe(400); // no principal from the client
    const badges = await request(app).get("/api/progress/badges").set(authA);
    expect(badges.status).toBe(200);
    expect(badges.body.data.badges.length).toBeGreaterThan(10);
  });
});
