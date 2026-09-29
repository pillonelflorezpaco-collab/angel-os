import type { MemoryType, ProvenanceKind } from "@prisma/client";
import { MemoryInvalidError } from "./index.js";

/** The provenance a type implies when the caller does not say. */
export function defaultProvenance(type: MemoryType): ProvenanceKind {
  if (type === "INFERENCE") return "INFERRED";
  if (type === "EXPERIENCE") return "EXPERIENCED";
  return "STATED";
}

/**
 * The semantic invariants of a memory, as ONE pure function shared by the
 * provider (before any write), the ActionDefinition schemas (before any
 * approval exists) and mirrored by database CHECK constraints:
 *   - INFERRED <=> type INFERENCE: a belief is never relabeled as a fact.
 *   - EXPERIENCE is EXPERIENCED (personally experienced/tested).
 *   - EXPERIENCED is only for EXPERIENCE or LESSON.
 *   - an unconfirmed inference never sits at full confidence.
 *   - confidence within 0..1; validity window ordered.
 */
export function assertMemoryInvariants(m: {
  type: MemoryType | string;
  provenance: ProvenanceKind | string;
  status: string;
  confidence: number;
  validFrom: Date | null;
  validUntil: Date | null;
}): void {
  if ((m.type === "INFERENCE") !== (m.provenance === "INFERRED")) {
    throw new MemoryInvalidError("An inference must be recorded as inferred, and only inferences are — a belief is never relabeled as a fact.");
  }
  if (m.type === "EXPERIENCE" && m.provenance !== "EXPERIENCED") {
    throw new MemoryInvalidError("An experience must be recorded as personally experienced.");
  }
  if (m.provenance === "EXPERIENCED" && m.type !== "EXPERIENCE" && m.type !== "LESSON") {
    throw new MemoryInvalidError("Only experiences and lessons can be recorded as personally experienced.");
  }
  if (!(m.confidence >= 0 && m.confidence <= 1)) throw new MemoryInvalidError("Confidence must be between 0 and 1.");
  if (m.type === "INFERENCE" && m.status === "UNCONFIRMED" && m.confidence >= 1) {
    throw new MemoryInvalidError("An unconfirmed inference cannot have full confidence; confirm it first.");
  }
  if (m.validFrom && m.validUntil && !(m.validFrom < m.validUntil)) throw new MemoryInvalidError("validFrom must be before validUntil.");
}
