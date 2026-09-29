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

export async function listEvidence(principalId: string, subjectKind: SubjectKind, subjectId: string) {
  return getDb().evidenceLink.findMany({ where: { principalId, subjectKind, subjectId }, orderBy: { createdAt: "asc" }, take: 200 });
}

export function summarizeEvidence(links: { stance: Stance }[]) {
  return { supports: links.filter((l) => l.stance === "SUPPORTS").length, contradicts: links.filter((l) => l.stance === "CONTRADICTS").length, context: links.filter((l) => l.stance === "CONTEXT").length, total: links.length };
}
