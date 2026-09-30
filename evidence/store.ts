import type { Prisma } from "@prisma/client";
import { getDb } from "../db/client/index.js";
import { LifeNotFoundError, LifeStateError } from "../life/store.js";

// Evidence links: an append-only RELATION saying "this record is evidence about that record".
// The source is never copied or altered. Both ends must belong to the principal (checked here and by the
// evidence_links_guard trigger). Only lived records count as evidence: a memory must be an EXPERIENCE or a
// LESSON (never an inference or a stated fact), and stance is explicit — no link is not a CONTRADICTS.

export type SubjectKind = "ASPIRATION_STATE" | "OBJECTIVE" | "EXPERIMENT";
export type SourceKind = "RESULT" | "DECISION" | "MEMORY" | "TASK" | "QUEST" | "LEARNING_SESSION" | "METRIC_READING" | "OBSERVATION";
export type Stance = "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
export interface EvidenceInput { subjectKind: SubjectKind; subjectId: string; sourceKind: SourceKind; sourceId: string; stance: Stance; note?: string }
type Tx = Prisma.TransactionClient;

async function assertSource(tx: Tx, principalId: string, kind: SourceKind, id: string): Promise<void> {
  const where = { id, principalId };
  const select = { id: true };
  const row =
    kind === "RESULT" ? await tx.result.findFirst({ where, select })
    : kind === "DECISION" ? await tx.decision.findFirst({ where, select })
    : kind === "TASK" ? await tx.task.findFirst({ where, select })
    : kind === "QUEST" ? await tx.quest.findFirst({ where, select })
    : kind === "LEARNING_SESSION" ? await tx.learningSession.findFirst({ where, select })
    : kind === "METRIC_READING" ? await tx.metricReading.findFirst({ where, select })
    : kind === "OBSERVATION" ? await tx.experimentObservation.findFirst({ where, select })
    : await tx.memory.findFirst({ where: { ...where, type: { in: ["EXPERIENCE", "LESSON"] }, status: { not: "RETRACTED" } }, select });
  if (!row) throw new LifeNotFoundError(kind === "MEMORY" ? "experience or lesson" : `${kind.toLowerCase().replace("_", " ")}`);
}

async function assertSubject(tx: Tx, principalId: string, kind: SubjectKind, id: string): Promise<void> {
  const where = { id, principalId };
  const select = { id: true };
  const row =
    kind === "ASPIRATION_STATE" ? await tx.aspirationState.findFirst({ where, select })
    : kind === "OBJECTIVE" ? await tx.learningObjective.findFirst({ where: { ...where, status: "ACTIVE" }, select })
    : await tx.learningExperiment.findFirst({ where: { ...where, status: { notIn: ["CONFIRMED", "REJECTED"] } }, select });
  if (!row) throw new LifeNotFoundError(kind.toLowerCase().replace("_", " "));
}

/** Attach evidence inside an existing transaction (used when a state/objective change needs its evidence atomically). */
export async function attachEvidenceTx(tx: Tx, principalId: string, d: EvidenceInput) {
  await assertSubject(tx, principalId, d.subjectKind, d.subjectId);
  await assertSource(tx, principalId, d.sourceKind, d.sourceId);
  const dup = await tx.evidenceLink.findFirst({ where: { subjectKind: d.subjectKind, subjectId: d.subjectId, sourceKind: d.sourceKind, sourceId: d.sourceId }, select: { id: true } });
  if (dup) throw new LifeStateError("That evidence is already linked; links are never edited — link different evidence.");
  return tx.evidenceLink.create({ data: { principalId, ...d } });
}

export const attachEvidence = (principalId: string, d: EvidenceInput) => getDb().$transaction((tx) => attachEvidenceTx(tx, principalId, d));

const clip = (t: string, n = 200) => (t.length > n ? `${t.slice(0, n)}…` : t);

/**
 * Evidence as the SERVER describes it: each label is read from the owner's own source row at read time, so a
 * user-controlled label can never become evidence. A memory says what type it is (EXPERIENCE/LESSON), and a
 * source that has since been retracted or removed is shown as such rather than dropped.
 */
export async function listEvidence(principalId: string, subjectKind: SubjectKind, subjectId: string) {
  const db = getDb();
  const links = await db.evidenceLink.findMany({ where: { principalId, subjectKind, subjectId }, orderBy: { createdAt: "asc" }, take: 200 });
  const ids = (k: SourceKind) => links.filter((l) => l.sourceKind === k).map((l) => l.sourceId);
  const where = (k: SourceKind) => ({ principalId, id: { in: ids(k) } });
  const [results, decisions, memories, tasks, quests, sessions, readings, observations] = await Promise.all([
    db.result.findMany({ where: where("RESULT"), select: { id: true, statement: true, value: true, unit: true } }),
    db.decision.findMany({ where: where("DECISION"), select: { id: true, title: true } }),
    db.memory.findMany({ where: where("MEMORY"), select: { id: true, content: true, type: true, status: true } }),
    db.task.findMany({ where: where("TASK"), select: { id: true, title: true } }),
    db.quest.findMany({ where: where("QUEST"), select: { id: true, title: true } }),
    db.learningSession.findMany({ where: where("LEARNING_SESSION"), select: { id: true, minutes: true, studiedAt: true } }),
    db.metricReading.findMany({ where: where("METRIC_READING"), select: { id: true, value: true, provenance: true, metric: { select: { name: true, unit: true } } } }),
    db.experimentObservation.findMany({ where: where("OBSERVATION"), select: { id: true, text: true } }),
  ]);
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const R = by(results), D = by(decisions), M = by(memories), T = by(tasks), Q = by(quests), S = by(sessions), G = by(readings), O = by(observations);
  return links.map((l) => {
    let label: string | null = null;
    let memoryType: string | null = null;
    let retracted = false;
    if (l.sourceKind === "RESULT") { const r = R.get(l.sourceId); if (r) label = clip(r.value !== null && r.unit ? `${r.statement} — ${r.value} ${r.unit}` : r.statement); }
    else if (l.sourceKind === "DECISION") label = D.get(l.sourceId)?.title ?? null;
    else if (l.sourceKind === "MEMORY") { const m = M.get(l.sourceId); if (m) { label = clip(m.content); memoryType = m.type; retracted = m.status === "RETRACTED"; } }
    else if (l.sourceKind === "TASK") label = T.get(l.sourceId)?.title ?? null;
    else if (l.sourceKind === "QUEST") label = Q.get(l.sourceId)?.title ?? null;
    else if (l.sourceKind === "LEARNING_SESSION") { const x = S.get(l.sourceId); if (x) label = `${x.minutes} minutes studied on ${x.studiedAt.toISOString().slice(0, 10)}`; }
    else if (l.sourceKind === "METRIC_READING") { const x = G.get(l.sourceId); if (x) label = `${x.metric.name}: ${x.value} ${x.metric.unit} (${x.provenance.toLowerCase().replace("_", " ")})`; }
    else if (l.sourceKind === "OBSERVATION") { const x = O.get(l.sourceId); if (x) label = clip(x.text); }
    return { ...l, label, memoryType, retracted };
  });
}

export function summarizeEvidence(links: { stance: Stance }[]) {
  return { supports: links.filter((l) => l.stance === "SUPPORTS").length, contradicts: links.filter((l) => l.stance === "CONTRADICTS").length, context: links.filter((l) => l.stance === "CONTEXT").length, total: links.length };
}
