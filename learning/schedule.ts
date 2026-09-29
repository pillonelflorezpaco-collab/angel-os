// Pure, deterministic recall scheduling (an SM-2 variant). No database, no clock, no model:
// `now` is always passed in. State is DERIVED from the append-only review history — it is never stored.
//
// grade: 0 again · 1 hard · 2 good · 3 easy (the owner's own assessment).
//   again → back to a 1-day step (a lapse), ease −0.2
//   hard  → interval ×1.2 (min 1 day), ease −0.15
//   good  → 1 day, then 3 days, then interval × ease
//   easy  → as good, ×1.3 on top, ease +0.15
// Ease stays within [1.3, 3.0]. A card never reviewed is due immediately.

export const MIN_EASE = 1.3;
export const MAX_EASE = 3.0;
const DAY = 24 * 3600 * 1000;

export type Grade = 0 | 1 | 2 | 3;
export interface ReviewEvent { grade: Grade; reviewedAt: Date }

export interface CardState {
  reviews: number;
  lapses: number;
  /** Consecutive non-lapse reviews since the last "again". */
  streak: number;
  ease: number;
  intervalDays: number;
  lastReviewedAt: Date | null;
  dueAt: Date;
}

export function cardState(createdAt: Date, history: ReviewEvent[]): CardState {
  const ordered = [...history].sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime());
  let ease = 2.5, interval = 0, streak = 0, lapses = 0;
  for (const r of ordered) {
    if (r.grade === 0) { lapses++; streak = 0; interval = 1; ease = Math.max(MIN_EASE, ease - 0.2); continue; }
    if (r.grade === 1) { interval = Math.max(1, Math.round(interval * 1.2)); ease = Math.max(MIN_EASE, ease - 0.15); }
    else {
      interval = streak === 0 ? 1 : streak === 1 ? 3 : Math.round(interval * ease);
      if (r.grade === 3) { interval = Math.max(interval, Math.round(interval * 1.3)); ease = Math.min(MAX_EASE, ease + 0.15); }
    }
    streak++;
  }
  const last = ordered.length ? ordered[ordered.length - 1].reviewedAt : null;
  return {
    reviews: ordered.length,
    lapses,
    streak,
    ease: Math.round(ease * 100) / 100,
    intervalDays: interval,
    lastReviewedAt: last,
    dueAt: last ? new Date(last.getTime() + interval * DAY) : createdAt,
  };
}

export const isDue = (state: CardState, now: Date): boolean => state.dueAt.getTime() <= now.getTime();

/** Plain, honest summary of a set of cards: counts only, no mastery claim. */
export function summarizeCards(states: CardState[], now: Date): { cards: number; due: number; neverReviewed: number } {
  return { cards: states.length, due: states.filter((s) => isDue(s, now)).length, neverReviewed: states.filter((s) => s.reviews === 0).length };
}
