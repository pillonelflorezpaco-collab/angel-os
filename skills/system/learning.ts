import { z } from "zod";
import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import { LIFE_AREA_PATTERN } from "../../activity/service.js";
import * as learning from "../../learning/store.js";
import * as exp from "../../learning/experiments.js";
import { getMemoryProvider } from "../../memory/index.js";
import { define } from "./life.js";

// Learning Lab: topics, self-reported study sessions, recall cards. Writes are ActionDefinitions
// (strict schema, permission, interface policy, audit); reads use LEARNING_READ. Cards are written by the
// owner — nothing here generates content or declares anything "mastered".

export const SKILL_KEY = "system.learning";
export const RESOURCE = "angel:learning";
export const READ_ACTION = "LEARNING_READ";
const target = { skillKey: SKILL_KEY, resource: RESOURCE };

const id = z.string().uuid();
const title = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const instant = z.string().datetime();

export const topicCreateDefinition = define({
  action: "TOPIC_CREATE",
  schema: strict({ title, area: z.string().regex(LIFE_AREA_PATTERN).optional(), intent: text.optional(), goalId: id.optional() }),
  describe: (p) => `Start learning topic: ${p.title}`,
  run: (pid, p) => learning.createTopic(pid, p),
  message: (_r, p) => `Topic added: ${p.title}`,
}, target);

export const topicUpdateDefinition = define({
  action: "TOPIC_UPDATE",
  schema: strict({ topicId: id, title: title.optional(), area: z.string().regex(LIFE_AREA_PATTERN).nullable().optional(), intent: text.nullable().optional(), goalId: id.nullable().optional() })
    .refine((p) => Object.keys(p).some((k) => k !== "topicId"), { message: "nothing to update" }),
  describe: (p) => `Update topic ${p.topicId}`,
  run: (pid, { topicId, ...d }) => learning.updateTopic(pid, topicId, d),
  message: () => "Topic updated.",
}, target);

export const topicSetStatusDefinition = define({
  action: "TOPIC_SET_STATUS",
  schema: strict({ topicId: id, status: z.enum(["ACTIVE", "PAUSED", "COMPLETED"]) }),
  describe: (p) => `Set topic ${p.topicId} to ${p.status.toLowerCase()}`,
  run: (pid, p) => learning.setTopicStatus(pid, p.topicId, p.status),
  message: (_r, p) => `Topic is now ${p.status.toLowerCase()}.`,
}, target);

export const sessionLogDefinition = define({
  action: "SESSION_LOG",
  schema: strict({ topicId: id, minutes: z.number().int().min(1).max(720), studiedAt: instant.optional(), note: text.optional(), knowledgeItemId: id.optional() }),
  describe: (p) => `Log a ${p.minutes}-minute study session on topic ${p.topicId}`,
  run: (pid, p) => learning.logSession(pid, { ...p, studiedAt: p.studiedAt ? new Date(p.studiedAt) : undefined }),
  message: (_r, p) => `Logged ${p.minutes} minutes.`,
  activity: (s: { id: string; studiedAt: Date }) => ({ type: "LEARNING_SESSION", summary: "Studied", refType: "learning_session", refId: s.id, occurredAt: s.studiedAt }),
}, target);

export const cardCreateDefinition = define({
  action: "CARD_CREATE",
  schema: strict({ topicId: id, prompt: text, answer: text, knowledgeItemId: id.optional() }),
  describe: (p) => `Add a recall card to topic ${p.topicId}`,
  run: (pid, p) => learning.createCard(pid, p),
  message: () => "Card added.",
}, target);

export const cardReviewDefinition = define({
  action: "CARD_REVIEW",
  schema: strict({ cardId: id, grade: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), reviewedAt: instant.optional() }),
  describe: (p) => `Review card ${p.cardId} (grade ${p.grade})`,
  run: (pid, p) => learning.reviewCard(pid, { ...p, reviewedAt: p.reviewedAt ? new Date(p.reviewedAt) : undefined }),
  message: () => "Review recorded.",
}, target);

export const cardRetireDefinition = define({
  action: "CARD_RETIRE",
  schema: strict({ cardId: id }),
  describe: (p) => `Retire card ${p.cardId}`,
  run: (pid, p) => learning.retireCard(pid, p.cardId),
  message: () => "Card retired.",
}, target);

export const objectiveCreateDefinition = define({
  action: "OBJECTIVE_CREATE",
  schema: strict({ title, evidenceStandard: text, topicId: id.optional(), aspirationId: id.optional() }),
  describe: (p) => `Set learning objective: ${p.title}`,
  run: (pid, p) => exp.createObjective(pid, p),
  message: (_r, p) => `Objective set: ${p.title}`,
}, target);

/** Meeting an objective is the owner's claim and needs linked supporting evidence; abandoning needs a reason. */
export const objectiveCloseDefinition = define({
  action: "OBJECTIVE_CLOSE",
  schema: strict({ objectiveId: id, outcome: z.enum(["MET", "ABANDONED"]), note: text.optional() }),
  describe: (p) => `Mark objective ${p.objectiveId} ${p.outcome.toLowerCase()}`,
  run: (pid, p) => exp.closeObjective(pid, p.objectiveId, p.outcome, p.note),
  message: (_r, p) => `Objective ${p.outcome.toLowerCase()}.`,
}, target);

export const experimentCreateDefinition = define({
  action: "EXPERIMENT_CREATE",
  schema: strict({ hypothesis: text, method: text, objectiveId: id.optional() }),
  describe: (p) => `Propose experiment: ${p.hypothesis}`,
  run: (pid, p) => exp.createExperiment(pid, p),
  message: () => "Experiment proposed (candidate).",
}, target);

export const experimentObserveDefinition = define({
  action: "EXPERIMENT_OBSERVE",
  schema: strict({ experimentId: id, text, observedAt: instant.optional() }),
  describe: (p) => `Record an observation for experiment ${p.experimentId}`,
  run: (pid, p) => exp.addObservation(pid, { experimentId: p.experimentId, text: p.text, observedAt: p.observedAt ? new Date(p.observedAt) : undefined }),
  message: () => "Observation recorded.",
}, target);

export const experimentTransitionDefinition = define({
  action: "EXPERIMENT_TRANSITION",
  schema: strict({ experimentId: id, to: z.enum(["OBSERVED", "SUPPORTED", "CONFIRMED", "REJECTED"]), note: text.optional() }),
  describe: (p) => `Move experiment ${p.experimentId} to ${p.to.toLowerCase()}`,
  run: (pid, p) => exp.transitionExperiment(pid, p.experimentId, p.to, p.note),
  message: (_r, p) => `Experiment is now ${p.to.toLowerCase()}.`,
}, target);

/** A lesson is explicit learning drawn from an experiment: a LESSON memory that references it. It never rewrites the experiment. */
export const lessonRecordDefinition = define({
  action: "LESSON_RECORD",
  schema: strict({ experimentId: id, content: text }),
  describe: (p) => `Record a lesson from experiment ${p.experimentId}`,
  run: async (pid, p) => {
    await exp.assertLessonSource(pid, p.experimentId);
    return getMemoryProvider().addMemory({ principalId: pid, type: "LESSON", provenance: "EXPERIENCED", content: p.content, source: "learning.experiment", sourceRef: `experiment:${p.experimentId}` });
  },
  message: () => "Lesson recorded.",
}, target);

export const LEARNING_DEFINITIONS = [objectiveCreateDefinition, objectiveCloseDefinition, experimentCreateDefinition, experimentObserveDefinition, experimentTransitionDefinition, lessonRecordDefinition, topicCreateDefinition, topicUpdateDefinition, topicSetStatusDefinition, sessionLogDefinition, cardCreateDefinition, cardReviewDefinition, cardRetireDefinition];

export function proposeLearning(identity: IdentityContext, action: string, parameters: unknown): Promise<Result> {
  return proposeAction(identity, { skillKey: SKILL_KEY, action, parameters });
}

function read<T>(identity: IdentityContext, agentKey: string, parameters: Record<string, unknown>, fn: (principalId: string) => Promise<T>): Promise<Result> {
  let explicit: IdentityContext;
  try { explicit = assertExplicitIdentity(identity); } catch { return Promise.resolve({ status: "FAILED", message: "I can't do that without knowing who you are." }); }
  return gatewayExecute({ principalId: explicit.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: READ_ACTION, parameters }, () => fn(explicit.principalId), "skill.system.learning");
}
export const readLearningOverview = (identity: IdentityContext, input: { agentKey: string; now?: Date }) => read(identity, input.agentKey, { op: "overview" }, (pid) => learning.learningOverview(pid, input.now));
export const readDueCards = (identity: IdentityContext, input: { agentKey: string; topicId?: string; limit?: number; now?: Date }) =>
  read(identity, input.agentKey, { op: "due", topicId: input.topicId ?? null, limit: input.limit ?? null }, (pid) => learning.dueCards(pid, input.now, { topicId: input.topicId, limit: input.limit }));
export const readCard = (identity: IdentityContext, input: { agentKey: string; cardId: string; now?: Date }) => read(identity, input.agentKey, { op: "card", cardId: input.cardId }, (pid) => learning.getCard(pid, input.cardId, input.now));
export const readObjectives = (identity: IdentityContext, input: { agentKey: string }) => read(identity, input.agentKey, { op: "objectives" }, exp.listObjectives);
export const readExperiments = (identity: IdentityContext, input: { agentKey: string }) => read(identity, input.agentKey, { op: "experiments" }, exp.listExperiments);
export const readExperiment = (identity: IdentityContext, input: { agentKey: string; experimentId: string }) => read(identity, input.agentKey, { op: "experiment", experimentId: input.experimentId }, (pid) => exp.getExperiment(pid, input.experimentId));
