// FACTUAL BADGES. A badge is a plain statement about what has actually been recorded ("3 decisions have a look-back"), with the exact rule that
// earns it and the count so far. There is no score, no level, no XP, no hidden weighting: every badge is a threshold on a real count, and a
// count of zero is a valid, honest state. Nothing here reads the database (see store.ts) or the clock.

export interface Facts {
  tasksDone: number;
  questsCompleted: number;
  decisionsRecorded: number;
  decisionsReviewed: number;
  learningSessions: number;
  learningMinutes: number;
  observations: number;
  experimentsClosed: number;
  experimentsRejected: number;
  lessons: number;
  experiences: number;
  statesEvidenced: number;
  objectivesMet: number;
  /** Distinct local calendar days with recorded activity, as YYYY-MM-DD. */
  activityDays: string[];
}

export interface Badge { key: string; title: string; statement: string; have: number; need: number; earned: boolean }

const at = (key: string, title: string, statement: string, have: number, need: number): Badge => ({ key, title, statement, have, need, earned: have >= need });

/** Runs of consecutive recorded days. `current` is the run that ends today (or yesterday: it is still alive until the day is over). */
export function streaks(days: string[], today: string): { current: number; longest: number; endsToday: boolean } {
  const set = new Set(days);
  const dayMs = 86_400_000;
  const prev = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - dayMs).toISOString().slice(0, 10);
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let last: string | null = null;
  for (const d of sorted) {
    run = last !== null && prev(d) === last ? run + 1 : 1;
    if (run > longest) longest = run;
    last = d;
  }
  const endsToday = set.has(today);
  let cursor = endsToday ? today : set.has(prev(today)) ? prev(today) : null;
  let current = 0;
  while (cursor && set.has(cursor)) { current += 1; cursor = prev(cursor); }
  return { current, longest, endsToday };
}

export function evaluateBadges(f: Facts, today: string): { badges: Badge[]; streak: ReturnType<typeof streaks> } {
  const s = streaks(f.activityDays, today);
  const badges: Badge[] = [
    at("first-decision", "First decision on record", "1 decision recorded", f.decisionsRecorded, 1),
    at("first-look-back", "First look-back", "1 decision has its look-back (expected vs what happened)", f.decisionsReviewed, 1),
    at("tasks-10", "10 tasks completed", "10 tasks marked done", f.tasksDone, 10),
    at("tasks-50", "50 tasks completed", "50 tasks marked done", f.tasksDone, 50),
    at("first-quest", "First quest completed", "1 quest completed", f.questsCompleted, 1),
    at("sessions-10", "10 study sessions", "10 study sessions logged (self-reported)", f.learningSessions, 10),
    at("study-10h", "10 hours studied", "600 minutes of study sessions logged (self-reported)", f.learningMinutes, 600),
    at("first-observation", "First experiment observation", "1 experiment observation recorded", f.observations, 1),
    at("experiment-closed", "An experiment reached a verdict", "1 experiment confirmed or rejected", f.experimentsClosed, 1),
    at("honest-negative", "A hypothesis was rejected and kept", "1 experiment rejected, its record kept", f.experimentsRejected, 1),
    at("first-evidenced-state", "First evidenced state change", "1 Future Self state recorded with evidence", f.statesEvidenced, 1),
    at("first-lesson", "First lesson", "1 lesson recorded", f.lessons, 1),
    at("experiences-10", "10 experiences recorded", "10 lived experiences recorded", f.experiences, 10),
    at("objective-met", "An objective met with evidence", "1 learning objective marked met", f.objectivesMet, 1),
    at("streak-3", "3 days in a row", "recorded activity on 3 consecutive days (longest run so far)", s.longest, 3),
    at("streak-7", "7 days in a row", "recorded activity on 7 consecutive days (longest run so far)", s.longest, 7),
    at("streak-30", "30 days in a row", "recorded activity on 30 consecutive days (longest run so far)", s.longest, 30),
  ];
  return { badges, streak: s };
}
