import { parseIntent } from "./router/index.js";
import { planFromIntent } from "./planner/index.js";
import { createTask, listTasks, listReminders, createRelativeReminder } from "../skills/system/tasks.js";
import { remember, search as searchMemory, describeMemory } from "../skills/system/memory.js";
import { queryDecisions } from "../skills/system/decisions.js";
import { listActivity, summarizeActivity } from "../skills/system/activity.js";
import { today as calendarToday, formatEventsAsContext, type TodayResult } from "../skills/integrations/calendar.js";
import type { MemoryRecord } from "../memory/types/index.js";
import { JARVIS_AGENT_KEY } from "../skills/agent.js";
import { registerSkillActions } from "../skills/manifest.js";
import type { IdentityContext } from "../identity/index.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { formatContext } from "../context/format.js";
import { toSafeError, logInternalError } from "./errors.js";
import type { Result } from "./types/index.js";

export { JARVIS_AGENT_KEY };
registerSkillActions();

export interface JarvisRequest {
  principalId: string;
  input: string;
  /** The authenticated identity. Required for anything that proposes an action (reminders, memories). */
  identity?: IdentityContext;
}

/**
 * Jarvis Core, v0.1: deterministic pipeline.
 *   Input -> Intent (router) -> Plan (planner) -> Action (skill, through
 *   the gateway) -> Result
 *
 * Jarvis Core ORCHESTRATES ONLY. It never imports Prisma and never calls
 * MemoryProvider directly — every intent maps to a skill call, and every
 * skill executes through the gateway.
 *
 * The context engine is not invoked here: its output had no consumer (the
 * deterministic planner doesn't use it), so calling it only produced
 * permission checks and audit entries for data nobody read. It is gated
 * and ready for the future LLM planner that will consume it — see
 * context/retrieval/index.ts.
 */
const NO_IDENTITY: Result = { status: "FAILED", message: "I can't do that without knowing who you are." };

export class JarvisCore {
  async handle(request: JarvisRequest): Promise<Result> {
    try {
      return await this.dispatch(request);
    } catch (err) {
      // Last line of defense for anything that fails outside a skill's
      // gatewayExecute (which sanitizes its own failures): the user gets a
      // safe message, never raw error text.
      logInternalError("jarvis-core", err);
      return { status: "FAILED", message: toSafeError(err).publicMessage };
    }
  }

  /** Intent dispatch. Exposed only so tests can exercise handle()'s error boundary. */
  async dispatch(request: JarvisRequest): Promise<Result> {
    const intent = parseIntent(request.input);

    switch (intent.name) {
      case "memory.remember": {
        const content = intent.slots.content ?? request.input;
        if (!request.identity) return NO_IDENTITY;
        return remember(request.identity, { type: "FACT", content, source: "jarvis-core:user-input" });
      }

      case "memory.search": {
        const query = intent.slots.query ?? request.input;
        const result = await searchMemory({
          principalId: request.principalId,
          agentKey: JARVIS_AGENT_KEY,
          query: { query },
        });
        if (result.status !== "EXECUTED") return result;
        const memories = result.data as MemoryRecord[];
        return {
          status: "EXECUTED",
          // Each line carries its type, so an unconfirmed inference is
          // never presented as a fact.
          message: memories.length ? memories.map(describeMemory).join("\n") : "No matching memories.",
          data: memories,
        };
      }

      case "decision.query": {
        const topic = intent.slots.topic ?? "";
        return queryDecisions({
          principalId: request.principalId,
          agentKey: JARVIS_AGENT_KEY,
          topic,
        });
      }

      case "context.brief": {
        if (!request.identity) return NO_IDENTITY;
        const ctx = await new DeterministicContextEngine().buildContext({ identity: request.identity, agentKey: JARVIS_AGENT_KEY, query: intent.slots.topic ?? request.input });
        return { status: "EXECUTED", message: formatContext(ctx), data: ctx };
      }

      case "activity.today":
        return listActivity({ principalId: request.principalId, agentKey: JARVIS_AGENT_KEY, range: "today" });

      case "activity.week":
        return summarizeActivity({ principalId: request.principalId, agentKey: JARVIS_AGENT_KEY, range: "week" });

      case "reminder.list":
        return listReminders({ principalId: request.principalId, agentKey: JARVIS_AGENT_KEY });

      case "calendar.today": {
        const result = await calendarToday({ principalId: request.principalId, agentKey: JARVIS_AGENT_KEY });
        if (result.status !== "EXECUTED") return result;
        const { timeZone, events } = result.data as TodayResult;
        return {
          status: "EXECUTED",
          message: `Today's calendar:\n${formatEventsAsContext(events, timeZone)}`,
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
        return this.executePlan(request, plan.action, plan.parameters);
      }
    }
  }

  private async executePlan(
    request: JarvisRequest,
    action: string,
    parameters: Record<string, unknown>
  ): Promise<Result> {
    const principalId = request.principalId;
    switch (action) {
      case "CREATE_TASK":
        if (!request.identity) return NO_IDENTITY;
        return createTask(request.identity, { title: String(parameters.title ?? "Untitled task") });
      case "READ":
        return listTasks({ principalId, agentKey: JARVIS_AGENT_KEY });
      case "CREATE_REMINDER": {
        const hour = parameters.hour === undefined ? 9 : Number(parameters.hour);
        const minute = parameters.minute === undefined ? 0 : Number(parameters.minute);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
          return { status: "FAILED", message: "That time isn't valid. Use a 24-hour time like 10 or 14:30." };
        }
        // Interpreted as "tomorrow" in the principal's timezone by the skill.
        if (!request.identity) return NO_IDENTITY;
        return createRelativeReminder(request.identity, {
          message: String(parameters.message ?? "Reminder"),
          dayOffset: 1,
          hour,
          minute,
        });
      }
      default:
        return { status: "FAILED", message: `Unknown action: ${action}` };
    }
  }
}
