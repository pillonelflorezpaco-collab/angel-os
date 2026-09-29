import { describe, it, expect } from "vitest";
import { cardState, isDue, summarizeCards, MIN_EASE, MAX_EASE, type Grade } from "../learning/schedule.js";

const DAY = 24 * 3600 * 1000;
const T0 = new Date(Date.UTC(2026, 0, 1));
const ev = (grades: Grade[], step = DAY) => grades.map((grade, i) => ({ grade, reviewedAt: new Date(T0.getTime() + i * step) }));

describe("learning/schedule: derived, deterministic recall state", () => {
  it("a never-reviewed card is due immediately, with no invented history", () => {
    const s = cardState(T0, []);
    expect(s).toMatchObject({ reviews: 0, lapses: 0, streak: 0, intervalDays: 0, lastReviewedAt: null, ease: 2.5 });
    expect(s.dueAt).toEqual(T0);
    expect(isDue(s, T0)).toBe(true);
  });

  it("good, good, good → 1, 3, then interval × ease (8) days", () => {
    expect(cardState(T0, ev([2])).intervalDays).toBe(1);
    expect(cardState(T0, ev([2, 2])).intervalDays).toBe(3);
    const s = cardState(T0, ev([2, 2, 2]));
    expect(s).toMatchObject({ intervalDays: 8, streak: 3, reviews: 3, lapses: 0, ease: 2.5 });
    expect(s.dueAt).toEqual(new Date(T0.getTime() + 2 * DAY + 8 * DAY));
  });

  it("again is a lapse: back to 1 day, streak reset, ease lowered; the history is kept", () => {
    const s = cardState(T0, ev([2, 2, 0]));
    expect(s).toMatchObject({ intervalDays: 1, streak: 0, lapses: 1, reviews: 3, ease: 2.3 });
  });

  it("hard grows slowly and lowers ease; easy grows faster and raises ease", () => {
    expect(cardState(T0, ev([1]))).toMatchObject({ intervalDays: 1, ease: 2.35 });
    expect(cardState(T0, ev([2, 2, 1])).intervalDays).toBe(4); // round(3 × 1.2)
    expect(cardState(T0, ev([3]))).toMatchObject({ intervalDays: 1, ease: 2.65 });
    expect(cardState(T0, ev([2, 2, 3])).intervalDays).toBeGreaterThan(cardState(T0, ev([2, 2, 2])).intervalDays);
  });

  it("ease stays within its bounds however long the streak of hard/easy grades", () => {
    expect(cardState(T0, ev(Array(30).fill(0) as Grade[])).ease).toBe(MIN_EASE);
    expect(cardState(T0, ev(Array(30).fill(3) as Grade[])).ease).toBe(MAX_EASE);
    expect(cardState(T0, ev(Array(30).fill(1) as Grade[])).ease).toBe(MIN_EASE);
  });

  it("depends only on the events, not on the order they are supplied in", () => {
    const events = ev([2, 3, 0, 2, 2, 1]);
    const forward = cardState(T0, events);
    expect(cardState(T0, [...events].reverse())).toEqual(forward);
    expect(cardState(T0, [events[3], events[0], events[5], events[1], events[4], events[2]])).toEqual(forward);
  });

  it("due is a plain comparison with the injected clock — before, at and after dueAt", () => {
    const s = cardState(T0, ev([2]));
    expect(isDue(s, new Date(s.dueAt.getTime() - 1))).toBe(false);
    expect(isDue(s, s.dueAt)).toBe(true);
    expect(isDue(s, new Date(s.dueAt.getTime() + DAY))).toBe(true);
  });

  it("summaries are counts only; there is no mastery flag", () => {
    const now = new Date(T0.getTime() + 100 * DAY);
    const sum = summarizeCards([cardState(T0, []), cardState(T0, ev([2])), cardState(new Date(now.getTime() + DAY), [])], now);
    expect(sum).toEqual({ cards: 3, due: 2, neverReviewed: 2 });
    expect(Object.keys(cardState(T0, ev([2, 2, 2, 2, 2, 2])))).not.toContain("mastered");
  });
});
