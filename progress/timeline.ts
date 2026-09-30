// FUTURE SELF TIMELINE + LIFE MAP (pure): shapes what was recorded for drawing. Dates are the dates things were recorded; evidence counts are counts
// of linked evidence. Nothing is interpolated, averaged, or turned into a percentage.

export interface StateRow { createdAt: Date; basis: string; current: string; evidenceSummary: { supports: number; contradicts: number; context: number; total: number } }
export interface TimelinePoint { at: string; basis: string; evidenceCount: number; supports: number; contradicts: number; current: string }
export interface AspirationLine { aspirationId: string; title: string; points: TimelinePoint[] }

const clip = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n)}…` : t);

export function buildTimeline(aspirations: { id: string; title: string; states: StateRow[] }[], now: Date): { from: string; to: string; lines: AspirationLine[] } {
  const lines = aspirations.map((a): AspirationLine => ({
    aspirationId: a.id, title: a.title,
    points: [...a.states].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((s) => ({ at: s.createdAt.toISOString(), basis: s.basis, evidenceCount: s.evidenceSummary.total, supports: s.evidenceSummary.supports, contradicts: s.evidenceSummary.contradicts, current: clip(s.current) })),
  }));
  const times = lines.flatMap((l) => l.points.map((p) => Date.parse(p.at)));
  const start = times.length ? Math.min(...times) : now.getTime();
  return { from: new Date(start).toISOString(), to: now.toISOString(), lines };
}

export interface MapProject { id: string; name: string; status: string; goalId: string | null; tasks: { open: number; done: number; cancelled: number } }
export interface MapGoal { id: string; title: string; horizon: string }

/** Goals with their projects and real task counts; projects without a goal are kept, under no goal. */
export function buildMap(goals: MapGoal[], projects: MapProject[]) {
  const proj = (p: MapProject) => ({ id: p.id, name: p.name, status: p.status, done: p.tasks.done, open: p.tasks.open });
  return {
    goals: goals.map((g) => ({ id: g.id, title: g.title, horizon: g.horizon, projects: projects.filter((p) => p.goalId === g.id).map(proj) })),
    unassigned: projects.filter((p) => !p.goalId || !goals.some((g) => g.id === p.goalId)).map(proj),
  };
}
