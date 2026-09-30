import { getDb } from "../db/client/index.js";
import { evaluateBadges, type Facts } from "./badges.js";

// Reads the counts the badges are defined on. Principal-scoped in every query; nothing is written and nothing is derived beyond counting.

function localDay(d: Date, timeZone: string): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone }).format(d); } catch { return d.toISOString().slice(0, 10); }
}

export async function collectFacts(principalId: string, now: Date): Promise<{ facts: Facts; today: string }> {
  const db = getDb();
  const principal = await db.principal.findUnique({ where: { id: principalId }, select: { timezone: true } });
  const tz = principal?.timezone ?? "UTC";
  const since = new Date(now.getTime() - 400 * 86_400_000);
  const [tasksDone, questsCompleted, decisionsRecorded, decisionsReviewed, sessions, observations, closed, rejected, lessons, experiences, statesEvidenced, objectivesMet, routineCheckIns, activity] = await Promise.all([
    db.task.count({ where: { principalId, status: "DONE" } }),
    db.quest.count({ where: { principalId, status: "COMPLETED" } }),
    db.decision.count({ where: { principalId } }),
    db.decision.count({ where: { principalId, reviewedAt: { not: null } } }),
    db.learningSession.aggregate({ where: { principalId }, _count: { _all: true }, _sum: { minutes: true } }),
    db.experimentObservation.count({ where: { principalId } }),
    db.learningExperiment.count({ where: { principalId, status: { in: ["CONFIRMED", "REJECTED"] } } }),
    db.learningExperiment.count({ where: { principalId, status: "REJECTED" } }),
    db.memory.count({ where: { principalId, type: "LESSON", status: { not: "RETRACTED" } } }),
    db.memory.count({ where: { principalId, type: "EXPERIENCE", status: { not: "RETRACTED" } } }),
    db.aspirationState.count({ where: { principalId, basis: "EVIDENCED" } }),
    db.learningObjective.count({ where: { principalId, status: "MET" } }),
    db.routineCheck.count({ where: { principalId, status: "DONE" } }),
    db.activity.findMany({ where: { principalId, occurredAt: { gte: since, lte: now } }, select: { occurredAt: true }, take: 20_000 }),
  ]);
  const activityDays = [...new Set(activity.map((a) => localDay(a.occurredAt, tz)))];
  const facts: Facts = {
    tasksDone, questsCompleted, decisionsRecorded, decisionsReviewed, learningSessions: sessions._count._all, learningMinutes: sessions._sum.minutes ?? 0,
    observations, experimentsClosed: closed, experimentsRejected: rejected, lessons, experiences, statesEvidenced, objectivesMet, routineCheckIns, activityDays,
  };
  return { facts, today: localDay(now, tz) };
}

export async function badgeReport(principalId: string, now: Date) {
  const { facts, today } = await collectFacts(principalId, now);
  const { badges, streak } = evaluateBadges(facts, today);
  const { activityDays: _days, ...counts } = facts;
  return { badges, streak, counts, note: "Every badge is a threshold on a real count. There are no points, levels or hidden scores." };
}

/** Recorded activity for the calendar: only the owner's own events, only the window asked for. */
export async function calendarEvents(principalId: string, now: Date, days: number) {
  const since = new Date(now.getTime() - (days + 2) * 86_400_000);
  const rows = await getDb().activity.findMany({ where: { principalId, occurredAt: { gte: since, lte: now } }, select: { occurredAt: true, type: true }, take: 20_000 });
  const tz = (await getDb().principal.findUnique({ where: { id: principalId }, select: { timezone: true } }))?.timezone ?? "UTC";
  return { events: rows.map((r) => ({ occurredAt: r.occurredAt, type: r.type as string })), timeZone: tz };
}
