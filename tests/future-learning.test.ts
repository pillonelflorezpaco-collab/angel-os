import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { proposeFuture, readStateTimeline, readFutureOverview } from "../skills/system/future.js";
import { proposeLearning, readExperiment, readSessions } from "../skills/system/learning.js";
import { transitionRefusal, CONFIRM_MIN } from "../learning/hypothesis.js";
import { recordState } from "../future/store.js";
import { getMemoryProvider } from "../memory/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
registerSkillActions();

describe("Future Self states + Learning experiments: evidence-gated, append-only, owner-scoped", () => {
  let a: string;
  let b: string;
  const db = () => getDb();
  const idA = (s: "GUIDEHUB" | "VOICE" = "GUIDEHUB") => identityFor(a, s);
  const idB = () => identityFor(b, "GUIDEHUB");
  const run = async (skill: "future" | "learning", who: ReturnType<typeof idA>, action: string, params: unknown) =>
    (skill === "future" ? proposeFuture : proposeLearning)(who, action, params);
  const ok = async (skill: "future" | "learning", action: string, params: unknown, who = idA()) => {
    const r = await run(skill, who, action, params);
    expect(r.status, `${action}: ${JSON.stringify(r)}`).toBe("EXECUTED");
    return r.data as any;
  };
  const failed = async (skill: "future" | "learning", action: string, params: unknown, who = idA()) => {
    const r = await run(skill, who, action, params);
    expect(r.status, `${action} ${JSON.stringify(params)}`).toBe("FAILED");
    return r;
  };
  const result = async (p: string) => {
    const g = await db().goal.create({ data: { principalId: p, title: "g" } });
    return db().result.create({ data: { principalId: p, subjectKind: "GOAL", subjectId: g.id, statement: "ran 5k", value: 5, unit: "km" } });
  };
  const aspire = () => ok("future", "ASPIRATION_CREATE", { title: `a-${Math.random()}`, current: "out of shape", desired: "run a 10k" });

  beforeAll(async () => {
    a = (await createPrincipal("FL A")).id;
    b = (await createPrincipal("FL B")).id;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, "system.future", "angel:future", "FUTURE_READ", "READ");
      await grant(p, JARVIS_AGENT_KEY, "system.learning", "angel:learning", "LEARNING_READ", "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => ["system.future", "system.learning", "system.life"].includes(x.skillKey) && x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("an aspiration starts with an INITIAL state; CURRENT/GAP/DESIRED change only via an evidenced state that keeps its evidence", async () => {
    const asp = await aspire();
    expect(await db().aspirationState.count({ where: { aspirationId: asp.id, basis: "INITIAL" } })).toBe(1);
    const r = await result(a);
    // no evidence → refused; context-only evidence → refused
    await failed("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [] });
    await failed("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "RESULT", sourceId: r.id, stance: "CONTEXT" }] });
    expect(await db().aspirationState.count({ where: { aspirationId: asp.id } })).toBe(1);
    const st = await ok("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "running 5k", desired: "run a 10k", evidence: [{ sourceKind: "RESULT", sourceId: r.id, stance: "SUPPORTS" }] });
    expect(await db().aspiration.findUniqueOrThrow({ where: { id: asp.id } })).toMatchObject({ current: "running 5k" });
    const tl = (await readStateTimeline(idA(), { agentKey: JARVIS_AGENT_KEY, aspirationId: asp.id })).data as any[];
    expect(tl.map((s) => s.basis)).toEqual(["INITIAL", "EVIDENCED"]);
    expect(tl[0].current).toBe("out of shape"); // history preserved
    expect(tl[1].evidence).toHaveLength(1);
    expect(tl[1].id).toBe(st.id);
    // the source record is untouched
    expect(await db().result.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ statement: "ran 5k" });
  });

  it("DB enforces: states and evidence are append-only; an evidenced state without evidence cannot commit; cross-principal evidence is refused", async () => {
    const asp = await aspire();
    const [first] = await db().aspirationState.findMany({ where: { aspirationId: asp.id } });
    await expect(db().aspirationState.update({ where: { id: first.id }, data: { current: "rewritten" } })).rejects.toThrow();
    await expect(db().aspirationState.create({ data: { principalId: a, aspirationId: asp.id, current: "c", desired: "d", basis: "EVIDENCED" } })).rejects.toThrow();
    const rB = await result(b);
    await failed("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "RESULT", sourceId: rB.id, stance: "SUPPORTS" }] });
    await expect(db().evidenceLink.create({ data: { principalId: a, subjectKind: "ASPIRATION_STATE", subjectId: first.id, sourceKind: "RESULT", sourceId: rB.id, stance: "SUPPORTS" } })).rejects.toThrow();
    const rA = await result(a);
    const link = await db().evidenceLink.create({ data: { principalId: a, subjectKind: "ASPIRATION_STATE", subjectId: first.id, sourceKind: "RESULT", sourceId: rA.id, stance: "SUPPORTS" } });
    await expect(db().evidenceLink.update({ where: { id: link.id }, data: { stance: "CONTRADICTS" } })).rejects.toThrow();
    // other principal cannot see or extend my timeline
    expect((await readStateTimeline(idB(), { agentKey: JARVIS_AGENT_KEY, aspirationId: asp.id })).status).toBe("FAILED");
    await failed("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "RESULT", sourceId: rA.id, stance: "SUPPORTS" }] }, idB());
  });

  it("only lived memories count as evidence; inferences and facts are refused", async () => {
    const asp = await aspire();
    const mem = getMemoryProvider();
    const fact = await mem.addMemory({ principalId: a, type: "FACT", content: "I like running", source: "t" });
    const inf = await mem.addMemory({ principalId: a, type: "INFERENCE", content: "I probably run better in the morning", source: "t" });
    const exp = await mem.addMemory({ principalId: a, type: "EXPERIENCE", content: "ran 5k at dawn", source: "t" });
    for (const m of [fact, inf]) await failed("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "MEMORY", sourceId: m.id, stance: "SUPPORTS" }] });
    await ok("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "MEMORY", sourceId: exp.id, stance: "SUPPORTS" }] });
  });

  it("closed aspirations keep their states frozen; forged fields and no scoring are rejected", async () => {
    const asp = await aspire();
    const r = await result(a);
    await ok("future", "ASPIRATION_RELEASE", { aspirationId: asp.id, reason: "changed my mind" });
    await failed("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "RESULT", sourceId: r.id, stance: "SUPPORTS" }] });
    const asp2 = await aspire();
    for (const extra of [{ principalId: b }, { score: 9 }, { xp: 1 }, { basis: "INITIAL" }])
      await failed("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp2.id, current: "x", desired: "y", evidence: [{ sourceKind: "RESULT", sourceId: r.id, stance: "SUPPORTS" }], ...extra });
  });

  it("interface policy is unchanged: voice needs approval, unknown interface fails closed", async () => {
    const asp = await aspire();
    const r = await result(a);
    const params = { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "RESULT", sourceId: r.id, stance: "SUPPORTS" }] };
    expect((await proposeFuture(idA("VOICE"), "ASPIRATION_STATE_RECORD", params)).status).toBe("PENDING_APPROVAL");
    const forged = { ...idA(), interfaceSource: "NOPE" } as any;
    expect((await proposeFuture(forged, "ASPIRATION_STATE_RECORD", params)).status).not.toBe("EXECUTED");
  });

  it("defense in depth: the store itself refuses a context-only state, and a future-dated observation", async () => {
    const asp = await aspire();
    const r = await result(a);
    await expect(recordState(a, { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "RESULT", sourceId: r.id, stance: "CONTEXT" }] })).rejects.toThrow(/supporting or contradicting/);
    const e = await ok("learning", "EXPERIMENT_CREATE", { hypothesis: "h", method: "m" });
    await failed("learning", "EXPERIMENT_OBSERVE", { experimentId: e.id, text: "x", observedAt: new Date(Date.now() + 86_400_000).toISOString() });
  });

  it("hypothesis gate: pure rules require evidence and never skip states", () => {
    const f = { observations: 0, observationDays: 0, supports: 0, contradicts: 0 };
    expect(transitionRefusal("CANDIDATE", "OBSERVED", f)).toMatch(/observation/);
    expect(transitionRefusal("CANDIDATE", "SUPPORTED", { ...f, observations: 5, supports: 5 })).toMatch(/can't go/);
    expect(transitionRefusal("CANDIDATE", "CONFIRMED", f)).toMatch(/can't go/);
    expect(transitionRefusal("OBSERVED", "SUPPORTED", { ...f, observations: 1 })).toMatch(/supporting/);
    expect(transitionRefusal("OBSERVED", "SUPPORTED", { ...f, observations: 1, supports: 1 })).toBeNull();
    const c = { observations: CONFIRM_MIN.observations, observationDays: CONFIRM_MIN.days, supports: CONFIRM_MIN.supports, contradicts: 0 };
    expect(transitionRefusal("SUPPORTED", "CONFIRMED", c)).toBeNull();
    expect(transitionRefusal("SUPPORTED", "CONFIRMED", { ...c, observations: c.observations - 1 })).toMatch(/Confirmed needs/);
    expect(transitionRefusal("SUPPORTED", "CONFIRMED", { ...c, observationDays: 1 })).toMatch(/Confirmed needs/);
    expect(transitionRefusal("SUPPORTED", "CONFIRMED", { ...c, contradicts: c.supports })).toMatch(/Contradicting/);
    expect(transitionRefusal("OBSERVED", "REJECTED", f)).toMatch(/Rejecting/);
    expect(transitionRefusal("CONFIRMED", "REJECTED", c)).toMatch(/can't go/);
    expect(transitionRefusal("REJECTED", "OBSERVED", c)).toMatch(/can't go/);
  });

  it("an experiment walks CANDIDATE → CONFIRMED only with observations and evidence; history is append-only; lessons reference it without rewriting it", async () => {
    const e = await ok("learning", "EXPERIMENT_CREATE", { hypothesis: "Morning study sticks better", method: "30 min at 7am for a week" });
    expect(e.status).toBe("CANDIDATE");
    await failed("learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "OBSERVED" });
    await failed("learning", "LESSON_RECORD", { experimentId: e.id, content: "too early" });
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const obs: any[] = [];
    for (const n of [3, 2, 1]) obs.push(await ok("learning", "EXPERIMENT_OBSERVE", { experimentId: e.id, text: `day -${n}`, observedAt: day(n) }));
    await ok("learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "OBSERVED" });
    await failed("learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "SUPPORTED" }); // no supporting evidence yet
    await ok("future", "EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: e.id, sourceKind: "OBSERVATION", sourceId: obs[0].id, stance: "SUPPORTS" });
    await ok("learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "SUPPORTED" });
    await failed("learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "CONFIRMED" }); // only 1 supporting link
    await failed("future", "EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: e.id, sourceKind: "OBSERVATION", sourceId: obs[0].id, stance: "SUPPORTS" }); // duplicate link
    await ok("future", "EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: e.id, sourceKind: "OBSERVATION", sourceId: obs[1].id, stance: "SUPPORTS" });
    await ok("learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "CONFIRMED", note: "held for me" });
    // terminal: no further transitions, observations or evidence
    await failed("learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "REJECTED" });
    await failed("learning", "EXPERIMENT_OBSERVE", { experimentId: e.id, text: "late" });
    await failed("future", "EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: e.id, sourceKind: "OBSERVATION", sourceId: obs[2].id, stance: "SUPPORTS" });
    await expect(db().learningExperiment.update({ where: { id: e.id }, data: { status: "REJECTED" } })).rejects.toThrow();
    const view = (await readExperiment(idA(), { agentKey: JARVIS_AGENT_KEY, experimentId: e.id })).data as any;
    expect(view.changes.map((c: any) => c.toStatus)).toEqual(["CANDIDATE", "OBSERVED", "SUPPORTED", "CONFIRMED"]);
    await expect(db().experimentStatusChange.update({ where: { id: view.changes[0].id }, data: { note: "x" } })).rejects.toThrow();
    await expect(db().experimentObservation.update({ where: { id: obs[0].id }, data: { text: "edited" } })).rejects.toThrow();
    // lesson: a LESSON memory that references the experiment; the experiment is unchanged
    const before = await db().learningExperiment.findUniqueOrThrow({ where: { id: e.id } });
    const lesson = await ok("learning", "LESSON_RECORD", { experimentId: e.id, content: "For me, 7am study worked in that week." });
    expect(await db().memory.findUniqueOrThrow({ where: { id: lesson.id } })).toMatchObject({ type: "LESSON", provenance: "EXPERIENCED", sourceRef: `experiment:${e.id}` });
    expect(await db().learningExperiment.findUniqueOrThrow({ where: { id: e.id } })).toEqual(before);
  });

  it("experiments and objectives are owner-scoped and forge-proof", async () => {
    const e = await ok("learning", "EXPERIMENT_CREATE", { hypothesis: "h", method: "m" });
    await failed("learning", "EXPERIMENT_OBSERVE", { experimentId: e.id, text: "x" }, idB());
    await failed("learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "OBSERVED" }, idB());
    await failed("learning", "EXPERIMENT_CREATE", { hypothesis: "h", method: "m", principalId: b });
    await failed("learning", "EXPERIMENT_CREATE", { hypothesis: "h", method: "m", status: "CONFIRMED" });
    const oB = await ok("learning", "OBJECTIVE_CREATE", { title: "B's", evidenceStandard: "s" }, idB());
    await failed("learning", "EXPERIMENT_CREATE", { hypothesis: "h", method: "m", objectiveId: oB.id });
    await expect(db().learningExperiment.create({ data: { principalId: a, hypothesis: "h", method: "m", objectiveId: oB.id } })).rejects.toThrow();
  });

  it("an objective is met only by the owner's claim with supporting evidence; abandoning needs a reason; both are final", async () => {
    const o = await ok("learning", "OBJECTIVE_CREATE", { title: "Read a paper a week", evidenceStandard: "a summary I wrote, checked by recall" });
    await failed("learning", "OBJECTIVE_CLOSE", { objectiveId: o.id, outcome: "MET" });
    const r = await result(a);
    await ok("future", "EVIDENCE_ATTACH", { subjectKind: "OBJECTIVE", subjectId: o.id, sourceKind: "RESULT", sourceId: r.id, stance: "CONTEXT" });
    await failed("learning", "OBJECTIVE_CLOSE", { objectiveId: o.id, outcome: "MET" }); // context is not support
    const r2 = await result(a);
    await ok("future", "EVIDENCE_ATTACH", { subjectKind: "OBJECTIVE", subjectId: o.id, sourceKind: "RESULT", sourceId: r2.id, stance: "SUPPORTS" });
    await ok("learning", "OBJECTIVE_CLOSE", { objectiveId: o.id, outcome: "MET" });
    await failed("learning", "OBJECTIVE_CLOSE", { objectiveId: o.id, outcome: "ABANDONED", note: "n" });
    const o2 = await ok("learning", "OBJECTIVE_CREATE", { title: "x", evidenceStandard: "y" });
    await failed("learning", "OBJECTIVE_CLOSE", { objectiveId: o2.id, outcome: "ABANDONED" });
    await ok("learning", "OBJECTIVE_CLOSE", { objectiveId: o2.id, outcome: "ABANDONED", note: "no longer relevant" });
  });

  it("metrics carry a definition and reading provenance; zero is a valid reading", async () => {
    const asp = await aspire();
    await failed("future", "METRIC_CREATE", { aspirationId: asp.id, name: "n", unit: "u", baseline: 0, target: 1 }); // definition required
    const m = await ok("future", "METRIC_CREATE", { aspirationId: asp.id, name: "n", unit: "u", definition: "count of x per week", baseline: 0, target: 3 });
    const rd = await ok("future", "METRIC_READING_RECORD", { metricId: m.id, value: 0, provenance: "MEASURED" });
    expect(rd).toMatchObject({ value: 0, provenance: "MEASURED" });
    await failed("future", "METRIC_READING_RECORD", { metricId: m.id, value: 1, provenance: "MAGIC" });
  });

  it("cockpit reads: evidence labels come from the owner's own rows, lessons/sessions/next-action are scoped, nothing crosses principals", async () => {
    const task = await db().task.create({ data: { principalId: a, title: "Buy shoes" } });
    const asp = await ok("future", "ASPIRATION_CREATE", { title: `cr-${Math.random()}`, current: "c", desired: "d", nextTaskId: task.id });
    const mem = getMemoryProvider();
    const exp = await mem.addMemory({ principalId: a, type: "EXPERIENCE", content: "ran 5k at dawn", source: "t" });
    const r = await result(a);
    await ok("future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "MEMORY", sourceId: exp.id, stance: "SUPPORTS" }, { sourceKind: "RESULT", sourceId: r.id, stance: "CONTEXT", note: "n" }] });
    const tl = (await readStateTimeline(idA(), { agentKey: JARVIS_AGENT_KEY, aspirationId: asp.id })).data as any[];
    const ev = tl[1].evidence;
    expect(ev.find((e: any) => e.sourceKind === "MEMORY")).toMatchObject({ label: "ran 5k at dawn", memoryType: "EXPERIENCE", retracted: false });
    expect(ev.find((e: any) => e.sourceKind === "RESULT").label).toBe("ran 5k — 5 km");
    const overview = (await readFutureOverview(idA(), { agentKey: JARVIS_AGENT_KEY })).data as any[];
    expect(overview.find((x) => x.id === asp.id).nextTask).toMatchObject({ title: "Buy shoes" });
    // a retracted memory is still shown, as retracted, never silently dropped
    await mem.retractMemory(a, exp.id, "test");
    const again = (await readStateTimeline(idA(), { agentKey: JARVIS_AGENT_KEY, aspirationId: asp.id })).data as any[];
    expect(again[1].evidence.find((e: any) => e.sourceKind === "MEMORY").retracted).toBe(true);
    // sessions are the caller's own
    const topic = await ok("learning", "TOPIC_CREATE", { title: "Spanish" });
    await ok("learning", "SESSION_LOG", { topicId: topic.id, minutes: 20 });
    expect(((await readSessions(idA(), { agentKey: JARVIS_AGENT_KEY })).data as any[]).some((x) => x.topicTitle === "Spanish" && x.minutes === 20)).toBe(true);
    expect(((await readSessions(idB(), { agentKey: JARVIS_AGENT_KEY })).data as any[]).some((x) => x.topicTitle === "Spanish")).toBe(false);
    // a lesson shows on its experiment, only for the owner
    const e = await ok("learning", "EXPERIMENT_CREATE", { hypothesis: "h2", method: "m" });
    await ok("learning", "EXPERIMENT_OBSERVE", { experimentId: e.id, text: "saw it" });
    await ok("learning", "LESSON_RECORD", { experimentId: e.id, content: "worked for me" });
    expect(((await readExperiment(idA(), { agentKey: JARVIS_AGENT_KEY, experimentId: e.id })).data as any).lessons.map((l: any) => l.content)).toEqual(["worked for me"]);
    expect((await readExperiment(idB(), { agentKey: JARVIS_AGENT_KEY, experimentId: e.id })).status).toBe("FAILED");
  });
});
