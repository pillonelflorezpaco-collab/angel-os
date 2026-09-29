import { z } from "zod";
import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import { LIFE_AREA_PATTERN } from "../../activity/service.js";
import * as future from "../../future/store.js";
import { define } from "./life.js";

// Future Self: CURRENT → GAP → DESIRED → NEXT in the owner's words, with evidence-only progress.
// Writes are ActionDefinitions (strict schema, permission, interface policy, audit); reads use FUTURE_READ.
// Nothing here awards points or infers achievement.

export const SKILL_KEY = "system.future";
export const RESOURCE = "angel:future";
export const READ_ACTION = "FUTURE_READ";
const target = { skillKey: SKILL_KEY, resource: RESOURCE };

const id = z.string().uuid();
const title = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
const note = z.string().trim().min(1).max(1000);
const num = z.number().finite();
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const aspirationCreateDefinition = define({
  action: "ASPIRATION_CREATE",
  schema: strict({ title, area: z.string().regex(LIFE_AREA_PATTERN).optional(), current: text, gap: text.optional(), desired: text, goalId: id.optional(), nextTaskId: id.optional(), nextQuestId: id.optional() }),
  describe: (p) => `Add aspiration: ${p.title}`,
  run: (pid, p) => future.createAspiration(pid, p),
  message: (_r, p) => `Aspiration added: ${p.title}`,
}, target);

export const aspirationUpdateDefinition = define({
  action: "ASPIRATION_UPDATE",
  schema: strict({ aspirationId: id, current: text.optional(), gap: text.nullable().optional(), desired: text.optional(), goalId: id.nullable().optional(), nextTaskId: id.nullable().optional(), nextQuestId: id.nullable().optional() })
    .refine((p) => Object.keys(p).some((k) => k !== "aspirationId"), { message: "nothing to update" }),
  describe: (p) => `Update aspiration ${p.aspirationId}`,
  run: (pid, { aspirationId, ...d }) => future.updateAspiration(pid, aspirationId, d),
  message: () => "Aspiration updated.",
}, target);

export const aspirationAchieveDefinition = define({
  action: "ASPIRATION_ACHIEVE",
  schema: strict({ aspirationId: id, note: note.optional() }),
  describe: (p) => `Mark aspiration ${p.aspirationId} achieved`,
  run: (pid, p) => future.closeAspiration(pid, p.aspirationId, "ACHIEVED", p.note),
  message: () => "Aspiration marked achieved.",
  activity: (a: { id: string }) => ({ type: "ACHIEVEMENT", summary: "Achieved an aspiration", refType: "aspiration", refId: a.id }),
}, target);

export const aspirationReleaseDefinition = define({
  action: "ASPIRATION_RELEASE",
  schema: strict({ aspirationId: id, reason: note }),
  describe: (p) => `Release aspiration ${p.aspirationId}`,
  run: (pid, p) => future.closeAspiration(pid, p.aspirationId, "RELEASED", p.reason),
  message: () => "Aspiration released.",
}, target);

/** Baseline and target are fixed at creation: progress can't be gamed by moving the goalposts. */
export const metricCreateDefinition = define({
  action: "METRIC_CREATE",
  schema: strict({ aspirationId: id, name: title, unit: z.string().trim().min(1).max(40), baseline: num, target: num })
    .refine((p) => p.baseline !== p.target, { message: "baseline and target must differ" }),
  describe: (p) => `Add metric ${p.name} (${p.baseline} → ${p.target} ${p.unit})`,
  run: (pid, p) => future.createMetric(pid, p),
  message: (_r, p) => `Metric added: ${p.name}`,
}, target);

export const metricReadingDefinition = define({
  action: "METRIC_READING_RECORD",
  schema: strict({ metricId: id, value: num, observedAt: z.string().datetime().optional(), resultId: id.optional(), note: note.optional() }),
  describe: (p) => `Record a reading (${p.value}) for metric ${p.metricId}`,
  run: (pid, p) => future.recordReading(pid, { ...p, observedAt: p.observedAt ? new Date(p.observedAt) : undefined }),
  message: () => "Reading recorded.",
  activity: (r: { id: string }) => ({ type: "GOAL_PROGRESS", summary: "Recorded a progress reading", refType: "metric_reading", refId: r.id }),
}, target);

export const FUTURE_DEFINITIONS = [aspirationCreateDefinition, aspirationUpdateDefinition, aspirationAchieveDefinition, aspirationReleaseDefinition, metricCreateDefinition, metricReadingDefinition];

export function proposeFuture(identity: IdentityContext, action: string, parameters: unknown): Promise<Result> {
  return proposeAction(identity, { skillKey: SKILL_KEY, action, parameters });
}

function read<T>(identity: IdentityContext, agentKey: string, parameters: Record<string, unknown>, fn: (principalId: string) => Promise<T>): Promise<Result> {
  let explicit: IdentityContext;
  try { explicit = assertExplicitIdentity(identity); } catch { return Promise.resolve({ status: "FAILED", message: "I can't do that without knowing who you are." }); }
  return gatewayExecute({ principalId: explicit.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: READ_ACTION, parameters }, () => fn(explicit.principalId), "skill.system.future");
}
export const readFutureOverview = (identity: IdentityContext, input: { agentKey: string }) => read(identity, input.agentKey, { op: "overview" }, future.futureOverview);
export const readAspiration = (identity: IdentityContext, input: { agentKey: string; aspirationId: string }) => read(identity, input.agentKey, { op: "get", aspirationId: input.aspirationId }, (pid) => future.getAspiration(pid, input.aspirationId));
