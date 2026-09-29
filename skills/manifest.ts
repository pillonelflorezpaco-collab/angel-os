import { registerAction, getActionDefinition } from "../gateway/actions/registry.js";
import { createReminderDefinition } from "./system/tasks.js";
import { rememberDefinition } from "./system/memory.js";

// The production action registry. Every ActionDefinition a running process
// may need to PROPOSE or EXECUTE (including approvals decided from Telegram
// or the API) must be registered here. Composition roots call
// registerSkillActions() once at start-up (api/server.ts, scripts/telegram.ts,
// scripts/worker.ts, and Jarvis Core). It is idempotent.

const DEFINITIONS = [createReminderDefinition, rememberDefinition] as const;

export function registerSkillActions(): void {
  for (const def of DEFINITIONS) {
    if (!getActionDefinition(def.skillKey, def.action)) registerAction(def as never);
  }
}

export const PRODUCTION_ACTIONS = DEFINITIONS.map((d) => `${d.skillKey}|${d.action}`);
