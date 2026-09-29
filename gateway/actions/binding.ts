import { createHash } from "node:crypto";

// "APPROVED ACTION == EXECUTED ACTION". The approval stores the exact
// parameters; the hash makes any drift detectable, and execution re-derives
// it from the stored row before running anything.

/** Deterministic JSON: object keys sorted at every depth; rejects values JSON cannot faithfully represent. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number cannot be bound to an approval.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new Error("Value cannot be bound to an approval.");
}

export interface BoundAction {
  principalId: string;
  skillKey: string;
  resource: string;
  action: string;
  parameters: unknown;
}

export function payloadHash(bound: BoundAction): string {
  return createHash("sha256")
    .update(
      canonicalize({
        principalId: bound.principalId,
        skillKey: bound.skillKey,
        resource: bound.resource,
        action: bound.action,
        parameters: bound.parameters,
      })
    )
    .digest("hex");
}
