// ACTIVITY CALENDAR (pure): what was actually recorded, day by day, for a heat-map. A day's shade is a bucket of a real count; the count itself
// is always shown next to it. A day with nothing recorded is "nothing recorded", not a bad day. No score, no target, no percentage.

export interface CalendarEvent { occurredAt: Date; type: string }
export interface CalendarDay { day: string; weekday: number; total: number; level: number; byType: Record<string, number> }

/** Shade buckets over real counts. Level 0 = nothing recorded. */
export const LEVELS = [
  { level: 0, label: "0", min: 0 }, { level: 1, label: "1", min: 1 }, { level: 2, label: "2–3", min: 2 }, { level: 3, label: "4–6", min: 4 }, { level: 4, label: "7+", min: 7 },
] as const;
export const levelOf = (count: number): number => (count <= 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4);

function localDay(d: Date, timeZone: string): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone }).format(d); } catch { return d.toISOString().slice(0, 10); }
}
const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Every local day from `days - 1` days ago through today, with its recorded total and per-type counts. */
export function buildCalendar(events: CalendarEvent[], now: Date, timeZone: string, days: number): { from: string; to: string; days: CalendarDay[]; activeDays: number; total: number } {
  const to = localDay(now, timeZone);
  const from = addDays(to, -(days - 1));
  const byDay = new Map<string, Record<string, number>>();
  for (const e of events) {
    const d = localDay(e.occurredAt, timeZone);
    const m = byDay.get(d) ?? {}; // days outside the window are simply never read below
    m[e.type] = (m[e.type] ?? 0) + 1;
    byDay.set(d, m);
  }
  const out: CalendarDay[] = [];
  for (let n = 0; n < days; n++) {
    const day = addDays(from, n);
    const byType = byDay.get(day) ?? {};
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    out.push({ day, weekday: weekdayOf(day), total, level: levelOf(total), byType });
  }
  return { from, to, days: out, activeDays: out.filter((d) => d.total > 0).length, total: out.reduce((a, d) => a + d.total, 0) };
}
