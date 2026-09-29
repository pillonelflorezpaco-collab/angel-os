import { readerIdentity, IDENTITY_REQUIRED } from "../readerIdentity.js";
import { getDb } from "../../db/client/index.js";
import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import type { ActionDefinition } from "../../gateway/index.js";
import { z } from "zod";
import { PublicError } from "../../core/errors.js";
import { assertTaskLinks, closeTask, updateTask } from "../../life/store.js";
import { recordActivity } from "../../activity/service.js";
import type { IdentityContext } from "../../identity/index.js";
import { JARVIS_AGENT_KEY } from "../agent.js";
import type { Result } from "../../core/types/index.js";
import { localTimeOnDay } from "../../core/time.js";
import { getPrincipalTimeZone } from "./principal.js";
import { formatLocalTime, localDateString } from "../../core/time.js";

export const SKILL_KEY = "system.tasks";
export const RESOURCE = "angel:tasks";

export interface CreateTaskInput {
  title: string;
  description?: string;
  dueAt?: Date;
  projectId?: string;
  questId?: string;
  relatedPersonId?: string;
}

const taskParams = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    dueAt: z.string().datetime().optional(),
    // Optional structure links; ownership is verified in execute (and again by the database).
    projectId: z.string().uuid().optional(),
    questId: z.string().uuid().optional(),
    relatedPersonId: z.string().uuid().optional(),
  })
  .strict();
type TaskParams = z.infer<typeof taskParams>;

/**
 * CREATE_TASK as a registered ActionDefinition (BUILD #8): explicit identity,
 * strict schema, interface policy. LOW risk: direct on GuideHub/API/Telegram,
 * approval on voice and SYSTEM. No Activity row: there is no
 * task-created activity type (only TASK_COMPLETED), and nothing completes tasks yet.
 */
export const createTaskDefinition: ActionDefinition<TaskParams> = {
  skillKey: SKILL_KEY,
  action: "CREATE_TASK",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: taskParams,
  describe: (p) => `Add task: ${p.title}`,
  async execute(ctx, p) {
    await assertTaskLinks(ctx.principalId, p);
    return getDb().task.create({
      data: {
        principalId: ctx.principalId,
        title: p.title,
        description: p.description,
        dueAt: p.dueAt ? new Date(p.dueAt) : undefined,
        projectId: p.projectId,
        questId: p.questId,
        relatedPersonId: p.relatedPersonId,
      },
    });
  },
  successMessage: (task, p) => `Task added: ${p.title}`,
};

export function createTask(identity: IdentityContext, input: CreateTaskInput): Promise<Result> {
  return proposeAction(identity, {
    skillKey: SKILL_KEY,
    action: "CREATE_TASK",
    parameters: {
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.dueAt ? { dueAt: input.dueAt.toISOString() } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.questId ? { questId: input.questId } : {}),
      ...(input.relatedPersonId ? { relatedPersonId: input.relatedPersonId } : {}),
    },
  });
}

const taskId = z.string().uuid();
const nullableDate = z.string().datetime().nullable().optional();

const taskUpdateParams = z
  .object({
    taskId,
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    dueAt: nullableDate,
    status: z.enum(["TODO", "IN_PROGRESS"]).optional(),
    projectId: z.string().uuid().nullable().optional(),
    questId: z.string().uuid().nullable().optional(),
    relatedPersonId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).some((k) => k !== "taskId"), { message: "nothing to update" });

export const taskUpdateDefinition: ActionDefinition<z.infer<typeof taskUpdateParams>> = {
  skillKey: SKILL_KEY,
  action: "TASK_UPDATE",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: taskUpdateParams,
  describe: (p) => `Update task ${p.taskId}`,
  execute: (ctx, { taskId: id, dueAt, ...d }) =>
    updateTask(ctx.principalId, id, { ...d, dueAt: dueAt === undefined ? undefined : dueAt === null ? null : new Date(dueAt) }),
  successMessage: () => "Task updated.",
};

const taskCloseParams = z.object({ taskId }).strict();

/** Completing is the owner's claim, never inferred; DONE and CANCELLED are terminal (a new task is created instead of reopening). */
export const taskCompleteDefinition: ActionDefinition<z.infer<typeof taskCloseParams>> = {
  skillKey: SKILL_KEY,
  action: "TASK_COMPLETE",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: taskCloseParams,
  describe: (p) => `Mark task ${p.taskId} done`,
  async execute(ctx, p) {
    const task = await closeTask(ctx.principalId, p.taskId, "DONE");
    await recordActivity({ principalId: ctx.principalId, type: "TASK_COMPLETED", summary: "Completed a task", refType: "task", refId: task.id });
    return task;
  },
  successMessage: () => "Task marked done.",
};

export const taskCancelDefinition: ActionDefinition<z.infer<typeof taskCloseParams>> = {
  skillKey: SKILL_KEY,
  action: "TASK_CANCEL",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: taskCloseParams,
  describe: (p) => `Cancel task ${p.taskId}`,
  execute: (ctx, p) => closeTask(ctx.principalId, p.taskId, "CANCELLED"),
  successMessage: () => "Task cancelled.",
};

export function proposeTaskAction(identity: IdentityContext, action: "TASK_UPDATE" | "TASK_COMPLETE" | "TASK_CANCEL", parameters: unknown): Promise<Result> {
  return proposeAction(identity, { skillKey: SKILL_KEY, action, parameters });
}

export interface ListTasksInput {
  agentKey: string;
}

export async function listTasks(identity: IdentityContext, raw: ListTasksInput): Promise<Result> {
  const who = readerIdentity(identity);
  if (!who) return IDENTITY_REQUIRED;
  const input = { ...raw, principalId: who.principalId };
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
  agentKey: string;
}

export async function listReminders(identity: IdentityContext, raw: ListRemindersInput): Promise<Result> {
  const who = readerIdentity(identity);
  if (!who) return IDENTITY_REQUIRED;
  const input = { ...raw, principalId: who.principalId };
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
