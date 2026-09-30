import { getDb } from "../db/client/index.js";
import { LifeNotFoundError, LifeStateError } from "../life/store.js";
import { listEvidence, summarizeEvidence } from "../evidence/store.js";
import { transitionRefusal, type Facts, type Hypothesis } from "./hypothesis.js";

// Learning objectives and personal experiments. Objectives are the owner's intent plus THEIR evidence
// standard; meeting one is the owner's claim, gated on linked supporting evidence. Experiments move only
// through learning/hypothesis.ts, atomically, with an append-only status history. Nothing is scored.

const FUTURE_SLACK_MS = 5 * 60_000;

export async function createObjective(principalId: string, d: { title: string; evidenceStandard: string; topicId?: string; aspirationId?: string }) {
  if (d.topicId && !(await getDb().learningTopic.findFirst({ where: { id: d.topicId, principalId }, select: { id: true } }))) throw new LifeNotFoundError("topic");
  if (d.aspirationId && !(await getDb().aspiration.findFirst({ where: { id: d.aspirationId, principalId }, select: { id: true } }))) throw new LifeNotFoundError("aspiration");
  return getDb().learningObjective.create({ data: { principalId, ...d } });
}

export async function closeObjective(principalId: string, id: string, to: "MET" | "ABANDONED", note?: string) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const o = await tx.learningObjective.findFirst({ where: { id, principalId } });
    if (!o) throw new LifeNotFoundError("objective");
    if (o.status !== "ACTIVE") throw new LifeStateError(`That objective is ${o.status.toLowerCase()} and can't be changed.`);
    if (to === "MET") {
      const supports = await tx.evidenceLink.count({ where: { principalId, subjectKind: "OBJECTIVE", subjectId: id, stance: "SUPPORTS" } });
      if (supports < 1) throw new LifeStateError("Link at least one supporting piece of evidence before marking an objective met.");
    } else if (!note) throw new LifeStateError("Say why the objective is being abandoned.");
    const r = await tx.learningObjective.updateMany({ where: { id, principalId, status: "ACTIVE" }, data: { status: to, closedAt: new Date(), closedNote: note ?? null } });
    if (r.count === 0) throw new LifeStateError("That objective changed; try again.");
    return tx.learningObjective.findFirstOrThrow({ where: { id, principalId } });
  });
}

export async function listObjectives(principalId: string) {
  const rows = await getDb().learningObjective.findMany({ where: { principalId }, orderBy: { createdAt: "desc" }, take: 100 });
  return Promise.all(rows.map(async (o) => ({ ...o, evidence: summarizeEvidence(await listEvidence(principalId, "OBJECTIVE", o.id)) })));
}

export async function createExperiment(principalId: string, d: { hypothesis: string; method: string; objectiveId?: string }) {
  if (d.objectiveId) {
    const o = await getDb().learningObjective.findFirst({ where: { id: d.objectiveId, principalId }, select: { status: true } });
    if (!o) throw new LifeNotFoundError("objective");
    if (o.status !== "ACTIVE") throw new LifeStateError("That objective is closed.");
  }
  return getDb().$transaction(async (tx) => {
    const e = await tx.learningExperiment.create({ data: { principalId, ...d } });
    await tx.experimentStatusChange.create({ data: { principalId, experimentId: e.id, fromStatus: "CANDIDATE", toStatus: "CANDIDATE", note: "proposed" } });
    return e;
  });
}

export async function addObservation(principalId: string, d: { experimentId: string; text: string; observedAt?: Date }, now = new Date()) {
  const e = await getDb().learningExperiment.findFirst({ where: { id: d.experimentId, principalId }, select: { status: true } });
  if (!e) throw new LifeNotFoundError("experiment");
  if (e.status === "CONFIRMED" || e.status === "REJECTED") throw new LifeStateError(`That experiment is ${e.status.toLowerCase()}; its record is closed.`);
  const observedAt = d.observedAt ?? now;
  if (observedAt.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new LifeStateError("An observation can't be from the future.");
  return getDb().experimentObservation.create({ data: { principalId, experimentId: d.experimentId, text: d.text, observedAt } });
}

export async function experimentFacts(principalId: string, id: string): Promise<Facts> {
  const [obs, links] = await Promise.all([
    getDb().experimentObservation.findMany({ where: { principalId, experimentId: id }, select: { observedAt: true } }),
    listEvidence(principalId, "EXPERIMENT", id),
  ]);
  const s = summarizeEvidence(links);
  return { observations: obs.length, observationDays: new Set(obs.map((o) => o.observedAt.toISOString().slice(0, 10))).size, supports: s.supports, contradicts: s.contradicts };
}

export async function transitionExperiment(principalId: string, id: string, to: Hypothesis, note?: string) {
  const db = getDb();
  const e = await db.learningExperiment.findFirst({ where: { id, principalId }, select: { status: true } });
  if (!e) throw new LifeNotFoundError("experiment");
  const refusal = transitionRefusal(e.status, to, await experimentFacts(principalId, id));
  if (refusal) throw new LifeStateError(refusal);
  return db.$transaction(async (tx) => {
    const r = await tx.learningExperiment.updateMany({ where: { id, principalId, status: e.status }, data: { status: to } });
    if (r.count === 0) throw new LifeStateError("That experiment changed; try again.");
    await tx.experimentStatusChange.create({ data: { principalId, experimentId: id, fromStatus: e.status, toStatus: to, note } });
    return tx.learningExperiment.findFirstOrThrow({ where: { id, principalId } });
  });
}

export async function getExperiment(principalId: string, id: string) {
  const db = getDb();
  const e = await db.learningExperiment.findFirst({ where: { id, principalId }, include: { observations: { orderBy: { observedAt: "asc" }, take: 200 }, changes: { orderBy: { createdAt: "asc" }, take: 50 } } });
  if (!e) throw new LifeNotFoundError("experiment");
  const evidence = await listEvidence(principalId, "EXPERIMENT", id);
  // Lessons reference the experiment (sourceRef); they are memories of their own and are only read here.
  const lessons = await db.memory.findMany({ where: { principalId, type: "LESSON", sourceRef: `experiment:${id}`, status: { not: "RETRACTED" } }, orderBy: { createdAt: "asc" }, take: 50, select: { id: true, content: true, createdAt: true, provenance: true } });
  return { ...e, evidence, evidenceSummary: summarizeEvidence(evidence), lessons };
}

export const listExperiments = (principalId: string) => getDb().learningExperiment.findMany({ where: { principalId }, orderBy: { createdAt: "desc" }, take: 100 });

/** A lesson may only be drawn from an experiment that has at least one observation. */
export async function assertLessonSource(principalId: string, experimentId: string) {
  const e = await getExperiment(principalId, experimentId);
  if (e.observations.length < 1) throw new LifeStateError("Record at least one observation before drawing a lesson.");
  return e;
}
