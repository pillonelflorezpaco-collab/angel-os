import type { ActionDefinition } from "./types.js";

// Actions are registered in code by their owning skill. The approval row
// stores only (skillKey, action, parameters); the definition — schema,
// risk, executor — always comes from here, never from the database or a
// client.

const definitions = new Map<string, ActionDefinition<any>>();

const keyOf = (skillKey: string, action: string) => `${skillKey}::${action}`;

export function registerAction<P>(definition: ActionDefinition<P>): void {
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
