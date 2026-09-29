import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { gatewayExecute, listAuditLog, proposeAction } from "../gateway/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { withAuditFailures, ACTIONS, FAKE_SKILL, calls, resetCalls, registerFakeActions, ensureExecRegistry, grantFake, identityFor, goodParams } from "./helpers/fakeActions.js";
import { PRODUCTION_ACTIONS } from "../skills/manifest.js";
import { createTask } from "../skills/system/tasks.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";

// BUILD #7: the legacy closure path is a READ lane. These tests pin that.

describe("gatewayExecute guardrail (legacy path is READ-only)", () => {
  const agentKey = "test-guardrail-agent";
  const skillKey = "test.guardrail.skill";
  const resource = "test:guardrail";
  let p: string;
  const req = (action: string) => ({ principalId: p, agentKey, skillKey, resource, action, parameters: {} });

  beforeAll(async () => {
    p = (await createPrincipal("Guardrail P")).id;
    registerFakeActions();
    await ensureExecRegistry();
  });
  afterAll(async () => {
    await deletePrincipal(p);
    await getDb().agent.delete({ where: { key: agentKey } }).catch(() => undefined);
    await disconnectDb();
  });

  it("READ works and runs the closure", async () => {
    await grant(p, agentKey, skillKey, resource, "R", "READ");
    let ran = false;
    const r = await gatewayExecute(req("R"), async () => { ran = true; return 1; });
    expect(r.status).toBe("EXECUTED");
    expect(ran).toBe(true);
  });

  it("an unauthorized READ (no permission row) fails closed and never runs the closure", async () => {
    let ran = false;
    const r = await gatewayExecute(req("NOPE"), async () => { ran = true; });
    expect(r.status).toBe("DENIED");
    expect(ran).toBe(false);
  });

  it("an EXECUTE action marked ALLOWED cannot run through the legacy gateway", async () => {
    await grant(p, agentKey, skillKey, resource, "E_ALLOWED", "EXECUTE", "ALLOWED");
    let ran = false;
    const r = await gatewayExecute(req("E_ALLOWED"), async () => { ran = true; });
    expect(r).toMatchObject({ status: "DENIED" });
    expect(ran).toBe(false);
    const row = (await listAuditLog(p, 20)).find((e) => e.action === "E_ALLOWED");
    expect(row?.metadata).toMatchObject({ reason: "legacy_path_non_read", category: "EXECUTE" });
  });

  it("a non-allow-listed WRITE cannot run through the legacy gateway either", async () => {
    await grant(p, agentKey, skillKey, resource, "W_ALLOWED", "WRITE", "ALLOWED");
    let ran = false;
    expect((await gatewayExecute(req("W_ALLOWED"), async () => { ran = true; })).status).toBe("DENIED");
    expect(ran).toBe(false);
  });

  it("APPROVAL_REQUIRED cannot execute through the legacy gateway, whatever its category", async () => {
    for (const [action, category] of [["AR_READ", "READ"], ["AR_WRITE", "WRITE"], ["AR_EXEC", "EXECUTE"]] as const) {
      await grant(p, agentKey, skillKey, resource, action, category, "APPROVAL_REQUIRED");
      let ran = false;
      const r = await gatewayExecute(req(action), async () => { ran = true; });
      expect(r.status, action).toBe("DENIED");
      expect(r.approvalId).toBeUndefined();
      expect(ran).toBe(false);
    }
  });

  it("an unknown/absent category fails closed (no permission row → no category)", async () => {
    let ran = false;
    expect((await gatewayExecute(req("NO_ROW"), async () => { ran = true; })).status).toBe("DENIED");
    expect(ran).toBe(false);
  });

  describe("there is no legacy write allow-list any more (BUILD #8)", () => {
    it("the gateway exports no allow-list at all", async () => {
      const gw = await import("../gateway/index.js");
      expect("LEGACY_WRITE_ALLOWLIST" in gw).toBe(false);
    });

    it("the formerly allow-listed writes are refused through gatewayExecute (CREATE_TASK, MEMORY_WRITE)", async () => {
      for (const [skill, res, action] of [["system.tasks", "angel:tasks", "CREATE_TASK"], ["system.memory", "angel:memory", "MEMORY_WRITE"]] as const) {
        await grant(p, agentKey, skill, res, action, "WRITE", "ALLOWED");
        let ran = false;
        const r = await gatewayExecute({ principalId: p, agentKey, skillKey: skill, resource: res, action, parameters: {} }, async () => { ran = true; });
        expect(r.status, action).toBe("DENIED");
        expect(ran).toBe(false);
      }
    });

    it("CREATE_TASK works — through the ActionDefinition path, not the gateway lane", async () => {
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "WRITE");
      const r = await createTask(identityFor(p), { title: "via definition" });
      expect(r.status).toBe("EXECUTED");
      const audit = (await listAuditLog(p, 50)).filter((e) => e.action === "CREATE_TASK").map((e) => e.eventType);
      expect(audit).toContain("ACTION_EXECUTION_SUCCEEDED");
      expect(audit).not.toContain("ACTION_EXECUTED"); // not the legacy event
    });

    it("a permission row whose category differs from the definition's is refused", async () => {
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "EXECUTE");
      expect((await createTask(identityFor(p), { title: "must be refused" })).status).toBe("DENIED");
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "WRITE");
    });
  });

  it("every production write is a registered ActionDefinition", () => {
    expect([...PRODUCTION_ACTIONS].sort()).toEqual([
      "system.knowledge|KNOWLEDGE_ADD",
      "system.knowledge|KNOWLEDGE_DELETE_SOURCE",
      "system.knowledge|KNOWLEDGE_INGEST",
      "system.knowledge|KNOWLEDGE_RELATE",
      "system.knowledge|KNOWLEDGE_RETRACT",
      "system.memory|MEMORY_CONFIRM",
      "system.memory|MEMORY_CREATE",
      "system.memory|MEMORY_DELETE",
      "system.memory|MEMORY_RETRACT",
      "system.memory|MEMORY_UPDATE",
      "system.tasks|CREATE_REMINDER",
      "system.tasks|CREATE_TASK",
      "system.life|GOAL_ABANDON",
      "system.life|GOAL_ACHIEVE",
      "system.life|GOAL_CREATE",
      "system.life|GOAL_UPDATE",
      "system.life|PERSON_CREATE",
      "system.life|PERSON_DELETE",
      "system.life|PERSON_UPDATE",
      "system.life|PROJECT_CREATE",
      "system.life|PROJECT_LINK_KNOWLEDGE",
      "system.life|PROJECT_LINK_PERSON",
      "system.life|PROJECT_SET_STATUS",
      "system.life|PROJECT_UNLINK_KNOWLEDGE",
      "system.life|PROJECT_UNLINK_PERSON",
      "system.life|PROJECT_UPDATE",
      "system.life|QUEST_ABANDON",
      "system.life|QUEST_COMPLETE",
      "system.life|QUEST_CREATE",
      "system.life|QUEST_START",
      "system.life|QUEST_UPDATE",
      "system.life|VISION_ARCHIVE",
      "system.life|VISION_CREATE",
      "system.life|VISION_UPDATE",
      "system.tasks|TASK_CANCEL",
      "system.tasks|TASK_COMPLETE",
      "system.tasks|TASK_UPDATE",
    ].sort());
  });

  describe("audit truthfulness", () => {
    it("an action failure is reported as FAILED and audited as ACTION_FAILED", async () => {
      await grant(p, agentKey, skillKey, resource, "R2", "READ");
      const r = await gatewayExecute(req("R2"), async () => { throw new Error("db://secret failure"); });
      expect(r.status).toBe("FAILED");
      expect(JSON.stringify(r)).not.toContain("secret");
    });

    it("if the audit write fails AFTER a successful action, the result is still EXECUTED, flagged auditUnconfirmed", async () => {
      await grant(p, agentKey, skillKey, resource, "R3", "READ");
      let effects = 0;
      const r = await withAuditFailures(() => true, () => gatewayExecute(req("R3"), async () => { effects += 1; return "done"; }));
      expect(effects).toBe(1);
      expect(r.status).toBe("EXECUTED"); // it happened; never report it as failed
      expect(r.auditUnconfirmed).toBe(true);
    });

    it("an ActionDefinition whose SUCCEEDED audit fails is EXECUTED + auditUnconfirmed", async () => {
      await grantFake(p, ACTIONS.LOW, "ALLOWED");
      resetCalls();
      const ok = await withAuditFailures((t) => t === "ACTION_EXECUTION_SUCCEEDED", () =>
        proposeAction(identityFor(p), { skillKey: FAKE_SKILL, action: ACTIONS.LOW, parameters: goodParams }));
      expect(ok.status).toBe("EXECUTED");
      expect(ok.auditUnconfirmed).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it("if the STARTED audit cannot be written, nothing runs (no audit trail → no effect)", async () => {
      await grantFake(p, ACTIONS.LOW, "ALLOWED");
      resetCalls();
      await expect(
        withAuditFailures((t) => t === "ACTION_EXECUTION_STARTED", () =>
          proposeAction(identityFor(p), { skillKey: FAKE_SKILL, action: ACTIONS.LOW, parameters: { ...goodParams, body: "no start audit" } }))
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("a failed action whose FAILED audit also cannot be written is still reported FAILED", async () => {
      await grant(p, agentKey, skillKey, resource, "R4", "READ");
      const r = await withAuditFailures(() => true, () => gatewayExecute(req("R4"), async () => { throw new Error("boom"); }));
      expect(r.status).toBe("FAILED");
    });
  });
});
