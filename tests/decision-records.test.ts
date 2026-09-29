import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { setClock } from "../gateway/clock.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { proposeDecision, readDecision, listDecisionRecords } from "../skills/system/decisions.js";
import { proposeLife, readResults, readReviews } from "../skills/system/life.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
registerSkillActions();
const readA = { agentKey: JARVIS_AGENT_KEY };
const DAY = 24 * 3600 * 1000;

describe("Decision records, results and reviews", () => {
  let a: string;
  let b: string;
  const db = () => getDb();
  const idA = (s: "GUIDEHUB" | "VOICE" | "TELEGRAM" | "API" = "GUIDEHUB") => identityFor(a, s);
  const idB = () => identityFor(b, "GUIDEHUB");
  type Who = ReturnType<typeof idA>;
  const record = async (who: Who, params: Record<string, unknown>) => proposeDecision(who, "DECISION_RECORD", { title: `d-${Math.random()}`, decision: "Do X", ...params });
  const okRecord = async (params: Record<string, unknown> = {}, who: Who = idA()) => {
    const r = await record(who, params);
    expect(r.status, JSON.stringify(r)).toBe("EXECUTED");
    return r.data as { id: string };
  };
  const life = (who: Who, action: string, params: unknown) => proposeLife(who, action, params);

  beforeAll(async () => {
    a = (await createPrincipal("Decisions A")).id;
    b = (await createPrincipal("Decisions B")).id;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, "system.decisions", "angel:decisions", "DECISION_READ", "READ");
      await grant(p, JARVIS_AGENT_KEY, "system.life", "angel:life", "LIFE_READ", "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => ["system.decisions", "system.life", "system.tasks"].includes(x.skillKey) && x.category === "WRITE")) {
        await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
      }
    }
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => setClock(null));
  afterEach(() => setClock(null));

  describe("recording", () => {
    it("stores question, options (one chosen), reasoning, expectation and evidence with snapshot labels taken from the owner's rows", async () => {
      const mem = await db().memory.create({ data: { principalId: a, type: "FACT", content: "I sleep badly after coffee", source: "t" } });
      const task = await db().task.create({ data: { principalId: a, title: "Try decaf" } });
      const d = await okRecord({
        question: "Keep drinking coffee?", options: [{ label: "Keep", pros: "taste" }, { label: "Stop", cons: "headaches" }], chosenIndex: 1,
        reasoning: "sleep matters", expected: "better sleep in 2 weeks", reviewAt: new Date(Date.now() + 14 * DAY).toISOString(),
        evidence: [{ kind: "MEMORY", refId: mem.id }, { kind: "TASK", refId: task.id }, { kind: "NOTE", note: "read an article" }],
      });
      const row = (await readDecision(idA(), { ...readA, decisionId: d.id })).data as any;
      expect(row).toMatchObject({ principalId: a, question: "Keep drinking coffee?", reasoning: "sleep matters", expected: "better sleep in 2 weeks", outcome: null, reviewedAt: null });
      expect(row.options.map((o: any) => [o.label, o.chosen])).toEqual([["Keep", false], ["Stop", true]]);
      expect(row.evidence.map((e: any) => e.label)).toEqual(["[memory] I sleep badly after coffee", "[task] Try decaf", "read an article"]);
      const acts = await db().activity.findMany({ where: { principalId: a, refId: d.id } });
      expect(acts.map((x) => x.type)).toEqual(["DECISION"]);
    });

    it("evidence never upgrades what it references: a client-supplied label is rejected and an INFERENCE memory stays an INFERENCE", async () => {
      const inf = await db().memory.create({ data: { principalId: a, type: "INFERENCE", content: "maybe I like tea", source: "t", status: "UNCONFIRMED", provenance: "INFERRED", confidence: 0.5 } });
      expect((await record(idA(), { evidence: [{ kind: "MEMORY", refId: inf.id, label: "fact: I like tea" }] })).status).toBe("FAILED");
      await okRecord({ evidence: [{ kind: "MEMORY", refId: inf.id }] });
      expect(await db().memory.findUniqueOrThrow({ where: { id: inf.id } })).toMatchObject({ type: "INFERENCE", status: "UNCONFIRMED" });
    });

    it("shape rules: ≥2 options, chosenIndex in range and only with options, notes have no ref, refs have no note", async () => {
      const before = await db().decision.count({ where: { principalId: a } });
      for (const bad of [
        { options: [{ label: "only one" }] },
        { options: [{ label: "x" }, { label: "y" }], chosenIndex: 2 },
        { chosenIndex: 0 },
        { evidence: [{ kind: "NOTE" }] },
        { evidence: [{ kind: "NOTE", note: "n", refId: "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e" }] },
        { evidence: [{ kind: "MEMORY" }] },
        { principalId: b },
        { status: "REVIEWED" },
      ]) expect((await record(idA(), bad)).status, JSON.stringify(bad)).toBe("FAILED");
      expect(await db().decision.count({ where: { principalId: a } })).toBe(before);
    });

    it("cross-principal project/evidence/supersedes are refused by the skill AND the database", async () => {
      const foreignProject = await db().project.create({ data: { principalId: b, name: "B" } });
      const foreignMem = await db().memory.create({ data: { principalId: b, type: "FACT", content: "B secret", source: "t" } });
      const foreignDecision = await okRecord({}, idB());
      for (const params of [{ projectId: foreignProject.id }, { evidence: [{ kind: "MEMORY", refId: foreignMem.id }] }, { supersedesId: foreignDecision.id }]) {
        const r = await record(idA(), params);
        expect(r.status, JSON.stringify(params)).toBe("FAILED");
        expect(r.message).toMatch(/wasn't found/);
        expect(JSON.stringify(r)).not.toContain("B secret");
      }
      const mine = await okRecord();
      await expect(db().decision.create({ data: { principalId: a, title: "t", decision: "d", supersedesId: foreignDecision.id } })).rejects.toThrow(/cross-principal/);
      await expect(db().decisionEvidence.create({ data: { principalId: a, decisionId: mine.id, kind: "MEMORY", refId: foreignMem.id, label: "x" } })).rejects.toThrow(/cross-principal/);
      await expect(db().decisionEvidence.create({ data: { principalId: a, decisionId: foreignDecision.id, kind: "NOTE", label: "x" } })).rejects.toThrow(/cross-principal/);
      await expect(db().decisionOption.create({ data: { principalId: a, decisionId: foreignDecision.id, label: "x" } })).rejects.toThrow(/cross-principal/);
    });
  });

  describe("history is immutable; changing your mind supersedes", () => {
    it("a decision's content can never be edited, even directly in the database", async () => {
      const d = await okRecord({ expected: "e" });
      for (const data of [{ decision: "changed" }, { title: "changed" }, { expected: "changed" }, { context: "changed" }, { reasoning: "changed" }, { decidedAt: new Date() }, { principalId: b }]) {
        await expect(db().decision.update({ where: { id: d.id }, data }), JSON.stringify(data)).rejects.toThrow();
      }
    });

    it("supersession forms a chain; a decision can be superseded once; foreign or missing targets fail", async () => {
      const first = await okRecord();
      const second = await okRecord({ supersedesId: first.id });
      const chain = (await readDecision(idA(), { ...readA, decisionId: first.id })).data as any;
      expect(chain.supersededBy.id).toBe(second.id);
      const again = await record(idA(), { supersedesId: first.id });
      expect(again.status).toBe("FAILED");
      expect(again.message).toMatch(/already been superseded/);
      expect((await record(idA(), { supersedesId: "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e" })).status).toBe("FAILED");
    });

    it("options and evidence are append-only", async () => {
      const d = await okRecord({ options: [{ label: "p" }, { label: "q" }], chosenIndex: 0, evidence: [{ kind: "NOTE", note: "n" }] });
      const o = await db().decisionOption.findFirstOrThrow({ where: { decisionId: d.id } });
      const e = await db().decisionEvidence.findFirstOrThrow({ where: { decisionId: d.id } });
      await expect(db().decisionOption.update({ where: { id: o.id }, data: { label: "z" } })).rejects.toThrow(/append-only/);
      await expect(db().decisionEvidence.update({ where: { id: e.id }, data: { label: "z" } })).rejects.toThrow(/append-only/);
      await expect(db().decisionOption.create({ data: { principalId: a, decisionId: d.id, label: "second chosen", chosen: true } })).rejects.toThrow();
    });
  });

  describe("review (the look-back)", () => {
    it("fills outcome and lesson once; nothing else changes; the second review fails; it is atomic under a race", async () => {
      const d = await okRecord({ expected: "it works" });
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => proposeDecision(idA(), "DECISION_REVIEW", { decisionId: d.id, outcome: `outcome ${i}` })));
      expect(rs.filter((r) => r.status === "EXECUTED")).toHaveLength(1);
      const row = await db().decision.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.reviewedAt).toBeInstanceOf(Date);
      expect(row.expected).toBe("it works");
      const winning = row.outcome;
      const later = await proposeDecision(idA(), "DECISION_REVIEW", { decisionId: d.id, outcome: "rewrite", lesson: "x" });
      expect(later.status).toBe("FAILED");
      expect(later.message).toMatch(/already been reviewed/); // the store answers, not the trigger's generic failure
      await expect(db().decision.update({ where: { id: d.id }, data: { outcome: "direct" } })).rejects.toThrow();
      expect((await db().decision.findUniqueOrThrow({ where: { id: d.id } })).outcome).toBe(winning);
    });

    it("a review needs the owner; a stranger cannot review or read", async () => {
      const d = await okRecord();
      expect((await proposeDecision(idB(), "DECISION_REVIEW", { decisionId: d.id, outcome: "hijack" })).status).toBe("FAILED");
      expect((await readDecision(idB(), { ...readA, decisionId: d.id })).status).toBe("FAILED");
      expect(JSON.stringify((await listDecisionRecords(idB(), readA)).data)).not.toContain(d.id);
      expect((await db().decision.findUniqueOrThrow({ where: { id: d.id } })).reviewedAt).toBeNull();
    });

    it("dueForReview lists only unreviewed decisions whose reviewAt has passed", async () => {
      const due = await okRecord({ reviewAt: new Date(Date.now() - DAY).toISOString() });
      const future = await okRecord({ reviewAt: new Date(Date.now() + DAY).toISOString() });
      const done = await okRecord({ reviewAt: new Date(Date.now() - DAY).toISOString() });
      await proposeDecision(idA(), "DECISION_REVIEW", { decisionId: done.id, outcome: "ok" });
      const ids = ((await listDecisionRecords(idA(), { ...readA, dueForReview: true })).data as { id: string }[]).map((x) => x.id);
      expect(ids).toContain(due.id);
      expect(ids).not.toContain(future.id);
      expect(ids).not.toContain(done.id);
    });
  });

  describe("results", () => {
    it("are append-only, owner-checked per subject kind, and measurements need a value AND a unit", async () => {
      const goal = await db().goal.create({ data: { principalId: a, title: "G" } });
      const project = await db().project.create({ data: { principalId: a, name: "P" } });
      const quest = await db().quest.create({ data: { principalId: a, projectId: project.id, title: "Q", objective: "o", criteria: "c" } });
      const dec = await okRecord();
      for (const [subjectKind, subjectId] of [["GOAL", goal.id], ["PROJECT", project.id], ["QUEST", quest.id], ["DECISION", dec.id]] as const) {
        expect((await life(idA(), "RESULT_RECORD", { subjectKind, subjectId, statement: `result for ${subjectKind}` })).status, subjectKind).toBe("EXECUTED");
        const foreign = await life(idB(), "RESULT_RECORD", { subjectKind, subjectId, statement: "not mine" });
        expect(foreign.status, subjectKind).toBe("FAILED");
        expect(foreign.message).toMatch(/wasn't found/);
      }
      expect((await life(idA(), "RESULT_RECORD", { subjectKind: "GOAL", subjectId: goal.id, statement: "ran", value: 5, unit: "km" })).status).toBe("EXECUTED");
      expect((await life(idA(), "RESULT_RECORD", { subjectKind: "GOAL", subjectId: goal.id, statement: "ran", value: 5 })).status).toBe("FAILED");
      expect((await life(idA(), "RESULT_RECORD", { subjectKind: "GOAL", subjectId: goal.id, statement: "ran", unit: "km" })).status).toBe("FAILED");
      expect((await life(idA(), "RESULT_RECORD", { subjectKind: "TASK", subjectId: goal.id, statement: "x" })).status).toBe("FAILED");
      const rows = (await readResults(idA(), { ...readA, subjectKind: "GOAL", subjectId: goal.id })).data as { id: string }[];
      expect(rows).toHaveLength(2);
      await expect(db().result.update({ where: { id: rows[0].id }, data: { statement: "edited" } })).rejects.toThrow(/append-only/);
      await expect(db().result.create({ data: { principalId: b, subjectKind: "GOAL", subjectId: goal.id, statement: "x" } })).rejects.toThrow(/cross-principal/);
      expect(JSON.stringify((await readResults(idB(), readA)).data)).not.toContain(goal.id);
    });
  });

  describe("reviews", () => {
    it("snapshot plain counts for the period from the owner's own rows, and are immutable", async () => {
      const start = new Date(Date.now() - 7 * DAY);
      const end = new Date(Date.now() + DAY);
      const t = await db().task.create({ data: { principalId: a, title: "done in period", status: "DONE", completedAt: new Date() } });
      await db().task.create({ data: { principalId: a, title: "done long ago", status: "DONE", completedAt: new Date(Date.now() - 30 * DAY) } });
      await db().task.create({ data: { principalId: b, title: "someone else's", status: "DONE", completedAt: new Date() } });
      await okRecord();
      const before = await db().review.count({ where: { principalId: a } });
      const r = await life(idA(), "REVIEW_CREATE", { periodStart: start.toISOString(), periodEnd: end.toISOString(), summary: "A good week", wins: "shipped" });
      expect(r.status, JSON.stringify(r)).toBe("EXECUTED");
      const row = (r.data as { id: string; facts: Record<string, number> });
      const mineDone = await db().task.count({ where: { principalId: a, status: "DONE", completedAt: { gte: start, lt: end } } });
      expect(row.facts.tasksCompleted).toBe(mineDone);
      expect(row.facts.tasksCompleted).toBeGreaterThanOrEqual(1);
      expect(row.facts.decisionsRecorded).toBeGreaterThanOrEqual(1);
      expect(Object.keys(row.facts).sort()).toEqual(["decisionsRecorded", "decisionsReviewed", "goalsAbandoned", "goalsAchieved", "questsCompleted", "resultsRecorded", "tasksCompleted"]);
      expect(JSON.stringify(row.facts)).not.toContain(t.id);
      expect(await db().review.count({ where: { principalId: a } })).toBe(before + 1);
      await expect(db().review.update({ where: { id: row.id }, data: { summary: "edited" } })).rejects.toThrow(/append-only/);
      expect(((await readReviews(idB(), readA)).data as { id: string }[]).map((x) => x.id)).not.toContain(row.id);
      expect(((await readReviews(idA(), readA)).data as { id: string }[]).map((x) => x.id)).toContain(row.id);
    });

    it("periods must be ordered and at most ~3 months; unknown fields (client-supplied facts) are rejected", async () => {
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      for (const p of [
        { periodStart: iso(now), periodEnd: iso(now - DAY), summary: "s" },
        { periodStart: iso(now), periodEnd: iso(now), summary: "s" },
        { periodStart: iso(now - 200 * DAY), periodEnd: iso(now), summary: "s" },
        { periodStart: iso(now - DAY), periodEnd: iso(now), summary: "s", facts: { tasksCompleted: 999 } },
      ]) expect((await life(idA(), "REVIEW_CREATE", p)).status, JSON.stringify(p)).toBe("FAILED");
    });
  });

  describe("interface policy and permissions", () => {
    it("LOW writes are direct on GuideHub/Telegram/API and need approval by voice, creating nothing until approved", async () => {
      for (const s of ["GUIDEHUB", "TELEGRAM", "API"] as const) expect((await record(idA(s), {})).status, s).toBe("EXECUTED");
      const title = `voice-${Math.random()}`;
      expect((await record(idA("VOICE"), { title })).status).toBe("PENDING_APPROVAL");
      expect(await db().decision.count({ where: { principalId: a, title } })).toBe(0);
    });

    it("no grant → denied and nothing created; DENIED row beats everything", async () => {
      const c = (await createPrincipal("Decisions none")).id;
      try {
        expect((await record(identityFor(c), {})).status).toBe("DENIED");
        expect((await proposeDecision(identityFor(c), "DECISION_REVIEW", { decisionId: "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e", outcome: "x" })).status).toBe("DENIED");
        expect((await life(identityFor(c), "REVIEW_CREATE", { periodStart: new Date(Date.now() - DAY).toISOString(), periodEnd: new Date().toISOString(), summary: "s" })).status).toBe("DENIED");
        await grant(c, JARVIS_AGENT_KEY, "system.decisions", "angel:decisions", "DECISION_RECORD", "WRITE", "DENIED");
        expect((await record(identityFor(c), {})).status).toBe("DENIED");
        expect(await db().decision.count({ where: { principalId: c } })).toBe(0);
      } finally { await deletePrincipal(c); }
    });
  });

  it("deleting a memory used as evidence keeps the decision and its snapshot label readable", async () => {
    const mem = await db().memory.create({ data: { principalId: a, type: "FACT", content: "ephemeral fact xqzv", source: "t" } });
    const d = await okRecord({ evidence: [{ kind: "MEMORY", refId: mem.id }] });
    await db().memory.delete({ where: { id: mem.id } });
    const row = (await readDecision(idA(), { ...readA, decisionId: d.id })).data as any;
    expect(row.evidence[0].label).toContain("ephemeral fact xqzv");
  });
});
