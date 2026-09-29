import { getDb } from "../../db/client/index.js";
import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import type { ActionDefinition } from "../../gateway/index.js";
import { z } from "zod";
import { PublicError } from "../../core/errors.js";
import type { IdentityContext } from "../../identity/index.js";
import { JARVIS_AGENT_KEY } from "../agent.js";
import type { Result } from "../../core/types/index.js";
import { localTimeOnDay } from "../../core/time.js";
import { getPrincipalTimeZone } from "./principal.js";
import { formatLocalTime, localDateString } from "../../core/time.js";

export const SKILL_KEY = "system.tasks";
export const RESOURCE = "angel:tasks";

export interface CreateTaskInput {
  principalId: string;
  agentKey: string;
  title: string;
  description?: string;
  dueAt?: Date;
}

export async function createTask(input: CreateTaskInput): Promise<Result> {
  const result = await gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "CREATE_TASK",
      parameters: { title: input.title },
    },
    async () => {
      const db = getDb();
      return db.task.create({
        data: {
          principalId: input.principalId,
          title: input.title,
          description: input.description,
          dueAt: input.dueAt,
        },
      });
    },
    "skill.system.tasks"
  );
  return result.status === "EXECUTED" ? { ...result, message: `Task added: ${input.title}` } : result;
}

export interface ListTasksInput {
  principalId: string;
  agentKey: string;
}

export async function listTasks(input: ListTasksInput): Promise<Result> {
  const result = await gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "READ",
      parameters: {},
    },
    async () => {
      const db = getDb();
      return db.task.findMany({
        where: { principalId: input.principalId },
        orderBy: { createdAt: "desc" },
      });
    },
    "skill.system.tasks"
  );
  if (result.status !== "EXECUTED") return result;
  const tasks = result.data as { title: string; status: string }[];
  return {
    ...result,
    message: tasks.length ? `Your tasks (${tasks.length}):\n` + tasks.map((t) => `• ${t.title} [${t.status.toLowerCase().replace("_", " ")}]`).join("\n") : "You have no tasks.",
  };
}

export interface CreateReminderInput {
  message: string;
  remindAt: Date;
  taskId?: string;
}

const reminderParams = z
  .object({
    message: z.string().trim().min(1).max(500),
    // An exact UTC instant. Relative wording ("tomorrow at 10") is resolved in the
    // principal's timezone BEFORE proposing, so an approval binds one exact time.
    remindAt: z.string().datetime(),
    taskId: z.string().uuid().optional(),
  })
  .strict();
type ReminderParams = z.infer<typeof reminderParams>;

interface CreatedReminder {
  id: string;
  message: string;
  remindAt: Date;
  display: string;
}

/**
 * CREATE_REMINDER as a registered ActionDefinition (BUILD #7): strict
 * schema, exact parameters, permission + interface policy + approval. LOW
 * risk: direct on GuideHub/API/Telegram, approval on voice.
 */
export const createReminderDefinition: ActionDefinition<ReminderParams> = {
  skillKey: SKILL_KEY,
  action: "CREATE_REMINDER",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: reminderParams,
  describe: (p) => `Create a reminder for ${p.remindAt}: ${p.message}`,
  async execute(ctx, p): Promise<CreatedReminder> {
    const db = getDb();
    if (p.taskId) {
      // A reminder may only reference the principal's OWN task.
      const task = await db.task.findFirst({ where: { id: p.taskId, principalId: ctx.principalId }, select: { id: true } });
      if (!task) throw new PublicError("That task wasn't found.");
    }
    const reminder = await db.reminder.create({
      data: { principalId: ctx.principalId, message: p.message, remindAt: new Date(p.remindAt), taskId: p.taskId },
    });
    const timeZone = await getPrincipalTimeZone(ctx.principalId);
    return {
      id: reminder.id,
      message: reminder.message,
      remindAt: reminder.remindAt,
      display: `${localDateString(reminder.remindAt, timeZone)} ${formatLocalTime(reminder.remindAt, timeZone)}`,
    };
  },
  successMessage: (data) => {
    const r = data as CreatedReminder;
    return `Reminder set for ${r.display}: ${r.message}`;
  },
};

export function createReminder(identity: IdentityContext, input: CreateReminderInput): Promise<Result> {
  return proposeAction(identity, {
    skillKey: SKILL_KEY,
    action: "CREATE_REMINDER",
    parameters: { message: input.message, remindAt: input.remindAt.toISOString(), ...(input.taskId ? { taskId: input.taskId } : {}) },
  });
}

export interface CreateRelativeReminderInput {
  message: string;
  /** Days from the principal's local "today" (1 = tomorrow). */
  dayOffset: number;
  hour: number;
  minute: number;
}

/**
 * "Tomorrow at 10:00" in the principal's timezone, resolved to one exact
 * UTC instant and proposed like any other reminder (so voice needs approval).
 */
export async function createRelativeReminder(identity: IdentityContext, input: CreateRelativeReminderInput): Promise<Result> {
  const timeZone = await getPrincipalTimeZone(identity.principalId);
  const remindAt = localTimeOnDay(new Date(), timeZone, input.dayOffset, input.hour, input.minute);
  return createReminder(identity, { message: input.message, remindAt });
}

export interface ListRemindersInput {
  principalId: string;
  agentKey: string;
}

export async function listReminders(input: ListRemindersInput): Promise<Result> {
  const result = await gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "READ",
      parameters: {},
    },
    async () => {
      const db = getDb();
      return db.reminder.findMany({
        where: { principalId: input.principalId },
        orderBy: { remindAt: "asc" },
      });
    },
    "skill.system.tasks"
  );
  if (result.status !== "EXECUTED") return result;
  const reminders = result.data as { message: string; remindAt: Date }[];
  if (!reminders.length) return { ...result, message: "You have no reminders." };
  const timeZone = await getPrincipalTimeZone(input.principalId);
  return {
    ...result,
    message: `Your reminders (${reminders.length}):\n` + reminders.map((r) => `• ${localDateString(r.remindAt, timeZone)} ${formatLocalTime(r.remindAt, timeZone)} — ${r.message}`).join("\n"),
  };
}
