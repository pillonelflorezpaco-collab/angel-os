// Pure gate for personal experiments. A status is only ever a statement about THIS owner's experiment and
// the evidence linked to it — never a universal claim, and never reached without evidence.
//   CANDIDATE → OBSERVED → SUPPORTED → CONFIRMED (terminal), or → REJECTED (terminal) from any open state.

export type Hypothesis = "CANDIDATE" | "OBSERVED" | "SUPPORTED" | "CONFIRMED" | "REJECTED";
export interface Facts { observations: number; observationDays: number; supports: number; contradicts: number }

export const TERMINAL: readonly Hypothesis[] = ["CONFIRMED", "REJECTED"];
const NEXT: Record<Hypothesis, readonly Hypothesis[]> = {
  CANDIDATE: ["OBSERVED", "REJECTED"], OBSERVED: ["SUPPORTED", "REJECTED"], SUPPORTED: ["CONFIRMED", "REJECTED"], CONFIRMED: [], REJECTED: [],
};
/** Confirmation needs repeated observation, on more than one day, with more support than contradiction. */
export const CONFIRM_MIN = { observations: 3, days: 2, supports: 2 } as const;

/** Returns null when the move is allowed, otherwise the reason it is refused. */
export function transitionRefusal(from: Hypothesis, to: Hypothesis, f: Facts): string | null {
  if (!NEXT[from].includes(to)) return `An experiment can't go from ${from.toLowerCase()} to ${to.toLowerCase()}.`;
  if (to === "OBSERVED" && f.observations < 1) return "Record at least one observation first.";
  if (to === "SUPPORTED" && (f.observations < 1 || f.supports < 1)) return "Supported needs an observation and at least one supporting evidence link.";
  if (to === "CONFIRMED") {
    if (f.observations < CONFIRM_MIN.observations || f.observationDays < CONFIRM_MIN.days || f.supports < CONFIRM_MIN.supports) return `Confirmed needs at least ${CONFIRM_MIN.observations} observations on ${CONFIRM_MIN.days} different days and ${CONFIRM_MIN.supports} supporting evidence links.`;
    if (f.contradicts >= f.supports) return "Contradicting evidence is not outweighed by supporting evidence.";
  }
  if (to === "REJECTED" && f.observations < 1 && f.contradicts < 1) return "Rejecting needs an observation or contradicting evidence.";
  return null;
}
