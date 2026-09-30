import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { interpretCapture, confirmCapture, cancelCapture } from "../skills/system/capture.js";
import { proposeNamedAction } from "../skills/system/apiActions.js";
import { ScriptedModelProvider, type InterpretInput } from "../capture/provider.js";
import { parseInterpretation } from "../capture/schema.js";
import { buildProposal, proposalHash, NO_REFS } from "../capture/proposal.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";
import { setClock } from "../gateway/clock.js";

process.env.NODE_ENV = "test";
registerSkillActions();

const READS: [string, string, string][] = [
  ["system.tasks", "angel:tasks", "READ"], ["system.life", "angel:life", "LIFE_READ"], ["system.future", "angel:future", "FUTURE_READ"], ["system.learning", "angel:learning", "LEARNING_READ"],
  ["system.decisions", "angel:decisions", "DECISION_READ"], ["system.capture", "angel:capture", "CAPTURE_INTERPRET"], ["system.capture", "angel:capture", "CAPTURE_DECIDE"],
];

describe("capture: model interprets, user confirms, the gateway executes", () => {
  let a: string;
  let b: string;
  const db = () => getDb();
  const idA = (s: "GUIDEHUB" | "VOICE" | "SYSTEM" = "GUIDEHUB") => identityFor(a, s as any);
  const modelOf = (out: unknown) => new ScriptedModelProvider(() => out);
  const interpret = async (out: unknown, text = "some sentence", who = idA()) => {
    const r = await interpretCapture(who, { text, provider: modelOf(out) });
    expect(r.status, JSON.stringify(r)).toBe("EXECUTED");
    return r.data as any;
  };
  const snapshot = async () => ({ mem: await db().memory.count({ where: { principalId: a } }), dec: await db().decision.count({ where: { principalId: a } }), task: await db().task.count({ where: { principalId: a } }), res: await db().result.count({ where: { principalId: a } }), obs: await db().experimentObservation.count({ where: { principalId: a } }), st: await db().aspirationState.count({ where: { principalId: a } }) });
  const ok = async (skill: string, action: string, params: unknown, who = idA()) => { const r = await proposeNamedAction(who, skill, action, params); expect(r.status, JSON.stringify(r)).toBe("EXECUTED"); return r.data as any; };

  beforeAll(async () => {
    a = (await createPrincipal("Capture A")).id;
    b = (await createPrincipal("Capture B")).id;
    for (const p of [a, b]) {
      for (const [s, r, x] of READS) await grant(p, JARVIS_AGENT_KEY, s, r, x, "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
  });
  afterAll(async () => { setClock(null); await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  const SENTENCE = "Today I worked three hours on Angel OS and realized I need to stop adding features and start testing it.";
  const TWO = { candidates: [
    { type: "EXPERIENCE", content: "Worked three hours on Angel OS." },
    { type: "INFERENCE", content: "Real-world testing should take priority over more features.", confidence: 0.95 },
    { type: "NEXT_ACTION", title: "Run the Angel OS real-world validation scenarios" },
  ] };

  it("interpreting saves NOTHING but a draft; the proposal says what it would run and what it understood", async () => {
    const before = await snapshot();
    const p = await interpret(TWO, SENTENCE);
    expect(await snapshot()).toEqual(before);
    expect(p.nothingSaved).toBe(true);
    expect(p.items.map((i: any) => [i.type, i.status, i.wouldRun])).toEqual([["EXPERIENCE", "READY", "system.memory/MEMORY_CREATE"], ["INFERENCE", "READY", "system.memory/MEMORY_CREATE"], ["NEXT_ACTION", "READY", "system.tasks/CREATE_TASK"]]);
    expect(p.understood[1]).toMatch(/not a fact/);
    expect(await db().captureProposal.count({ where: { principalId: a, id: p.proposalId, status: "PENDING" } })).toBe(1);
  });

  it("user confirms → each item runs through the ordinary action path; the inference stays an unconfirmed inference and confidence is not stored as truth", async () => {
    const p = await interpret(TWO, SENTENCE);
    const r = await confirmCapture(idA(), { proposalId: p.proposalId });
    expect(r.status).toBe("EXECUTED");
    const out = (r.data as any).outcomes;
    expect(out.map((o: any) => o.status)).toEqual(["EXECUTED", "EXECUTED", "EXECUTED"]);
    const mems = await db().memory.findMany({ where: { principalId: a, source: "jarvis-capture" } });
    const exp = mems.find((m) => m.type === "EXPERIENCE")!, inf = mems.find((m) => m.type === "INFERENCE")!;
    expect(exp.provenance).toBe("EXPERIENCED");
    expect(inf).toMatchObject({ provenance: "INFERRED", status: "UNCONFIRMED" });
    expect(inf.confidence).toBeLessThan(0.95); // the model's 0.95 was metadata, never stored
    expect(mems.some((m) => m.type === "FACT")).toBe(false);
    expect(await db().task.count({ where: { principalId: a, title: "Run the Angel OS real-world validation scenarios" } })).toBe(1);
    expect(await db().activity.count({ where: { principalId: a, type: "MEMORY_CREATED" } })).toBeGreaterThanOrEqual(2); // the existing definitions wrote their own activity
    const row = await db().captureProposal.findUniqueOrThrow({ where: { id: p.proposalId } });
    expect(row.status).toBe("CONFIRMED");
    expect((row.outcome as any[]).map((o) => o.status)).toEqual(["EXECUTED", "EXECUTED", "EXECUTED"]);
    const audits = await db().auditLog.findMany({ where: { principalId: a, resource: "angel:capture" } });
    expect(audits.length).toBeGreaterThan(1);
    expect(JSON.stringify(audits.map((x) => x.metadata))).not.toContain("Worked three hours"); // content stays out of the audit metadata
  });

  it("single use: a confirmed or cancelled draft cannot run again; rejecting writes nothing", async () => {
    const p = await interpret(TWO);
    const before = await snapshot();
    expect((await cancelCapture(idA(), { proposalId: p.proposalId })).status).toBe("EXECUTED");
    expect((await confirmCapture(idA(), { proposalId: p.proposalId })).status).toBe("FAILED");
    expect(await snapshot()).toEqual(before);
    const q = await interpret(TWO);
    expect((await confirmCapture(idA(), { proposalId: q.proposalId })).status).toBe("EXECUTED");
    const n = await snapshot();
    expect((await confirmCapture(idA(), { proposalId: q.proposalId })).status).toBe("FAILED");
    expect((await cancelCapture(idA(), { proposalId: q.proposalId })).status).toBe("FAILED");
    expect(await snapshot()).toEqual(n);
    // concurrent confirmations: exactly one wins
    const r = await interpret({ candidates: [{ type: "NEXT_ACTION", title: "only once" }] });
    const rs = await Promise.all(Array.from({ length: 4 }, () => confirmCapture(idA(), { proposalId: r.proposalId })));
    expect(rs.filter((x) => x.status === "EXECUTED")).toHaveLength(1);
    expect(await db().task.count({ where: { principalId: a, title: "only once" } })).toBe(1);
  });

  it("the owner may confirm just some items (edit-lite); the rest are not saved", async () => {
    const p = await interpret(TWO);
    const r = await confirmCapture(idA(), { proposalId: p.proposalId, accept: [0] });
    const out = (r.data as any).outcomes;
    expect(out.map((o: any) => o.status)).toEqual(["EXECUTED", "SKIPPED", "SKIPPED"]);
  });

  it("expired drafts cannot be confirmed", async () => {
    const p = await interpret(TWO);
    setClock(() => new Date(Date.now() + 2 * 3600_000));
    expect((await confirmCapture(idA(), { proposalId: p.proposalId })).status).toBe("FAILED");
    setClock(null);
  });

  it("decision: options, chosen option, look-back date and expected outcome map to DECISION_RECORD exactly", async () => {
    const p = await interpret({ candidates: [{ type: "DECISION", title: "Pause features", decision: "I will not start another major feature until I complete ten real-world validation scenarios.", question: "What next?", options: [{ label: "Keep building" }, { label: "Validate first" }], chosenOption: "validate first", reasoning: "Nobody has used it daily.", expectedOutcome: "Real gaps found", lookbackDate: "2027-01-15" }] });
    expect(p.items[0].status).toBe("READY");
    await confirmCapture(idA(), { proposalId: p.proposalId });
    const d = await db().decision.findFirstOrThrow({ where: { principalId: a, title: "Pause features" }, include: { options: true } });
    expect(d).toMatchObject({ question: "What next?", expected: "Real gaps found" });
    expect(d.reviewAt?.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    expect(d.options.find((o: any) => o.chosen)?.label).toBe("Validate first");
  });

  it("decision: a chosen option that isn't one of the options, or has no options, is asked about — never picked", async () => {
    const p = await interpret({ candidates: [
      { type: "DECISION", title: "t1", decision: "d", options: [{ label: "A" }, { label: "B" }], chosenOption: "C" },
      { type: "DECISION", title: "t2", decision: "d", chosenOption: "A" },
    ] });
    expect(p.items.map((i: any) => i.status)).toEqual(["NEEDS_CLARIFICATION", "INVALID"]);
    expect(p.items[0].question.options).toEqual(["A", "B"]);
  });

  it("result: resolves the subject by exact title among the owner's own records; ambiguity and strangers never guess", async () => {
    const goal = await ok("system.life", "GOAL_CREATE", { title: "Validate Angel OS" });
    await ok("system.life", "GOAL_CREATE", { title: "Twin goal" }); await ok("system.life", "GOAL_CREATE", { title: "Twin goal" });
    const bGoal = await ok("system.life", "GOAL_CREATE", { title: "B's private goal" }, identityFor(b, "GUIDEHUB"));
    const p = await interpret({ candidates: [
      { type: "RESULT", statement: "I tested Docker and got the services communicating.", subject: { kind: "GOAL", title: "validate angel os" } },
      { type: "RESULT", statement: "x", subject: { kind: "GOAL", title: "Twin goal" } },
      { type: "RESULT", statement: "y", subject: { kind: "GOAL", title: "B's private goal" } },
      { type: "RESULT", statement: "z", subject: { kind: "GOAL", title: "Nope" }, value: 3 },
    ] });
    expect(p.items.map((i: any) => i.status)).toEqual(["READY", "NEEDS_CLARIFICATION", "NEEDS_CLARIFICATION", "INVALID"]);
    expect(p.items[1].question.question).toMatch(/Which “Twin goal”/);
    expect(JSON.stringify(p)).not.toContain(bGoal.id);
    await confirmCapture(idA(), { proposalId: p.proposalId });
    expect(await db().result.count({ where: { principalId: a, subjectId: goal.id, statement: "I tested Docker and got the services communicating." } })).toBe(1);
    expect(await db().result.count({ where: { principalId: b } })).toBe(0);
  });

  it("lesson and observation: a lesson is a LESSON memory; an observation resolves an open experiment by its hypothesis and never changes its status", async () => {
    const exp = await ok("system.learning", "EXPERIMENT_CREATE", { hypothesis: "Spaced flashcards improve recall", method: "10 cards a day" });
    const p = await interpret({ candidates: [
      { type: "LESSON", content: "Check the volume ownership before blaming the app." },
      { type: "EXPERIMENT_OBSERVATION", experiment: { hypothesis: "spaced flashcards improve recall" }, text: "Recalled 7 of 10 after three days." },
      { type: "EXPERIMENT_OBSERVATION", experiment: { hypothesis: "An experiment that does not exist" }, text: "x" },
    ] });
    expect(p.items.map((i: any) => i.status)).toEqual(["READY", "READY", "NEEDS_CLARIFICATION"]);
    await confirmCapture(idA(), { proposalId: p.proposalId });
    expect(await db().memory.count({ where: { principalId: a, type: "LESSON", content: "Check the volume ownership before blaming the app." } })).toBe(1);
    expect(await db().experimentObservation.count({ where: { experimentId: exp.id } })).toBe(1);
    expect((await db().learningExperiment.findUniqueOrThrow({ where: { id: exp.id } })).status).toBe("CANDIDATE");
  });

  it("future self state: needs evidence; only an EXPERIENCE in the same message counts; inference, lesson and missing evidence are refused; execution links the created memory", async () => {
    const asp = await ok("system.future", "ASPIRATION_CREATE", { title: "Angel OS as a daily system", current: "built, unused", desired: "used daily" });
    const state = (evidenceFrom: number[]) => ({ type: "FUTURE_SELF_STATE", aspiration: { title: "Angel OS as a daily system" }, current: "Architecture exists; not used daily.", gap: "No daily usage data", desired: "Reliable daily system", evidenceFrom });
    const none = await interpret({ candidates: [state([])] });
    expect(none.items[0]).toMatchObject({ status: "UNSUPPORTED" });
    expect(none.items[0].note).toMatch(/must cite evidence/);
    const inf = await interpret({ candidates: [{ type: "INFERENCE", content: "I never use it" }, state([0])] });
    expect(inf.items[1]).toMatchObject({ status: "INVALID" });
    expect(inf.items[1].note).toMatch(/not evidence/);
    const les = await interpret({ candidates: [{ type: "LESSON", content: "l" }, state([0])] });
    expect(les.items[1].status).toBe("INVALID");
    const bad = await interpret({ candidates: [state([5])] });
    expect(bad.items[0].status).toBe("INVALID");
    const good = await interpret({ candidates: [state([1]), { type: "EXPERIENCE", content: "Opened the cockpit twice this week." }] });
    expect(good.items.map((i: any) => i.status)).toEqual(["READY", "READY"]);
    expect(good.items[0].dependsOn).toEqual([1]);
    const r = await confirmCapture(idA(), { proposalId: good.proposalId });
    expect((r.data as any).outcomes.map((o: any) => o.status)).toEqual(["EXECUTED", "EXECUTED"]);
    const link = await db().evidenceLink.findFirstOrThrow({ where: { principalId: a, subjectKind: "ASPIRATION_STATE" }, orderBy: { createdAt: "desc" } });
    const mem = await db().memory.findUniqueOrThrow({ where: { id: link.sourceId } });
    expect(mem).toMatchObject({ type: "EXPERIENCE", content: "Opened the cockpit twice this week." });
    expect(await db().aspiration.findUniqueOrThrow({ where: { id: asp.id } })).toMatchObject({ current: "Architecture exists; not used daily." });
    // if the experience is left out of the confirmation, the dependent state is skipped, not run without its evidence
    const again = await interpret({ candidates: [state([1]), { type: "EXPERIENCE", content: "Another experience" }] });
    const c2 = await confirmCapture(idA(), { proposalId: again.proposalId, accept: [0] });
    expect((c2.data as any).outcomes[0].status).toBe("SKIPPED");
    expect(await db().aspirationState.count({ where: { aspirationId: asp.id } })).toBe(2);
  });

  it("several candidates in one sentence: each is validated alone; one bad candidate does not corrupt another", async () => {
    const p = await interpret({ candidates: [
      { type: "EXPERIENCE", content: "Worked on Angel OS yesterday." },
      { type: "DISCOVERY", content: "unknown type" },
      { type: "FACT", content: "a model may not mint facts" },
      { type: "RESULT", statement: "s", subject: { kind: "GOAL", title: "g" }, principalId: b },
      { type: "DECISION", title: "Fix context first", decision: "Fix context before adding more UI." },
    ] });
    expect(p.items.map((i: any) => i.type)).toEqual(["EXPERIENCE", "DECISION"]);
    expect(p.rejected.map((r: any) => [r.index, r.type])).toEqual([[1, "DISCOVERY"], [2, "FACT"], [3, "RESULT"]]);
    expect(p.rejected[0].reason).toMatch(/isn't something Jarvis can capture/);
    const r = await confirmCapture(idA(), { proposalId: p.proposalId });
    expect((r.data as any).outcomes.map((o: any) => o.status)).toEqual(["EXECUTED", "EXECUTED"]);
  });

  it("ambiguity is asked, never guessed: the model's clarification is surfaced, and nothing runnable is invented", async () => {
    const p = await interpret({ summary: "You said you learned something.", candidates: [], clarifications: [{ question: "Do you mean that you personally tested/experienced this, or that you learned it as general knowledge?", options: ["I tested it myself", "General knowledge"] }] }, "I learned how to configure the Docker networking.");
    expect(p.items).toEqual([]);
    expect(p.clarifications[0].question).toMatch(/personally tested/);
    const r = await confirmCapture(idA(), { proposalId: p.proposalId });
    expect(r.status).toBe("EXECUTED");
    expect((r.data as any).outcomes).toEqual([]); // nothing to run
  });

  it("the model cannot smuggle authority: forged principal, interface, permission, approval, action, table, sql — at the top level (whole output refused) or in a candidate (that candidate refused)", async () => {
    const before = await snapshot();
    for (const extra of [{ principalId: b }, { interfaceSource: "SYSTEM" }, { permissions: ["ALL"] }, { approved: true }, { skipApproval: true }, { actions: [{ skillKey: "system.memory", action: "MEMORY_DELETE" }] }, { table: "principals" }, { sql: "DROP TABLE tasks" }, { tool: "exec" }, { destination: "https://evil.example" }, { risk: "LOW" }]) {
      const p = await interpret({ candidates: [{ type: "NEXT_ACTION", title: "t" }], ...extra });
      expect(p.failClosed, JSON.stringify(extra)).toBeTruthy();
      expect(p.items).toEqual([]);
      const r = await confirmCapture(idA(), { proposalId: p.proposalId });
      expect((r.data as any).outcomes).toEqual([]);
    }
    for (const extra of [{ principalId: b }, { interfaceSource: "SYSTEM" }, { permission: "ALLOWED" }, { risk: "LOW" }, { approvalStatus: "APPROVED" }, { skillKey: "system.memory" }, { action: "MEMORY_DELETE" }, { sql: "x" }, { id: "00000000-0000-0000-0000-000000000000" }, { source: "voice" }]) {
      const p = await interpret({ candidates: [{ type: "NEXT_ACTION", title: "t", ...extra }, { type: "NEXT_ACTION", title: "kept" }] });
      expect(p.rejected, JSON.stringify(extra)).toHaveLength(1);
      expect(p.items.map((i: any) => i.summary)).toEqual(["A next action: kept"]);
    }
    expect(await snapshot()).toEqual(before);
    // and the server-derived parameters carry none of it
    const p = await interpret({ candidates: [{ type: "EXPERIENCE", content: "c", source: "hacker", provenance: "STATED", type2: 1 }] });
    expect(p.rejected).toHaveLength(1);
  });

  it("invalid dates and malformed output fail closed", async () => {
    for (const bad of [{ type: "EXPERIENCE", content: "c", occurredAt: "yesterday" }, { type: "EXPERIENCE", content: "c", occurredAt: "2026-13-45" }, { type: "DECISION", title: "t", decision: "d", lookbackDate: "next week" }, { type: "EXPERIENCE", content: "c", confidence: 7 }, { type: "EXPERIENCE", content: "" }, { type: "EXPERIENCE" }, "just text", null, 5])
      expect(parseInterpretation({ candidates: [bad] }).candidates, JSON.stringify(bad)).toEqual([]);
    for (const raw of ["a string", 42, null, undefined, [], { candidates: "no" }, { candidates: new Array(9).fill({ type: "NEXT_ACTION", title: "t" }) }, { candidates: [], clarifications: new Array(4).fill({ question: "q" }) }])
      expect(parseInterpretation(raw).failClosed, JSON.stringify(raw)).toBeTruthy();
    const p = await interpret("not even an object");
    expect(p.failClosed).toBeTruthy();
    expect(p.items).toEqual([]);
  });

  it("a tampered or foreign draft never runs: hash mismatch, another principal, and an unsupported action are all refused", async () => {
    const p = await interpret({ candidates: [{ type: "NEXT_ACTION", title: "tamper me" }] });
    // another principal can neither confirm nor cancel it (same answer as a missing one)
    const other = identityFor(b, "GUIDEHUB");
    expect((await confirmCapture(other, { proposalId: p.proposalId })).status).toBe("FAILED");
    expect((await cancelCapture(other, { proposalId: p.proposalId })).status).toBe("FAILED");
    // the database refuses to edit a draft's content
    await expect(db().captureProposal.update({ where: { id: p.proposalId }, data: { proposal: {} } })).rejects.toThrow();
    // a proposal that names an action capture doesn't support is never run, even if its hash is valid
    const bad = buildProposal({ candidates: [{ index: 0, candidate: { type: "NEXT_ACTION", title: "x" } }], clarifications: [], rejected: [], summary: null, failClosed: null }, NO_REFS);
    bad.items[0].action = { skillKey: "system.memory", action: "MEMORY_DELETE", parameters: {} };
    const row = await db().captureProposal.create({ data: { principalId: a, interfaceSource: "GUIDEHUB", proposal: bad as any, proposalHash: proposalHash(bad.items), expiresAt: new Date(Date.now() + 60_000) } });
    const r = await confirmCapture(idA(), { proposalId: row.id });
    expect((r.data as any).outcomes[0].status).toBe("SKIPPED");
    // a draft whose hash no longer matches is refused entirely
    const row2 = await db().captureProposal.create({ data: { principalId: a, interfaceSource: "GUIDEHUB", proposal: bad as any, proposalHash: "0".repeat(64), expiresAt: new Date(Date.now() + 60_000) } });
    expect((await confirmCapture(idA(), { proposalId: row2.id })).status).toBe("FAILED");
    expect(await db().memory.count({ where: { principalId: a, content: "x" } })).toBe(0);
  });

  it("exact parameters do not change between proposal and execution; the stored draft is what runs", async () => {
    const p = await interpret({ candidates: [{ type: "DECISION", title: "Exact", decision: "Exactly this." }] });
    const draft = await db().captureProposal.findUniqueOrThrow({ where: { id: p.proposalId } });
    const stored = (draft.proposal as any).items[0].action;
    expect(stored).toEqual({ skillKey: "system.decisions", action: "DECISION_RECORD", parameters: { title: "Exact", decision: "Exactly this." } });
    expect(draft.proposalHash).toBe(proposalHash((draft.proposal as any).items));
    await confirmCapture(idA(), { proposalId: p.proposalId });
    expect(await db().decision.count({ where: { principalId: a, title: "Exact", decision: "Exactly this." } })).toBe(1);
  });

  it("interface policy is unchanged: voice writes still need approval, SYSTEM and unknown interfaces cannot confirm", async () => {
    const p = await interpret({ candidates: [{ type: "NEXT_ACTION", title: "spoken task" }] });
    expect((await confirmCapture(idA("SYSTEM"), { proposalId: p.proposalId })).status).toBe("DENIED");
    expect((await confirmCapture({ ...idA(), interfaceSource: "NOPE" } as any, { proposalId: p.proposalId })).status).not.toBe("EXECUTED");
    const v = await confirmCapture(idA("VOICE"), { proposalId: p.proposalId });
    expect((v.data as any).outcomes[0].status).toBe("PENDING_APPROVAL"); // confirming does not bypass the approval the action needs
    expect(await db().task.count({ where: { principalId: a, title: "spoken task" } })).toBe(0);
    expect((await interpretCapture({ ...idA(), interfaceSource: "NOPE" } as any, { text: "x", provider: modelOf({ candidates: [] }) })).status).not.toBe("EXECUTED");
  });

  it("without the capture permission nothing is interpreted or run; without a domain permission that item is refused by the gateway", async () => {
    const c = (await createPrincipal("No capture")).id;
    try {
      const r = await interpretCapture(identityFor(c, "GUIDEHUB"), { text: "x", provider: modelOf({ candidates: [] }) });
      expect(r.status).toBe("DENIED");
      await grant(c, JARVIS_AGENT_KEY, "system.capture", "angel:capture", "CAPTURE_INTERPRET", "READ");
      await grant(c, JARVIS_AGENT_KEY, "system.capture", "angel:capture", "CAPTURE_DECIDE", "READ");
      const p = (await interpretCapture(identityFor(c, "GUIDEHUB"), { text: "x", provider: modelOf({ candidates: [{ type: "NEXT_ACTION", title: "no task perm" }] }) })).data as any;
      const out = await confirmCapture(identityFor(c, "GUIDEHUB"), { proposalId: p.proposalId });
      expect((out.data as any).outcomes[0].status).toBe("DENIED");
      expect(await db().task.count({ where: { principalId: c } })).toBe(0);
    } finally { await deletePrincipal(c); }
  });

  it("the model receives only the words and a small read-only context of titles — no ids, no principal, no secrets — and its output is untrusted", async () => {
    await ok("system.life", "GOAL_CREATE", { title: "Context goal" });
    const model = new ScriptedModelProvider(() => ({ candidates: [] }));
    await interpretCapture(idA(), { text: "hello", provider: model });
    const seen: InterpretInput = model.seen[0];
    const json = JSON.stringify(seen);
    expect(seen.context.goals).toContain("Context goal");
    expect(json).not.toContain(a);
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(json).not.toMatch(/aos_|Bearer|password|secret|token/i);
    expect(Object.keys(seen).sort()).toEqual(["context", "text"]);
    // a provider that throws or hangs fails safe: nothing saved
    const before = await snapshot();
    const boom = await interpretCapture(idA(), { text: "x", provider: new ScriptedModelProvider(() => { throw new Error("secret stack detail"); }) });
    expect(boom.status).toBe("FAILED");
    expect(boom.message).not.toMatch(/secret stack/);
    expect(await snapshot()).toEqual(before);
    expect((await interpretCapture(idA(), { text: "   ", provider: model })).status).toBe("FAILED");
    expect((await interpretCapture(idA(), { text: "x".repeat(4001), provider: model })).status).toBe("FAILED");
  });

  it("realistic sentences keep their uncertainty (scripted interpretations)", async () => {
    const tested = await interpret({ candidates: [{ type: "EXPERIENCE", content: "Tested the Docker setup; the services communicated." }, { type: "RESULT", statement: "Services communicating.", subject: { kind: "PROJECT", title: "Docker setup" } }] }, "I tested the Docker setup and successfully got the services communicating.");
    expect(tested.items.map((i: any) => i.status)).toEqual(["READY", "NEEDS_CLARIFICATION"]); // no project called that → asked, not invented
    const failed = await interpret({ candidates: [{ type: "EXPERIENCE", content: "The proposed learning method did not improve recall." }, { type: "INFERENCE", content: "The hypothesis is probably wrong." }], clarifications: [{ question: "Should I record the experiment as rejected? That is your call." }] }, "The experiment failed because the proposed learning method did not improve recall.");
    expect(failed.items[1].summary).toMatch(/not a fact/);
    expect(failed.clarifications).toHaveLength(1);
    await confirmCapture(idA(), { proposalId: failed.proposalId });
    expect(await db().learningExperiment.count({ where: { principalId: a, status: "REJECTED" } })).toBe(0); // nothing rejected an experiment on the model's say-so
  });
});
