import { getDb } from "../db/client/index.js";
import { assertOwned, LifeNotFoundError, LifeStateError, type LifeKind } from "./store.js";

// Decision records, results and reviews (BUILD #13). Same rules as life/store.ts:
// every query is principal-scoped, references are ownership-checked, nothing is inferred.
// A decision's content is immutable history; only the look-back (`outcome`/`lesson`) can be
// filled in, once. Options, evidence, results and reviews are append-only.

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface EvidenceInput { kind: "MEMORY" | "KNOWLEDGE" | "TASK" | "NOTE"; refId?: string; note?: string }
export interface OptionInput { label: string; pros?: string; cons?: string }
export interface DecisionInput {
  title: string;
  decision: string;
  question?: string;
  context?: string;
  reasoning?: string;
  expected?: string;
  reviewAt?: Date;
  projectId?: string;
  supersedesId?: string;
  options?: OptionInput[];
  chosenIndex?: number;
  evidence?: EvidenceInput[];
}

/** The snapshot label comes from the OWNED row itself, never from the caller. */
async function evidenceLabel(principalId: string, e: EvidenceInput): Promise<string> {
  const db = getDb();
  if (e.kind === "NOTE") {
    if (!e.note || e.refId) throw new LifeStateError("A note needs text and no reference.");
    return clip(e.note, 500);
  }
  if (!e.refId || e.note) throw new LifeStateError("Evidence must reference exactly one item.");
  const kind: LifeKind = e.kind === "MEMORY" ? "memory" : e.kind === "KNOWLEDGE" ? "knowledge" : "task";
  await assertOwned(principalId, kind, e.refId);
  if (e.kind === "MEMORY") return `[memory] ${clip((await db.memory.findFirstOrThrow({ where: { id: e.refId, principalId }, select: { content: true, type: true } })).content)}`;
  if (e.kind === "KNOWLEDGE") return `[knowledge] ${clip((await db.knowledgeItem.findFirstOrThrow({ where: { id: e.refId, principalId }, select: { title: true } })).title)}`;
  return `[task] ${clip((await db.task.findFirstOrThrow({ where: { id: e.refId, principalId }, select: { title: true } })).title)}`;
}

export async function recordDecision(principalId: string, d: DecisionInput) {
  if (d.projectId) await assertOwned(principalId, "project", d.projectId);
  if (d.supersedesId) {
    await assertOwned(principalId, "decision", d.supersedesId);
    const taken = await getDb().decision.findFirst({ where: { supersedesId: d.supersedesId, principalId }, select: { id: true } });
    if (taken) throw new LifeStateError("That decision has already been superseded.");
  }
  if (d.options) {
    if (d.options.length < 2) throw new LifeStateError("A decision with options needs at least two.");
    if (d.chosenIndex !== undefined && (d.chosenIndex < 0 || d.chosenIndex >= d.options.length)) throw new LifeStateError("The chosen option is out of range.");
  } else if (d.chosenIndex !== undefined) throw new LifeStateError("chosenIndex needs options.");
  const labels = await Promise.all((d.evidence ?? []).map((e) => evidenceLabel(principalId, e)));
  return getDb().$transaction(async (tx) => {
    const row = await tx.decision.create({
      data: {
        principalId, title: d.title, decision: d.decision, question: d.question, context: d.context, reasoning: d.reasoning,
        expected: d.expected, reviewAt: d.reviewAt, projectId: d.projectId, supersedesId: d.supersedesId,
      },
    });
    for (const [i, o] of (d.options ?? []).entries()) await tx.decisionOption.create({ data: { principalId, decisionId: row.id, label: o.label, pros: o.pros, cons: o.cons, chosen: d.chosenIndex === i } });
    for (const [i, e] of (d.evidence ?? []).entries()) await tx.decisionEvidence.create({ data: { principalId, decisionId: row.id, kind: e.kind, refId: e.refId, label: labels[i] } });
    return row;
  });
}

/** The look-back is set exactly once, atomically. */
export async function reviewDecision(principalId: string, id: string, d: { outcome: string; lesson?: string }) {
  const r = await getDb().decision.updateMany({ where: { id, principalId, reviewedAt: null }, data: { outcome: d.outcome, lesson: d.lesson ?? null, reviewedAt: new Date() } });
  if (r.count === 0) {
    await assertOwned(principalId, "decision", id);
    throw new LifeStateError("That decision has already been reviewed.");
  }
  return getDb().decision.findFirstOrThrow({ where: { id, principalId } });
}

export async function getDecision(principalId: string, id: string) {
  const d = await getDb().decision.findFirst({
    where: { id, principalId },
    include: { options: { orderBy: { createdAt: "asc" } }, evidence: { orderBy: { createdAt: "asc" } }, supersedes: { select: { id: true, title: true } }, supersededBy: { select: { id: true, title: true } } },
  });
  if (!d) throw new LifeNotFoundError("decision");
  return d;
}

export const listDecisions = (principalId: string, o: { dueForReview?: boolean } = {}) =>
  getDb().decision.findMany({
    where: { principalId, ...(o.dueForReview ? { reviewedAt: null, reviewAt: { lte: new Date() } } : {}) },
    orderBy: { decidedAt: "desc" },
    take: 100,
  });

// ── Results ─────────────────────────────────────────────────────────────────
export async function recordResult(principalId: string, r: { subjectKind: "GOAL" | "PROJECT" | "QUEST" | "DECISION"; subjectId: string; statement: string; value?: number; unit?: string }) {
  if ((r.value === undefined) !== (r.unit === undefined)) throw new LifeStateError("A measurement needs both a value and a unit.");
  await assertOwned(principalId, r.subjectKind.toLowerCase() as LifeKind, r.subjectId);
  return getDb().result.create({ data: { principalId, ...r } });
}
export const listResults = (principalId: string, o: { subjectKind?: "GOAL" | "PROJECT" | "QUEST" | "DECISION"; subjectId?: string } = {}) =>
  getDb().result.findMany({ where: { principalId, ...o }, orderBy: { recordedAt: "desc" }, take: 100 });

// ── Reviews ─────────────────────────────────────────────────────────────────
const MAX_PERIOD_MS = 93 * 24 * 3600 * 1000;

/** `facts` are plain counts computed here from the principal's own rows in the period — a snapshot, not a judgement. */
export async function createReview(principalId: string, r: { periodStart: Date; periodEnd: Date; summary: string; wins?: string; lessons?: string; nextSteps?: string }) {
  const { periodStart, periodEnd } = r;
  if (!(periodEnd > periodStart)) throw new LifeStateError("The review period must end after it starts.");
  if (periodEnd.getTime() - periodStart.getTime() > MAX_PERIOD_MS) throw new LifeStateError("A review period can span at most about three months.");
  const db = getDb();
  const within = { gte: periodStart, lt: periodEnd };
  const [tasksCompleted, questsCompleted, goalsAchieved, goalsAbandoned, decisionsRecorded, decisionsReviewed, resultsRecorded] = await Promise.all([
    db.task.count({ where: { principalId, status: "DONE", completedAt: within } }),
    db.quest.count({ where: { principalId, status: "COMPLETED", closedAt: within } }),
    db.goal.count({ where: { principalId, status: "ACHIEVED", closedAt: within } }),
    db.goal.count({ where: { principalId, status: "ABANDONED", closedAt: within } }),
    db.decision.count({ where: { principalId, decidedAt: within } }),
    db.decision.count({ where: { principalId, reviewedAt: within } }),
    db.result.count({ where: { principalId, recordedAt: within } }),
  ]);
  return db.review.create({
    data: { principalId, ...r, facts: { tasksCompleted, questsCompleted, goalsAchieved, goalsAbandoned, decisionsRecorded, decisionsReviewed, resultsRecorded } },
  });
}
export const listReviews = (principalId: string) => getDb().review.findMany({ where: { principalId }, orderBy: { periodEnd: "desc" }, take: 50 });
