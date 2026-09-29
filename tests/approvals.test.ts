import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { setPermission } from "../gateway/permissions/index.js";
import { createApprovalRequest, decideApproval, listPendingApprovals, getApproval } from "../gateway/approvals/index.js";
import { listAuditLog } from "../gateway/audit/index.js";
import { seedTestFixtures, cleanupPrincipal, cleanupAgentAndSkill } from "./setup.js";

describe("approval flow", () => {
  let principalId: string;
  let agentKey: string;
  let skillKey: string;
  let agentId: string;
  let skillId: string;

  beforeAll(async () => {
    const fixtures = await seedTestFixtures("approval");
    principalId = fixtures.principal.id;
    agentKey = fixtures.agent.key;
    skillKey = fixtures.skill.key;
    agentId = fixtures.agent.id;
    skillId = fixtures.skill.id;

    await setPermission({
      principalId,
      agentKey,
      skillKey,
      resource: "test:approval-resource",
      action: "SEND_EMAIL",
      category: "EXECUTE",
      state: "APPROVAL_REQUIRED",
    });
  });

  afterAll(async () => {
    await cleanupPrincipal(principalId);
    await cleanupAgentAndSkill(agentId, skillId);
    await disconnectDb();
  });

  it("creates a PENDING approval request with the requested action recorded", async () => {
    const approval = await createApprovalRequest({
      principalId,
      agentKey,
      skillKey,
      resource: "test:approval-resource",
      action: "SEND_EMAIL",
      parameters: { to: "example@example.com" },
      reason: "user asked to draft and send",
    });

    expect(approval.status).toBe("PENDING");
    expect(approval.resource).toBe("test:approval-resource");
    expect(approval.action).toBe("SEND_EMAIL");

    const pending = await listPendingApprovals(principalId);
    expect(pending.some((a) => a.id === approval.id)).toBe(true);
  });

  it("authorizes the action once approved, and logs it", async () => {
    const approval = await createApprovalRequest({
      principalId,
      agentKey,
      skillKey,
      resource: "test:approval-resource",
      action: "SEND_EMAIL",
      parameters: {},
    });

    const decided = await decideApproval(principalId, approval.id, "APPROVED", "test");
    expect(decided.status).toBe("APPROVED");
    expect(decided.decidedAt).not.toBeNull();

    const fetched = await getApproval(approval.id);
    expect(fetched?.status).toBe("APPROVED");

    const logs = await listAuditLog(principalId, 50);
    expect(logs.some((l) => l.eventType === "ACTION_APPROVED")).toBe(true);
  });

  it("rejects an approval and refuses to decide it twice", async () => {
    const approval = await createApprovalRequest({
      principalId,
      agentKey,
      skillKey,
      resource: "test:approval-resource",
      action: "SEND_EMAIL",
      parameters: {},
    });

    const decided = await decideApproval(principalId, approval.id, "REJECTED", "test");
    expect(decided.status).toBe("REJECTED");

    await expect(decideApproval(principalId, approval.id, "APPROVED", "test")).rejects.toThrow();
  });

  it("concurrent decisions on the same approval: exactly one wins, never both", async () => {
    const approval = await createApprovalRequest({
      principalId,
      agentKey,
      skillKey,
      resource: "test:approval-resource",
      action: "SEND_EMAIL",
      parameters: {},
    });

    const [settledA, settledB] = await Promise.allSettled([
      decideApproval(principalId, approval.id, "APPROVED", "test-race-a"),
      decideApproval(principalId, approval.id, "REJECTED", "test-race-b"),
    ]);

    const outcomes = [settledA, settledB];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");

    // The atomic conditional update (status: "PENDING" in the same query as
    // the write) guarantees exactly one of the two concurrent calls can
    // still match PENDING — the other's WHERE clause no longer matches and
    // it throws ApprovalNotPendingError. Never both succeed, never both fail.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const db = getDb();
    const final = await db.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    expect(["APPROVED", "REJECTED"]).toContain(final.status);
    expect(final.decidedAt).not.toBeNull();
  });
});
