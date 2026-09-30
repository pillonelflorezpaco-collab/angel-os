import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { setClock } from "../gateway/clock.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { proposeFuture, readFutureOverview, readAspiration } from "../skills/system/future.js";
import { proposeLife } from "../skills/system/life.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { formatContext } from "../context/format.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
registerSkillActions();
const readA = { agentKey: JARVIS_AGENT_KEY };
const HOUR = 3600 * 1000;

describe("Future Self: aspirations, metrics, evidence-based progress", () => {
  let a: string;
  let b: string;
  const db = () => getDb();
  const idA = (s: "GUIDEHUB" | "VOICE" | "TELEGRAM" | "API" = "GUIDEHUB") => identityFor(a, s);
  const idB = () => identityFor(b, "GUIDEHUB");
  type Who = ReturnType<typeof idA>;
  const ok = async (who: Who, action: string, params: unknown) => {
    const r = await proposeFuture(who, action, params);
    expect(r.status, `${action}: ${JSON.stringify(r)}`).toBe("EXECUTED");
    return r.data as any;
  };
  const failed = async (who: Who, action: string, params: unknown) => {
    const r = await proposeFuture(who, action, params);
    expect(r.status, `${action} ${JSON.stringify(params)}: ${JSON.stringify(r)}`).toBe("FAILED");
    return r;
  };
  const aspire = (extra: Record<string, unknown> = {}, who: Who = idA()) => ok(who, "ASPIRATION_CREATE", { title: `asp-${Math.random()}`, current: "out of shape", desired: "run a 10k", ...extra });

  beforeAll(async () => {
    a = (await createPrincipal("Future A")).id;
    b = (await createPrincipal("Future B")).id;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, "system.future", "angel:future", "FUTURE_READ", "READ");
      await grant(p, JARVIS_AGENT_KEY, "system.life", "angel:life", "LIFE_READ", "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => ["system.future", "system.life"].includes(x.skillKey) && x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => setClock(null));
  afterEach(() => setClock(null));

  it("CURRENT → GAP → DESIRED → NEXT are the owner's words, with a next task/quest link owned by the owner", async () => {
    const task = await db().task.create({ data: { principalId: a, title: "Buy shoes" } });
    const asp = await aspire({ gap: "no routine", nextTaskId: task.id, area: "health" });
    expect(asp).toMatchObject({ principalId: a, current: "out of shape", gap: "no routine", desired: "run a 10k", nextTaskId: task.id, status: "ACTIVE" });
    const updated = await ok(idA(), "ASPIRATION_UPDATE", { aspirationId: asp.id, nextTaskId: null });
    expect(updated).toMatchObject({ current: "out of shape", nextTaskId: null, desired: "run a 10k" });
    // CURRENT/GAP/DESIRED can no longer be edited in place — only recorded as an evidenced state (future-learning.test.ts).
    await failed(idA(), "ASPIRATION_UPDATE", { aspirationId: asp.id, current: "running twice a week" });
  });

  it("NO progress figure exists until there is evidence, and progress is derived, never stored", async () => {
    const asp = await aspire();
    const metric = await ok(idA(), "METRIC_CREATE", { aspirationId: asp.id, name: "10k time", unit: "min", definition: "how it is measured", baseline: 70, target: 55 });
    let view = (await readAspiration(idA(), { ...readA, aspirationId: asp.id })).data as any;
    expect(view.progress).toBeNull();
    expect(view.metrics[0]).toMatchObject({ progress: null, readings: 0, latest: null });
    await ok(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 62.5 });
    view = (await readAspiration(idA(), { ...readA, aspirationId: asp.id })).data as any;
    expect(view.metrics[0].progress).toBeCloseTo(0.5);
    expect(view.progress).toBeCloseTo(0.5);
    // Not a stored column anywhere
    const raw = await db().aspiration.findUniqueOrThrow({ where: { id: asp.id } });
    expect(Object.keys(raw)).not.toContain("progress");
    expect(Object.keys(raw)).not.toContain("xp");
  });

  it("reaching the target NEVER closes the aspiration; only the owner does, once, and it is final", async () => {
    const asp = await aspire();
    const metric = await ok(idA(), "METRIC_CREATE", { aspirationId: asp.id, name: "km", unit: "km", definition: "how it is measured", baseline: 0, target: 10 });
    await ok(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 12 });
    const view = (await readAspiration(idA(), { ...readA, aspirationId: asp.id })).data as any;
    expect(view).toMatchObject({ progress: 1, status: "ACTIVE" });
    expect(view.metrics[0].targetReached).toBe(true);
    await failed(idA(), "ASPIRATION_RELEASE", { aspirationId: asp.id });
    await ok(idA(), "ASPIRATION_ACHIEVE", { aspirationId: asp.id, note: "did it" });
    const row = await db().aspiration.findUniqueOrThrow({ where: { id: asp.id } });
    expect(row).toMatchObject({ status: "ACHIEVED", closedNote: "did it" });
    expect(row.closedAt).toBeInstanceOf(Date);
    await failed(idA(), "ASPIRATION_RELEASE", { aspirationId: asp.id, reason: "changed my mind" });
    await failed(idA(), "ASPIRATION_UPDATE", { aspirationId: asp.id, desired: "moved goalposts" });
    await failed(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 1 });
    await failed(idA(), "METRIC_CREATE", { aspirationId: asp.id, name: "late", unit: "u", definition: "how it is measured", baseline: 0, target: 1 });
    await expect(db().aspiration.update({ where: { id: asp.id }, data: { status: "ACTIVE", closedAt: null } })).rejects.toThrow();
    expect((await db().activity.findMany({ where: { principalId: a, refId: asp.id } })).map((x) => x.type)).toEqual(["ACHIEVEMENT"]);
  });

  it("metrics are fixed at creation (no moving goalposts) and readings are append-only, also at the database", async () => {
    const asp = await aspire();
    const metric = await ok(idA(), "METRIC_CREATE", { aspirationId: asp.id, name: "m", unit: "u", definition: "how it is measured", baseline: 0, target: 100 });
    const reading = await ok(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 10 });
    await expect(db().metric.update({ where: { id: metric.id }, data: { target: 20 } })).rejects.toThrow(/append-only/);
    await expect(db().metricReading.update({ where: { id: reading.id }, data: { value: 99 } })).rejects.toThrow(/append-only/);
    expect((await proposeFuture(idA(), "METRIC_UPDATE", { metricId: metric.id, target: 20 })).status).toBe("FAILED"); // no such action
    await expect(db().metric.create({ data: { principalId: a, aspirationId: asp.id, name: "flat", unit: "u", baseline: 5, target: 5 } })).rejects.toThrow();
    await failed(idA(), "METRIC_CREATE", { aspirationId: asp.id, name: "flat", unit: "u", definition: "how it is measured", baseline: 5, target: 5 });
  });

  it("a later, worse reading lowers progress: nothing ratchets", async () => {
    const asp = await aspire();
    const metric = await ok(idA(), "METRIC_CREATE", { aspirationId: asp.id, name: "m", unit: "u", definition: "how it is measured", baseline: 0, target: 100 });
    await ok(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 90, observedAt: new Date(Date.now() - 48 * HOUR).toISOString() });
    await ok(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 30, observedAt: new Date(Date.now() - 24 * HOUR).toISOString() });
    expect(((await readAspiration(idA(), { ...readA, aspirationId: asp.id })).data as any).metrics[0].progress).toBeCloseTo(0.3);
    // an OLDER observation recorded last does not override the newest one
    await ok(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 100, observedAt: new Date(Date.now() - 72 * HOUR).toISOString() });
    expect(((await readAspiration(idA(), { ...readA, aspirationId: asp.id })).data as any).metrics[0].progress).toBeCloseTo(0.3);
  });

  it("readings cannot come from the future; a result may back a reading, and it must be the owner's", async () => {
    const asp = await aspire();
    const metric = await ok(idA(), "METRIC_CREATE", { aspirationId: asp.id, name: "m", unit: "u", definition: "how it is measured", baseline: 0, target: 10 });
    await failed(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 5, observedAt: new Date(Date.now() + 24 * HOUR).toISOString() });
    const goal = await db().goal.create({ data: { principalId: a, title: "G" } });
    const result = (await proposeLife(idA(), "RESULT_RECORD", { subjectKind: "GOAL", subjectId: goal.id, statement: "ran 5k" })).data as { id: string };
    const goalB = await db().goal.create({ data: { principalId: b, title: "GB" } });
    const resultB = (await proposeLife(idB(), "RESULT_RECORD", { subjectKind: "GOAL", subjectId: goalB.id, statement: "not mine" })).data as { id: string };
    const r = await failed(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 5, resultId: resultB.id });
    expect(r.message).toMatch(/wasn't found/);
    await ok(idA(), "METRIC_READING_RECORD", { metricId: metric.id, value: 5, resultId: result.id, note: "parkrun" });
    const view = (await readAspiration(idA(), { ...readA, aspirationId: asp.id })).data as any;
    expect(view.metrics[0]).toMatchObject({ readings: 1, evidenced: 1 });
    await expect(db().metricReading.create({ data: { principalId: a, metricId: metric.id, value: 1, observedAt: new Date(), resultId: resultB.id } })).rejects.toThrow(/cross-principal/);
  });

  describe("isolation", () => {
    it("another principal cannot see, read, extend or close any of it; DB triggers refuse foreign references", async () => {
      const asp = await aspire();
      const metric = await ok(idA(), "METRIC_CREATE", { aspirationId: asp.id, name: "m", unit: "u", definition: "how it is measured", baseline: 0, target: 10 });
      expect(JSON.stringify((await readFutureOverview(idB(), readA)).data)).not.toContain(asp.id);
      expect((await readAspiration(idB(), { ...readA, aspirationId: asp.id })).status).toBe("FAILED");
      for (const [action, params] of [
        ["ASPIRATION_UPDATE", { aspirationId: asp.id, nextTaskId: null }],
        ["ASPIRATION_ACHIEVE", { aspirationId: asp.id }],
        ["ASPIRATION_RELEASE", { aspirationId: asp.id, reason: "x" }],
        ["METRIC_CREATE", { aspirationId: asp.id, name: "x", unit: "u", definition: "how it is measured", baseline: 0, target: 1 }],
        ["METRIC_READING_RECORD", { metricId: metric.id, value: 5 }],
      ] as const) expect((await failed(idB(), action, params)).message, action).toMatch(/wasn't found/);
      const foreignTask = await db().task.create({ data: { principalId: b, title: "B task" } });
      const r = await failed(idA(), "ASPIRATION_CREATE", { title: "x", current: "c", desired: "d", nextTaskId: foreignTask.id });
      expect(r.message).toMatch(/wasn't found/);
      await expect(db().aspiration.create({ data: { principalId: a, title: "x", current: "c", desired: "d", nextTaskId: foreignTask.id } })).rejects.toThrow(/cross-principal/);
      await expect(db().metric.create({ data: { principalId: b, aspirationId: asp.id, name: "x", unit: "u", baseline: 0, target: 1 } })).rejects.toThrow(/cross-principal/);
      expect((await db().aspiration.findUniqueOrThrow({ where: { id: asp.id } })).current).toBe("out of shape");
    });

    it("racing closes: exactly one wins and one Activity row exists", async () => {
      const asp = await aspire();
      const rs = await Promise.all(Array.from({ length: 6 }, () => proposeFuture(idA(), "ASPIRATION_ACHIEVE", { aspirationId: asp.id })));
      expect(rs.filter((r) => r.status === "EXECUTED")).toHaveLength(1);
      expect(await db().activity.count({ where: { principalId: a, refId: asp.id } })).toBe(1);
    });
  });

  describe("policy and schema", () => {
    it("LOW writes are direct on GuideHub/Telegram/API and need approval on voice", async () => {
      for (const s of ["GUIDEHUB", "TELEGRAM", "API"] as const) await ok(idA(s), "ASPIRATION_CREATE", { title: `via ${s}`, current: "c", desired: "d" });
      const title = `voice-${Math.random()}`;
      expect((await proposeFuture(idA("VOICE"), "ASPIRATION_CREATE", { title, current: "c", desired: "d" })).status).toBe("PENDING_APPROVAL");
      expect(await db().aspiration.count({ where: { principalId: a, title } })).toBe(0);
    });

    it("strict schemas: unknown fields, client-supplied progress/status/principal, bad tags and empty updates are refused", async () => {
      const asp = await aspire();
      const before = await db().approvalRequest.count({ where: { principalId: a } });
      for (const [action, params] of [
        ["ASPIRATION_CREATE", { title: "x", current: "c", desired: "d", progress: 1 }],
        ["ASPIRATION_CREATE", { title: "x", current: "c", desired: "d", status: "ACHIEVED" }],
        ["ASPIRATION_CREATE", { title: "x", current: "c", desired: "d", principalId: b }],
        ["ASPIRATION_CREATE", { title: "x", current: "c", desired: "d", area: "Not A Slug!" }],
        ["ASPIRATION_UPDATE", { aspirationId: asp.id }],
        ["ASPIRATION_UPDATE", { aspirationId: asp.id, status: "ACHIEVED" }],
        ["METRIC_CREATE", { aspirationId: asp.id, name: "x", unit: "u", definition: "how it is measured", baseline: 0, target: 1, progress: 1 }],
        ["METRIC_CREATE", { aspirationId: asp.id, name: "x", unit: "u", definition: "how it is measured", baseline: "0", target: 1 }],
        ["METRIC_READING_RECORD", { metricId: asp.id, value: Number.POSITIVE_INFINITY }],
        ["METRIC_READING_RECORD", { metricId: asp.id, value: 1, xp: 10 }],
      ] as const) expect((await proposeFuture(idA(), action, params)).status, action + JSON.stringify(params)).toBe("FAILED");
      expect(await db().approvalRequest.count({ where: { principalId: a } })).toBe(before);
    });

    it("no grant → denied, nothing created; DENIED beats a grant", async () => {
      const c = (await createPrincipal("Future none")).id;
      try {
        expect((await proposeFuture(identityFor(c), "ASPIRATION_CREATE", { title: "x", current: "c", desired: "d" })).status).toBe("DENIED");
        expect((await readFutureOverview(identityFor(c), readA)).status).toBe("DENIED");
        await grant(c, JARVIS_AGENT_KEY, "system.future", "angel:future", "ASPIRATION_CREATE", "WRITE", "DENIED");
        expect((await proposeFuture(identityFor(c), "ASPIRATION_CREATE", { title: "x", current: "c", desired: "d" })).status).toBe("DENIED");
        expect(await db().aspiration.count({ where: { principalId: c } })).toBe(0);
      } finally { await deletePrincipal(c); }
    });
  });

  it("overview lists only the caller's ACTIVE aspirations with derived progress", async () => {
    const c = (await createPrincipal("Future overview")).id;
    try {
      for (const act of ["ASPIRATION_CREATE", "METRIC_CREATE", "METRIC_READING_RECORD", "ASPIRATION_RELEASE"]) await grant(c, JARVIS_AGENT_KEY, "system.future", "angel:future", act, "WRITE");
      await grant(c, JARVIS_AGENT_KEY, "system.future", "angel:future", "FUTURE_READ", "READ");
      const who = identityFor(c, "GUIDEHUB");
      const keep = await aspire({ title: "keep" }, who);
      const gone = await aspire({ title: "gone" }, who);
      await ok(who, "ASPIRATION_RELEASE", { aspirationId: gone.id, reason: "no longer me" });
      const m = await ok(who, "METRIC_CREATE", { aspirationId: keep.id, name: "m", unit: "u", definition: "how it is measured", baseline: 0, target: 4 });
      await ok(who, "METRIC_READING_RECORD", { metricId: m.id, value: 1 });
      const overview = (await readFutureOverview(who, readA)).data as any[];
      expect(overview.map((x) => x.title)).toEqual(["keep"]);
      expect(overview[0].progress).toBeCloseTo(0.25);
    } finally { await deletePrincipal(c); }
  });

  it("the Context Engine shows aspirations with 'no evidence yet' honestly, withholds without FUTURE_READ, and never leaks another principal's", async () => {
    const c = (await createPrincipal("Future ctx")).id;
    try {
      await grant(c, JARVIS_AGENT_KEY, "system.future", "angel:future", "FUTURE_READ", "READ");
      await db().aspiration.create({ data: { principalId: c, title: "zvxq aspiration", current: "here", desired: "there" } });
      await db().aspiration.create({ data: { principalId: b, title: "zvxq someone else", current: "x", desired: "y" } });
      const engine = new DeterministicContextEngine();
      const ctx = await engine.buildContext({ identity: identityFor(c), agentKey: JARVIS_AGENT_KEY, query: "zvxq" });
      expect(ctx.activeAspirations).toEqual([expect.objectContaining({ title: "zvxq aspiration", progress: null })]);
      expect(formatContext(ctx)).toContain("no measured readings yet");
      expect(ctx.withheld).not.toContain("future");
      const none = await engine.buildContext({ identity: identityFor(a), agentKey: JARVIS_AGENT_KEY, query: "zvxq" });
      expect(JSON.stringify(none.activeAspirations)).not.toContain("someone else");
      expect(JSON.stringify(ctx.activeAspirations)).not.toContain("someone else");
      expect((await engine.buildContext({ identity: identityFor((await createPrincipal("Future ctx2")).id), agentKey: JARVIS_AGENT_KEY, query: "zvxq" })).withheld).toContain("future");
    } finally { await deletePrincipal(c); }
  });
});
