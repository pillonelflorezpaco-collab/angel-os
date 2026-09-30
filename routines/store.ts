import { getDb } from "../db/client/index.js";
import { LifeNotFoundError, LifeStateError } from "../life/store.js";
import { buildToday, dayRefusal, localParts, type CheckRow, type RoutineRow } from "./schedule.js";

// Routines persistence: principal-scoped in the same statement, archived is final, check-ins are append-only (one per routine per local day).

export interface RoutineInput { title: string; kind?: "MEAL" | "HABIT" | "BLOCK" | "OTHER"; details?: string; daysOfWeek: number[]; timeOfDay: string; durationMinutes?: number }
const uniq = (d: number[]) => [...new Set(d)].sort((a, b) => a - b);

export const createRoutine = (principalId: string, d: RoutineInput) => getDb().routine.create({ data: { principalId, ...d, daysOfWeek: uniq(d.daysOfWeek) } });

export async function updateRoutine(principalId: string, id: string, d: Partial<Omit<RoutineInput, "details" | "durationMinutes">> & { details?: string | null; durationMinutes?: number | null }) {
  const data = { ...d, ...(d.daysOfWeek ? { daysOfWeek: uniq(d.daysOfWeek) } : {}) };
  const r = await getDb().routine.updateMany({ where: { id, principalId, status: { not: "ARCHIVED" } }, data });
  if (r.count === 0) return miss(principalId, id);
  return getDb().routine.findFirstOrThrow({ where: { id, principalId } });
}

// ACTIVE ⇄ PAUSED; ACTIVE|PAUSED → ARCHIVED (final).
const FROM = { ACTIVE: ["PAUSED"], PAUSED: ["ACTIVE"], ARCHIVED: ["ACTIVE", "PAUSED"] } as const;
export async function setRoutineStatus(principalId: string, id: string, to: "ACTIVE" | "PAUSED" | "ARCHIVED") {
  const r = await getDb().routine.updateMany({ where: { id, principalId, status: { in: [...FROM[to]] } }, data: { status: to } });
  if (r.count === 0) return miss(principalId, id, `can't move to ${to.toLowerCase()} from its current status`);
  return getDb().routine.findFirstOrThrow({ where: { id, principalId } });
}

async function miss(principalId: string, id: string, reason?: string): Promise<never> {
  const row = await getDb().routine.findFirst({ where: { id, principalId }, select: { status: true } });
  if (!row) throw new LifeNotFoundError("routine");
  throw new LifeStateError(reason ? `That routine ${reason}.` : `That routine is ${row.status.toLowerCase()} and can't be changed.`);
}

export async function checkRoutine(principalId: string, d: { routineId: string; status: "DONE" | "SKIPPED"; day?: string; note?: string }, now: Date) {
  const db = getDb();
  const routine = await db.routine.findFirst({ where: { id: d.routineId, principalId }, select: { status: true } });
  if (!routine) throw new LifeNotFoundError("routine");
  if (routine.status === "ARCHIVED") throw new LifeStateError("That routine is archived and can't be changed.");
  const tz = (await db.principal.findUnique({ where: { id: principalId }, select: { timezone: true } }))?.timezone ?? "UTC";
  const today = localParts(now, tz).day;
  const day = d.day ?? today;
  const refusal = dayRefusal(day, today);
  if (refusal) throw new LifeStateError(refusal);
  try { return await db.routineCheck.create({ data: { principalId, routineId: d.routineId, day, status: d.status, note: d.note } }); }
  catch (e) { if ((e as { code?: string }).code === "P2002") throw new LifeStateError("That routine already has a check-in for that day; a check-in isn't edited afterwards."); throw e; }
}

export const listRoutines = (principalId: string) => getDb().routine.findMany({ where: { principalId, status: { not: "ARCHIVED" } }, orderBy: [{ timeOfDay: "asc" }, { title: "asc" }], take: 200 });

/** Today's plan on the owner's clock, with each item's recorded state. */
export async function todayPlan(principalId: string, now: Date) {
  const db = getDb();
  const tz = (await db.principal.findUnique({ where: { id: principalId }, select: { timezone: true } }))?.timezone ?? "UTC";
  const { day } = localParts(now, tz);
  const [routines, checks] = await Promise.all([
    db.routine.findMany({ where: { principalId, status: "ACTIVE" }, take: 200 }),
    db.routineCheck.findMany({ where: { principalId, day }, take: 400 }),
  ]);
  return { timeZone: tz, ...buildToday(routines as RoutineRow[], checks as CheckRow[], now, tz), hasAnyRoutine: routines.length > 0 };
}

export async function countCheckIns(principalId: string) {
  return getDb().routineCheck.count({ where: { principalId, status: "DONE" } });
}
