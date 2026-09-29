import type { Intent, Plan } from "../types/index.js";
import { SKILL_KEY as TASKS_SKILL, RESOURCE as TASKS_RESOURCE } from "../../skills/system/tasks.js";

/**
 * Turns a parsed Intent into a Plan naming exactly which skill/action/
 * resource will be invoked. Jarvis Core never calls the database directly
 * — it only ever produces a Plan that a skill executes through the
 * gateway.
 */
export function planFromIntent(intent: Intent): Plan | null {
  switch (intent.name) {
    case "reminder.create":
      return {
        intent,
        skillKey: TASKS_SKILL,
        action: "CREATE_REMINDER",
        resource: TASKS_RESOURCE,
        parameters: {
          message: intent.slots.message ?? intent.raw,
          hour: intent.slots.hour,
          minute: intent.slots.minute,
        },
      };
    case "task.create":
      return {
        intent,
        skillKey: TASKS_SKILL,
        action: "CREATE_TASK",
        resource: TASKS_RESOURCE,
        parameters: { title: intent.slots.title ?? intent.raw },
      };
    case "task.list":
      return {
        intent,
        skillKey: TASKS_SKILL,
        action: "READ",
        resource: TASKS_RESOURCE,
        parameters: {},
      };
    case "memory.remember":
    case "memory.search":
    case "decision.query":
    case "unknown":
      return null; // handled directly by Jarvis Core (see core/index.ts), not a skill action
    default:
      return null;
  }
}
