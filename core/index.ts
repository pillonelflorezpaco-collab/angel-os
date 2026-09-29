import { parseIntent } from "./router/index.js";
import { planFromIntent, resolveReminderTime } from "./planner/index.js";
import { createTask, listTasks, createReminder } from "../skills/system/tasks.js";
import { remember, search as searchMemory } from "../skills/system/memory.js";
import { queryDecisions } from "../skills/system/decisions.js";
import { today as calendarToday, formatEventsAsContext } from "../skills/integrations/calendar.js";
import type { CalendarEvent } from "../connectors/types/calendar.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import type { Result } from "./types/index.js";

export const JARVIS_AGENT_KEY = "jarvis-core";

export interface JarvisRequest {
  principalId: string;
  input: string;
}

/**
 * Jarvis Core, v0.1: deterministic pipeline.
 *   Input -> Intent (router) -> Context (context engine) -> Plan (planner)
 *   -> Action (skill, through the gateway) -> Result
 *
 * Jarvis Core ORCHESTRATES ONLY. It never imports Prisma and never calls
 * MemoryProvider directly for a domain operation — every intent maps to a
 * skill call, and every skill executes through the gateway. This is the
 * fix for the Jarvis Core bypass found in the security audit: memory and
 * decision reads/writes used to skip the skill/gateway layer entirely.
 */
export class JarvisCore {
  private readonly contextEngine = new DeterministicContextEngine();

  async handle(request: JarvisRequest): Promise<Result> {
    const intent = parseIntent(request.input);

    // Context is assembled for every request so a future LLM-assisted
    // planner has it available; v0.1's deterministic planner doesn't need
    // it yet, but the pipeline shape is already correct end to end.
    await this.contextEngine.buildContext({
      principalId: request.principalId,
      query: request.input,
    });

    switch (intent.name) {
      case "memory.remember": {
        const content = intent.slots.content ?? request.input;
        return remember({
          principalId: request.principalId,
          agentKey: JARVIS_AGENT_KEY,
          memory: { type: "FACT", content, source: "jarvis-core:user-input" },
        });
      }

      case "memory.search": {
        const query = intent.slots.query ?? request.input;
        return searchMemory({
          principalId: request.principalId,
          agentKey: JARVIS_AGENT_KEY,
          query: { query },
        });
      }

      case "decision.query": {
        const topic = intent.slots.topic ?? "";
        return queryDecisions({
          principalId: request.principalId,
          agentKey: JARVIS_AGENT_KEY,
          topic,
        });
      }

      case "calendar.today": {
        const result = await calendarToday({ principalId: request.principalId, agentKey: JARVIS_AGENT_KEY });
        if (result.status !== "EXECUTED") return result;
        const events = result.data as CalendarEvent[];
        return {
          status: "EXECUTED",
          message: `Today's calendar:\n${formatEventsAsContext(events)}`,
          data: events,
        };
      }

      case "unknown":
        return {
          status: "FAILED",
          message: `I didn't understand: "${request.input}". Try "remind me tomorrow at 10 to ...", "what are my tasks", or "remember that ...".`,
        };

      default: {
        const plan = planFromIntent(intent);
        if (!plan) {
          return { status: "FAILED", message: "No plan could be derived for this intent." };
        }
        return this.executePlan(request.principalId, plan.action, plan.parameters);
      }
    }
  }

  private async executePlan(
    principalId: string,
    action: string,
    parameters: Record<string, unknown>
  ): Promise<Result> {
    switch (action) {
      case "CREATE_TASK":
        return createTask({
          principalId,
          agentKey: JARVIS_AGENT_KEY,
          title: String(parameters.title ?? "Untitled task"),
        });
      case "READ":
        return listTasks({ principalId, agentKey: JARVIS_AGENT_KEY });
      case "CREATE_REMINDER": {
        const remindAt = resolveReminderTime(
          parameters.hour as string | undefined,
          parameters.minute as string | undefined
        );
        return createReminder({
          principalId,
          agentKey: JARVIS_AGENT_KEY,
          message: String(parameters.message ?? "Reminder"),
          remindAt,
        });
      }
      default:
        return { status: "FAILED", message: `Unknown action: ${action}` };
    }
  }
}
