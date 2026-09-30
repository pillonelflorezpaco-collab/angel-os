import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../../db/client/index.js";
import { JARVIS_AGENT_KEY, JarvisCore, setModelProvider } from "../../core/index.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../../skills/manifest.js";
import { proposeNamedAction } from "../../skills/system/apiActions.js";
import { DeterministicContextEngine } from "../../context/retrieval/index.js";
import { formatContext } from "../../context/format.js";
import type { ModelProvider } from "../../orchestration/types.js";
import type { IdentityContext } from "../../identity/index.js";
import { createPrincipal, deletePrincipal, grant } from "../helpers/fixtures.js";
import { identityFor } from "../helpers/fakeActions.js";
import { record, printMatrix, type Grade, type Stage } from "./matrix.js";

// REAL-WORLD VALIDATION v1. Synthetic, Angel-like data driven the way Angel would actually use the system: natural language through
// Jarvis Core first, structured actions second, then retrieval/context. Two kinds of statements live here:
//   - expect(...)  : an invariant that MUST hold (integrity, security, semantics). A failure is a bug.
//   - record(...)  : an honest grade of one pipeline stage (PASS/PARTIAL/FAIL/NOT IMPLEMENTED) with the reason. Grades are evidence
//                    for the report, not test assertions — a FAIL grade documents a gap; it does not hide it.
process.env.NODE_ENV = "test";
registerSkillActions();

const READS: [string, string, string][] = [
  ["system.tasks", "angel:tasks", "READ"], ["system.memory", "angel:memory", "MEMORY_READ"], ["system.knowledge", "angel:knowledge", "KNOWLEDGE_READ"],
  ["system.life", "angel:life", "LIFE_READ"], ["system.future", "angel:future", "FUTURE_READ"], ["system.learning", "angel:learning", "LEARNING_READ"],
  ["system.decisions", "angel:decisions", "DECISION_READ"], ["system.activity", "angel:activity", "ACTIVITY_READ"],
];

describe("Angel OS real-world validation v1", () => {
  let owner: string;
  let other: string;
  const db = () => getDb();
  const me = (): IdentityContext => identityFor(owner, "GUIDEHUB");
  const jarvis = new JarvisCore();
  const say = (input: string) => jarvis.handle({ principalId: owner, input, identity: me() });
  const act = async (skill: string, action: string, params: unknown, who: IdentityContext = me()) => proposeNamedAction(who, skill, action, params);
  const ok = async (skill: string, action: string, params: unknown, who?: IdentityContext) => {
    const r = await act(skill, action, params, who);
    expect(r.status, `${skill}/${action}: ${JSON.stringify(r)}`).toBe("EXECUTED");
    return r.data as any;
  };
  const ctx = (query: string) => new DeterministicContextEngine().buildContext({ identity: me(), agentKey: JARVIS_AGENT_KEY, query });
  const day = (n: number) => new Date(Date.now() - n * 86_400_000);

  beforeAll(async () => {
    owner = (await createPrincipal("Angel (synthetic)")).id;
    other = (await createPrincipal("Someone else")).id;
    for (const p of [owner, other]) {
      for (const [s, r, a] of READS) await grant(p, JARVIS_AGENT_KEY, s, r, a, "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
    setModelProvider(null);
  });
  afterAll(async () => { setModelProvider(null); printMatrix(); await deletePrincipal(owner); await deletePrincipal(other); await disconnectDb(); });

  // ── 1. DAILY LOG ─────────────────────────────────────────────────────────
  it("S1 daily log: free text through Jarvis, then the structured path", async () => {
    const S = "S1";
    const log = "I worked several hours on Angel OS today, finished the Future Self cockpit, and realized that I should stop adding features for a moment and start testing the system against real life.";
    const r = await say(log);
    record(S, "INPUT→INTERPRETATION", r.status === "FAILED" ? "FAIL" : "PARTIAL", `A free-form daily log is not understood by the deterministic router without a model (status ${r.status}: "${r.message.slice(0, 60)}…"). Only fixed phrases (remember/note, add task, remind me, what happened…) parse.`);
    expect(await db().memory.count({ where: { principalId: owner } })).toBe(0); // nothing invented from text it did not understand
    expect(await db().decision.count({ where: { principalId: owner } })).toBe(0);

    const rem = await say(`remember that ${log}`);
    const stored = await db().memory.findFirst({ where: { principalId: owner } });
    expect(rem.status).toBe("EXECUTED");
    record(S, "INTERPRETATION→STRUCTURED STATE", stored?.type === "FACT" ? "FAIL" : "PASS", `"remember that <lived experience>" is stored as type ${stored?.type} / provenance ${stored?.provenance}. The router has no notion of experience, lesson, decision or next action; every "remember" is a FACT (see core/index.ts memory.remember).`);
    await db().memory.deleteMany({ where: { principalId: owner } });

    // structured path: the same day, each thing in its proper type
    const exp = await ok("system.memory", "MEMORY_CREATE", { type: "EXPERIENCE", content: "Worked several hours on Angel OS and finished the Future Self cockpit.", source: "acceptance", occurredAt: new Date().toISOString() });
    const lesson = await ok("system.memory", "MEMORY_CREATE", { type: "LESSON", content: "I should pause feature work and test Angel OS against real life.", source: "acceptance", derivedFromId: exp.id });
    expect(exp).toMatchObject({ type: "EXPERIENCE", provenance: "EXPERIENCED" });
    expect(lesson).toMatchObject({ type: "LESSON" });
    // it will not let an experience or lesson be relabelled as a fact, or a fact as experienced
    expect((await act("system.memory", "MEMORY_CREATE", { type: "FACT", provenance: "EXPERIENCED", content: "x", source: "acceptance" })).status).toBe("FAILED");
    expect((await act("system.memory", "MEMORY_CREATE", { type: "INFERENCE", provenance: "STATED", content: "x", source: "acceptance" })).status).toBe("FAILED");
    record(S, "STORAGE", "PASS", "EXPERIENCE (EXPERIENCED) and LESSON are separate typed memories; fact/experience/inference relabelling is refused by the schema/provider.");
    const act1 = await db().activity.findMany({ where: { principalId: owner } });
    record(S, "ACTIVITY", act1.length ? "PASS" : "PARTIAL", `Activity events after the two memories: ${act1.map((a) => a.type).join(",") || "none"}.`);
    record(S, "INPUT→ACTION (explicit decision / next action)", "NOT IMPLEMENTED", "The sentence contains a realization but no explicit decision or next action; the system created none (correct). But nothing extracts lesson/decision/next-action from prose — the caller must supply structure.");
  });

  // ── 2. DECISION ──────────────────────────────────────────────────────────
  it("S2 decision: record, immutability, replacement, look-back", async () => {
    const S = "S2";
    const d = await ok("system.decisions", "DECISION_RECORD", {
      title: "Pause new Angel OS features", question: "What should come next?", decision: "I will not start another major Angel OS feature until I complete 10 real-world validation scenarios.",
      reasoning: "Foundations exist; nobody has used them daily.", expected: "Ten scenarios completed and gaps found", reviewAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      options: [{ label: "Keep building features" }, { label: "Validate first", pros: "finds real gaps" }], chosenIndex: 1,
      evidence: [{ kind: "NOTE", note: "Step 5 shipped; no daily usage yet" }],
    });
    const full = await db().decision.findUniqueOrThrow({ where: { id: d.id }, include: { options: true, evidence: true } });
    expect(full.options).toHaveLength(2);
    expect(full.options.filter((o: any) => o.chosen)).toHaveLength(1);
    expect(full.evidence).toHaveLength(1);
    expect(full.expected).toMatch(/Ten scenarios/);
    record(S, "STORAGE", "PASS", "question, options, chosen option, reasoning, expected outcome, look-back date and evidence are stored.");
    const before = { ...full };
    await expect(db().decision.update({ where: { id: d.id }, data: { decision: "changed" } })).rejects.toThrow(); // DB-level immutability
    const review = await ok("system.decisions", "DECISION_REVIEW", { decisionId: d.id, outcome: "Completed 10 scenarios; found 3 P1 gaps.", lesson: "Real usage finds gaps unit tests do not." });
    expect(review.reviewedAt).toBeTruthy();
    expect((await act("system.decisions", "DECISION_REVIEW", { decisionId: d.id, outcome: "again" })).status).toBe("FAILED"); // once
    const after = await db().decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.decision).toBe(before.decision);
    expect(after.expected).toBe(before.expected);
    const r2 = await ok("system.decisions", "DECISION_RECORD", { title: "Validate, then decide", decision: "Validate for two weeks, then decide the next build.", supersedesId: d.id });
    expect((await db().decision.findUniqueOrThrow({ where: { id: d.id } })).decision).toBe(before.decision);
    expect((await act("system.decisions", "DECISION_RECORD", { title: "x", decision: "y", supersedesId: d.id })).status).toBe("FAILED"); // only once
    expect(r2.supersedesId).toBe(d.id);
    record(S, "LEARNING", "PARTIAL", "The look-back stores expected vs actual and a free-text lesson ON the decision row. It is not a LESSON memory, and no next action is created from it — the two are not connected.");
    record(S, "RETRIEVAL", (await say("what did I decide about validation")).status === "EXECUTED" ? "PASS" : "FAIL", "\"what did I decide about <topic>\" works through Jarvis (keyword match on the decision).");
  });

  // ── 3. RESULT ────────────────────────────────────────────────────────────
  it("S3 result: from a completed project/task", async () => {
    const S = "S3";
    const goal = await ok("system.life", "GOAL_CREATE", { title: "Angel OS becomes my daily system", horizon: "LONG" });
    const project = await ok("system.life", "PROJECT_CREATE", { name: "Future Self cockpit", goalId: goal.id });
    const task = await ok("system.tasks", "CREATE_TASK", { title: "Ship the Future Self cockpit", projectId: project.id });
    const done = await act("system.tasks", "TASK_COMPLETE", { taskId: task.id });
    expect(done.status).toBe("EXECUTED");
    const result = await ok("system.life", "RESULT_RECORD", { subjectKind: "PROJECT", subjectId: project.id, statement: "Cockpit screens shipped and browser-tested." });
    expect(await db().result.findUniqueOrThrow({ where: { id: result.id } })).toMatchObject({ subjectKind: "PROJECT", subjectId: project.id, value: null });
    expect((await act("system.life", "RESULT_RECORD", { subjectKind: "TASK", subjectId: task.id, statement: "x" })).status).toBe("FAILED");
    expect((await act("system.life", "RESULT_RECORD", { subjectKind: "PROJECT", subjectId: project.id, statement: "x", progress: 80 })).status).toBe("FAILED");
    record(S, "STORAGE", "PARTIAL", "A result can attach to a GOAL/PROJECT/QUEST/DECISION — not to a TASK. Completing a task records an activity but no result; the task→result link does not exist (P2).");
    // the result can later serve as evidence for learning/future self
    const exp = await ok("system.memory", "MEMORY_CREATE", { type: "EXPERIENCE", content: "Shipping the cockpit felt smooth once the routes were allow-listed.", source: "acceptance" });
    const asp = await ok("system.future", "ASPIRATION_CREATE", { title: "Angel OS as daily system", current: "built, unused", desired: "used daily" });
    await ok("system.future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "cockpit shipped, still unused", desired: "used daily", evidence: [{ sourceKind: "RESULT", sourceId: result.id, stance: "SUPPORTS" }, { sourceKind: "MEMORY", sourceId: exp.id, stance: "CONTEXT" }] });
    record(S, "RESULT→LEARNING", "PASS", "A result and an experience can be linked as evidence to a Future Self state (no score is created).");
  });

  // ── 4. LEARNING ──────────────────────────────────────────────────────────
  it("S4 learning: objective → session → observation → evidence → review → lesson", async () => {
    const S = "S4";
    const topic = await ok("system.learning", "TOPIC_CREATE", { title: "Docker infrastructure administration", intent: "run Angel OS on a VPS" });
    const obj = await ok("system.learning", "OBJECTIVE_CREATE", { title: "Deploy a two-container stack from scratch", evidenceStandard: "A stack I built without copying a guide, running after a reboot", topicId: topic.id });
    const session = await ok("system.learning", "SESSION_LOG", { topicId: topic.id, minutes: 90, note: "compose networks and volumes" });
    const exp = await ok("system.learning", "EXPERIMENT_CREATE", { hypothesis: "Writing the compose file myself teaches more than following a guide", method: "Build from docs only; note every lookup", objectiveId: obj.id });
    const o1 = await ok("system.learning", "EXPERIMENT_OBSERVE", { experimentId: exp.id, text: "Needed 6 lookups for volumes, 0 for networks the second time.", observedAt: day(2).toISOString() });
    await ok("system.future", "EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: exp.id, sourceKind: "OBSERVATION", sourceId: o1.id, stance: "SUPPORTS" });
    await ok("system.future", "EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: exp.id, sourceKind: "LEARNING_SESSION", sourceId: session.id, stance: "CONTEXT" });
    await ok("system.learning", "EXPERIMENT_TRANSITION", { experimentId: exp.id, to: "OBSERVED", note: "first week" });
    await ok("system.learning", "EXPERIMENT_TRANSITION", { experimentId: exp.id, to: "SUPPORTED" });
    expect((await act("system.learning", "EXPERIMENT_TRANSITION", { experimentId: exp.id, to: "CONFIRMED" })).status).toBe("FAILED"); // one observation is not confirmation
    // the objective cannot be "met" merely because a session happened
    expect((await act("system.learning", "OBJECTIVE_CLOSE", { objectiveId: obj.id, outcome: "MET" })).status).toBe("FAILED");
    await ok("system.future", "EVIDENCE_ATTACH", { subjectKind: "OBJECTIVE", subjectId: obj.id, sourceKind: "OBSERVATION", sourceId: o1.id, stance: "SUPPORTS" });
    await ok("system.learning", "OBJECTIVE_CLOSE", { objectiveId: obj.id, outcome: "MET" });
    const lesson = await ok("system.learning", "LESSON_RECORD", { experimentId: exp.id, content: "For me, building from docs stuck better than copying — in this first week." });
    expect(lesson).toMatchObject({ type: "LESSON", sourceRef: `experiment:${exp.id}` });
    record(S, "STORAGE→LEARNING", "PASS", "objective, method, session, observation, evidence links, review transitions and lesson are all stored; a session alone never advances an objective or experiment; confirmation needs repeated observation.");
    record(S, "INPUT→INTERPRETATION", "NOT IMPLEMENTED", "\"I learned X\" / \"I studied docker for 90 minutes\" are not understood by Jarvis without a model; the flow works through structured actions / the cockpit only.");
    record(S, "PARTIAL: objective↔session", "PARTIAL", "A session cannot name the objective it served (SESSION_LOG has no objectiveId); the link is only through the topic.");
  });

  // ── 5. FUTURE SELF ───────────────────────────────────────────────────────
  it("S5 future self: evidence required, typed, no scores", async () => {
    const S = "S5";
    const asp = await ok("system.future", "ASPIRATION_CREATE", { title: "Angel OS is my daily personal OS", current: "Angel OS exists but is not yet used daily.", gap: "No sustained real-world usage data.", desired: "Angel OS is a reliable daily personal operating system." });
    const task = await ok("system.tasks", "CREATE_TASK", { title: "Run 10 acceptance scenarios" });
    await ok("system.future", "ASPIRATION_UPDATE", { aspirationId: asp.id, nextTaskId: task.id });
    expect((await act("system.future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "used twice", desired: "daily", evidence: [] })).status).toBe("FAILED");
    const fact = await ok("system.memory", "MEMORY_CREATE", { type: "FACT", content: "Angel OS has 850 tests", source: "acceptance" });
    const inf = await ok("system.memory", "MEMORY_CREATE", { type: "INFERENCE", content: "I probably work best in the evening", source: "acceptance", confidence: 0.4 });
    for (const m of [fact, inf]) expect((await act("system.future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "x", desired: "y", evidence: [{ sourceKind: "MEMORY", sourceId: m.id, stance: "SUPPORTS" }] })).status).toBe("FAILED");
    const lived = await ok("system.memory", "MEMORY_CREATE", { type: "EXPERIENCE", content: "Ran scenarios 1–3 against the real API today.", source: "acceptance" });
    await ok("system.future", "ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "Angel OS is being tested against real usage scenarios but not used daily", gap: "Only 3 of 10 scenarios done", desired: "reliable daily system", evidence: [{ sourceKind: "MEMORY", sourceId: lived.id, stance: "SUPPORTS" }] });
    const ov = (await (await import("../../skills/system/future.js")).readFutureOverview(me(), { agentKey: JARVIS_AGENT_KEY })).data as any[];
    const a = ov.find((x) => x.id === asp.id);
    expect(a.nextTask.title).toBe("Run 10 acceptance scenarios");
    expect(a.progress).toBeNull(); // no metric readings → no figure
    expect(JSON.stringify(a)).not.toMatch(/xp|level|score/i);
    record(S, "STORAGE", "PASS", "current/desired/gap/next action stored; state change refused without evidence; fact and inference refused as evidence; lived experience accepted; progress is null (no invented figure).");
    record(S, "ACTION", "PASS", "next action is a real task link, shown by name.");
  });

  // ── 6. MEMORY RETRIEVAL ──────────────────────────────────────────────────
  it("S6 memory retrieval: types stay visible, only relevant records return, ownership holds", async () => {
    const S = "S6";
    await ok("system.memory", "MEMORY_CREATE", { type: "FACT", content: "My VPS runs Ubuntu 24.04 with Docker", source: "acceptance" });
    await ok("system.memory", "MEMORY_CREATE", { type: "INFERENCE", content: "Docker networking is probably my weakest infrastructure area", source: "acceptance", confidence: 0.4 });
    await ok("system.memory", "MEMORY_CREATE", { type: "EXPERIENCE", content: "I debugged a Docker volume permission problem for two hours", source: "acceptance" });
    await ok("system.memory", "MEMORY_CREATE", { type: "LESSON", content: "Check Docker volume ownership before blaming the app", source: "acceptance" });
    await ok("system.memory", "MEMORY_CREATE", { type: "FACT", content: "Angel prefers Spanish for personal notes", source: "acceptance" });
    await ok("system.memory", "MEMORY_CREATE", { type: "EXPERIENCE", content: "Took a long walk on Sunday", source: "acceptance" }, undefined);
    await act("system.memory", "MEMORY_CREATE", { type: "FACT", content: "SECRET Docker fact of somebody else", source: "acceptance" }, identityFor(other, "GUIDEHUB"));
    const r = await say("what do I know about docker");
    expect(r.status).toBe("EXECUTED");
    const msg = r.message;
    expect(msg).not.toMatch(/SECRET|walk|Spanish/); // irrelevant and foreign records are not returned
    expect(msg.toLowerCase()).toContain("volume permission");
    const types = (r.data as any[]).map((m) => m.type).sort();
    expect(types).toEqual(["EXPERIENCE", "FACT", "INFERENCE", "LESSON"]);
    const inferenceLine = msg.split("\n").find((l) => /weakest/.test(l))!;
    expect(inferenceLine).toMatch(/think|infer|unconfirmed|guess/i);
    expect(inferenceLine).not.toMatch(/^fact/i);
    record(S, "RETRIEVAL", "PASS", "keyword retrieval returns the four relevant typed records, excludes irrelevant and foreign ones, and prints the inference as an unconfirmed guess.");
    record(S, "RETRIEVAL (semantic)", "PARTIAL", "Retrieval is term overlap: a question worded differently from the stored text (\"containers\" vs \"Docker\") will miss. No embeddings by design; this is the honest limit of the current engine.");
  });

  // ── 7. CONTEXT RECONSTRUCTION ────────────────────────────────────────────
  it("S7 context reconstruction: 'what have I actually done toward my desired future self?'", async () => {
    const S = "S7";
    const q = "What have I actually done recently toward becoming my desired future self?";
    const c = await ctx(q);
    const text = formatContext(c);
    const r = await say(`brief me on future self`);
    record(S, "CONTEXT", c.activeAspirations!.length && (c.recentActivity?.length ?? 0) ? "PARTIAL" : "FAIL",
      `Terms extracted from the question: [${(c.terms ?? []).join(", ")}]. Aspirations included: ${c.activeAspirations?.length}. Recent activity items: ${c.recentActivity?.length}. Memories matched: ${c.relevantMemories.length}. Decisions matched: ${c.relevantDecisions?.length}.`);
    const sections = ["activeAspirations", "recentActivity", "activeGoals", "activeProjects", "activeLearning", "relevantMemories", "relevantDecisions"];
    expect(sections.every((s) => s in c)).toBe(true);
    // not in context at all today:
    for (const k of ["experiments", "objectives", "evidence", "lessons", "results", "stateHistory"]) expect(k in c).toBe(false);
    record(S, "CONTEXT (coverage)", "PARTIAL", "Context has NO experiments, objectives, evidence links, results, lessons-as-such or state history; an aspiration appears only as its current/desired text. It cannot show WHAT was done toward the gap, only recent activity summaries (max 5) and keyword-matched records.");
    expect(text).not.toMatch(/\d+\s?%\s*(complete|done)|score|\blevel\b|\bxp\b/i);
    expect(r.status).toBe("EXECUTED");
    // ownership: other principal's context holds none of this owner's aspirations
    const oc = await new DeterministicContextEngine().buildContext({ identity: identityFor(other, "GUIDEHUB"), agentKey: JARVIS_AGENT_KEY, query: q });
    expect(JSON.stringify(oc)).not.toMatch(/Angel OS is my daily personal OS|Future Self cockpit/);
    // an aspiration whose state carries evidence must never be described as having "no evidence"
    expect(text).not.toMatch(/no evidence yet/i);
    expect(text).toMatch(/no measured readings yet/);
    record(S, "CONTEXT (ownership)", "PASS", "another principal's context contains none of the owner's records.");
  });

  // ── 8. DECISION → ACTION → RESULT → REVIEW → LESSON ──────────────────────
  it("S8 causal chain preserved; the lesson does not rewrite the decision", async () => {
    const S = "S8";
    const d = await ok("system.decisions", "DECISION_RECORD", { title: "Use an allow-list proxy for the cockpit", decision: "The cockpit only reaches explicitly listed routes.", expected: "No accidental exposure", reviewAt: day(-1).toISOString() });
    const task = await ok("system.tasks", "CREATE_TASK", { title: "Implement the allow-list proxy" });
    await act("system.tasks", "TASK_COMPLETE", { taskId: task.id });
    const res = await ok("system.life", "RESULT_RECORD", { subjectKind: "DECISION", subjectId: d.id, statement: "Proxy shipped; 25 rules; probes pass" });
    const rev = await ok("system.decisions", "DECISION_REVIEW", { decisionId: d.id, outcome: "No exposure found in probes.", lesson: "Default-deny made review easy." });
    const lesson = await ok("system.memory", "MEMORY_CREATE", { type: "LESSON", content: "Default-deny allow-lists make security review cheap.", source: "acceptance", sourceRef: `decision:${d.id}`, derivedFromId: undefined });
    const row = await db().decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.decision).toBe("The cockpit only reaches explicitly listed routes.");
    expect(row.lesson).toBe("Default-deny made review easy.");
    expect(res.subjectId).toBe(d.id);
    expect(rev.id).toBe(d.id);
    expect(lesson.sourceRef).toBe(`decision:${d.id}`);
    record(S, "CAUSAL CHAIN", "PARTIAL", "Decision→result (subject link) and decision→review are linked in the database. The ACTION (task) is NOT linked to the decision, and the LESSON memory links only by a free-text sourceRef — there is no relational decision↔task or decision↔lesson edge. The chain is reconstructable by a human, not queryable.");
  });

  // ── 9. FAILURE / NEGATIVE RESULT ─────────────────────────────────────────
  it("S9 failure is a first-class, retained outcome", async () => {
    const S = "S9";
    const e = await ok("system.learning", "EXPERIMENT_CREATE", { hypothesis: "Studying at 11pm works as well as mornings", method: "A week of late-night sessions" });
    const o = await ok("system.learning", "EXPERIMENT_OBSERVE", { experimentId: e.id, text: "Recall was poor on 4 of 5 late nights." });
    await ok("system.future", "EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: e.id, sourceKind: "OBSERVATION", sourceId: o.id, stance: "CONTRADICTS" });
    expect((await act("system.learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "CONFIRMED" })).status).toBe("FAILED");
    const rej = await ok("system.learning", "EXPERIMENT_TRANSITION", { experimentId: e.id, to: "REJECTED", note: "did not hold up for me" });
    expect(rej.status).toBe("REJECTED");
    const lesson = await ok("system.learning", "LESSON_RECORD", { experimentId: e.id, content: "Late-night study did not work for me in this test." });
    const nextTask = await ok("system.tasks", "CREATE_TASK", { title: "Move study block to 7am" });
    expect(await db().learningExperiment.count({ where: { id: e.id, status: "REJECTED" } })).toBe(1);
    expect((await act("system.learning", "EXPERIMENT_OBSERVE", { experimentId: e.id, text: "rewrite history" })).status).toBe("FAILED");
    expect(lesson.type).toBe("LESSON");
    expect(nextTask.title).toContain("7am");
    // a failed project is representable as an abandoned quest/goal with a reason, plus a result
    const goal = await ok("system.life", "GOAL_CREATE", { title: "Automate gmail triage (scrapped)" });
    await ok("system.life", "GOAL_ABANDON", { goalId: goal.id, reason: "Out of scope; not worth the risk" });
    await ok("system.life", "RESULT_RECORD", { subjectKind: "GOAL", subjectId: goal.id, statement: "Abandoned after a week; nothing shipped." });
    record(S, "STORAGE", "PASS", "rejected hypothesis (with contradicting evidence), retained observations, a lesson, an abandoned goal with reason and a negative result are all representable and immutable; failure is not missing data.");
    record(S, "LESSON→NEXT ACTION", "PARTIAL", "A lesson does not create or link a next action; the follow-up task is a separate, unlinked write.");
  });

  // ── 10. WHAT HAPPENED? ───────────────────────────────────────────────────
  it("S10 'what happened this week' and 'what matters for next week'", async () => {
    const S = "S10";
    const week = await say("what happened this week");
    expect(week.status).toBe("EXECUTED");
    record(S, "WEEKLY SUMMARY", "PARTIAL", `activity.week returns: "${week.message.slice(0, 200).replace(/\n/g, " | ")}". It summarizes ACTIVITY events (counts by type). Decisions recorded, experiments observed/rejected, lessons and results appear only if an activity event was written for them.`);
    const act7 = await db().activity.findMany({ where: { principalId: owner }, select: { type: true } });
    const types = [...new Set(act7.map((a) => a.type))].sort();
    record(S, "ACTIVITY COVERAGE", types.includes("DECISION") ? "PARTIAL" : "FAIL", `Activity types present after the week: ${types.join(", ") || "none"}. Not present: ${(["DECISION", "TASK_COMPLETED", "MEMORY_CREATED", "LEARNING_SESSION", "ACHIEVEMENT", "GOAL_PROGRESS"] as string[]).filter((t) => !(types as string[]).includes(t)).join(", ") || "none"}. Experiment observations, experiment status changes, lessons, results and state records produce no activity.`);
    const next = await say("what matters for next week");
    expect(next.status).toBe("FAILED"); // not understood — and, importantly, not fabricated
    expect(next.message).not.toMatch(/priorit/i);
    record(S, "NEXT-WEEK PRIORITIES", "NOT IMPLEMENTED", "\"What matters next week / today\" is not understood. The raw ingredients exist (open tasks, aspirations' next task, decisions due for review, experiments not yet closed) but nothing assembles them, so nothing is fabricated either.");
    const c = await ctx("what matters next week");
    record(S, "OPEN LOOPS", "PARTIAL", `Context exposes open tasks (${c.currentTasks.length}) and active goals/projects, but not decisions due for review, open experiments/objectives, or aspirations' next actions as open loops.`);
  });

  // ── Cross-cutting: orchestration with a model, security, identity ────────
  it("ORCH: a scripted model can reach every domain — only by proposing registered actions, under the same permission/approval rules", async () => {
    const script: ModelProvider = { name: "scripted", async propose(input) {
      if (/log:/.test(input.userText)) return { reply: "Logged.", proposals: [
        { skillKey: "system.memory", action: "MEMORY_CREATE", parameters: { type: "EXPERIENCE", content: "Wrote the acceptance pack.", source: "model" } },
        { skillKey: "system.decisions", action: "DECISION_RECORD", parameters: { title: "Stop features", decision: "Validate first." } },
        { skillKey: "system.decisions", action: "DECISION_UPDATE", parameters: {} },
        { skillKey: "system.memory", action: "MEMORY_CREATE", parameters: { type: "FACT", content: "x", source: "m", principalId: other } },
      ] };
      return { proposals: [] };
    } };
    setModelProvider(script);
    const r = await say("log: I wrote the acceptance pack and decided to validate first");
    setModelProvider(null);
    expect(r.message).toMatch(/✓/);
    expect(r.message).toMatch(/✗/); // unknown action and forged principal are rejected
    expect(await db().memory.count({ where: { principalId: other, content: "x" } })).toBe(0);
    expect(await db().memory.count({ where: { principalId: owner, content: "Wrote the acceptance pack." } })).toBe(1);
    record("ORCH", "INTERPRETATION (with a model)", "PARTIAL", "With a ModelProvider, free text can become EXPERIENCE/DECISION writes through the ordinary gateway path (unknown actions and forged principals are rejected, outcomes are written by the OS). BUT no real model adapter exists: without one (the current default) none of this is reachable from natural language. Tested here with a scripted stand-in only.");
    // voice needs approval for the same LOW write
    const v = await act("system.memory", "MEMORY_CREATE", { type: "EXPERIENCE", content: "spoken", source: "voice" }, identityFor(owner, "VOICE"));
    expect(v.status).toBe("PENDING_APPROVAL");
  });

  it("SEC: no cross-principal read or write through any acceptance path", async () => {
    const exp = await db().learningExperiment.findFirst({ where: { principalId: owner } });
    const oid = identityFor(other, "GUIDEHUB");
    expect((await act("system.learning", "EXPERIMENT_OBSERVE", { experimentId: exp!.id, text: "intruder" }, oid)).status).toBe("FAILED");
    expect((await act("system.learning", "EXPERIMENT_CREATE", { hypothesis: "h", method: "m", principalId: owner }, oid)).status).toBe("FAILED");
    const theirs = await say("what do I know about docker");
    expect(theirs.message).not.toMatch(/somebody else/);
    const r = await jarvis.handle({ principalId: other, input: "what did I decide about validation", identity: me() });
    expect(r.status).toBe("FAILED"); // two principals in one request is refused
    record("SEC", "IDENTITY", "PASS", "forged principal fields are rejected by strict schemas; mismatched request/identity principals are refused; foreign records never surface.");
  });
});
