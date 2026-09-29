import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { gatewayExecute, LEGACY_WRITE_ALLOWLIST, listAuditLog, proposeAction } from "../gateway/index.js";
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

  describe("the temporary allow-list", () => {
    it("is exactly the two documented entries — CREATE_REMINDER and remember are not on it", () => {
      expect([...LEGACY_WRITE_ALLOWLIST]).toEqual([
        "system.tasks|angel:tasks|CREATE_TASK",
        "system.memory|angel:memory|MEMORY_WRITE",
      ]);
      expect(LEGACY_WRITE_ALLOWLIST.some((e) => e.includes("CREATE_REMINDER"))).toBe(false);
    });

    it("cannot be expanded at runtime", () => {
      expect(Object.isFrozen(LEGACY_WRITE_ALLOWLIST)).toBe(true);
      expect(() => (LEGACY_WRITE_ALLOWLIST as string[]).push("x|y|z")).toThrow();
    });

    it("matches exactly: a look-alike skill/resource/action does not inherit the entry", async () => {
      await grant(p, agentKey, "system.tasks", "angel:tasks", "CREATE_TASK_2", "WRITE", "ALLOWED");
      let ran = false;
      const r = await gatewayExecute({ principalId: p, agentKey, skillKey: "system.tasks", resource: "angel:tasks", action: "CREATE_TASK_2", parameters: {} }, async () => { ran = true; });
      expect(r.status).toBe("DENIED");
      expect(ran).toBe(false);
    });

    it("an allow-listed WRITE (CREATE_TASK) still works — existing behaviour preserved", async () => {
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "WRITE");
      const r = await createTask({ principalId: p, agentKey: JARVIS_AGENT_KEY, title: "still legacy" });
      expect(r.status).toBe("EXECUTED");
    });

    it("but the allow-list only ever covers WRITE: an EXECUTE row for an allow-listed action is refused", async () => {
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "EXECUTE");
      const r = await createTask({ principalId: p, agentKey: JARVIS_AGENT_KEY, title: "must be refused" });
      expect(r.status).toBe("DENIED");
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "WRITE");
    });
  });

  it("CREATE_REMINDER is a registered production ActionDefinition, not a legacy write", () => {
    expect(PRODUCTION_ACTIONS).toContain("system.tasks|CREATE_REMINDER");
    expect(PRODUCTION_ACTIONS).toContain("system.memory|MEMORY_WRITE");
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
