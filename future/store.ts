import { getDb } from "../db/client/index.js";
import { assertOwned, LifeNotFoundError, LifeStateError } from "../life/store.js";
import { aspirationProgress, metricProgress } from "./progress.js";
import { attachEvidenceTx, listEvidence, summarizeEvidence, type EvidenceInput } from "../evidence/store.js";

// Future Self persistence. Principal-scoped in the same statement; references ownership-checked
// here and again by DB triggers; terminal states final. Progress is computed on read (see
// progress.ts) — nothing in this module writes a score.

const opt = async (pid: string, kind: Parameters<typeof assertOwned>[1], id?: string | null) => { if (id) await assertOwned(pid, kind, id); };

export interface AspirationInput { title: string; area?: string; current: string; gap?: string; desired: string; goalId?: string; nextTaskId?: string; nextQuestId?: string }

export async function createAspiration(principalId: string, d: AspirationInput) {
  await opt(principalId, "goal", d.goalId); await opt(principalId, "task", d.nextTaskId); await opt(principalId, "quest", d.nextQuestId);
  // The aspiration and its INITIAL state are one atomic write, so history is complete from the first moment.
  return getDb().$transaction(async (tx) => {
    const a = await tx.aspiration.create({ data: { principalId, ...d } });
    await tx.aspirationState.create({ data: { principalId, aspirationId: a.id, current: d.current, gap: d.gap ?? null, desired: d.desired, basis: "INITIAL" } });
    return a;
  });
}

export interface StateEvidence { sourceKind: EvidenceInput["sourceKind"]; sourceId: string; stance: EvidenceInput["stance"]; note?: string }

/**
 * Record an UPDATED STATE: an immutable snapshot that must cite evidence (at least one link, at least one
 * supporting or contradicting — context alone does not justify a change). The aspiration's mirror is
 * written in the same transaction; the evidence that caused the state stays linked to it forever.
 */
export async function recordState(principalId: string, d: { aspirationId: string; current: string; gap?: string | null; desired: string; note?: string; evidence: StateEvidence[] }) {
  if (!d.evidence.some((e) => e.stance !== "CONTEXT")) throw new LifeStateError("A state change needs at least one piece of supporting or contradicting evidence.");
  return getDb().$transaction(async (tx) => {
    const a = await tx.aspiration.findFirst({ where: { id: d.aspirationId, principalId }, select: { status: true } });
    if (!a) throw new LifeNotFoundError("aspiration");
    if (a.status !== "ACTIVE") throw new LifeStateError("That aspiration is closed and its state can't change.");
    const state = await tx.aspirationState.create({ data: { principalId, aspirationId: d.aspirationId, current: d.current, gap: d.gap ?? null, desired: d.desired, basis: "EVIDENCED", note: d.note } });
    for (const e of d.evidence) await attachEvidenceTx(tx, principalId, { subjectKind: "ASPIRATION_STATE", subjectId: state.id, ...e });
    await tx.aspiration.updateMany({ where: { id: d.aspirationId, principalId, status: "ACTIVE" }, data: { current: d.current, gap: d.gap ?? null, desired: d.desired } });
    return state;
  });
}

/** Timeline of states, each with the evidence that caused it. */
export async function stateTimeline(principalId: string, aspirationId: string) {
  const db = getDb();
  if (!(await db.aspiration.findFirst({ where: { id: aspirationId, principalId }, select: { id: true } }))) throw new LifeNotFoundError("aspiration");
  const states = await db.aspirationState.findMany({ where: { principalId, aspirationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200 });
  return Promise.all(states.map(async (s) => { const ev = await listEvidence(principalId, "ASPIRATION_STATE", s.id); return { ...s, evidence: ev, evidenceSummary: summarizeEvidence(ev) }; }));
}

export async function updateAspiration(principalId: string, id: string, d: { goalId?: string | null; nextTaskId?: string | null; nextQuestId?: string | null }) {
  await opt(principalId, "goal", d.goalId); await opt(principalId, "task", d.nextTaskId); await opt(principalId, "quest", d.nextQuestId);
  const r = await getDb().aspiration.updateMany({ where: { id, principalId, status: "ACTIVE" }, data: d });
  if (r.count === 0) return missOrClosed(principalId, id);
  return getDb().aspiration.findFirstOrThrow({ where: { id, principalId } });
}

/** Closing is the owner's claim (ACHIEVED) or a deliberate release; progress never closes anything. */
export async function closeAspiration(principalId: string, id: string, to: "ACHIEVED" | "RELEASED", note?: string) {
  const r = await getDb().aspiration.updateMany({ where: { id, principalId, status: "ACTIVE" }, data: { status: to, closedAt: new Date(), closedNote: note ?? null } });
  if (r.count === 0) return missOrClosed(principalId, id);
  return getDb().aspiration.findFirstOrThrow({ where: { id, principalId } });
}

async function missOrClosed(principalId: string, id: string): Promise<never> {
  const row = await getDb().aspiration.findFirst({ where: { id, principalId }, select: { status: true } });
  if (!row) throw new LifeNotFoundError("aspiration");
  throw new LifeStateError(`That aspiration is ${row.status.toLowerCase()} and can't be changed.`);
}

export async function createMetric(principalId: string, d: { aspirationId: string; name: string; unit: string; definition: string; baseline: number; target: number }) {
  if (d.baseline === d.target) throw new LifeStateError("A metric's baseline and target must differ.");
  const a = await getDb().aspiration.findFirst({ where: { id: d.aspirationId, principalId }, select: { status: true } });
  if (!a) throw new LifeNotFoundError("aspiration");
  if (a.status !== "ACTIVE") throw new LifeStateError("That aspiration is closed.");
  return getDb().metric.create({ data: { principalId, ...d } });
}

export async function recordReading(principalId: string, d: { metricId: string; value: number; observedAt?: Date; resultId?: string; provenance?: "OWNER_REPORTED" | "MEASURED" | "DERIVED"; note?: string }, now = new Date()) {
  const m = await getDb().metric.findFirst({ where: { id: d.metricId, principalId }, include: { aspiration: { select: { status: true } } } });
  if (!m) throw new LifeNotFoundError("metric");
  if (m.aspiration.status !== "ACTIVE") throw new LifeStateError("That aspiration is closed.");
  const observedAt = d.observedAt ?? now;
  if (observedAt.getTime() > now.getTime() + 5 * 60_000) throw new LifeStateError("A reading can't be from the future.");
  await opt(principalId, "result", d.resultId);
  return getDb().metricReading.create({ data: { principalId, metricId: d.metricId, value: d.value, observedAt, resultId: d.resultId, provenance: d.provenance, note: d.note } });
}

type Db = ReturnType<typeof getDb>;
async function withProgress(db: Db, principalId: string, aspirations: { id: string }[]) {
  const ids = aspirations.map((a) => a.id);
  const metrics = await db.metric.findMany({ where: { principalId, aspirationId: { in: ids } }, include: { readings: { orderBy: [{ observedAt: "asc" }, { createdAt: "asc" }], take: 500 } }, orderBy: { createdAt: "asc" } });
  return aspirations.map((a) => {
    const ms = metrics.filter((m) => m.aspirationId === a.id).map((m) => ({
      id: m.id, name: m.name, unit: m.unit, definition: m.definition, baseline: m.baseline, target: m.target,
      ...metricProgress(m, m.readings),
      evidenced: m.readings.filter((r) => r.resultId).length,
    }));
    return { ...a, metrics: ms, progress: aspirationProgress(ms) };
  });
}

/** Active aspirations with derived, evidence-only progress. */
export async function futureOverview(principalId: string) {
  const db = getDb();
  const rows = await db.aspiration.findMany({ where: { principalId, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 100 });
  const withP = await withProgress(db, principalId, rows);
  const tasks = await db.task.findMany({ where: { principalId, id: { in: rows.flatMap((r) => (r.nextTaskId ? [r.nextTaskId] : [])) } }, select: { id: true, title: true, status: true } });
  const quests = await db.quest.findMany({ where: { principalId, id: { in: rows.flatMap((r) => (r.nextQuestId ? [r.nextQuestId] : [])) } }, select: { id: true, title: true, status: true } });
  return withP.map((a) => { const row = rows.find((r) => r.id === a.id)!; return { ...a, nextTask: tasks.find((t) => t.id === row.nextTaskId) ?? null, nextQuest: quests.find((q) => q.id === row.nextQuestId) ?? null }; });
}

export async function getAspiration(principalId: string, id: string) {
  const db = getDb();
  const row = await db.aspiration.findFirst({ where: { id, principalId } });
  if (!row) throw new LifeNotFoundError("aspiration");
  const [withP] = await withProgress(db, principalId, [row]);
  const [nextTask, nextQuest] = await Promise.all([
    row.nextTaskId ? db.task.findFirst({ where: { id: row.nextTaskId, principalId }, select: { id: true, title: true, status: true } }) : null,
    row.nextQuestId ? db.quest.findFirst({ where: { id: row.nextQuestId, principalId }, select: { id: true, title: true, status: true } }) : null,
  ]);
  return { ...withP, nextTask, nextQuest };
}
