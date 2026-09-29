import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { getDb, disconnectDb } from "../db/client/index.js";
import { registerAction, unregisterAction, getActionDefinition, validateDefinition, IncompleteActionDefinitionError } from "../gateway/actions/registry.js";
import { verifyRegisteredActions } from "../gateway/actions/verify.js";
import { registerSkillActions, verifyProductionActions, PRODUCTION_ACTIONS } from "../skills/manifest.js";
import type { ActionDefinition } from "../gateway/actions/types.js";
import { ensureAgent, ensureSkill, createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

const good = (over: Partial<ActionDefinition<{ x: string }>> = {}): ActionDefinition<{ x: string }> => ({
  skillKey: "test.registry.skill",
  action: "REG_OK",
  resource: "test:registry",
  category: "WRITE",
  risk: "LOW",
  agentKey: "test-registry-agent",
  schema: z.object({ x: z.string() }).strict(),
  describe: (p) => `do ${p.x}`,
  execute: async () => "ok",
  ...over,
});

describe("action registry: incomplete definitions can never register", () => {
  afterAll(async () => {
    unregisterAction("test.registry.skill", "REG_OK");
    await getDb().agent.delete({ where: { key: "test-registry-agent" } }).catch(() => undefined);
    await getDb().skill.delete({ where: { key: "test.registry.skill" } }).catch(() => undefined);
    await disconnectDb();
  });

  it("a complete definition registers and is retrievable", () => {
    expect(validateDefinition(good())).toEqual([]);
    registerAction(good());
    expect(getActionDefinition("test.registry.skill", "REG_OK")).toBeDefined();
    expect(() => registerAction(good())).toThrow(/already registered/); // no silent double registration
  });

  it.each([
    ["missing skillKey", { skillKey: "" }],
    ["missing action", { action: " " }],
    ["missing resource", { resource: "" }],
    ["missing agentKey", { agentKey: "" }],
    ["invalid category", { category: "DELETE" as never }],
    ["invalid risk", { risk: "MEDIUM" as never }],
    ["missing schema", { schema: undefined as never }],
    ["missing describe", { describe: undefined as never }],
    ["missing execute", { execute: undefined as never }],
    ["invalid approvalTtlMs", { approvalTtlMs: -5 }],
    ["approvalTtlMs above a day", { approvalTtlMs: 25 * 3600_000 }],
  ])("rejects: %s (startup fails rather than tolerating it)", (_name, over) => {
    const d = good({ action: `REG_BAD_${Math.random().toString(36).slice(2)}`, ...(over as object) });
    expect(validateDefinition(d).length).toBeGreaterThan(0);
    expect(() => registerAction(d)).toThrow(IncompleteActionDefinitionError);
    expect(getActionDefinition(d.skillKey, d.action)).toBeUndefined();
  });

  it("every production definition is complete and the manifest registers all of them", () => {
    registerSkillActions();
    for (const key of PRODUCTION_ACTIONS) {
      const [skill, action] = key.split("|");
      expect(getActionDefinition(skill, action), key).toBeDefined();
    }
  });

  describe("database invariant (skill + agent + permission of the right category)", () => {
    it("fails when the skill, the agent or the permission is missing, or the category differs", async () => {
      const d = good({ action: "REG_DB" });
      const p = (await createPrincipal("Registry P")).id;
      try {
        await expect(verifyRegisteredActions([d], p)).rejects.toThrow(/skill "test.registry.skill" is not registered[\s\S]*agent "test-registry-agent" is not registered/);
        await ensureSkill("test.registry.skill");
        await ensureAgent("test-registry-agent");
        await expect(verifyRegisteredActions([d], p)).rejects.toThrow(/production principal has no permission/);
        await grant(p, "test-registry-agent", "test.registry.skill", "test:registry", "REG_DB", "READ");
        await expect(verifyRegisteredActions([d], p)).rejects.toThrow(/category READ does not match WRITE/);
        await grant(p, "test-registry-agent", "test.registry.skill", "test:registry", "REG_DB", "WRITE");
        await expect(verifyRegisteredActions([d], p)).resolves.toBeUndefined();
      } finally { await deletePrincipal(p); }
    });

    it("a permission held by ANOTHER principal does not satisfy the production principal; DENIED does not either; a missing principal fails", async () => {
      const d = good({ action: "REG_OWNER" });
      await ensureSkill("test.registry.skill");
      await ensureAgent("test-registry-agent");
      const owner = (await createPrincipal("Registry owner")).id;
      const other = (await createPrincipal("Registry other")).id;
      try {
        await grant(other, "test-registry-agent", "test.registry.skill", "test:registry", "REG_OWNER", "WRITE");
        await expect(verifyRegisteredActions([d], owner)).rejects.toThrow(/production principal has no permission/); // weaker "any principal" check would pass
        await grant(owner, "test-registry-agent", "test.registry.skill", "test:registry", "REG_OWNER", "WRITE", "DENIED");
        await expect(verifyRegisteredActions([d], owner)).rejects.toThrow(/permission is DENIED/);
        await grant(owner, "test-registry-agent", "test.registry.skill", "test:registry", "REG_OWNER", "WRITE", "APPROVAL_REQUIRED");
        await expect(verifyRegisteredActions([d], owner)).resolves.toBeUndefined();
        await expect(verifyRegisteredActions([d], "00000000-0000-0000-0000-00000000dead")).rejects.toThrow(/principal .* does not exist/);
        await expect(verifyRegisteredActions([d], "")).rejects.toThrow(/requires the configured production principal/);
      } finally { await deletePrincipal(owner); await deletePrincipal(other); }
    });

    it("an invalid policy/definition is reported by the startup verification too", async () => {
      const bad = good({ action: "REG_BADRISK", risk: "MEDIUM" as never });
      const p = (await createPrincipal("Registry bad")).id;
      try {
        await expect(verifyRegisteredActions([bad], p)).rejects.toThrow(/invalid risk/);
      } finally { await deletePrincipal(p); }
    });

    it("the configured production principal comes from ANGEL_OS_SYSTEM_PRINCIPAL_ID; unset is a startup REJECTION, not a sync throw", async () => {
      const saved = process.env.ANGEL_OS_SYSTEM_PRINCIPAL_ID;
      delete process.env.ANGEL_OS_SYSTEM_PRINCIPAL_ID;
      try {
        const promise = verifyProductionActions();
        await expect(promise).rejects.toThrow(/ANGEL_OS_SYSTEM_PRINCIPAL_ID must be set/);
      } finally { if (saved !== undefined) process.env.ANGEL_OS_SYSTEM_PRINCIPAL_ID = saved; }
    });

    it("API, Telegram and worker entry points all run the verification before serving (and stop on failure)", async () => {
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      for (const f of ["api/server.ts", "scripts/telegram.ts", "scripts/worker.ts"]) {
        const src = readFileSync(path.resolve(import.meta.dirname, "..", f), "utf-8");
        expect(src, f).toMatch(/verifyProductionActions\(\)/);
        expect(src, f).toMatch(/process\.exit\(1\)/);
      }
    });

    it("the production actions verify against a database whose skills/permissions are provisioned", async () => {
      registerSkillActions();
      const p = (await createPrincipal("Registry Prod")).id;
      try {
        for (const [skill, action, resource] of [
          ["system.tasks", "CREATE_TASK", "angel:tasks"], ["system.tasks", "CREATE_REMINDER", "angel:tasks"],
          ["system.memory", "MEMORY_CREATE", "angel:memory"], ["system.memory", "MEMORY_UPDATE", "angel:memory"],
          ["system.memory", "MEMORY_CONFIRM", "angel:memory"], ["system.memory", "MEMORY_DELETE", "angel:memory"], ["system.memory", "MEMORY_RETRACT", "angel:memory"],
        ]) await grant(p, "jarvis-core", skill, resource, action, "WRITE");
        await expect(verifyProductionActions(p)).resolves.toBeUndefined();
      } finally { await deletePrincipal(p); }
    });
  });
});
