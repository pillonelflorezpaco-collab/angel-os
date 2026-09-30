import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import { setClock } from "../gateway/clock.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { proposeRoutine, readRoutines, readTodayPlan, formatPlan } from "../skills/system/routines.js";
import { readOpenLoops, readBadges } from "../skills/system/today.js";
import { buildToday, dayRefusal, describeDays, localParts, toMinutes } from "../routines/schedule.js";
import { parseIntent } from "../core/router/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
registerSkillActions();
const { app } = await import("../api/server.js");

const R = (o: Partial<Parameters<typeof buildToday>[0][number]> = {}) => ({ id: "r1", title: "Lunch", kind: "MEAL", details: "Rice and chicken", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timeOfDay: "12:30", durationMinutes: 30, status: "ACTIVE", ...o });

describe("routines schedule (pure)", () => {
  it("places 'now' on the owner's clock: day, weekday and minutes follow the time zone, and an unknown zone falls back to UTC", () => {
    const at = new Date("2026-10-06T23:30:00Z"); // Tuesday in UTC
    expect(localParts(at, "UTC")).toEqual({ day: "2026-10-06", weekday: 2, minutes: 23 * 60 + 30 });
    expect(localParts(at, "Asia/Tokyo")).toEqual({ day: "2026-10-07", weekday: 3, minutes: 8 * 60 + 30 });
    expect(localParts(at, "America/New_York")).toEqual({ day: "2026-10-06", weekday: 2, minutes: 19 * 60 + 30 });
    expect(localParts(at, "Not/AZone")).toEqual(localParts(at, "UTC"));
    expect(localParts(new Date("2026-10-06T00:00:00Z"), "UTC").minutes).toBe(0); // midnight is 0, not 24:00
  });
  it("today's items: only ACTIVE routines that occur on this weekday; state comes from the recorded check-in, otherwise from the clock — a passed time is 'not recorded', never 'failed'", () => {
    const now = new Date("2026-10-06T13:00:00Z"); // Tuesday 13:00 UTC
    const routines = [R(), R({ id: "r2", title: "Dinner", timeOfDay: "19:00" }), R({ id: "r3", title: "Gym", timeOfDay: "07:00", daysOfWeek: [1, 3] }), R({ id: "r4", title: "Paused", status: "PAUSED" }), R({ id: "r5", title: "Archived", status: "ARCHIVED" }), R({ id: "r6", title: "Morning walk", timeOfDay: "07:00" }), R({ id: "r7", title: "Vitamins", timeOfDay: "08:00" })];
    const checks = [{ routineId: "r6", day: "2026-10-06", status: "DONE" as const, note: "30 min" }, { routineId: "r7", day: "2026-10-06", status: "SKIPPED" as const }, { routineId: "r1", day: "2026-10-05", status: "DONE" as const }];
    const t = buildToday(routines, checks, now, "UTC");
    expect(t.weekday).toBe("Tuesday");
    expect(t.items.map((i) => [i.title, i.state])).toEqual([["Morning walk", "DONE"], ["Vitamins", "SKIPPED"], ["Lunch", "PAST_UNRECORDED"], ["Dinner", "UPCOMING"]]); // yesterday's check doesn't count for today
    expect(t.items.find((i) => i.title === "Morning walk")!.checkNote).toBe("30 min");
    expect(t.items.find((i) => i.title === "Dinner")!.minutesUntil).toBe(6 * 60);
    expect(t.next?.title).toBe("Dinner");
    expect(JSON.stringify(t)).not.toMatch(/fail|late|missed|score|streak/i);
    expect(buildToday([], [], now, "UTC")).toMatchObject({ items: [], next: null });
  });
  it("the boundary: at the exact minute a routine is due it is no longer 'upcoming'; one minute before it is, in 1 min", () => {
    const at = (t: string) => buildToday([R()], [], new Date(`2026-10-06T${t}:00Z`), "UTC").items[0];
    expect(at("12:29")).toMatchObject({ state: "UPCOMING", minutesUntil: 1 });
    expect(at("12:30")).toMatchObject({ state: "PAST_UNRECORDED", minutesUntil: null });
    expect(at("00:00").state).toBe("UPCOMING"); // a 12:30 routine at midnight is still ahead
    expect(buildToday([R({ timeOfDay: "00:00" })], [], new Date("2026-10-06T00:00:00Z"), "UTC").items[0].state).toBe("PAST_UNRECORDED");
  });

  it("a check-in may be for today or the last 7 days; never the future, never invalid", () => {
    expect(dayRefusal("2026-10-06", "2026-10-06")).toBeNull();
    expect(dayRefusal("2026-09-29", "2026-10-06")).toBeNull();
    expect(dayRefusal("2026-09-28", "2026-10-06")).toMatch(/last 7 days/);
    expect(dayRefusal("2026-10-07", "2026-10-06")).toMatch(/hasn't happened yet/);
    for (const bad of ["yesterday", "2026-13-01", "2026-02-30x", "06/10/2026", ""]) expect(dayRefusal(bad, "2026-10-06"), bad).toMatch(/valid date/);
    expect(toMinutes("07:05")).toBe(425);
    expect(describeDays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(describeDays([6, 0])).toBe("Weekends");
    expect(describeDays([0, 1, 2, 3, 4, 5, 6, 6])).toBe("Every day");
    expect(describeDays([3, 1])).toBe("Monday, Wednesday");
  });
});

describe("routines (real database, skills, Jarvis, API)", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  let authB: { Authorization: string };
  const db = () => getDb();
  const idA = (s: "GUIDEHUB" | "VOICE" = "GUIDEHUB") => identityFor(a, s);
  const jarvis = new JarvisCore();
  const READS: [string, string, string][] = [
    ["system.tasks", "angel:tasks", "READ"], ["system.life", "angel:life", "LIFE_READ"], ["system.future", "angel:future", "FUTURE_READ"], ["system.learning", "angel:learning", "LEARNING_READ"],
    ["system.decisions", "angel:decisions", "DECISION_READ"], ["system.today", "angel:today", "TODAY_READ"], ["system.today", "angel:today", "PROGRESS_READ"], ["system.routines", "angel:routines", "ROUTINE_READ"],
  ];
  const ok = async (action: string, params: unknown, who = idA()) => { const r = await proposeRoutine(who, action, params); expect(r.status, `${action}: ${JSON.stringify(r)}`).toBe("EXECUTED"); return r.data as any; };
  const failed = async (action: string, params: unknown, who = idA()) => { const r = await proposeRoutine(who, action, params); expect(r.status, `${action} ${JSON.stringify(params)}`).toBe("FAILED"); return r; };
  const ALL = [0, 1, 2, 3, 4, 5, 6];

  beforeAll(async () => {
    a = (await createPrincipal("Routines A", "UTC")).id;
    b = (await createPrincipal("Routines B", "UTC")).id;
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

  it("strict schemas: a routine needs a valid time and days; unknown fields, a forged principal and bad values are refused", async () => {
    for (const bad of [
      { title: "x", daysOfWeek: ALL, timeOfDay: "7:00" }, { title: "x", daysOfWeek: ALL, timeOfDay: "24:00" }, { title: "x", daysOfWeek: ALL, timeOfDay: "12:60" }, { title: "x", daysOfWeek: [], timeOfDay: "07:00" },
      { title: "x", daysOfWeek: [7], timeOfDay: "07:00" }, { title: "x", daysOfWeek: [1.5], timeOfDay: "07:00" }, { title: "", daysOfWeek: ALL, timeOfDay: "07:00" }, { title: "x", daysOfWeek: ALL, timeOfDay: "07:00", durationMinutes: 0 },
      { title: "x", daysOfWeek: ALL, timeOfDay: "07:00", durationMinutes: 1441 }, { title: "x", kind: "DIET", daysOfWeek: ALL, timeOfDay: "07:00" }, { title: "x", daysOfWeek: ALL, timeOfDay: "07:00", principalId: b },
      { title: "x", daysOfWeek: ALL, timeOfDay: "07:00", score: 5 }, { title: "x", daysOfWeek: ALL, timeOfDay: "07:00", calories: 500 },
    ]) await failed("ROUTINE_CREATE", bad);
    const r = await ok("ROUTINE_CREATE", { title: "Lunch", kind: "MEAL", details: "Rice, chicken, salad", daysOfWeek: [3, 1, 1, 2], timeOfDay: "12:30", durationMinutes: 30 });
    expect(r).toMatchObject({ principalId: a, kind: "MEAL", daysOfWeek: [1, 2, 3], status: "ACTIVE" }); // de-duplicated and ordered
    expect(await db().routine.count({ where: { principalId: b } })).toBe(0);
  });

  it("the plan is the owner's words, updated by the owner; today's view uses the owner's clock and time zone", async () => {
    const r = await ok("ROUTINE_CREATE", { title: "Breakfast", kind: "MEAL", details: "Oats and fruit", daysOfWeek: ALL, timeOfDay: "08:00" });
    await ok("ROUTINE_UPDATE", { routineId: r.id, details: "Eggs and toast", timeOfDay: "08:15" });
    expect(await db().routine.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ details: "Eggs and toast", timeOfDay: "08:15" });
    await failed("ROUTINE_UPDATE", { routineId: r.id });
    await failed("ROUTINE_UPDATE", { routineId: r.id, status: "ARCHIVED" });
    setClock(() => new Date("2026-10-06T09:00:00Z"));
    const plan = (await readTodayPlan(idA(), { agentKey: JARVIS_AGENT_KEY })).data as any;
    expect(plan.items.find((i: any) => i.title === "Breakfast")).toMatchObject({ state: "PAST_UNRECORDED", details: "Eggs and toast" });
    expect(plan.items.find((i: any) => i.title === "Lunch")).toMatchObject({ state: "UPCOMING", minutesUntil: 3 * 60 + 30 });
    // the same instant on a different clock: Tokyo is already the next morning
    await db().principal.update({ where: { id: a }, data: { timezone: "Asia/Tokyo" } });
    const tokyo = (await readTodayPlan(idA(), { agentKey: JARVIS_AGENT_KEY })).data as any;
    expect(tokyo.timeZone).toBe("Asia/Tokyo");
    expect(tokyo.items.find((i: any) => i.title === "Lunch").state).toBe("PAST_UNRECORDED"); // 18:00 in Tokyo
    await db().principal.update({ where: { id: a }, data: { timezone: "UTC" } });
  });

  it("check-ins: one per routine per day, DONE or SKIPPED, recorded not edited; not for the future, not older than a week; not checking is not a failure", async () => {
    const r = await ok("ROUTINE_CREATE", { title: "Walk", kind: "HABIT", daysOfWeek: ALL, timeOfDay: "18:00" });
    setClock(() => new Date("2026-10-06T20:00:00Z"));
    const done = await ok("ROUTINE_CHECK", { routineId: r.id, status: "DONE", note: "Around the park" });
    expect(done).toMatchObject({ day: "2026-10-06", status: "DONE", principalId: a });
    const dup = await failed("ROUTINE_CHECK", { routineId: r.id, status: "SKIPPED" });
    expect(dup.message).toMatch(/already has a check-in/);
    await ok("ROUTINE_CHECK", { routineId: r.id, status: "SKIPPED", day: "2026-10-05", note: "Rain" });
    await failed("ROUTINE_CHECK", { routineId: r.id, status: "DONE", day: "2026-10-07" });
    await failed("ROUTINE_CHECK", { routineId: r.id, status: "DONE", day: "2026-09-20" });
    await failed("ROUTINE_CHECK", { routineId: r.id, status: "DONE", day: "tomorrow" });
    await failed("ROUTINE_CHECK", { routineId: r.id, status: "MAYBE" });
    await failed("ROUTINE_CHECK", { routineId: r.id, status: "DONE", day: "2026-10-04", points: 10 });
    await expect(db().routineCheck.update({ where: { id: done.id }, data: { status: "SKIPPED" } })).rejects.toThrow(); // append-only in the database
    expect(await db().activity.count({ where: { principalId: a, type: "HABIT_COMPLETED", refType: "routine_check", refId: done.id } })).toBe(1);
    const plan = (await readTodayPlan(idA(), { agentKey: JARVIS_AGENT_KEY })).data as any;
    expect(plan.items.find((i: any) => i.title === "Walk")).toMatchObject({ state: "DONE", checkNote: "Around the park" });
  });

  it("pause / resume / archive: archived is final and can no longer be changed or checked; a paused routine drops out of today", async () => {
    const r = await ok("ROUTINE_CREATE", { title: "Stretch", daysOfWeek: ALL, timeOfDay: "06:30" });
    setClock(() => new Date("2026-10-06T07:00:00Z"));
    await ok("ROUTINE_SET_STATUS", { routineId: r.id, status: "PAUSED" });
    expect(((await readTodayPlan(idA(), { agentKey: JARVIS_AGENT_KEY })).data as any).items.map((i: any) => i.title)).not.toContain("Stretch");
    await ok("ROUTINE_SET_STATUS", { routineId: r.id, status: "ACTIVE" });
    await ok("ROUTINE_SET_STATUS", { routineId: r.id, status: "ARCHIVED" });
    await failed("ROUTINE_SET_STATUS", { routineId: r.id, status: "ACTIVE" });
    await failed("ROUTINE_UPDATE", { routineId: r.id, title: "Renamed" });
    await failed("ROUTINE_CHECK", { routineId: r.id, status: "DONE" });
    await expect(db().routine.update({ where: { id: r.id }, data: { status: "ACTIVE" } })).rejects.toThrow();
    expect(((await readRoutines(idA(), { agentKey: JARVIS_AGENT_KEY })).data as any[]).map((x) => x.title)).not.toContain("Stretch");
  });

  it("the database refuses what the API would: bad time, empty or out-of-range days, bad duration, bad day text, foreign check-ins", async () => {
    const mk = (over: object) => db().routine.create({ data: { principalId: a, title: "x", daysOfWeek: [1], timeOfDay: "07:00", ...over } });
    await expect(mk({ timeOfDay: "7:00" })).rejects.toThrow();
    await expect(mk({ timeOfDay: "25:00" })).rejects.toThrow();
    await expect(mk({ daysOfWeek: [] })).rejects.toThrow();
    await expect(mk({ daysOfWeek: [8] })).rejects.toThrow();
    await expect(mk({ durationMinutes: 0 })).rejects.toThrow();
    const r = await mk({});
    await expect(db().routineCheck.create({ data: { principalId: a, routineId: r.id, day: "6/10/2026", status: "DONE" } })).rejects.toThrow();
    await expect(db().routineCheck.create({ data: { principalId: b, routineId: r.id, day: "2026-10-06", status: "DONE" } })).rejects.toThrow(); // B can't check A's routine, even directly
  });

  it("isolation: another principal can neither see, change nor check my routines (same answer as missing); no forged principal", async () => {
    const r = await ok("ROUTINE_CREATE", { title: "Private routine", daysOfWeek: ALL, timeOfDay: "10:00" });
    const other = identityFor(b, "GUIDEHUB");
    for (const [action, params] of [["ROUTINE_UPDATE", { routineId: r.id, title: "stolen" }], ["ROUTINE_SET_STATUS", { routineId: r.id, status: "ARCHIVED" }], ["ROUTINE_CHECK", { routineId: r.id, status: "DONE" }]] as const)
      expect((await failed(action, params, other)).message, action).toMatch(/wasn't found/);
    expect(JSON.stringify((await readRoutines(other, { agentKey: JARVIS_AGENT_KEY })).data)).not.toContain("Private routine");
    expect(JSON.stringify((await readTodayPlan(other, { agentKey: JARVIS_AGENT_KEY })).data)).not.toContain("Private routine");
    expect((await readTodayPlan(undefined as any, { agentKey: JARVIS_AGENT_KEY })).status).toBe("FAILED");
  });

  it("interface policy unchanged: voice needs approval, unknown interfaces fail closed, reading needs ROUTINE_READ", async () => {
    const before = await db().routine.count({ where: { principalId: a } });
    expect((await proposeRoutine(idA("VOICE"), "ROUTINE_CREATE", { title: "Spoken", daysOfWeek: ALL, timeOfDay: "09:00" })).status).toBe("PENDING_APPROVAL");
    expect((await proposeRoutine({ ...idA(), interfaceSource: "NOPE" } as any, "ROUTINE_CREATE", { title: "x", daysOfWeek: ALL, timeOfDay: "09:00" })).status).not.toBe("EXECUTED");
    expect(await db().routine.count({ where: { principalId: a } })).toBe(before);
    const c = (await createPrincipal("No routine read")).id;
    try { expect((await readTodayPlan(identityFor(c, "GUIDEHUB"), { agentKey: JARVIS_AGENT_KEY })).status).toBe("DENIED"); } finally { await deletePrincipal(c); }
  });

  it("Jarvis shows the owner's OWN plan (English and French), never one it made up", async () => {
    expect(parseIntent("what's my plan today").name).toBe("routine.today");
    expect(parseIntent("What do I eat today?").name).toBe("routine.today");
    expect(parseIntent("qu'est-ce que je mange aujourd'hui").name).toBe("routine.today");
    expect(parseIntent("mon planning").name).toBe("routine.today");
    expect(parseIntent("what do I have today").name).toBe("calendar.today"); // the calendar phrase keeps its meaning
    setClock(() => new Date("2026-10-06T09:00:00Z"));
    const r = await jarvis.handle({ principalId: a, input: "What do I eat today?", identity: idA() });
    expect(r.status).toBe("EXECUTED");
    expect(r.message).toMatch(/^Your plan for Tuesday:/);
    expect(r.message).toMatch(/• 08:15 — Breakfast: Eggs and toast \(not recorded yet\)/);
    expect(r.message).toMatch(/• 12:30 — Lunch: Rice, chicken, salad \(upcoming, in 210 min\)/);
    const fresh = (await createPrincipal("No plan")).id;
    try {
      for (const [s, rr, x] of READS) await grant(fresh, JARVIS_AGENT_KEY, s, rr, x, "READ");
      const e = await jarvis.handle({ principalId: fresh, input: "what do I eat today", identity: identityFor(fresh, "GUIDEHUB") });
      expect(e.message).toBe("You haven't set up any routines yet, so there is no plan to show. I don't make one up.");
      expect(e.message).not.toMatch(/calor|diet|recommend/i);
    } finally { await deletePrincipal(fresh); }
    expect((await jarvis.handle({ principalId: a, input: "what do I eat today" })).status).toBe("FAILED");
    expect(formatPlan({ weekday: "Monday", hasAnyRoutine: true, items: [] })).toBe("Nothing is planned for Monday.");
  });

  it("open loops and badges see routines: a passed time with no check-in is a loop, an upcoming one is 'coming up', a check-in earns a fact", async () => {
    setClock(() => new Date("2026-10-06T09:00:00Z"));
    const d = (await readOpenLoops(idA())).data as any;
    expect(d.NOW.find((x: any) => x.title === "Breakfast")).toMatchObject({ kind: "ROUTINE", why: "Scheduled for 08:15 today; no check-in is recorded yet." });
    expect(d.NEXT.find((x: any) => x.title === "Lunch")).toMatchObject({ kind: "ROUTINE", why: "Scheduled for 12:30 today." });
    expect(JSON.stringify(d)).not.toMatch(/fail|missed/i);
    const badges = (await readBadges(idA())).data as any;
    expect(badges.counts.routineCheckIns).toBe(1); // the one DONE check-in above; SKIPPED does not count
    expect(badges.badges.find((x: any) => x.key === "routine-10")).toMatchObject({ have: 1, need: 10, earned: false });
    expect(((await readBadges(identityFor(b, "GUIDEHUB"))).data as any).counts.routineCheckIns).toBe(0);
  });

  it("HTTP: reads need a token and are the caller's own; writes exist only as actions; no principal from the client", async () => {
    for (const p of ["/api/routines", "/api/routines/today"]) {
      expect((await request(app).get(p)).status, p).toBe(401);
      expect((await request(app).post(p).set(authA).send({})).status, p).toBe(404);
    }
    const mine = await request(app).get("/api/routines").set(authA);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).toContain("Lunch");
    expect(JSON.stringify((await request(app).get("/api/routines").set(authB)).body)).not.toContain("Lunch");
    expect((await request(app).get("/api/routines/today?principalId=" + b).set(authA)).status).toBe(400);
    const created = await request(app).post("/api/actions/system.routines/ROUTINE_CREATE").set(authA).send({ title: "Via API", daysOfWeek: [1], timeOfDay: "10:10" });
    expect(created.status).toBe(200);
    expect((await request(app).post("/api/actions/system.routines/ROUTINE_CREATE").set(authA).send({ title: "x", daysOfWeek: [1], timeOfDay: "10:10", principalId: b })).status).toBe(400);
  });
});
