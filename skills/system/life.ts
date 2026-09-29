import { z } from "zod";
import { gatewayExecute } from "../../gateway/index.js";
import type { ActionDefinition, ExecutionContext } from "../../gateway/index.js";
import { proposeAction } from "../../gateway/index.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import { recordActivity } from "../../activity/service.js";
import { JARVIS_AGENT_KEY } from "../agent.js";
import * as life from "../../life/store.js";

// Life OS structure: Vision → Goal → Project → Quest → Task, plus People and links.
//
//   READS  → the READ lane (LIFE_READ).
//   WRITES → ActionDefinitions: strict schema, exact parameters, permission +
//            category, interface policy, approval where policy demands it, audit.
//
// Nothing here scores or infers progress: status changes are claims made by the
// owner, and derived counts are plain counts. Completion is never automatic.

export const SKILL_KEY = "system.life";
export const RESOURCE = "angel:life";
export const READ_ACTION = "LIFE_READ";

const id = z.string().uuid();
const title = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
const note = z.string().trim().min(1).max(1000);
const instant = z.string().datetime();
const when = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));

interface Spec<P> {
  action: string;
  risk?: "LOW" | "SENSITIVE";
  schema: z.ZodType<P, z.ZodTypeDef, unknown>;
  describe(p: P): string;
  run(principalId: string, p: P, ctx: ExecutionContext): Promise<unknown>;
  message(result: any, p: P): string;
  activity?: (result: any) => Parameters<typeof recordActivity>[0] extends infer A ? Omit<A & object, "principalId"> : never;
}

function define<P>(s: Spec<P>): ActionDefinition<P> {
  return {
    skillKey: SKILL_KEY,
    action: s.action,
    resource: RESOURCE,
    category: "WRITE",
    risk: s.risk ?? "LOW",
    agentKey: JARVIS_AGENT_KEY,
    schema: s.schema,
    describe: s.describe,
    async execute(ctx, p) {
      const result = await s.run(ctx.principalId, p, ctx);
      // Life history references the row; it never copies content. Best-effort by design.
      if (s.activity) await recordActivity({ principalId: ctx.principalId, ...s.activity(result) } as never);
      return result;
    },
    successMessage: (r, p) => s.message(r, p),
  };
}

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const atLeastOne = <T extends z.ZodTypeAny>(schema: T, keys: string[]) =>
  schema.refine((v: Record<string, unknown>) => keys.some((k) => v[k] !== undefined), { message: "nothing to update" });

// ── Vision ──────────────────────────────────────────────────────────────────
export const visionCreateDefinition = define({
  action: "VISION_CREATE",
  schema: strict({ title, statement: text }),
  describe: (p) => `Create vision: ${p.title}`,
  run: (pid, p) => life.createVision(pid, p),
  message: (_r, p) => `Vision created: ${p.title}`,
});
export const visionUpdateDefinition = define({
  action: "VISION_UPDATE",
  schema: atLeastOne(strict({ visionId: id, title: title.optional(), statement: text.optional() }), ["title", "statement"]),
  describe: (p) => `Update vision ${p.visionId}`,
  run: (pid, { visionId, ...d }) => life.updateVision(pid, visionId, d),
  message: () => "Vision updated.",
});
export const visionArchiveDefinition = define({
  action: "VISION_ARCHIVE",
  schema: strict({ visionId: id }),
  describe: (p) => `Archive vision ${p.visionId}`,
  run: (pid, p) => life.archiveVision(pid, p.visionId),
  message: () => "Vision archived.",
});

// ── Goal ────────────────────────────────────────────────────────────────────
export const goalCreateDefinition = define({
  action: "GOAL_CREATE",
  schema: strict({ title, description: text.optional(), horizon: z.enum(["SHORT", "MEDIUM", "LONG"]).optional(), targetDate: instant.optional(), visionId: id.optional() }),
  describe: (p) => `Create goal: ${p.title}`,
  run: (pid, p) => life.createGoal(pid, { ...p, targetDate: when(p.targetDate) }),
  message: (_r, p) => `Goal created: ${p.title}`,
});
export const goalUpdateDefinition = define({
  action: "GOAL_UPDATE",
  schema: atLeastOne(strict({ goalId: id, title: title.optional(), description: text.optional(), horizon: z.enum(["SHORT", "MEDIUM", "LONG"]).optional(), targetDate: instant.nullable().optional(), visionId: id.nullable().optional() }), ["title", "description", "horizon", "targetDate", "visionId"]),
  describe: (p) => `Update goal ${p.goalId}`,
  run: (pid, { goalId, targetDate, ...d }) => life.updateGoal(pid, goalId, { ...d, targetDate: when(targetDate) }),
  message: () => "Goal updated.",
});
export const goalAchieveDefinition = define({
  action: "GOAL_ACHIEVE",
  schema: strict({ goalId: id, note: note.optional() }),
  describe: (p) => `Mark goal ${p.goalId} achieved`,
  run: (pid, p) => life.closeGoal(pid, p.goalId, "ACHIEVED", p.note),
  message: () => "Goal marked achieved.",
  activity: (g: { id: string }) => ({ type: "ACHIEVEMENT", summary: "Achieved a goal", refType: "goal", refId: g.id }),
});
export const goalAbandonDefinition = define({
  action: "GOAL_ABANDON",
  schema: strict({ goalId: id, reason: note }),
  describe: (p) => `Abandon goal ${p.goalId}`,
  run: (pid, p) => life.closeGoal(pid, p.goalId, "ABANDONED", p.reason),
  message: () => "Goal abandoned.",
});

// ── Project ─────────────────────────────────────────────────────────────────
export const projectCreateDefinition = define({
  action: "PROJECT_CREATE",
  schema: strict({ name: title, description: text.optional(), goalId: id.optional(), targetDate: instant.optional() }),
  describe: (p) => `Create project: ${p.name}`,
  run: (pid, p) => life.createProject(pid, { ...p, targetDate: when(p.targetDate) }),
  message: (_r, p) => `Project created: ${p.name}`,
});
export const projectUpdateDefinition = define({
  action: "PROJECT_UPDATE",
  schema: atLeastOne(strict({ projectId: id, name: title.optional(), description: text.optional(), goalId: id.nullable().optional(), targetDate: instant.nullable().optional() }), ["name", "description", "goalId", "targetDate"]),
  describe: (p) => `Update project ${p.projectId}`,
  run: (pid, { projectId, targetDate, ...d }) => life.updateProject(pid, projectId, { ...d, targetDate: when(targetDate) }),
  message: () => "Project updated.",
});
export const projectSetStatusDefinition = define({
  action: "PROJECT_SET_STATUS",
  schema: strict({ projectId: id, status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]) }),
  describe: (p) => `Set project ${p.projectId} to ${p.status.toLowerCase()}`,
  run: (pid, p) => life.setProjectStatus(pid, p.projectId, p.status),
  message: (_r, p) => `Project is now ${p.status.toLowerCase()}.`,
});
export const projectLinkPersonDefinition = define({
  action: "PROJECT_LINK_PERSON",
  schema: strict({ projectId: id, personId: id, role: title.optional() }),
  describe: (p) => `Link person ${p.personId} to project ${p.projectId}`,
  run: (pid, p) => life.linkPerson(pid, p.projectId, p.personId, p.role),
  message: () => "Person linked to the project.",
});
export const projectUnlinkPersonDefinition = define({
  action: "PROJECT_UNLINK_PERSON",
  schema: strict({ projectId: id, personId: id }),
  describe: (p) => `Unlink person ${p.personId} from project ${p.projectId}`,
  run: (pid, p) => life.unlinkPerson(pid, p.projectId, p.personId),
  message: () => "Person unlinked.",
});
export const projectLinkKnowledgeDefinition = define({
  action: "PROJECT_LINK_KNOWLEDGE",
  schema: strict({ projectId: id, itemId: id, note: note.optional() }),
  describe: (p) => `Link knowledge ${p.itemId} to project ${p.projectId}`,
  run: (pid, p) => life.linkKnowledge(pid, p.projectId, p.itemId, p.note),
  message: () => "Knowledge linked to the project.",
});
export const projectUnlinkKnowledgeDefinition = define({
  action: "PROJECT_UNLINK_KNOWLEDGE",
  schema: strict({ projectId: id, itemId: id }),
  describe: (p) => `Unlink knowledge ${p.itemId} from project ${p.projectId}`,
  run: (pid, p) => life.unlinkKnowledge(pid, p.projectId, p.itemId),
  message: () => "Knowledge unlinked.",
});

// ── Quest ───────────────────────────────────────────────────────────────────
export const questCreateDefinition = define({
  action: "QUEST_CREATE",
  // `criteria` is REQUIRED and explicit: what "done" means is written by the owner, never inferred.
  schema: strict({ projectId: id, title, objective: text, criteria: text, dueAt: instant.optional() }),
  describe: (p) => `Create quest: ${p.title}`,
  run: (pid, p) => life.createQuest(pid, { ...p, dueAt: when(p.dueAt) }),
  message: (_r, p) => `Quest created: ${p.title}`,
});
export const questUpdateDefinition = define({
  action: "QUEST_UPDATE",
  schema: atLeastOne(strict({ questId: id, title: title.optional(), objective: text.optional(), criteria: text.optional(), dueAt: instant.nullable().optional() }), ["title", "objective", "criteria", "dueAt"]),
  describe: (p) => `Update quest ${p.questId}`,
  run: (pid, { questId, dueAt, ...d }) => life.updateQuest(pid, questId, { ...d, dueAt: when(dueAt) }),
  message: () => "Quest updated.",
});
export const questStartDefinition = define({
  action: "QUEST_START",
  schema: strict({ questId: id }),
  describe: (p) => `Start quest ${p.questId}`,
  run: (pid, p) => life.startQuest(pid, p.questId),
  message: () => "Quest started.",
});
export const questCompleteDefinition = define({
  action: "QUEST_COMPLETE",
  schema: strict({ questId: id, note: note.optional() }),
  describe: (p) => `Complete quest ${p.questId}`,
  run: (pid, p) => life.closeQuest(pid, p.questId, "COMPLETED", p.note),
  message: () => "Quest completed.",
  activity: (q: { id: string }) => ({ type: "QUEST_COMPLETED", summary: "Completed a quest", refType: "quest", refId: q.id }),
});
export const questAbandonDefinition = define({
  action: "QUEST_ABANDON",
  schema: strict({ questId: id, reason: note }),
  describe: (p) => `Abandon quest ${p.questId}`,
  run: (pid, p) => life.closeQuest(pid, p.questId, "ABANDONED", p.reason),
  message: () => "Quest abandoned.",
});

// ── Person ──────────────────────────────────────────────────────────────────
export const personCreateDefinition = define({
  action: "PERSON_CREATE",
  schema: strict({ name: title, relationship: title.optional(), notes: text.optional() }),
  describe: (p) => `Add person: ${p.name}`,
  run: (pid, p) => life.createPerson(pid, p),
  message: (_r, p) => `Added ${p.name}.`,
});
export const personUpdateDefinition = define({
  action: "PERSON_UPDATE",
  schema: atLeastOne(strict({ personId: id, name: title.optional(), relationship: title.nullable().optional(), notes: text.nullable().optional() }), ["name", "relationship", "notes"]),
  describe: (p) => `Update person ${p.personId}`,
  run: (pid, { personId, ...d }) => life.updatePerson(pid, personId, d),
  message: () => "Person updated.",
});
export const personDeleteDefinition = define({
  action: "PERSON_DELETE",
  risk: "SENSITIVE",
  schema: strict({ personId: id }),
  describe: (p) => `Delete person ${p.personId} (their project links are removed; tasks keep existing)`,
  run: (pid, p) => life.deletePerson(pid, p.personId),
  message: () => "Person deleted.",
});

export const LIFE_DEFINITIONS = [
  visionCreateDefinition, visionUpdateDefinition, visionArchiveDefinition,
  goalCreateDefinition, goalUpdateDefinition, goalAchieveDefinition, goalAbandonDefinition,
  projectCreateDefinition, projectUpdateDefinition, projectSetStatusDefinition,
  projectLinkPersonDefinition, projectUnlinkPersonDefinition, projectLinkKnowledgeDefinition, projectUnlinkKnowledgeDefinition,
  questCreateDefinition, questUpdateDefinition, questStartDefinition, questCompleteDefinition, questAbandonDefinition,
  personCreateDefinition, personUpdateDefinition, personDeleteDefinition,
] as ActionDefinition<any>[];

/** Propose any life action by name with an explicit identity (the only entry point for interfaces and Core). */
export function proposeLife(identity: IdentityContext, action: string, parameters: unknown): Promise<Result> {
  return proposeAction(identity, { skillKey: SKILL_KEY, action, parameters });
}

// ── Reads (READ lane) ───────────────────────────────────────────────────────
const IDENTITY_REQUIRED: Result = { status: "FAILED", message: "I can't do that without knowing who you are." };

function read<T>(identity: IdentityContext, agentKey: string, parameters: Record<string, unknown>, fn: (principalId: string) => Promise<T>): Promise<Result> {
  let explicit: IdentityContext;
  try {
    explicit = assertExplicitIdentity(identity);
  } catch {
    return Promise.resolve(IDENTITY_REQUIRED);
  }
  return gatewayExecute(
    { principalId: explicit.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: READ_ACTION, parameters },
    () => fn(explicit.principalId),
    "skill.system.life"
  );
}

export const readLifeOverview = (identity: IdentityContext, input: { agentKey: string }) => read(identity, input.agentKey, { op: "overview" }, life.lifeOverview);
export const readProject = (identity: IdentityContext, input: { agentKey: string; projectId: string }) => read(identity, input.agentKey, { op: "project", projectId: input.projectId }, (pid) => life.getProject(pid, input.projectId));
export const readPeople = (identity: IdentityContext, input: { agentKey: string }) => read(identity, input.agentKey, { op: "people" }, life.listPeople);
