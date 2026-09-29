import { z } from "zod";
import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import { LIFE_AREA_PATTERN } from "../../activity/service.js";
import * as learning from "../../learning/store.js";
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

export const LEARNING_DEFINITIONS = [topicCreateDefinition, topicUpdateDefinition, topicSetStatusDefinition, sessionLogDefinition, cardCreateDefinition, cardReviewDefinition, cardRetireDefinition];

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
