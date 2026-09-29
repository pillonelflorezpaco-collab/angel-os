import { getDb } from "../db/client/index.js";
import { assertOwned, LifeNotFoundError, LifeStateError } from "../life/store.js";
import { aspirationProgress, metricProgress } from "./progress.js";

// Future Self persistence. Principal-scoped in the same statement; references ownership-checked
// here and again by DB triggers; terminal states final. Progress is computed on read (see
// progress.ts) — nothing in this module writes a score.

const opt = async (pid: string, kind: Parameters<typeof assertOwned>[1], id?: string | null) => { if (id) await assertOwned(pid, kind, id); };

export interface AspirationInput { title: string; area?: string; current: string; gap?: string; desired: string; goalId?: string; nextTaskId?: string; nextQuestId?: string }

export async function createAspiration(principalId: string, d: AspirationInput) {
  await opt(principalId, "goal", d.goalId); await opt(principalId, "task", d.nextTaskId); await opt(principalId, "quest", d.nextQuestId);
  return getDb().aspiration.create({ data: { principalId, ...d } });
}

export async function updateAspiration(principalId: string, id: string, d: { current?: string; desired?: string; gap?: string | null; goalId?: string | null; nextTaskId?: string | null; nextQuestId?: string | null }) {
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

export async function createMetric(principalId: string, d: { aspirationId: string; name: string; unit: string; baseline: number; target: number }) {
  if (d.baseline === d.target) throw new LifeStateError("A metric's baseline and target must differ.");
  const a = await getDb().aspiration.findFirst({ where: { id: d.aspirationId, principalId }, select: { status: true } });
  if (!a) throw new LifeNotFoundError("aspiration");
  if (a.status !== "ACTIVE") throw new LifeStateError("That aspiration is closed.");
  return getDb().metric.create({ data: { principalId, ...d } });
}

export async function recordReading(principalId: string, d: { metricId: string; value: number; observedAt?: Date; resultId?: string; note?: string }, now = new Date()) {
  const m = await getDb().metric.findFirst({ where: { id: d.metricId, principalId }, include: { aspiration: { select: { status: true } } } });
  if (!m) throw new LifeNotFoundError("metric");
  if (m.aspiration.status !== "ACTIVE") throw new LifeStateError("That aspiration is closed.");
  const observedAt = d.observedAt ?? now;
  if (observedAt.getTime() > now.getTime() + 5 * 60_000) throw new LifeStateError("A reading can't be from the future.");
  await opt(principalId, "result", d.resultId);
  return getDb().metricReading.create({ data: { principalId, metricId: d.metricId, value: d.value, observedAt, resultId: d.resultId, note: d.note } });
}

type Db = ReturnType<typeof getDb>;
async function withProgress(db: Db, principalId: string, aspirations: { id: string }[]) {
  const ids = aspirations.map((a) => a.id);
  const metrics = await db.metric.findMany({ where: { principalId, aspirationId: { in: ids } }, include: { readings: { orderBy: [{ observedAt: "asc" }, { createdAt: "asc" }], take: 500 } }, orderBy: { createdAt: "asc" } });
  return aspirations.map((a) => {
    const ms = metrics.filter((m) => m.aspirationId === a.id).map((m) => ({
      id: m.id, name: m.name, unit: m.unit, baseline: m.baseline, target: m.target,
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
  return withProgress(db, principalId, rows);
}

export async function getAspiration(principalId: string, id: string) {
  const db = getDb();
  const row = await db.aspiration.findFirst({ where: { id, principalId } });
  if (!row) throw new LifeNotFoundError("aspiration");
  const [withP] = await withProgress(db, principalId, [row]);
  return withP;
}
