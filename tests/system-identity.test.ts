import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import {
  createSystemIdentity, runAsSystem, requireSystemIdentity, currentIdentity, getApiTokenService, getExternalIdentityService,
  INTERFACE_SOURCES, USER_INTERFACE_SOURCES,
} from "../identity/index.js";
import { gatewayExecute, listAuditLog, proposeAction, decideApproval } from "../gateway/index.js";
import { ReminderEngine } from "../reminders/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { ACTIONS, FAKE_SKILL, calls, resetCalls, registerFakeActions, ensureExecRegistry, grantAllFake, goodParams, identityFor } from "./helpers/fakeActions.js";

describe("SYSTEM identity", () => {
  let angel: string;
  let other: string;
  const agentKey = "test-system-agent";
  const skillKey = "test.system.skill";
  const resource = "test:system";

  beforeAll(async () => {
    registerFakeActions();
    await ensureExecRegistry();
    angel = (await createPrincipal("System Angel")).id;
    other = (await createPrincipal("System Other")).id;
    await grant(angel, agentKey, skillKey, resource, "READ", "READ");
    await grant(other, agentKey, skillKey, resource, "READ", "READ");
    await grantAllFake(angel);
  });
  afterAll(async () => {
    await deletePrincipal(angel);
    await deletePrincipal(other);
    await getDb().agent.delete({ where: { key: agentKey } }).catch(() => undefined);
    await disconnectDb();
  });

  const req = (principalId: string) => ({ principalId, agentKey, skillKey, resource, action: "READ", parameters: {} });

  it("SYSTEM + an explicit principal succeeds, in ALS, with authMethod system", async () => {
    await runAsSystem(angel, "test-job", async (identity) => {
      expect(currentIdentity()).toBe(identity);
      expect(identity).toMatchObject({ principalId: angel, interfaceSource: "SYSTEM", authMethod: "system" });
      expect(requireSystemIdentity()).toBe(identity);
      await Promise.resolve();
      expect(currentIdentity()).toBe(identity); // survives awaits
    });
    expect(currentIdentity()).toBeUndefined();
  });

  it("SYSTEM without a principal fails — no way to construct one", async () => {
    for (const bad of ["", undefined, null, 42, "short", "x".repeat(200), "a b c d e f g h", "../../etc"]) {
      expect(() => createSystemIdentity(bad as never, "job")).toThrow(/explicit principal/);
    }
    await expect(runAsSystem("" as never, "job", async () => 1)).rejects.toThrow();
    await expect(runAsSystem("00000000-0000-0000-0000-00000000dead", "job", async () => 1)).rejects.toThrow(/does not exist/);
    expect(() => createSystemIdentity(angel, "")).toThrow();
  });

  it("background code refuses to run outside a SYSTEM identity (including as a normal user identity)", async () => {
    expect(() => requireSystemIdentity()).toThrow(/SYSTEM identity/);
    const { runWithIdentity } = await import("../identity/index.js");
    expect(() => runWithIdentity(identityFor(angel, "API"), () => requireSystemIdentity())).toThrow(/SYSTEM identity/);
    const engine = new ReminderEngine({ principalId: angel, deliverer: { dispatch: async () => ({ channel: null, result: { status: "DELIVERED" } }) } });
    await expect(engine.processOne()).rejects.toThrow(/SYSTEM identity/); // called bare, no identity
  });

  it("SYSTEM cannot be used to impersonate another principal: the gateway refuses a mismatched action", async () => {
    const result = await runAsSystem(angel, "test-job", () => gatewayExecute(req(other), async () => "leak"));
    expect(result.status).toBe("DENIED");
    expect((await listAuditLog(angel, 20)).some((r) => r.interfaceSource === "SYSTEM" && (r.metadata as { reason?: string }).reason === "principal_mismatch")).toBe(true);
    // ...and the engine only ever acts on its own configured principal
    const engine = new ReminderEngine({ principalId: other, deliverer: { dispatch: async () => ({ channel: null, result: { status: "DELIVERED" } }) } });
    await expect(runAsSystem(angel, "test-job", () => engine.processOne())).rejects.toThrow(/does not match/);
  });

  it("SYSTEM actions are stamped in audit with interface SYSTEM and the job's request id", async () => {
    let requestId = "";
    await runAsSystem(angel, "stamp-job", async (identity) => {
      requestId = identity.requestId;
      await gatewayExecute(req(angel), async () => "ok");
    });
    const row = (await listAuditLog(angel, 30)).find((r) => r.requestId === requestId && r.eventType === "ACTION_EXECUTED");
    expect(row).toMatchObject({ interfaceSource: "SYSTEM", principalId: angel });
  });

  it("SYSTEM cannot bypass authorization: permission rules still apply", async () => {
    const denied = await runAsSystem(angel, "job", () => gatewayExecute({ ...req(angel), action: "NOT_GRANTED" }, async () => "x"));
    expect(denied.status).toBe("DENIED");
  });

  it("SYSTEM cannot bypass approval policy: sensitive actions need approval, dangerous are refused, and SYSTEM can never approve", async () => {
    resetCalls();
    const sys = await runAsSystem(angel, "job", async (identity) => ({
      identity,
      sensitive: await proposeAction(identity, { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: goodParams }),
      dangerous: await proposeAction(identity, { skillKey: FAKE_SKILL, action: ACTIONS.DANGER, parameters: goodParams }),
      low: await proposeAction(identity, { skillKey: FAKE_SKILL, action: ACTIONS.LOW, parameters: goodParams }),
    }));
    expect(sys.sensitive.status).toBe("PENDING_APPROVAL");
    expect(sys.dangerous.status).toBe("DENIED");
    expect(sys.low.status).toBe("PENDING_APPROVAL"); // stricter than users: background work asks first
    const attempt = await decideApproval(sys.identity, sys.sensitive.approvalId!, "APPROVED");
    expect(attempt).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(calls).toHaveLength(0);
  });

  it("no credential can be issued for SYSTEM: not an API token, not an external link", async () => {
    expect(INTERFACE_SOURCES).toContain("SYSTEM");
    expect(USER_INTERFACE_SOURCES).not.toContain("SYSTEM");
    await expect(getApiTokenService().create({ principalId: angel, interfaceSource: "SYSTEM", label: "x" })).rejects.toThrow(/not a user interface/);
    await expect(getExternalIdentityService().link({ principalId: angel, interfaceSource: "SYSTEM", externalId: "1" })).rejects.toThrow(/not a user interface/);
  });
});
