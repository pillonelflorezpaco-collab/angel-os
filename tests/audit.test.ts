import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { disconnectDb } from "../db/client/index.js";
import { recordAuditEvent, listAuditLog } from "../gateway/audit/index.js";
import { seedTestFixtures, cleanupPrincipal, cleanupAgentAndSkill } from "./setup.js";

describe("audit log", () => {
  let principalId: string;
  let agentKey: string;
  let agentId: string;
  let skillId: string;

  beforeAll(async () => {
    const fixtures = await seedTestFixtures("audit");
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

  it("records an event with who/what/when/result", async () => {
    const event = await recordAuditEvent({
      principalId,
      agentKey,
      eventType: "ACTION_EXECUTED",
      resource: "test:resource",
      action: "READ",
      result: "SUCCESS",
      source: "test",
      metadata: { note: "no secrets here" },
    });

    expect(event.principalId).toBe(principalId);
    expect(event.eventType).toBe("ACTION_EXECUTED");
    expect(event.result).toBe("SUCCESS");
    expect(event.createdAt).toBeInstanceOf(Date);
  });

  it("lists events for a principal, most recent first", async () => {
    await recordAuditEvent({
      principalId,
      eventType: "ACTION_DENIED",
      result: "DENIED",
      source: "test",
    });

    const logs = await listAuditLog(principalId, 10);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].createdAt.getTime()).toBeGreaterThanOrEqual(logs[logs.length - 1].createdAt.getTime());
  });
});
