import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { disconnectDb } from "../db/client/index.js";
import { setPermission } from "../gateway/permissions/index.js";
import * as memorySkill from "../skills/system/memory.js";
import { seedTestFixtures, cleanupPrincipal, cleanupAgentAndSkill } from "./setup.js";

/**
 * Fixes the audit finding that GET /api/memory/search called MemoryProvider
 * directly, bypassing the gateway. Proves the memory SKILL (which the route
 * now calls) actually enforces permission, both ways.
 */
describe("skills/system/memory.ts — routes through the gateway", () => {
  let principalId: string;
  let agentKey: string;
  let agentId: string;
  let skillId: string;

  beforeAll(async () => {
    const fixtures = await seedTestFixtures("memskill");
    principalId = fixtures.principal.id;
    agentKey = fixtures.agent.key;
    agentId = fixtures.agent.id;
    skillId = fixtures.skill.id;
  });

  afterAll(async () => {
    await cleanupPrincipal(principalId);
    await cleanupAgentAndSkill(agentId, skillId);
    await disconnectDb();
  });

  it("denies memory.search when no permission row exists yet (fail closed)", async () => {
    // No permission granted yet for memorySkill.SKILL_KEY/RESOURCE for this
    // principal — confirms fail-closed default end to end through the real
    // skill module the API route now calls, instead of the old direct
    // MemoryProvider call that had no gate at all.
    const result = await memorySkill.search({ principalId, agentKey, query: { query: "secret" } });
    expect(result.status).toBe("DENIED");
  });

  it("allows memory.search once MEMORY_READ is granted, and denies memory.remember until MEMORY_WRITE is also granted", async () => {
    await setPermission({
      principalId,
      agentKey,
      skillKey: memorySkill.SKILL_KEY,
      resource: memorySkill.RESOURCE,
      action: "MEMORY_READ",
      category: "READ",
      state: "ALLOWED",
    });

    const searchResult = await memorySkill.search({ principalId, agentKey, query: { query: "anything" } });
    expect(searchResult.status).toBe("EXECUTED");

    const rememberResult = await memorySkill.remember({
      principalId,
      agentKey,
      memory: { type: "FACT", content: "should be denied", source: "test" },
    });
    expect(rememberResult.status).toBe("DENIED");

    await setPermission({
      principalId,
      agentKey,
      skillKey: memorySkill.SKILL_KEY,
      resource: memorySkill.RESOURCE,
      action: "MEMORY_WRITE",
      category: "WRITE",
      state: "ALLOWED",
    });

    const rememberResult2 = await memorySkill.remember({
      principalId,
      agentKey,
      memory: { type: "FACT", content: "now allowed", source: "test" },
    });
    expect(rememberResult2.status).toBe("EXECUTED");

    const found = await memorySkill.search({ principalId, agentKey, query: { query: "now allowed" } });
    expect(found.status).toBe("EXECUTED");
    const memories = found.data as { content: string }[];
    expect(memories.some((m) => m.content === "now allowed")).toBe(true);
  });
});
