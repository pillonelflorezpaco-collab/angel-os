// Pure, deterministic progress. No database, no clock, no model.
//
//   progress = (latest − baseline) / (target − baseline), clamped to [0, 1]
//
// works for both directions (a target below the baseline means "lower is better"). With no
// readings there is NO progress figure — `null` means "no evidence yet", never zero.
// Reaching 1 does not mean the aspiration is achieved: only its owner closes it.

export interface MetricShape { baseline: number; target: number }
export interface Reading { value: number; observedAt: Date }

export interface MetricProgress {
  progress: number | null;
  latest: number | null;
  lastObservedAt: Date | null;
  readings: number;
  /** True once the latest reading is at or past the target. Informational only. */
  targetReached: boolean;
}

export function metricProgress(m: MetricShape, readings: Reading[]): MetricProgress {
  if (m.baseline === m.target) throw new Error("baseline and target must differ");
  if (readings.length === 0) return { progress: null, latest: null, lastObservedAt: null, readings: 0, targetReached: false };
  // Latest by observation time; ties broken by the larger index so the last-recorded wins deterministically.
  let latest = readings[0];
  for (const r of readings) if (r.observedAt.getTime() >= latest.observedAt.getTime()) latest = r;
  const raw = (latest.value - m.baseline) / (m.target - m.baseline);
  return { progress: Math.min(1, Math.max(0, raw)), latest: latest.value, lastObservedAt: latest.observedAt, readings: readings.length, targetReached: raw >= 1 };
}

/** Mean of the metrics that HAVE evidence; null when none do. Metrics without readings are excluded, not counted as zero. */
export function aspirationProgress(metrics: MetricProgress[]): number | null {
  const withEvidence = metrics.filter((m) => m.progress !== null);
  if (withEvidence.length === 0) return null;
  return withEvidence.reduce((sum, m) => sum + (m.progress as number), 0) / withEvidence.length;
}
