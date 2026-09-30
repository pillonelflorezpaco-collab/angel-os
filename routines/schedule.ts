// ROUTINES (pure): the owner's own plan for recurring parts of the day, placed on today's clock. No reads, no writes, no clock of its own.
// Nothing here invents a plan: an item exists only because the owner defined it. A time that has passed without a check-in is "not recorded
// yet", never "failed" — the absence of a record is not a verdict.

export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const DAY_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const BACKFILL_DAYS = 7;

export interface LocalParts { day: string; weekday: number; minutes: number }

/** The owner's local calendar day, weekday (0 = Sunday) and minutes since midnight at `now`. An unknown time zone falls back to UTC. */
export function localParts(now: Date, timeZone: string): LocalParts {
  const format = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try { parts = format(timeZone); } catch { parts = format("UTC"); }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day: `${get("year")}-${get("month")}-${get("day")}`, weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export interface RoutineRow { id: string; title: string; kind: string; details: string | null; daysOfWeek: number[]; timeOfDay: string; durationMinutes: number | null; status: string }
export interface CheckRow { routineId: string; day: string; status: "DONE" | "SKIPPED"; note?: string | null }
export type ItemState = "DONE" | "SKIPPED" | "PAST_UNRECORDED" | "UPCOMING";
export interface TodayItem { routineId: string; title: string; kind: string; details: string | null; time: string; durationMinutes: number | null; state: ItemState; minutesUntil: number | null; checkNote: string | null }

export function buildToday(routines: RoutineRow[], checks: CheckRow[], now: Date, timeZone: string): { day: string; weekday: string; items: TodayItem[]; next: TodayItem | null } {
  const at = localParts(now, timeZone);
  const items = routines
    .filter((r) => r.status === "ACTIVE" && r.daysOfWeek.includes(at.weekday))
    .map((r): TodayItem => {
      const check = checks.find((c) => c.routineId === r.id && c.day === at.day);
      const start = toMinutes(r.timeOfDay);
      const state: ItemState = check ? check.status : start > at.minutes ? "UPCOMING" : "PAST_UNRECORDED";
      return { routineId: r.id, title: r.title, kind: r.kind, details: r.details, time: r.timeOfDay, durationMinutes: r.durationMinutes, state, minutesUntil: state === "UPCOMING" ? start - at.minutes : null, checkNote: check?.note ?? null };
    })
    .sort((a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
  return { day: at.day, weekday: DAY_NAMES[at.weekday], items, next: items.find((i) => i.state === "UPCOMING") ?? null };
}

/** A check-in may be for today or one of the last few days — never the future, never older than the back-fill window. Returns the reason it is refused, or null. */
export function dayRefusal(day: string, today: string): string | null {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return "That isn't a valid date.";
  if (day > today) return "A check-in can't be for a day that hasn't happened yet.";
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - BACKFILL_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (day < oldest) return `A check-in can only be recorded for today or the last ${BACKFILL_DAYS} days.`;
  return null;
}

/** "Monday, Wednesday, Friday" / "Every day" / "Weekdays" / "Weekends". */
export function describeDays(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 7) return "Every day";
  if (set.join() === "1,2,3,4,5") return "Weekdays";
  if (set.join() === "0,6") return "Weekends";
  return set.map((d) => DAY_NAMES[d]).join(", ");
}
