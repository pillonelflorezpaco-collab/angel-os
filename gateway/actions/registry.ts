import type { ActionDefinition } from "./types.js";
import { INTERFACE_SOURCES } from "../../identity/interfaces.js";
import { routeFor } from "../policy.js";

// Actions are registered in code by their owning skill. The approval row
// stores only (skillKey, action, parameters); the definition — schema,
// risk, executor — always comes from here, never from the database or a
// client.

const definitions = new Map<string, ActionDefinition<any>>();

const keyOf = (skillKey: string, action: string) => `${skillKey}::${action}`;

const CATEGORIES = ["READ", "WRITE", "EXECUTE"];
const RISKS = ["LOW", "SENSITIVE", "DANGEROUS"];

export class IncompleteActionDefinitionError extends Error {
  constructor(key: string, problems: string[]) {
    super(`Action definition ${key} is incomplete: ${problems.join("; ")}`);
    this.name = "IncompleteActionDefinitionError";
  }
}

/** Structural invariants every definition must satisfy before it can be registered. Returns the problems found. */
export function validateDefinition(d: Partial<ActionDefinition<unknown>>): string[] {
  const problems: string[] = [];
  for (const f of ["skillKey", "action", "resource", "agentKey"] as const) {
    if (typeof d[f] !== "string" || !(d[f] as string).trim()) problems.push(`missing ${f}`);
  }
  if (!CATEGORIES.includes(d.category as string)) problems.push("invalid category");
  if (!RISKS.includes(d.risk as string)) problems.push("invalid risk");
  if (!d.schema || typeof (d.schema as { safeParse?: unknown }).safeParse !== "function") problems.push("missing schema");
  if (typeof d.describe !== "function") problems.push("missing describe");
  if (typeof d.execute !== "function") problems.push("missing execute");
  if (d.approvalTtlMs !== undefined && (!Number.isInteger(d.approvalTtlMs) || d.approvalTtlMs <= 0 || d.approvalTtlMs > 24 * 3600_000)) problems.push("invalid approvalTtlMs");
  if (!problems.length) {
    // Risk policy must be defined for every interface, and nothing that acts
    // on the world (EXECUTE) or is not LOW risk may ever be DIRECT.
    for (const source of INTERFACE_SOURCES) {
      const route = routeFor(source, d.category!, d.risk!);
      if (!["DIRECT", "APPROVAL", "REFUSE"].includes(route)) problems.push(`no policy route for ${source}`);
      if (route === "DIRECT" && d.category !== "READ" && d.risk !== "LOW") problems.push(`${source} would run a non-LOW action directly`);
      if (route === "DIRECT" && d.category === "EXECUTE") problems.push(`${source} would run an EXECUTE action directly`);
    }
  }
  return problems;
}

export function registerAction<P>(definition: ActionDefinition<P>): void {
  const problems = validateDefinition(definition as Partial<ActionDefinition<unknown>>);
  if (problems.length) throw new IncompleteActionDefinitionError(`${definition?.skillKey}::${definition?.action}`, problems);
  const key = keyOf(definition.skillKey, definition.action);
  if (definitions.has(key)) throw new Error(`Action already registered: ${key}`);
  definitions.set(key, definition);
}

export function getActionDefinition(skillKey: string, action: string): ActionDefinition<any> | undefined {
  return definitions.get(keyOf(skillKey, action));
}

/** Test seam. */
export function unregisterAction(skillKey: string, action: string): void {
  definitions.delete(keyOf(skillKey, action));
}

export function listActionDefinitions(): ActionDefinition<any>[] {
  return [...definitions.values()];
}
