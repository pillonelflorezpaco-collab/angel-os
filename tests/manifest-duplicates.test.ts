import { describe, it, expect, afterAll } from "vitest";
import { z } from "zod";
import { registerAction, getActionDefinition, unregisterAction } from "../gateway/actions/registry.js";
import { registerSkillActions, PRODUCTION_ACTIONS } from "../skills/manifest.js";
import { disconnectDb } from "../db/client/index.js";
import type { ActionDefinition } from "../gateway/actions/types.js";

// Fresh module state (this file never imports Core/API): the manifest has NOT registered yet.
describe("production registration never silently skips or shadows a key", () => {
  afterAll(async () => { await disconnectDb(); });

  const impostor: ActionDefinition<{ x: string }> = {
    skillKey: "system.tasks", action: "CREATE_TASK", resource: "angel:tasks", category: "WRITE", risk: "LOW", agentKey: "jarvis-core",
    schema: z.object({ x: z.string() }).strict(), describe: () => "impostor", execute: async () => "impostor",
  };

  it("if something already registered a production key, registerSkillActions THROWS and the impostor stays visible (nothing is skipped or replaced)", () => {
    registerAction(impostor);
    expect(() => registerSkillActions()).toThrow(/already registered/);
    expect(getActionDefinition("system.tasks", "CREATE_TASK")).toBe(impostor); // not silently replaced either
    expect(() => registerSkillActions()).toThrow(/already registered/); // and it keeps failing — no "second call passes" loophole
  });

  it("with the conflict removed, registration succeeds, is idempotent across composition roots, and registers every production action", () => {
    unregisterAction("system.tasks", "CREATE_TASK");
    // the failed attempt above may have registered earlier keys; clear them so this is a clean start
    for (const key of PRODUCTION_ACTIONS) { const [s, a] = key.split("|"); unregisterAction(s, a); }
    registerSkillActions();
    registerSkillActions(); // second root: harmless
    for (const key of PRODUCTION_ACTIONS) { const [s, a] = key.split("|"); expect(getActionDefinition(s, a), key).toBeDefined(); expect(getActionDefinition(s, a)).not.toBe(impostor); }
  });

  it("registering the same key twice always throws", () => {
    expect(() => registerAction({ ...impostor, action: "DUP_ONE" })).not.toThrow();
    expect(() => registerAction({ ...impostor, action: "DUP_ONE" })).toThrow(/already registered/);
    unregisterAction("system.tasks", "DUP_ONE");
  });
});
