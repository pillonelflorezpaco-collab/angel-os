import { identityFor } from "./helpers/fakeActions.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { setPermission } from "../gateway/permissions/index.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import { RESOURCE as TASKS_RESOURCE, SKILL_KEY as TASKS_SKILL } from "../skills/system/tasks.js";
import { RESOURCE as MEMORY_RESOURCE, SKILL_KEY as MEMORY_SKILL } from "../skills/system/memory.js";
import { RESOURCE as DECISIONS_RESOURCE, SKILL_KEY as DECISIONS_SKILL } from "../skills/system/decisions.js";

/**
 * Covers both "creating a task" / "creating a reminder" (Definition of Done
 * items 9-10) and Jarvis Core's basic request flow (item 10 of the test
 * checklist), since both exercise the same real jarvis-core agent /
 * system.tasks skill registry entries the API uses.
 */
describe("Jarvis Core — deterministic request flow", () => {
  let principalId: string;
  const jarvis = new JarvisCore();

  beforeAll(async () => {
    const db = getDb();
    const principal = await db.principal.create({ data: { name: "Test Principal jarvis-core" } });
    principalId = principal.id;

    await db.agent.upsert({
      where: { key: JARVIS_AGENT_KEY },
      update: {},
      create: { key: JARVIS_AGENT_KEY, name: "Jarvis Core" },
    });
    await db.skill.upsert({
      where: { key: TASKS_SKILL },
      update: {},
      create: { key: TASKS_SKILL, name: "System Tasks" },
    });
    await db.skill.upsert({
      where: { key: MEMORY_SKILL },
      update: {},
      create: { key: MEMORY_SKILL, name: "System Memory" },
    });
    await db.skill.upsert({
      where: { key: DECISIONS_SKILL },
      update: {},
      create: { key: DECISIONS_SKILL, name: "System Decisions" },
    });

    for (const action of ["READ", "CREATE_TASK", "CREATE_REMINDER"] as const) {
      await setPermission({
        principalId,
        agentKey: JARVIS_AGENT_KEY,
        skillKey: TASKS_SKILL,
        resource: TASKS_RESOURCE,
        action,
        category: action === "READ" ? "READ" : "WRITE",
        state: "ALLOWED",
      });
    }
    for (const action of ["MEMORY_READ", "MEMORY_CREATE"] as const) {
      await setPermission({
        principalId,
        agentKey: JARVIS_AGENT_KEY,
        skillKey: MEMORY_SKILL,
        resource: MEMORY_RESOURCE,
        action,
        category: action === "MEMORY_READ" ? "READ" : "WRITE",
        state: "ALLOWED",
      });
    }
    await setPermission({
      principalId,
      agentKey: JARVIS_AGENT_KEY,
      skillKey: DECISIONS_SKILL,
      resource: DECISIONS_RESOURCE,
      action: "DECISION_READ",
      category: "READ",
      state: "ALLOWED",
    });
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
    await disconnectDb();
  });

  it("creates a task from natural language and it is retrievable", async () => {
    const createResult = await jarvis.handle({
      principalId, identity: identityFor(principalId),
      input: "create task: call the accountant",
    });
    expect(createResult.status).toBe("EXECUTED");

    const listResult = await jarvis.handle({ principalId, identity: identityFor(principalId), input: "what are my tasks" });
    expect(listResult.status).toBe("EXECUTED");
    const tasks = listResult.data as { title: string }[];
    expect(tasks.some((t) => t.title === "call the accountant")).toBe(true);
  });

  it("creates a reminder from 'remind me tomorrow at 10 to call John'", async () => {
    const result = await jarvis.handle({
      principalId, identity: identityFor(principalId),
      input: "Remind me tomorrow at 10 to call John.",
    });
    expect(result.status).toBe("EXECUTED");
    const reminder = result.data as { message: string; remindAt: Date };
    expect(reminder.message.toLowerCase()).toContain("call john");
  });

  it("stores and retrieves a memory via 'remember that ...'", async () => {
    const remembered = await jarvis.handle({
      principalId, identity: identityFor(principalId),
      input: "remember that I prefer async standups",
    });
    expect(remembered.status).toBe("EXECUTED");

    const searched = await jarvis.handle({
      principalId, identity: identityFor(principalId),
      input: "what do i know about async standups",
    });
    expect(searched.status).toBe("EXECUTED");
    const memories = searched.data as { content: string }[];
    expect(memories.some((m) => m.content.includes("async standups"))).toBe(true);
  });

  it("returns FAILED with guidance for unrecognized input", async () => {
    const result = await jarvis.handle({ principalId, identity: identityFor(principalId), input: "asdkjhaskjdh nonsense input" });
    expect(result.status).toBe("FAILED");
  });
});
