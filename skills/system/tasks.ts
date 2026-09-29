import { getDb } from "../../db/client/index.js";
import { gatewayExecute } from "../../gateway/index.js";
import type { Result } from "../../core/types/index.js";
import { localTimeOnDay } from "../../core/time.js";
import { getPrincipalTimeZone } from "./principal.js";

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
  return gatewayExecute(
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
}

export interface ListTasksInput {
  principalId: string;
  agentKey: string;
}

export async function listTasks(input: ListTasksInput): Promise<Result> {
  return gatewayExecute(
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
}

export interface CreateReminderInput {
  principalId: string;
  agentKey: string;
  message: string;
  remindAt: Date;
  taskId?: string;
}

export async function createReminder(input: CreateReminderInput): Promise<Result> {
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "CREATE_REMINDER",
      parameters: { message: input.message, remindAt: input.remindAt.toISOString() },
    },
    async () => {
      const db = getDb();
      return db.reminder.create({
        data: {
          principalId: input.principalId,
          message: input.message,
          remindAt: input.remindAt,
          taskId: input.taskId,
        },
      });
    },
    "skill.system.tasks"
  );
}

export interface CreateRelativeReminderInput {
  principalId: string;
  agentKey: string;
  message: string;
  /** Days from the principal's local "today" (1 = tomorrow). */
  dayOffset: number;
  hour: number;
  minute: number;
}

/**
 * Creates a reminder at a wall-clock time on a user-relative day
 * ("tomorrow at 10:00"), interpreted in the principal's timezone and
 * stored as a UTC instant. Same permission as createReminder.
 */
export async function createRelativeReminder(input: CreateRelativeReminderInput): Promise<Result> {
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "CREATE_REMINDER",
      parameters: { message: input.message, dayOffset: input.dayOffset, hour: input.hour, minute: input.minute },
    },
    async () => {
      const timeZone = await getPrincipalTimeZone(input.principalId);
      const remindAt = localTimeOnDay(new Date(), timeZone, input.dayOffset, input.hour, input.minute);
      return getDb().reminder.create({
        data: { principalId: input.principalId, message: input.message, remindAt },
      });
    },
    "skill.system.tasks"
  );
}

export interface ListRemindersInput {
  principalId: string;
  agentKey: string;
}

export async function listReminders(input: ListRemindersInput): Promise<Result> {
  return gatewayExecute(
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
}
