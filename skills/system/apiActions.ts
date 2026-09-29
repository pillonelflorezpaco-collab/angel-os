import { proposeAction, describeActions, hasAction } from "../../gateway/index.js";
import type { ActionSpec } from "../../gateway/index.js";
import type { IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";

// The doorway for the HTTP interface's generic "act by name" route. It exists so the API adapter never touches
// the gateway's registry or execution engine directly. A caller-named action is exactly a human proposal:
// proposeAction(identity, …) — strict schema (no client principal), permission, interface policy, risk policy,
// approval, exact binding and audit all apply. Only registered ActionDefinitions exist here; there is no way
// from this module to read data, approve, or decide anything.

export const isKnownAction = hasAction;
export const listActionCatalog = (): ActionSpec[] => describeActions();

export function proposeNamedAction(identity: IdentityContext, skillKey: string, action: string, parameters: unknown): Promise<Result> {
  return proposeAction(identity, { skillKey, action, parameters });
}
