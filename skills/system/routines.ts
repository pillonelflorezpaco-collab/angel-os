import { z } from "zod";
import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import { now } from "../../gateway/clock.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import * as routines from "../../routines/store.js";
import { TIME_RE, DAY_RE, describeDays } from "../../routines/schedule.js";
import { define } from "./life.js";

// Routines: the owner's own recurring plan (a meal, a habit, a block of time) and a plain record of whether it was done.
// Writes are ActionDefinitions (strict schema, permission, interface policy, audit); reads use ROUTINE_READ. Angel OS holds and reminds —
// it does not invent a plan, and a check-in is a fact, never a score.

export const SKILL_KEY = "system.routines";
export const RESOURCE = "angel:routines";
export const READ_ACTION = "ROUTINE_READ";
const target = { skillKey: SKILL_KEY, resource: RESOURCE };

const id = z.string().uuid();
const title = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
const note = z.string().trim().min(1).max(1000);
const days = z.array(z.number().int().min(0).max(6)).min(1).max(7);
const time = z.string().regex(TIME_RE, "use 24-hour HH:MM");
const minutes = z.number().int().min(1).max(1440);
const kind = z.enum(["MEAL", "HABIT", "BLOCK", "OTHER"]);
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const routineCreateDefinition = define({
  action: "ROUTINE_CREATE",
  schema: strict({ title, kind: kind.optional(), details: text.optional(), daysOfWeek: days, timeOfDay: time, durationMinutes: minutes.optional() }),
  describe: (p) => `Add routine: ${p.title} at ${p.timeOfDay} (${describeDays(p.daysOfWeek)})`,
  run: (pid, p) => routines.createRoutine(pid, p),
  message: (_r, p) => `Routine added: ${p.title}`,
}, target);

export const routineUpdateDefinition = define({
  action: "ROUTINE_UPDATE",
  schema: strict({ routineId: id, title: title.optional(), kind: kind.optional(), details: text.nullable().optional(), daysOfWeek: days.optional(), timeOfDay: time.optional(), durationMinutes: minutes.nullable().optional() })
    .refine((p) => Object.keys(p).some((k) => k !== "routineId"), { message: "nothing to update" }),
  describe: (p) => `Update routine ${p.routineId}`,
  run: (pid, { routineId, ...d }) => routines.updateRoutine(pid, routineId, d),
  message: () => "Routine updated.",
}, target);

export const routineSetStatusDefinition = define({
  action: "ROUTINE_SET_STATUS",
  schema: strict({ routineId: id, status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]) }),
  describe: (p) => `Set routine ${p.routineId} to ${p.status.toLowerCase()}`,
  run: (pid, p) => routines.setRoutineStatus(pid, p.routineId, p.status),
  message: (_r, p) => `Routine is now ${p.status.toLowerCase()}.`,
}, target);

/** One check-in per routine per local day; recorded, never edited. Not checking a day is "not recorded", not a failure. */
export const routineCheckDefinition = define({
  action: "ROUTINE_CHECK",
  schema: strict({ routineId: id, status: z.enum(["DONE", "SKIPPED"]), day: z.string().regex(DAY_RE, "use YYYY-MM-DD").optional(), note: note.optional() }),
  describe: (p) => `Mark routine ${p.routineId} ${p.status.toLowerCase()}${p.day ? ` for ${p.day}` : " for today"}`,
  run: (pid, p) => routines.checkRoutine(pid, p, now()),
  message: (_r, p) => (p.status === "DONE" ? "Marked done." : "Marked skipped."),
  activity: (c: { id: string; status: string }) => ({ type: "HABIT_COMPLETED", summary: c.status === "DONE" ? "Completed a routine" : "Skipped a routine", refType: "routine_check", refId: c.id }),
}, target);

export const ROUTINE_DEFINITIONS = [routineCreateDefinition, routineUpdateDefinition, routineSetStatusDefinition, routineCheckDefinition];

export function proposeRoutine(identity: IdentityContext, action: string, parameters: unknown): Promise<Result> {
  return proposeAction(identity, { skillKey: SKILL_KEY, action, parameters });
}

function read<T>(identity: IdentityContext, agentKey: string, parameters: Record<string, unknown>, fn: (principalId: string) => Promise<T>): Promise<Result> {
  let explicit: IdentityContext;
  try { explicit = assertExplicitIdentity(identity); } catch { return Promise.resolve({ status: "FAILED", message: "I can't do that without knowing who you are." }); }
  return gatewayExecute({ principalId: explicit.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: READ_ACTION, parameters }, () => fn(explicit.principalId), "skill.system.routines");
}
export const readRoutines = (identity: IdentityContext, input: { agentKey: string }) => read(identity, input.agentKey, { op: "list" }, routines.listRoutines);
export const readTodayPlan = (identity: IdentityContext, input: { agentKey: string }) => read(identity, input.agentKey, { op: "today" }, (pid) => routines.todayPlan(pid, now()));

interface PlanView { weekday: string; hasAnyRoutine: boolean; items: { title: string; kind: string; details: string | null; time: string; state: string; minutesUntil: number | null }[] }
const STATE_WORDS: Record<string, string> = { DONE: "done", SKIPPED: "skipped", PAST_UNRECORDED: "not recorded yet", UPCOMING: "upcoming" };

/** Text for a chat surface. Only what the owner defined; with nothing defined it says so and never suggests a plan. */
export function formatPlan(p: PlanView): string {
  if (!p.hasAnyRoutine) return "You haven't set up any routines yet, so there is no plan to show. I don't make one up.";
  if (!p.items.length) return `Nothing is planned for ${p.weekday}.`;
  return [`Your plan for ${p.weekday}:`, ...p.items.map((i) => `• ${i.time} — ${i.title}${i.details ? `: ${i.details}` : ""} (${STATE_WORDS[i.state] ?? i.state.toLowerCase()}${i.minutesUntil !== null ? `, in ${i.minutesUntil} min` : ""})`)].join("\n");
}
