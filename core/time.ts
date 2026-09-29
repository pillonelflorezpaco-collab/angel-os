// User-relative date logic. Instants are always stored and compared in
// UTC; "today", "tomorrow", and "10:00" are interpreted in the
// principal's IANA timezone. Uses only the built-in Intl API.

export const DEFAULT_TIMEZONE = "UTC";

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (e.g. Bogota = -5h). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given
 * local date/time. Month/day overflow is normalized by Date.UTC (day 32 →
 * next month). Re-checks the offset once to land correctly across DST.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wallAsUtc - offsetMs(new Date(wallAsUtc), timeZone);
  const corrected = wallAsUtc - offsetMs(new Date(guess), timeZone);
  if (corrected !== guess) guess = corrected;
  return new Date(guess);
}

/** Local calendar date (YYYY-MM-DD) in `timeZone` at `instant`. */
export function localDateString(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * UTC bounds [start, end) of a local day in `timeZone`. `dayOffset` 0 is
 * today, 1 tomorrow, -1 yesterday — relative to the user's date at `now`,
 * never the server's.
 */
export function localDayBounds(now: Date, timeZone: string, dayOffset = 0): { start: Date; end: Date } {
  const p = localParts(now, timeZone);
  return {
    start: zonedTimeToUtc(p.year, p.month, p.day + dayOffset, 0, 0, timeZone),
    end: zonedTimeToUtc(p.year, p.month, p.day + dayOffset + 1, 0, 0, timeZone),
  };
}

/** The instant at local `hour:minute` on the user's day `dayOffset` days from `now`. */
export function localTimeOnDay(now: Date, timeZone: string, dayOffset: number, hour: number, minute: number): Date {
  const p = localParts(now, timeZone);
  return zonedTimeToUtc(p.year, p.month, p.day + dayOffset, hour, minute, timeZone);
}

/** HH:MM wall-clock time of `instant` in `timeZone`, for presentation. */
export function formatLocalTime(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
