import type { Prisma } from "@prisma/client";
import { getDb } from "../db/client/index.js";
import { PublicError } from "../core/errors.js";

// Postgres persistence for Life OS structure (Vision → Goal → Project → Quest → Task,
// plus People and links). Every query is scoped by principalId in the same
// statement, every reference is ownership-checked before it is written, and every
// status change is an atomic conditional update (`where id, principalId, status in
// allowedFrom`), so two racing transitions can never both win. The database
// enforces the same rules again (life_owner_guard / life_immutable_guard triggers).
// The store performs NO authorization beyond ownership: permission, risk policy and
// approval live above it (skills/system/life.ts + the gateway).

export class LifeNotFoundError extends PublicError {
  constructor(what = "item") {
    super(`That ${what} wasn't found.`);
  }
}
export class LifeStateError extends PublicError {}

export type LifeKind = "vision" | "goal" | "project" | "quest" | "person" | "task" | "knowledge" | "decision" | "memory" | "result";

const LABEL: Record<LifeKind, string> = { vision: "vision", goal: "goal", project: "project", quest: "quest", person: "person", task: "task", knowledge: "knowledge item", decision: "decision", memory: "memory", result: "result" };

/** Throws LifeNotFoundError unless the row exists AND belongs to the principal. Never reveals which. */
export async function assertOwned(principalId: string, kind: LifeKind, id: string, tx: Prisma.TransactionClient | ReturnType<typeof getDb> = getDb()): Promise<void> {
  const where = { id, principalId };
  const select = { id: true };
  const row =
    kind === "vision" ? await tx.vision.findFirst({ where, select })
    : kind === "goal" ? await tx.goal.findFirst({ where, select })
    : kind === "project" ? await tx.project.findFirst({ where, select })
    : kind === "quest" ? await tx.quest.findFirst({ where, select })
    : kind === "person" ? await tx.person.findFirst({ where, select })
    : kind === "task" ? await tx.task.findFirst({ where, select })
    : kind === "decision" ? await tx.decision.findFirst({ where, select })
    : kind === "result" ? await tx.result.findFirst({ where, select })
    : kind === "memory" ? await tx.memory.findFirst({ where: { ...where, status: { not: "RETRACTED" } }, select })
    : await tx.knowledgeItem.findFirst({ where: { ...where, status: "ACTIVE" }, select });
  if (!row) throw new LifeNotFoundError(LABEL[kind]);
}

async function assertOptional(principalId: string, kind: LifeKind, id: string | null | undefined): Promise<void> {
  if (id) await assertOwned(principalId, kind, id);
}

const notActionable = (what: string, status: string) => new LifeStateError(`That ${what} is ${status.toLowerCase()} and can't be changed.`);

// ── Vision ──────────────────────────────────────────────────────────────────
export async function createVision(principalId: string, d: { title: string; statement: string }) {
  return getDb().vision.create({ data: { principalId, ...d } });
}
export async function updateVision(principalId: string, id: string, d: { title?: string; statement?: string }) {
  const r = await getDb().vision.updateMany({ where: { id, principalId, status: "ACTIVE" }, data: d });
  if (r.count === 0) return missOrTerminal(principalId, "vision", id);
  return getDb().vision.findFirstOrThrow({ where: { id, principalId } });
}
export async function archiveVision(principalId: string, id: string) {
  const r = await getDb().vision.updateMany({ where: { id, principalId, status: "ACTIVE" }, data: { status: "ARCHIVED" } });
  if (r.count === 0) return missOrTerminal(principalId, "vision", id);
  return getDb().vision.findFirstOrThrow({ where: { id, principalId } });
}

// ── Goal ────────────────────────────────────────────────────────────────────
export interface GoalInput { title: string; description?: string; horizon?: "SHORT" | "MEDIUM" | "LONG"; targetDate?: Date | null; visionId?: string | null }
export async function createGoal(principalId: string, d: GoalInput) {
  await assertOptional(principalId, "vision", d.visionId);
  return getDb().goal.create({ data: { principalId, ...d } });
}
export async function updateGoal(principalId: string, id: string, d: Partial<GoalInput>) {
  await assertOptional(principalId, "vision", d.visionId);
  const r = await getDb().goal.updateMany({ where: { id, principalId, status: "ACTIVE" }, data: d });
  if (r.count === 0) return missOrTerminal(principalId, "goal", id);
  return getDb().goal.findFirstOrThrow({ where: { id, principalId } });
}
export async function closeGoal(principalId: string, id: string, to: "ACHIEVED" | "ABANDONED", note?: string) {
  const r = await getDb().goal.updateMany({ where: { id, principalId, status: "ACTIVE" }, data: { status: to, closedAt: new Date(), closedNote: note ?? null } });
  if (r.count === 0) return missOrTerminal(principalId, "goal", id);
  return getDb().goal.findFirstOrThrow({ where: { id, principalId } });
}

// ── Project ─────────────────────────────────────────────────────────────────
export interface ProjectInput { name: string; description?: string; goalId?: string | null; targetDate?: Date | null }
export async function createProject(principalId: string, d: ProjectInput) {
  await assertOptional(principalId, "goal", d.goalId);
  return getDb().project.create({ data: { principalId, ...d } });
}
export async function updateProject(principalId: string, id: string, d: Partial<ProjectInput>) {
  await assertOptional(principalId, "goal", d.goalId);
  const r = await getDb().project.updateMany({ where: { id, principalId, status: { not: "ARCHIVED" } }, data: d });
  if (r.count === 0) return missOrTerminal(principalId, "project", id);
  return getDb().project.findFirstOrThrow({ where: { id, principalId } });
}
// ACTIVE ⇄ PAUSED; ACTIVE|PAUSED → COMPLETED; anything but ARCHIVED → ARCHIVED (terminal). A COMPLETED project may only be archived.
const PROJECT_FROM: Record<string, string[]> = { ACTIVE: ["PAUSED"], PAUSED: ["ACTIVE"], COMPLETED: ["ACTIVE", "PAUSED"], ARCHIVED: ["ACTIVE", "PAUSED", "COMPLETED"] };
export async function setProjectStatus(principalId: string, id: string, to: "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED") {
  const r = await getDb().project.updateMany({
    where: { id, principalId, status: { in: PROJECT_FROM[to] as never } },
    data: { status: to, completedAt: to === "COMPLETED" ? new Date() : to === "ARCHIVED" ? undefined : null },
  });
  if (r.count === 0) return missOrTerminal(principalId, "project", id, `can't move to ${to.toLowerCase()} from its current status`);
  return getDb().project.findFirstOrThrow({ where: { id, principalId } });
}
export async function linkPerson(principalId: string, projectId: string, personId: string, role?: string) {
  await assertOwned(principalId, "project", projectId);
  await assertOwned(principalId, "person", personId);
  return getDb().projectPerson.upsert({
    where: { projectId_personId: { projectId, personId } },
    create: { projectId, personId, principalId, role },
    update: { role: role ?? null },
  });
}
export async function unlinkPerson(principalId: string, projectId: string, personId: string) {
  const r = await getDb().projectPerson.deleteMany({ where: { projectId, personId, principalId } });
  if (r.count === 0) throw new LifeNotFoundError("link");
  return { projectId, personId };
}
export async function linkKnowledge(principalId: string, projectId: string, itemId: string, note?: string) {
  await assertOwned(principalId, "project", projectId);
  await assertOwned(principalId, "knowledge", itemId);
  return getDb().projectKnowledge.upsert({
    where: { projectId_itemId: { projectId, itemId } },
    create: { projectId, itemId, principalId, note },
    update: { note: note ?? null },
  });
}
export async function unlinkKnowledge(principalId: string, projectId: string, itemId: string) {
  const r = await getDb().projectKnowledge.deleteMany({ where: { projectId, itemId, principalId } });
  if (r.count === 0) throw new LifeNotFoundError("link");
  return { projectId, itemId };
}

// ── Quest ───────────────────────────────────────────────────────────────────
export interface QuestInput { projectId: string; title: string; objective: string; criteria: string; dueAt?: Date | null }
export async function createQuest(principalId: string, d: QuestInput) {
  await assertOwned(principalId, "project", d.projectId);
  return getDb().quest.create({ data: { principalId, ...d } });
}
export async function updateQuest(principalId: string, id: string, d: Partial<Omit<QuestInput, "projectId">>) {
  const r = await getDb().quest.updateMany({ where: { id, principalId, status: { in: ["PLANNED", "ACTIVE"] } }, data: d });
  if (r.count === 0) return missOrTerminal(principalId, "quest", id);
  return getDb().quest.findFirstOrThrow({ where: { id, principalId } });
}
export async function startQuest(principalId: string, id: string) {
  const r = await getDb().quest.updateMany({ where: { id, principalId, status: "PLANNED" }, data: { status: "ACTIVE", startedAt: new Date() } });
  if (r.count === 0) return missOrTerminal(principalId, "quest", id, "isn't planned");
  return getDb().quest.findFirstOrThrow({ where: { id, principalId } });
}
/** Completing requires the quest to have been started; the criteria stay as written — completion is a claim by the owner, never inferred. */
export async function closeQuest(principalId: string, id: string, to: "COMPLETED" | "ABANDONED", note?: string) {
  const from = to === "COMPLETED" ? ["ACTIVE"] : ["PLANNED", "ACTIVE"];
  const r = await getDb().quest.updateMany({ where: { id, principalId, status: { in: from as never } }, data: { status: to, closedAt: new Date(), closedNote: note ?? null } });
  if (r.count === 0) return missOrTerminal(principalId, "quest", id, to === "COMPLETED" ? "isn't active" : undefined);
  return getDb().quest.findFirstOrThrow({ where: { id, principalId } });
}

// ── Person ──────────────────────────────────────────────────────────────────
export async function createPerson(principalId: string, d: { name: string; relationship?: string; notes?: string }) {
  return getDb().person.create({ data: { principalId, ...d } });
}
export async function updatePerson(principalId: string, id: string, d: { name?: string; relationship?: string | null; notes?: string | null }) {
  const r = await getDb().person.updateMany({ where: { id, principalId }, data: d });
  if (r.count === 0) throw new LifeNotFoundError("person");
  return getDb().person.findFirstOrThrow({ where: { id, principalId } });
}
export async function deletePerson(principalId: string, id: string) {
  const r = await getDb().person.deleteMany({ where: { id, principalId } });
  if (r.count === 0) throw new LifeNotFoundError("person");
  return { id };
}

// ── Task lifecycle ──────────────────────────────────────────────────────────
export interface TaskLinks { projectId?: string | null; questId?: string | null; relatedPersonId?: string | null }
export async function assertTaskLinks(principalId: string, l: TaskLinks): Promise<void> {
  await assertOptional(principalId, "project", l.projectId);
  await assertOptional(principalId, "quest", l.questId);
  await assertOptional(principalId, "person", l.relatedPersonId);
}
export async function updateTask(principalId: string, id: string, d: { title?: string; description?: string | null; dueAt?: Date | null; status?: "TODO" | "IN_PROGRESS" } & TaskLinks) {
  await assertTaskLinks(principalId, d);
  const r = await getDb().task.updateMany({ where: { id, principalId, status: { in: ["TODO", "IN_PROGRESS"] } }, data: d });
  if (r.count === 0) return missOrTerminal(principalId, "task", id);
  return getDb().task.findFirstOrThrow({ where: { id, principalId } });
}
export async function closeTask(principalId: string, id: string, to: "DONE" | "CANCELLED") {
  const r = await getDb().task.updateMany({ where: { id, principalId, status: { in: ["TODO", "IN_PROGRESS"] } }, data: { status: to, completedAt: to === "DONE" ? new Date() : null } });
  if (r.count === 0) return missOrTerminal(principalId, "task", id);
  return getDb().task.findFirstOrThrow({ where: { id, principalId } });
}

/** After a conditional update matched nothing: not found / not yours → NotFound; otherwise it was in the wrong state. */
async function missOrTerminal(principalId: string, kind: LifeKind, id: string, reason?: string): Promise<never> {
  await assertOwned(principalId, kind, id);
  const row = await statusOf(principalId, kind, id);
  throw reason ? new LifeStateError(`That ${LABEL[kind]} ${reason}.`) : notActionable(LABEL[kind], row ?? "closed");
}
async function statusOf(principalId: string, kind: LifeKind, id: string): Promise<string | undefined> {
  const db = getDb();
  const where = { id, principalId };
  const select = { status: true };
  const row =
    kind === "vision" ? await db.vision.findFirst({ where, select })
    : kind === "goal" ? await db.goal.findFirst({ where, select })
    : kind === "project" ? await db.project.findFirst({ where, select })
    : kind === "quest" ? await db.quest.findFirst({ where, select })
    : kind === "task" ? await db.task.findFirst({ where, select })
    : null;
  return row?.status;
}

// ── Reads ───────────────────────────────────────────────────────────────────
const CAP = 200;

/** The whole structure in one principal-scoped read: derived counts only — no invented progress score. */
export async function lifeOverview(principalId: string) {
  const db = getDb();
  const [visions, goals, projects, quests, taskGroups] = await Promise.all([
    db.vision.findMany({ where: { principalId, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: CAP }),
    db.goal.findMany({ where: { principalId, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: CAP }),
    db.project.findMany({ where: { principalId, status: { in: ["ACTIVE", "PAUSED"] } }, orderBy: { createdAt: "asc" }, take: CAP }),
    db.quest.findMany({ where: { principalId, status: { in: ["PLANNED", "ACTIVE"] } }, orderBy: { createdAt: "asc" }, take: CAP }),
    db.task.groupBy({ by: ["projectId", "status"], where: { principalId, projectId: { not: null } }, _count: { _all: true } }),
  ]);
  const counts = new Map<string, { open: number; done: number; cancelled: number }>();
  for (const g of taskGroups) {
    const c = counts.get(g.projectId!) ?? { open: 0, done: 0, cancelled: 0 };
    if (g.status === "DONE") c.done += g._count._all;
    else if (g.status === "CANCELLED") c.cancelled += g._count._all;
    else c.open += g._count._all;
    counts.set(g.projectId!, c);
  }
  return {
    visions,
    goals,
    projects: projects.map((p) => ({ ...p, tasks: counts.get(p.id) ?? { open: 0, done: 0, cancelled: 0 } })),
    quests,
  };
}

/**
 * What has been CLOSED, newest first (terminal states never reopen, so this is history, not a to-do list): achieved/abandoned goals,
 * completed/abandoned quests, archived visions, completed/archived projects. Capped; principal-scoped in every query.
 */
export async function lifeHistory(principalId: string) {
  const db = getDb();
  const take = 50;
  const [goals, quests, visions, projects] = await Promise.all([
    db.goal.findMany({ where: { principalId, status: { not: "ACTIVE" } }, orderBy: { closedAt: "desc" }, take }),
    db.quest.findMany({ where: { principalId, status: { in: ["COMPLETED", "ABANDONED"] } }, orderBy: { closedAt: "desc" }, take }),
    db.vision.findMany({ where: { principalId, status: "ARCHIVED" }, orderBy: { updatedAt: "desc" }, take }),
    db.project.findMany({ where: { principalId, status: { in: ["COMPLETED", "ARCHIVED"] } }, orderBy: { updatedAt: "desc" }, take }),
  ]);
  return { goals, quests, visions, projects };
}

export async function getProject(principalId: string, id: string) {
  const p = await getDb().project.findFirst({
    where: { id, principalId },
    include: {
      quests: { orderBy: { createdAt: "asc" }, take: CAP },
      tasks: { orderBy: { createdAt: "asc" }, take: CAP },
      people: { include: { person: { select: { id: true, name: true, relationship: true } } }, take: CAP },
      knowledge: { include: { item: { select: { id: true, kind: true, title: true } } }, take: CAP },
    },
  });
  if (!p) throw new LifeNotFoundError("project");
  return p;
}

export const listPeople = (principalId: string) => getDb().person.findMany({ where: { principalId }, orderBy: { name: "asc" }, take: CAP });
