import { registerAction } from "../gateway/actions/registry.js";
import { createReminderDefinition, createTaskDefinition } from "./system/tasks.js";
import { rememberDefinition, memoryUpdateDefinition, memoryConfirmDefinition, memoryDeleteDefinition, memoryRetractDefinition } from "./system/memory.js";
import { verifyRegisteredActions, configuredProductionPrincipalId } from "../gateway/actions/verify.js";

// The production action registry. Every ActionDefinition a running process
// may need to PROPOSE or EXECUTE (including approvals decided from Telegram
// or the API) must be registered here. Composition roots call
// registerSkillActions() once at start-up (api/server.ts, scripts/telegram.ts,
// scripts/worker.ts, and Jarvis Core). It is idempotent.

const DEFINITIONS = [createReminderDefinition, createTaskDefinition, rememberDefinition, memoryUpdateDefinition, memoryConfirmDefinition, memoryDeleteDefinition, memoryRetractDefinition] as const;

let registered = false;

/**
 * Registers every production definition, once per process. A duplicate key
 * THROWS (registerAction refuses it) — nothing is ever silently skipped or
 * shadowed. Repeated calls from several composition roots are harmless
 * because the manifest itself registers only once.
 */
export function registerSkillActions(): void {
  if (registered) return;
  for (const def of DEFINITIONS) registerAction(def as never);
  registered = true;
}

export const PRODUCTION_ACTIONS = DEFINITIONS.map((d) => `${d.skillKey}|${d.action}`);

/**
 * Async startup invariant: every production definition has a registered
 * skill, agent and (for the CONFIGURED production principal, ANGEL_OS_SYSTEM_PRINCIPAL_ID)
 * a granted permission of the right category. Call before serving; a
 * rejection must stop startup.
 */
export async function verifyProductionActions(principalId?: string): Promise<void> {
  // async: a missing configuration is a REJECTION (startup fails), never a synchronous throw that escapes a .catch
  return verifyRegisteredActions(DEFINITIONS as never, principalId ?? configuredProductionPrincipalId());
}
