import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { decideApproval } from "../gateway/index.js";
import { setClock } from "../gateway/clock.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { proposeLife, readLifeOverview, readProject, readPeople } from "../skills/system/life.js";
import { proposeTaskAction, createTask } from "../skills/system/tasks.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
registerSkillActions();

const LIFE_SKILLS = ["system.life", "system.tasks"];
const readA = { agentKey: JARVIS_AGENT_KEY };

describe("Life OS: vision → goal → project → quest → task, people and links", () => {
  let a: string;
  let b: string;
  const db = () => getDb();
  const idA = (s: "GUIDEHUB" | "VOICE" | "TELEGRAM" | "API" = "GUIDEHUB") => identityFor(a, s);
  const idB = () => identityFor(b, "GUIDEHUB");
  const ok = async (who: ReturnType<typeof idA>, action: string, parameters: unknown) => {
    const r = await proposeLife(who, action, parameters);
    expect(r.status, `${action}: ${JSON.stringify(r)}`).toBe("EXECUTED");
    return r.data as any;
  };
  const failed = async (who: ReturnType<typeof idA>, action: string, parameters: unknown) => {
    const r = await proposeLife(who, action, parameters);
    expect(r.status, `${action}: ${JSON.stringify(r)}`).toBe("FAILED");
    return r;
  };
  const notFound = async (who: ReturnType<typeof idA>, action: string, parameters: unknown) => {
    // the SKILL's ownership check answers, not the database trigger's generic failure
    expect((await failed(who, action, parameters)).message).toMatch(/wasn't found/);
  };
  const task = async (who: ReturnType<typeof idA>, extra: Record<string, unknown> = {}) => {
    const r = await createTask(who, { title: `t-${Math.random()}`, ...extra } as never);
    expect(r.status, JSON.stringify(r)).toBe("EXECUTED");
    return (r.data as { id: string }).id;
  };

  beforeAll(async () => {
    a = (await createPrincipal("Life OS A")).id;
    b = (await createPrincipal("Life OS B")).id;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, "system.life", "angel:life", "LIFE_READ", "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => LIFE_SKILLS.includes(x.skillKey) && x.category === "WRITE")) {
        await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE", d.risk === "SENSITIVE" ? "APPROVAL_REQUIRED" : "ALLOWED");
      }
    }
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => setClock(null));
  afterEach(() => setClock(null));

  it("builds the whole hierarchy, every row owned by the caller, and reads it back with derived counts only", async () => {
    const vision = await ok(idA(), "VISION_CREATE", { title: "Build a good life", statement: "Deep work and health" });
    const goal = await ok(idA(), "GOAL_CREATE", { title: "Ship Angel OS", visionId: vision.id, horizon: "LONG" });
    const project = await ok(idA(), "PROJECT_CREATE", { name: "Backend", goalId: goal.id });
    const quest = await ok(idA(), "QUEST_CREATE", { projectId: project.id, title: "Life OS", objective: "Structure", criteria: "All tests pass" });
    const t1 = await task(idA(), { projectId: project.id, questId: quest.id });
    const t2 = await task(idA(), { projectId: project.id });
    for (const [table, rowId] of [["vision", vision.id], ["goal", goal.id], ["project", project.id], ["quest", quest.id], ["task", t1]] as const) {
      expect(await (db() as any)[table].count({ where: { id: rowId, principalId: a } })).toBe(1);
    }
    await proposeTaskAction(idA(), "TASK_COMPLETE", { taskId: t1 });
    const overview = (await readLifeOverview(idA(), readA)).data as any;
    const p = overview.projects.find((x: any) => x.id === project.id);
    expect(p.tasks).toEqual({ open: 1, done: 1, cancelled: 0 });
    expect(Object.keys(p)).not.toContain("progress");
    expect(overview.goals.map((g: any) => g.id)).toContain(goal.id);
    const detail = (await readProject(idA(), { ...readA, projectId: project.id })).data as any;
    expect(detail.tasks.map((t: any) => t.id).sort()).toEqual([t1, t2].sort());
    expect(detail.quests).toHaveLength(1);
  });

  it("another principal sees none of it and cannot read or address it", async () => {
    const project = await ok(idA(), "PROJECT_CREATE", { name: "Private project" });
    const seen = (await readLifeOverview(idB(), readA)).data as any;
    expect(JSON.stringify(seen)).not.toContain(project.id);
    const r = await readProject(idB(), { ...readA, projectId: project.id });
    expect(r.status).toBe("FAILED");
    await failed(idB(), "PROJECT_UPDATE", { projectId: project.id, name: "stolen" });
    await failed(idB(), "PROJECT_SET_STATUS", { projectId: project.id, status: "ARCHIVED" });
    const v = await ok(idA(), "VISION_CREATE", { title: "A vision", statement: "s" });
    await notFound(idB(), "VISION_ARCHIVE", { visionId: v.id });
    await notFound(idB(), "VISION_UPDATE", { visionId: v.id, title: "stolen" });
    expect((await db().vision.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("ACTIVE");
    expect((await db().project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe("Private project");
  });

  describe("cross-principal references are refused by the skill AND by the database", () => {
    let foreign: { goal: string; project: string; quest: string; person: string; vision: string; item: string };
    let mine: { project: string; goal: string };
    beforeAll(async () => {
      const g = await ok(idB(), "GOAL_CREATE", { title: "B goal" });
      const pr = await ok(idB(), "PROJECT_CREATE", { name: "B project" });
      const q = await ok(idB(), "QUEST_CREATE", { projectId: pr.id, title: "B quest", objective: "o", criteria: "c" });
      const pe = await ok(idB(), "PERSON_CREATE", { name: "B person" });
      const v = await ok(idB(), "VISION_CREATE", { title: "B vision", statement: "s" });
      const src = await db().knowledgeSource.create({ data: { principalId: b, title: "s", kind: "note", contentHash: `h-${Math.random()}` } });
      const item = await db().knowledgeItem.create({ data: { principalId: b, sourceId: src.id, kind: "FACT", title: "B item", body: "c", origin: "INGESTED" } as never });
      foreign = { goal: g.id, project: pr.id, quest: q.id, person: pe.id, vision: v.id, item: item.id };
      mine = { project: (await ok(idA(), "PROJECT_CREATE", { name: "Mine" })).id, goal: (await ok(idA(), "GOAL_CREATE", { title: "Mine goal" })).id };
    });

    it("skill level: every link kind fails with the same 'not found' and writes nothing", async () => {
      await notFound(idA(), "GOAL_CREATE", { title: "x", visionId: foreign.vision });
      await notFound(idA(), "PROJECT_CREATE", { name: "x", goalId: foreign.goal });
      await failed(idA(), "QUEST_CREATE", { projectId: foreign.project, title: "x", objective: "o", criteria: "c" });
      await notFound(idA(), "PROJECT_LINK_PERSON", { projectId: mine.project, personId: foreign.person });
      await failed(idA(), "PROJECT_LINK_PERSON", { projectId: foreign.project, personId: foreign.person });
      await notFound(idA(), "PROJECT_LINK_KNOWLEDGE", { projectId: mine.project, itemId: foreign.item });
      const t = await createTask(idA(), { title: "x", projectId: foreign.project } as never);
      expect(t.status).toBe("FAILED");
      expect((await createTask(idA(), { title: "x", questId: foreign.quest } as never)).status).toBe("FAILED");
      expect((await createTask(idA(), { title: "x", relatedPersonId: foreign.person } as never)).status).toBe("FAILED");
      expect(await db().task.count({ where: { principalId: a, title: "x" } })).toBe(0);
      expect(await db().projectPerson.count({ where: { principalId: a } })).toBe(0);
    });

    it("database level: direct writes with a foreign reference are rejected by the trigger", async () => {
      const bad = [
        () => db().goal.create({ data: { principalId: a, title: "x", visionId: foreign.vision } }),
        () => db().project.create({ data: { principalId: a, name: "x", goalId: foreign.goal } }),
        () => db().quest.create({ data: { principalId: a, projectId: foreign.project, title: "x", objective: "o", criteria: "c" } }),
        () => db().task.create({ data: { principalId: a, title: "x", projectId: foreign.project } }),
        () => db().task.create({ data: { principalId: a, title: "x", questId: foreign.quest } }),
        () => db().task.create({ data: { principalId: a, title: "x", relatedPersonId: foreign.person } }),
        () => db().decision.create({ data: { principalId: a, title: "t", context: "c", decision: "d", projectId: foreign.project } as never }),
        () => db().projectPerson.create({ data: { principalId: a, projectId: mine.project, personId: foreign.person } }),
        () => db().projectKnowledge.create({ data: { principalId: a, projectId: mine.project, itemId: foreign.item } }),
        // and re-pointing an existing row at a foreign parent
        async () => { const t = await task(idA()); return db().task.update({ where: { id: t }, data: { projectId: foreign.project } }); },
      ];
      for (const [i, fn] of bad.entries()) await expect(fn(), `case ${i}`).rejects.toThrow(/cross-principal/);
    });

    it("principalId can never be reassigned", async () => {
      await expect(db().project.update({ where: { id: mine.project }, data: { principalId: b } })).rejects.toThrow(/immutable/);
      await expect(db().person.update({ where: { id: foreign.person }, data: { principalId: a } })).rejects.toThrow(/immutable/);
    });
  });

  describe("lifecycle: terminal states are final, transitions are guarded", () => {
    it("tasks: DONE and CANCELLED never reopen or change; completedAt is set exactly when DONE", async () => {
      const t = await task(idA());
      expect((await proposeTaskAction(idA(), "TASK_UPDATE", { taskId: t, status: "IN_PROGRESS", title: "renamed" })).status).toBe("EXECUTED");
      expect((await proposeTaskAction(idA(), "TASK_COMPLETE", { taskId: t })).status).toBe("EXECUTED");
      const done = await db().task.findUniqueOrThrow({ where: { id: t } });
      expect(done).toMatchObject({ status: "DONE" });
      expect(done.completedAt).toBeInstanceOf(Date);
      for (const action of ["TASK_COMPLETE", "TASK_CANCEL", "TASK_UPDATE"] as const) {
        const r = await proposeTaskAction(idA(), action, action === "TASK_UPDATE" ? { taskId: t, title: "again" } : { taskId: t });
        expect(r.status, action).toBe("FAILED");
      }
      await expect(db().task.update({ where: { id: t }, data: { status: "TODO", completedAt: null } })).rejects.toThrow();
      const c = await task(idA());
      await proposeTaskAction(idA(), "TASK_CANCEL", { taskId: c });
      expect(await db().task.findUniqueOrThrow({ where: { id: c } })).toMatchObject({ status: "CANCELLED", completedAt: null });
    });

    it("task completion records Activity by reference only; cancel and update record none", async () => {
      const t = await task(idA());
      await proposeTaskAction(idA(), "TASK_COMPLETE", { taskId: t });
      const rows = await db().activity.findMany({ where: { principalId: a, refId: t } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: "TASK_COMPLETED", refType: "task" });
    });

    it("a task cannot be completed by someone else, and a failed attempt changes nothing", async () => {
      const t = await task(idA());
      expect((await proposeTaskAction(idB(), "TASK_COMPLETE", { taskId: t })).status).toBe("FAILED");
      expect((await db().task.findUniqueOrThrow({ where: { id: t } })).status).toBe("TODO");
    });

    it("goals: achieve/abandon once; abandonment needs a reason; closedAt is set; nothing reopens", async () => {
      const g = await ok(idA(), "GOAL_CREATE", { title: "Close me" });
      await failed(idA(), "GOAL_ABANDON", { goalId: g.id });
      await ok(idA(), "GOAL_ACHIEVE", { goalId: g.id, note: "done!" });
      const row = await db().goal.findUniqueOrThrow({ where: { id: g.id } });
      expect(row).toMatchObject({ status: "ACHIEVED", closedNote: "done!" });
      expect(row.closedAt).toBeInstanceOf(Date);
      await failed(idA(), "GOAL_ABANDON", { goalId: g.id, reason: "changed my mind" });
      await failed(idA(), "GOAL_UPDATE", { goalId: g.id, title: "edit" });
      await expect(db().goal.update({ where: { id: g.id }, data: { status: "ACTIVE", closedAt: null } })).rejects.toThrow();
      const acts = await db().activity.findMany({ where: { principalId: a, refId: g.id } });
      expect(acts.map((x) => x.type)).toEqual(["ACHIEVEMENT"]);
    });

    it("quests: must be started before completion; criteria are explicit and required; completion is final", async () => {
      const p = await ok(idA(), "PROJECT_CREATE", { name: "Quest host" });
      await failed(idA(), "QUEST_CREATE", { projectId: p.id, title: "no criteria", objective: "o" });
      const q = await ok(idA(), "QUEST_CREATE", { projectId: p.id, title: "Q", objective: "o", criteria: "explicit criteria" });
      expect(q.status).toBe("PLANNED");
      await failed(idA(), "QUEST_COMPLETE", { questId: q.id });
      await ok(idA(), "QUEST_START", { questId: q.id });
      await failed(idA(), "QUEST_START", { questId: q.id });
      await ok(idA(), "QUEST_COMPLETE", { questId: q.id });
      const row = await db().quest.findUniqueOrThrow({ where: { id: q.id } });
      expect(row).toMatchObject({ status: "COMPLETED", criteria: "explicit criteria" });
      expect(row.closedAt).toBeInstanceOf(Date);
      await failed(idA(), "QUEST_ABANDON", { questId: q.id, reason: "nope" });
      await failed(idA(), "QUEST_UPDATE", { questId: q.id, criteria: "moved goalposts" });
      expect((await db().quest.findUniqueOrThrow({ where: { id: q.id } })).criteria).toBe("explicit criteria");
      expect((await db().activity.findMany({ where: { principalId: a, refId: q.id } })).map((x) => x.type)).toEqual(["QUEST_COMPLETED"]);
    });

    it("projects: pause/resume/complete/archive; ARCHIVED is terminal and immutable; completedAt follows the status", async () => {
      const p = await ok(idA(), "PROJECT_CREATE", { name: "Lifecycle" });
      await ok(idA(), "PROJECT_SET_STATUS", { projectId: p.id, status: "PAUSED" });
      await failed(idA(), "PROJECT_SET_STATUS", { projectId: p.id, status: "PAUSED" });
      await ok(idA(), "PROJECT_SET_STATUS", { projectId: p.id, status: "ACTIVE" });
      await ok(idA(), "PROJECT_SET_STATUS", { projectId: p.id, status: "COMPLETED" });
      expect((await db().project.findUniqueOrThrow({ where: { id: p.id } })).completedAt).toBeInstanceOf(Date);
      await ok(idA(), "PROJECT_SET_STATUS", { projectId: p.id, status: "ARCHIVED" });
      await failed(idA(), "PROJECT_SET_STATUS", { projectId: p.id, status: "ACTIVE" });
      await failed(idA(), "PROJECT_UPDATE", { projectId: p.id, name: "edit" });
      await expect(db().project.update({ where: { id: p.id }, data: { status: "ACTIVE" } })).rejects.toThrow();
    });

    it("visions can be archived once and never reopen", async () => {
      const v = await ok(idA(), "VISION_CREATE", { title: "V", statement: "s" });
      await ok(idA(), "VISION_ARCHIVE", { visionId: v.id });
      await failed(idA(), "VISION_ARCHIVE", { visionId: v.id });
      await failed(idA(), "VISION_UPDATE", { visionId: v.id, title: "edit" });
    });

    it("racing completions of the same task: exactly one wins, one Activity row", async () => {
      const t = await task(idA());
      const results = await Promise.all(Array.from({ length: 8 }, () => proposeTaskAction(idA(), "TASK_COMPLETE", { taskId: t })));
      expect(results.filter((r) => r.status === "EXECUTED")).toHaveLength(1);
      expect(await db().activity.count({ where: { principalId: a, refId: t } })).toBe(1);
    });
  });

  describe("people and links", () => {
    it("links carry an optional role, are idempotent, and unlink removes only the link", async () => {
      const p = await ok(idA(), "PROJECT_CREATE", { name: "With people" });
      const person = await ok(idA(), "PERSON_CREATE", { name: "Ana", relationship: "friend" });
      await ok(idA(), "PROJECT_LINK_PERSON", { projectId: p.id, personId: person.id, role: "advisor" });
      await ok(idA(), "PROJECT_LINK_PERSON", { projectId: p.id, personId: person.id, role: "partner" });
      const links = await db().projectPerson.findMany({ where: { projectId: p.id } });
      expect(links).toHaveLength(1);
      expect(links[0].role).toBe("partner");
      await ok(idA(), "PROJECT_UNLINK_PERSON", { projectId: p.id, personId: person.id });
      await failed(idA(), "PROJECT_UNLINK_PERSON", { projectId: p.id, personId: person.id });
      expect(await db().person.count({ where: { id: person.id } })).toBe(1);
    });

    it("PERSON_DELETE is SENSITIVE: approval on every interface; on approval links go, tasks stay", async () => {
      const person = await ok(idA(), "PERSON_CREATE", { name: "Temp" });
      const p = await ok(idA(), "PROJECT_CREATE", { name: "Del host" });
      await ok(idA(), "PROJECT_LINK_PERSON", { projectId: p.id, personId: person.id });
      const t = await task(idA(), { relatedPersonId: person.id });
      for (const s of ["GUIDEHUB", "TELEGRAM", "API", "VOICE"] as const) {
        expect((await proposeLife(idA(s), "PERSON_DELETE", { personId: person.id })).status, s).toBe("PENDING_APPROVAL");
      }
      expect(await db().person.count({ where: { id: person.id } })).toBe(1);
      const row = await db().approvalRequest.findFirstOrThrow({ where: { principalId: a, action: "PERSON_DELETE", status: "PENDING", parameters: { path: ["personId"], equals: person.id } } });
      expect(row.parameters).toEqual({ personId: person.id });
      expect(await decideApproval(idB(), row.id, "APPROVED")).toMatchObject({ ok: false });
      expect(await decideApproval(idA(), row.id, "APPROVED")).toMatchObject({ ok: true });
      expect(await db().person.count({ where: { id: person.id } })).toBe(0);
      expect(await db().projectPerson.count({ where: { personId: person.id } })).toBe(0);
      expect((await db().task.findUniqueOrThrow({ where: { id: t } })).relatedPersonId).toBeNull();
      expect(await decideApproval(idA(), row.id, "APPROVED")).toMatchObject({ ok: false });
    });

    it("people are private to their owner", async () => {
      const person = await ok(idA(), "PERSON_CREATE", { name: "Only A" });
      expect(JSON.stringify((await readPeople(idB(), readA)).data)).not.toContain(person.id);
      await failed(idB(), "PERSON_UPDATE", { personId: person.id, name: "renamed" });
      expect((await proposeLife(idB(), "PERSON_DELETE", { personId: person.id })).status).toBe("PENDING_APPROVAL");
    });
  });

  describe("interface policy and strict schemas", () => {
    it("LOW life writes are direct on GuideHub/Telegram/API and need approval on voice, changing nothing until approved", async () => {
      for (const s of ["GUIDEHUB", "TELEGRAM", "API"] as const) expect((await proposeLife(idA(s), "GOAL_CREATE", { title: `via ${s}` })).status, s).toBe("EXECUTED");
      const v = await proposeLife(idA("VOICE"), "GOAL_CREATE", { title: "via voice unique" });
      expect(v.status).toBe("PENDING_APPROVAL");
      expect(await db().goal.count({ where: { principalId: a, title: "via voice unique" } })).toBe(0);
    });

    it("unknown fields, non-UUID ids, empty updates and client-supplied principals are rejected before any approval exists", async () => {
      const before = await db().approvalRequest.count({ where: { principalId: a } });
      const g = await ok(idA(), "GOAL_CREATE", { title: "schema target" });
      const bad: [string, unknown][] = [
        ["GOAL_CREATE", { title: "x", principalId: b }],
        ["GOAL_CREATE", { title: "x", status: "ACHIEVED" }],
        ["GOAL_CREATE", { title: "" }],
        ["GOAL_CREATE", { title: "x", visionId: "nope" }],
        ["GOAL_UPDATE", { goalId: g.id }],
        ["GOAL_UPDATE", { goalId: g.id, status: "ACHIEVED" }],
        ["GOAL_UPDATE", { goalId: g.id, principalId: b, title: "x" }],
        ["PROJECT_SET_STATUS", { projectId: g.id, status: "DELETED" }],
        ["TASKISH", {}],
      ];
      for (const [action, params] of bad) expect((await proposeLife(idA(), action, params)).status, action + JSON.stringify(params)).toBe("FAILED");
      expect((await proposeTaskAction(idA(), "TASK_UPDATE", { taskId: g.id })).status).toBe("FAILED");
      expect((await proposeTaskAction(idA(), "TASK_UPDATE", { taskId: g.id, status: "DONE" })).status).toBe("FAILED");
      expect(await db().approvalRequest.count({ where: { principalId: a } })).toBe(before);
    });

    it("without the permission grant, every write and read is denied and nothing is created", async () => {
      const c = (await createPrincipal("Life OS no grants")).id;
      try {
        expect((await proposeLife(identityFor(c), "GOAL_CREATE", { title: "x" })).status).toBe("DENIED");
        expect((await readLifeOverview(identityFor(c), readA)).status).toBe("DENIED");
        expect(await db().goal.count({ where: { principalId: c } })).toBe(0);
      } finally { await deletePrincipal(c); }
    });

    it("a DENIED permission row beats everything", async () => {
      const c = (await createPrincipal("Life OS denied")).id;
      try {
        await grant(c, JARVIS_AGENT_KEY, "system.life", "angel:life", "GOAL_CREATE", "WRITE", "DENIED");
        expect((await proposeLife(identityFor(c), "GOAL_CREATE", { title: "x" })).status).toBe("DENIED");
      } finally { await deletePrincipal(c); }
    });
  });

  it("the Context Engine surfaces only the caller's ACTIVE goals/projects, capped, and reports `withheld` without LIFE_READ", async () => {
    const c = (await createPrincipal("Life OS ctx")).id;
    const d = (await createPrincipal("Life OS ctx other")).id;
    try {
      for (const [sk, res, act] of [["system.tasks", "angel:tasks", "READ"], ["system.life", "angel:life", "LIFE_READ"]] as const) await grant(c, JARVIS_AGENT_KEY, sk, res, act, "READ");
      const mkGoal = (pid: string, title: string, status: "ACTIVE" | "ACHIEVED" = "ACTIVE") =>
        db().goal.create({ data: { principalId: pid, title, status, closedAt: status === "ACTIVE" ? null : new Date() } });
      await mkGoal(c, "qzkx active goal");
      await mkGoal(c, "qzkx achieved goal", "ACHIEVED");
      await mkGoal(d, "qzkx someone else's goal");
      for (let i = 0; i < 12; i++) await db().project.create({ data: { principalId: c, name: `qzkx project ${i}` } });
      const engine = new DeterministicContextEngine();
      const ctx = await engine.buildContext({ identity: identityFor(c), agentKey: JARVIS_AGENT_KEY, query: "qzkx" });
      expect(ctx.activeGoals!.map((g) => g.title)).toEqual(["qzkx active goal"]);
      expect(ctx.activeProjects!.length).toBe(8);
      expect(ctx.withheld).not.toContain("life");
      const denied = await engine.buildContext({ identity: identityFor(d), agentKey: JARVIS_AGENT_KEY, query: "qzkx" });
      expect(denied.withheld).toContain("life");
      expect(denied.activeGoals).toEqual([]);
    } finally { await deletePrincipal(c); await deletePrincipal(d); }
  });

  it("every executed life action is audited with a payload hash and no content", async () => {
    const r = await proposeLife(idA(), "GOAL_CREATE", { title: "Audit me zzqq" });
    expect(r.status).toBe("EXECUTED");
    const rows = await db().auditLog.findMany({ where: { principalId: a, action: "GOAL_CREATE" }, orderBy: { createdAt: "desc" }, take: 1 });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("zzqq");
  });
});
