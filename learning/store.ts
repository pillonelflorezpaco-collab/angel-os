import { getDb } from "../db/client/index.js";
import { assertOwned, LifeNotFoundError, LifeStateError } from "../life/store.js";
import { cardState, isDue, summarizeCards, type Grade } from "./schedule.js";

// Learning Lab persistence: principal-scoped, ownership-checked references (and DB triggers),
// atomic conditional transitions, append-only sessions and reviews. Everything shown as "due" or
// "stable" is computed from review history by learning/schedule.ts on read.

const FUTURE_SLACK_MS = 5 * 60_000;
const notFuture = (d: Date, now: Date, what: string) => { if (d.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new LifeStateError(`${what} can't be in the future.`); };

export async function createTopic(principalId: string, d: { title: string; area?: string; intent?: string; goalId?: string }) {
  if (d.goalId) await assertOwned(principalId, "goal", d.goalId);
  return getDb().learningTopic.create({ data: { principalId, ...d } });
}

export async function updateTopic(principalId: string, id: string, d: { title?: string; area?: string | null; intent?: string | null; goalId?: string | null }) {
  if (d.goalId) await assertOwned(principalId, "goal", d.goalId);
  const r = await getDb().learningTopic.updateMany({ where: { id, principalId, status: { not: "COMPLETED" } }, data: d });
  if (r.count === 0) return topicMiss(principalId, id);
  return getDb().learningTopic.findFirstOrThrow({ where: { id, principalId } });
}

// ACTIVE ⇄ PAUSED; ACTIVE|PAUSED → COMPLETED (terminal, the owner's claim).
const TOPIC_FROM = { ACTIVE: ["PAUSED"], PAUSED: ["ACTIVE"], COMPLETED: ["ACTIVE", "PAUSED"] } as const;
export async function setTopicStatus(principalId: string, id: string, to: "ACTIVE" | "PAUSED" | "COMPLETED") {
  const r = await getDb().learningTopic.updateMany({
    where: { id, principalId, status: { in: [...TOPIC_FROM[to]] } },
    data: { status: to, completedAt: to === "COMPLETED" ? new Date() : null },
  });
  if (r.count === 0) return topicMiss(principalId, id, `can't move to ${to.toLowerCase()} from its current status`);
  return getDb().learningTopic.findFirstOrThrow({ where: { id, principalId } });
}

async function topicMiss(principalId: string, id: string, reason?: string): Promise<never> {
  const t = await getDb().learningTopic.findFirst({ where: { id, principalId }, select: { status: true } });
  if (!t) throw new LifeNotFoundError("topic");
  throw new LifeStateError(reason ? `That topic ${reason}.` : `That topic is ${t.status.toLowerCase()} and can't be changed.`);
}

async function activeTopic(principalId: string, id: string) {
  const t = await getDb().learningTopic.findFirst({ where: { id, principalId }, select: { status: true } });
  if (!t) throw new LifeNotFoundError("topic");
  if (t.status !== "ACTIVE") throw new LifeStateError("That topic isn't active.");
}

/** Self-reported and append-only. Nothing derives a streak or reward from it. */
export async function logSession(principalId: string, d: { topicId: string; minutes: number; studiedAt?: Date; note?: string; knowledgeItemId?: string }, now = new Date()) {
  await activeTopic(principalId, d.topicId);
  if (d.knowledgeItemId) await assertOwned(principalId, "knowledge", d.knowledgeItemId);
  const studiedAt = d.studiedAt ?? now;
  notFuture(studiedAt, now, "A study session");
  return getDb().learningSession.create({ data: { principalId, ...d, studiedAt } });
}

export async function createCard(principalId: string, d: { topicId: string; prompt: string; answer: string; knowledgeItemId?: string }) {
  await activeTopic(principalId, d.topicId);
  if (d.knowledgeItemId) await assertOwned(principalId, "knowledge", d.knowledgeItemId);
  return getDb().learningCard.create({ data: { principalId, ...d } });
}

export async function reviewCard(principalId: string, d: { cardId: string; grade: Grade; reviewedAt?: Date }, now = new Date()) {
  const card = await getDb().learningCard.findFirst({ where: { id: d.cardId, principalId }, select: { status: true } });
  if (!card) throw new LifeNotFoundError("card");
  if (card.status !== "ACTIVE") throw new LifeStateError("That card is retired.");
  const reviewedAt = d.reviewedAt ?? now;
  notFuture(reviewedAt, now, "A review");
  await getDb().cardReview.create({ data: { principalId, cardId: d.cardId, grade: d.grade, reviewedAt } });
  return getCard(principalId, d.cardId, now);
}

export async function retireCard(principalId: string, id: string) {
  const r = await getDb().learningCard.updateMany({ where: { id, principalId, status: "ACTIVE" }, data: { status: "RETIRED" } });
  if (r.count === 0) {
    const c = await getDb().learningCard.findFirst({ where: { id, principalId }, select: { id: true } });
    if (!c) throw new LifeNotFoundError("card");
    throw new LifeStateError("That card is already retired.");
  }
  return getDb().learningCard.findFirstOrThrow({ where: { id, principalId } });
}

// ── Reads (derived state) ───────────────────────────────────────────────────
const CAP = 200;

export async function getCard(principalId: string, id: string, now = new Date()) {
  const c = await getDb().learningCard.findFirst({ where: { id, principalId }, include: { reviews: { select: { grade: true, reviewedAt: true }, orderBy: { reviewedAt: "asc" }, take: 1000 } } });
  if (!c) throw new LifeNotFoundError("card");
  const state = cardState(c.createdAt, c.reviews.map((r) => ({ grade: r.grade as Grade, reviewedAt: r.reviewedAt })));
  return { id: c.id, topicId: c.topicId, prompt: c.prompt, answer: c.answer, status: c.status, ...state, due: c.status === "ACTIVE" && isDue(state, now) };
}

/** Active cards that are due now, oldest-due first. Answers are included (the owner is the reader). */
export async function dueCards(principalId: string, now = new Date(), o: { topicId?: string; limit?: number } = {}) {
  const cards = await getDb().learningCard.findMany({
    where: { principalId, status: "ACTIVE", topic: { status: "ACTIVE" }, ...(o.topicId ? { topicId: o.topicId } : {}) },
    include: { reviews: { select: { grade: true, reviewedAt: true }, orderBy: { reviewedAt: "asc" } } },
    take: 1000,
  });
  return cards
    .map((c) => ({ c, s: cardState(c.createdAt, c.reviews.map((r) => ({ grade: r.grade as Grade, reviewedAt: r.reviewedAt }))) }))
    .filter(({ s }) => isDue(s, now))
    .sort((x, y) => x.s.dueAt.getTime() - y.s.dueAt.getTime())
    .slice(0, o.limit ?? 20)
    .map(({ c, s }) => ({ id: c.id, topicId: c.topicId, prompt: c.prompt, answer: c.answer, dueAt: s.dueAt, reviews: s.reviews, lapses: s.lapses, intervalDays: s.intervalDays }));
}

/** Topics with plain, derived counts: minutes studied (self-reported) in the last 7/30 days and card counts. No score. */
export async function learningOverview(principalId: string, now = new Date()) {
  const db = getDb();
  const topics = await db.learningTopic.findMany({ where: { principalId, status: { in: ["ACTIVE", "PAUSED"] } }, orderBy: { createdAt: "asc" }, take: CAP });
  const since30 = new Date(now.getTime() - 30 * 86400000);
  const since7 = new Date(now.getTime() - 7 * 86400000);
  const [sessions, cards] = await Promise.all([
    db.learningSession.findMany({ where: { principalId, topicId: { in: topics.map((t) => t.id) }, studiedAt: { gte: since30, lte: now } }, select: { topicId: true, minutes: true, studiedAt: true } }),
    db.learningCard.findMany({ where: { principalId, status: "ACTIVE", topicId: { in: topics.map((t) => t.id) } }, include: { reviews: { select: { grade: true, reviewedAt: true } } }, take: 2000 }),
  ]);
  return topics.map((t) => {
    const ss = sessions.filter((s) => s.topicId === t.id);
    const states = cards.filter((c) => c.topicId === t.id).map((c) => cardState(c.createdAt, c.reviews.map((r) => ({ grade: r.grade as Grade, reviewedAt: r.reviewedAt }))));
    return {
      id: t.id, title: t.title, status: t.status, area: t.area, intent: t.intent,
      minutesLast7Days: ss.filter((s) => s.studiedAt >= since7).reduce((n, s) => n + s.minutes, 0),
      minutesLast30Days: ss.reduce((n, s) => n + s.minutes, 0),
      ...summarizeCards(states, now),
    };
  });
}
