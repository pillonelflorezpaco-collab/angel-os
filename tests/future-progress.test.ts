import { describe, it, expect } from "vitest";
import { metricProgress, aspirationProgress } from "../future/progress.js";

const at = (d: number) => new Date(Date.UTC(2026, 0, d));

describe("future/progress: deterministic, evidence-only", () => {
  it("no readings → null (no evidence yet), never zero", () => {
    expect(metricProgress({ baseline: 0, target: 10 }, [])).toEqual({ progress: null, latest: null, lastObservedAt: null, readings: 0, targetReached: false });
    expect(aspirationProgress([metricProgress({ baseline: 0, target: 10 }, [])])).toBeNull();
  });

  it("(latest − baseline) / (target − baseline), clamped to [0, 1], both directions", () => {
    const up = { baseline: 50, target: 100 };
    expect(metricProgress(up, [{ value: 75, observedAt: at(1) }]).progress).toBe(0.5);
    expect(metricProgress(up, [{ value: 20, observedAt: at(1) }]).progress).toBe(0); // regression below baseline never goes negative
    expect(metricProgress(up, [{ value: 400, observedAt: at(1) }]).progress).toBe(1);
    const down = { baseline: 90, target: 80 }; // lower is better
    expect(metricProgress(down, [{ value: 85, observedAt: at(1) }]).progress).toBe(0.5);
    expect(metricProgress(down, [{ value: 95, observedAt: at(1) }]).progress).toBe(0);
    expect(metricProgress(down, [{ value: 70, observedAt: at(1) }])).toMatchObject({ progress: 1, targetReached: true });
  });

  it("uses the LATEST observation by time, not by insertion order, and is order-independent", () => {
    const m = { baseline: 0, target: 100 };
    const rs = [{ value: 80, observedAt: at(3) }, { value: 10, observedAt: at(1) }, { value: 40, observedAt: at(2) }];
    const forward = metricProgress(m, rs);
    expect(forward).toMatchObject({ progress: 0.8, latest: 80, readings: 3 });
    expect(metricProgress(m, [...rs].reverse())).toEqual(forward);
    expect(forward.lastObservedAt).toEqual(at(3));
  });

  it("a regression is visible: a later worse reading lowers progress", () => {
    const m = { baseline: 0, target: 100 };
    expect(metricProgress(m, [{ value: 90, observedAt: at(1) }, { value: 30, observedAt: at(2) }]).progress).toBe(0.3);
  });

  it("targetReached is informational and only true at/after the target", () => {
    const m = { baseline: 0, target: 10 };
    expect(metricProgress(m, [{ value: 9.99, observedAt: at(1) }]).targetReached).toBe(false);
    expect(metricProgress(m, [{ value: 10, observedAt: at(1) }]).targetReached).toBe(true);
  });

  it("a degenerate range is refused rather than dividing by zero", () => {
    expect(() => metricProgress({ baseline: 5, target: 5 }, [{ value: 5, observedAt: at(1) }])).toThrow();
  });

  it("aspiration progress is the mean of metrics WITH evidence; metrics with none are excluded, not counted as zero", () => {
    const m = { baseline: 0, target: 10 };
    const a = metricProgress(m, [{ value: 10, observedAt: at(1) }]);
    const b = metricProgress(m, [{ value: 5, observedAt: at(1) }]);
    const none = metricProgress(m, []);
    expect(aspirationProgress([a, b, none])).toBe(0.75);
    expect(aspirationProgress([none, none])).toBeNull();
    expect(aspirationProgress([])).toBeNull();
  });
});
