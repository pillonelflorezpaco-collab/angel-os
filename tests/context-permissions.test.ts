import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { LocalMemoryProvider } from "../memory/local/index.js";
import { listAuditLog } from "../gateway/index.js";
import { SKILL_KEY as TASKS_SKILL, RESOURCE as TASKS_RESOURCE } from "../skills/system/tasks.js";
import { SKILL_KEY as MEMORY_SKILL, RESOURCE as MEMORY_RESOURCE } from "../skills/system/memory.js";
import { createPrincipal, deletePrincipal, ensureAgent, ensureSkill, grant } from "./helpers/fixtures.js";

/**
 * Regression for audit finding F1: the context engine used to read tasks
 * and memories directly from Prisma/MemoryProvider with no permission
 * check and no audit entry.
 */
describe("context engine — protected reads go through the permission gateway", () => {
  const engine = new DeterministicContextEngine();
  const provider = new LocalMemoryProvider();
  const agentKey = "test-context-agent";
  const TASK_TITLE = "ctx-private-task-title";
  const MEMORY_CONTENT = "ctx-private-memory alpha-content";
  let principalId: string;

  beforeEach(async () => {
    await ensureAgent(agentKey);
    await ensureSkill(TASKS_SKILL);
    await ensureSkill(MEMORY_SKILL);
    const p = await createPrincipal("Context Permissions Principal");
    principalId = p.id;
    await getDb().task.create({ data: { principalId, title: TASK_TITLE } });
    await provider.addMemory({ principalId, type: "FACT", content: MEMORY_CONTENT, source: "test" });
  });

  afterEach(async () => {
    await deletePrincipal(principalId);
  });

  afterAll(async () => {
    await getDb().agent.delete({ where: { key: agentKey } }).catch(() => undefined);
    await disconnectDb();
  });

  it("missing permission: both sections withheld, no protected data returned", async () => {
    const ctx = await engine.buildContext({ principalId, agentKey, query: "alpha-content" });
    expect(ctx.currentTasks).toEqual([]);
    expect(ctx.relevantMemories).toEqual([]);
    expect(ctx.withheld.sort()).toEqual(["memories", "tasks"]);
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain(TASK_TITLE);
    expect(serialized).not.toContain(MEMORY_CONTENT);
  });

  it("missing permission is audited as ACTION_DENIED for each protected resource", async () => {
    await engine.buildContext({ principalId, agentKey, query: "alpha-content" });
    const logs = await listAuditLog(principalId, 50);
    const denied = logs.filter((l) => l.eventType === "ACTION_DENIED").map((l) => l.resource);
    expect(denied).toContain(TASKS_RESOURCE);
    expect(denied).toContain(MEMORY_RESOURCE);
  });

  it("explicit DENIED on memory: memories withheld, tasks still returned when allowed", async () => {
    await grant(principalId, agentKey, TASKS_SKILL, TASKS_RESOURCE, "READ", "READ", "ALLOWED");
    await grant(principalId, agentKey, MEMORY_SKILL, MEMORY_RESOURCE, "MEMORY_READ", "READ", "DENIED");

    const ctx = await engine.buildContext({ principalId, agentKey, query: "alpha-content" });
    expect(ctx.currentTasks.map((t) => t.title)).toContain(TASK_TITLE);
    expect(ctx.relevantMemories).toEqual([]);
    expect(ctx.withheld).toEqual(["memories"]);
    expect(JSON.stringify(ctx)).not.toContain(MEMORY_CONTENT);
  });

  it("authorized: returns tasks and memories, audits ACTION_EXECUTED, and never writes memory content to the audit log", async () => {
    await grant(principalId, agentKey, TASKS_SKILL, TASKS_RESOURCE, "READ", "READ");
    await grant(principalId, agentKey, MEMORY_SKILL, MEMORY_RESOURCE, "MEMORY_READ", "READ");

    const ctx = await engine.buildContext({ principalId, agentKey, query: "alpha-content" });
    expect(ctx.withheld).toEqual([]);
    expect(ctx.currentTasks.map((t) => t.title)).toContain(TASK_TITLE);
    expect(ctx.relevantMemories.map((m) => m.content)).toContain(MEMORY_CONTENT);

    const logs = await listAuditLog(principalId, 50);
    const executed = logs.filter((l) => l.eventType === "ACTION_EXECUTED").map((l) => l.resource);
    expect(executed).toContain(TASKS_RESOURCE);
    expect(executed).toContain(MEMORY_RESOURCE);
    expect(JSON.stringify(logs)).not.toContain(MEMORY_CONTENT);
  });

  it("permissions are per agent: another agent's grant does not authorize this agent", async () => {
    await grant(principalId, "some-other-agent", MEMORY_SKILL, MEMORY_RESOURCE, "MEMORY_READ", "READ");
    const ctx = await engine.buildContext({ principalId, agentKey, query: "alpha-content" });
    expect(ctx.relevantMemories).toEqual([]);
    expect(ctx.withheld).toContain("memories");
    await getDb().agent.delete({ where: { key: "some-other-agent" } }).catch(() => undefined);
  });
});
