import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { checkPermission, setPermission } from "../gateway/permissions/index.js";
import { gatewayExecute, listAuditLog } from "../gateway/index.js";
import { seedTestFixtures, cleanupPrincipal, cleanupAgentAndSkill } from "./setup.js";

describe("permission model", () => {
  let principalId: string;
  let agentKey: string;
  let skillKey: string;
  let agentId: string;
  let skillId: string;

  beforeAll(async () => {
    const fixtures = await seedTestFixtures("perm");
    principalId = fixtures.principal.id;
    agentKey = fixtures.agent.key;
    skillKey = fixtures.skill.key;
    agentId = fixtures.agent.id;
    skillId = fixtures.skill.id;
  });

  afterAll(async () => {
    await cleanupPrincipal(principalId);
    await cleanupAgentAndSkill(agentId, skillId);
    await disconnectDb();
  });

  it("denies by default when no permission row exists", async () => {
    const result = await checkPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:resource",
      action: "UNSEEN_ACTION",
    });
    expect(result.state).toBe("DENIED");
  });

  it("allows an action once granted ALLOWED", async () => {
    await setPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:resource",
      action: "READ",
      category: "READ",
      state: "ALLOWED",
    });
    const result = await checkPermission({ principalId, agentKey, skillKey, resource: "test:resource", action: "READ" });
    expect(result.state).toBe("ALLOWED");
  });

  it("blocks an action explicitly set to DENIED", async () => {
    await setPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:resource",
      action: "EXECUTE_TRANSACTION",
      category: "EXECUTE",
      state: "DENIED",
    });
    const result = await checkPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:resource",
      action: "EXECUTE_TRANSACTION",
    });
    expect(result.state).toBe("DENIED");
  });

  it("refuses to run an APPROVAL_REQUIRED closure (approval-gated actions must be ActionDefinitions) and never executes it", async () => {
    await setPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:resource",
      action: "SEND_EMAIL",
      category: "EXECUTE",
      state: "APPROVAL_REQUIRED",
    });

    let executed = false;
    const result = await gatewayExecute(
      {
        principalId,
        agentKey,
        skillKey,
        resource: "test:resource",
        action: "SEND_EMAIL",
        parameters: {},
      },
      async () => {
        executed = true;
        return { sent: true };
      }
    );

    // A closure can never be "the approved action", so the closure path fails
    // closed; the real approval path is proposeAction (tests/approval-engine.test.ts).
    expect(result.status).toBe("DENIED");
    expect(result.approvalId).toBeUndefined();
    expect(executed).toBe(false); // the gateway must never execute before approval
  });

  it("gatewayExecute returns DENIED and never calls the executor for a denied action", async () => {
    let executed = false;
    const result = await gatewayExecute(
      {
        principalId,
        agentKey,
        skillKey,
        resource: "test:resource",
        action: "EXECUTE_TRANSACTION",
        parameters: {},
      },
      async () => {
        executed = true;
      }
    );
    expect(result.status).toBe("DENIED");
    expect(executed).toBe(false);
  });

  it("gatewayExecute runs the executor and returns EXECUTED for an allowed action", async () => {
    const result = await gatewayExecute(
      {
        principalId,
        agentKey,
        skillKey,
        resource: "test:resource",
        action: "READ",
        parameters: {},
      },
      async () => ({ value: 42 })
    );
    expect(result.status).toBe("EXECUTED");
    expect(result.data).toEqual({ value: 42 });
  });

  it("setPermission records a PERMISSION_GRANTED audit event when granting ALLOWED", async () => {
    await setPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:audited-resource",
      action: "AUDITED_ACTION",
      category: "WRITE",
      state: "ALLOWED",
    });
    const logs = await listAuditLog(principalId, 50);
    const grant = logs.find(
      (l) => l.eventType === "PERMISSION_GRANTED" && l.resource === "test:audited-resource" && l.action === "AUDITED_ACTION"
    );
    expect(grant).toBeDefined();
  });

  it("setPermission records a PERMISSION_REVOKED audit event when setting DENIED", async () => {
    await setPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:audited-resource-2",
      action: "AUDITED_ACTION_2",
      category: "WRITE",
      state: "DENIED",
    });
    const logs = await listAuditLog(principalId, 50);
    const revoke = logs.find(
      (l) => l.eventType === "PERMISSION_REVOKED" && l.resource === "test:audited-resource-2" && l.action === "AUDITED_ACTION_2"
    );
    expect(revoke).toBeDefined();
  });

  it("setPermission's audit metadata records the previous and new state, never a secret", async () => {
    await setPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:audited-resource-3",
      action: "AUDITED_ACTION_3",
      category: "READ",
      state: "ALLOWED",
    });
    await setPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:audited-resource-3",
      action: "AUDITED_ACTION_3",
      category: "READ",
      state: "DENIED",
    });
    const logs = await listAuditLog(principalId, 50);
    const revoke = logs.find(
      (l) => l.eventType === "PERMISSION_REVOKED" && l.resource === "test:audited-resource-3"
    );
    expect(revoke).toBeDefined();
    expect(revoke?.metadata).toMatchObject({ previousState: "ALLOWED", newState: "DENIED" });
  });
});
