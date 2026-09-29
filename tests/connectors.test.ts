import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { disconnectDb, getDb } from "../db/client/index.js";
import {
  ConnectorRegistry,
  UnknownConnectorError,
  EnvCredentialStore,
  CredentialNotFoundError,
  ConnectionService,
  ConnectionNotFoundError,
} from "../connectors/index.js";
import { listAuditLog } from "../gateway/index.js";
import type { ConnectorCapability, ConnectorHealth, ConnectorProvider } from "../connectors/types/index.js";

/** A fake provider for tests only — NOT a real integration, per Build #2's scope (no Google/Telegram/etc. implemented). */
class FakeTestConnector implements ConnectorProvider {
  readonly providerKey = "faketest";
  readonly displayName = "Fake Test Connector";

  listCapabilities(): ConnectorCapability[] {
    return [
      { key: "faketest.read", category: "READ", description: "Read something from the fake provider." },
      { key: "faketest.write", category: "WRITE", description: "Write something to the fake provider." },
    ];
  }

  requiresAuthorization(): boolean {
    return true;
  }

  async checkHealth(): Promise<ConnectorHealth> {
    return { reachable: true, checkedAt: new Date() };
  }
}

describe("A. Connector registration", () => {
  it("registers a connector and retrieves it by providerKey", () => {
    const registry = new ConnectorRegistry();
    const connector = new FakeTestConnector();
    registry.register(connector);
    expect(registry.get("faketest")).toBe(connector);
  });
});

describe("B. Connector discovery", () => {
  it("lists all registered connectors", () => {
    const registry = new ConnectorRegistry();
    registry.register(new FakeTestConnector());
    const list = registry.list();
    expect(list.map((c) => c.providerKey)).toEqual(["faketest"]);
  });

  it("isAvailable reflects registration state", () => {
    const registry = new ConnectorRegistry();
    expect(registry.isAvailable("faketest")).toBe(false);
    registry.register(new FakeTestConnector());
    expect(registry.isAvailable("faketest")).toBe(true);
  });
});

describe("C. Capability discovery", () => {
  it("lists capabilities for a registered connector, each mapped to READ/WRITE/EXECUTE", () => {
    const registry = new ConnectorRegistry();
    registry.register(new FakeTestConnector());
    const caps = registry.listCapabilities("faketest");
    expect(caps).toEqual([
      { key: "faketest.read", category: "READ", description: "Read something from the fake provider." },
      { key: "faketest.write", category: "WRITE", description: "Write something to the fake provider." },
    ]);
  });

  it("a capability existing does not by itself grant permission — capability and permission are separate models", () => {
    // No Permission row is created anywhere by connector registration or
    // capability discovery; this is a structural assertion, not a runtime
    // one — there is no code path from ConnectorRegistry into the
    // permissions table at all.
    const registry = new ConnectorRegistry();
    registry.register(new FakeTestConnector());
    expect(typeof (registry as unknown as { grantPermission?: unknown }).grantPermission).toBe("undefined");
  });
});

describe("G. Unknown connector handling", () => {
  it("getOrThrow throws UnknownConnectorError for an unregistered provider", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.getOrThrow("does-not-exist")).toThrow(UnknownConnectorError);
  });

  it("listCapabilities throws for an unregistered provider rather than returning an empty list silently", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.listCapabilities("does-not-exist")).toThrow(UnknownConnectorError);
  });
});

describe("H. Credential reference abstraction", () => {
  const ref = "TEST_CREDENTIAL_REF_FOR_ANGEL_OS";

  afterAll(() => {
    delete process.env[ref];
  });

  it("resolves a reference to its value via the store, never by direct env access from application code", async () => {
    process.env[ref] = "super-secret-value";
    const store = new EnvCredentialStore();
    const value = await store.getSecret(ref);
    expect(value).toBe("super-secret-value");
  });

  it("throws CredentialNotFoundError for an unresolvable reference, not a bare env lookup returning undefined", async () => {
    const store = new EnvCredentialStore();
    await expect(store.getSecret("TOTALLY_UNSET_REF_XYZ")).rejects.toThrow(CredentialNotFoundError);
  });
});

describe("I. Credential never appears in audit output", () => {
  const service = new ConnectionService();
  let principalId: string;

  beforeAll(async () => {
    const db = getDb();
    const principal = await db.principal.create({ data: { name: "Test Principal credential-audit" } });
    principalId = principal.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
    await disconnectDb();
  });

  it("creating a connection with a secret-looking value in scope never writes that value into audit metadata", async () => {
    const secretLookingValue = "ya29.a0AfH6SMB_super_secret_oauth_token";
    process.env.NEVER_LOGGED_TEST_SECRET = secretLookingValue;

    await service.create({
      principalId,
      provider: "faketest",
      externalAccountId: "angel@example.com",
      displayName: "Angel's Fake Account",
    });

    const logs = await listAuditLog(principalId, 50);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(secretLookingValue);
    expect(logs.some((l) => l.eventType === "CONNECTION_CREATED")).toBe(true);

    delete process.env.NEVER_LOGGED_TEST_SECRET;
  });
});

describe("E/F. Connection creation, disable, remove", () => {
  const service = new ConnectionService();
  let principalId: string;

  beforeAll(async () => {
    const db = getDb();
    const principal = await db.principal.create({ data: { name: "Test Principal connection-crud" } });
    principalId = principal.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
    await disconnectDb();
  });

  it("creates a connection in PENDING status", async () => {
    const conn = await service.create({
      principalId,
      provider: "faketest",
      externalAccountId: "angel@crud-test.example",
    });
    expect(conn.status).toBe("PENDING");
    expect(conn.principalId).toBe(principalId);
  });

  it("lists only this principal's connections", async () => {
    const list = await service.list(principalId);
    expect(list.every((c) => c.principalId === principalId)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it("disables a connection and audit-logs it", async () => {
    const conn = await service.create({
      principalId,
      provider: "faketest",
      externalAccountId: "angel@disable-test.example",
    });
    const disabled = await service.disable(principalId, conn.id);
    expect(disabled.status).toBe("DISABLED");

    const logs = await listAuditLog(principalId, 50);
    expect(logs.some((l) => l.eventType === "CONNECTION_DISABLED" && (l.metadata as { connectionId?: string })?.connectionId === conn.id)).toBe(
      true
    );
  });

  it("removes a connection and it is no longer listed", async () => {
    const conn = await service.create({
      principalId,
      provider: "faketest",
      externalAccountId: "angel@remove-test.example",
    });
    await service.remove(principalId, conn.id);
    const list = await service.list(principalId);
    expect(list.find((c) => c.id === conn.id)).toBeUndefined();

    const logs = await listAuditLog(principalId, 50);
    expect(logs.some((l) => l.eventType === "CONNECTION_REMOVED")).toBe(true);
  });

  it("enforces (principalId, provider, externalAccountId) uniqueness", async () => {
    await service.create({ principalId, provider: "faketest", externalAccountId: "angel@unique-test.example" });
    await expect(
      service.create({ principalId, provider: "faketest", externalAccountId: "angel@unique-test.example" })
    ).rejects.toThrow();
  });
});

describe("D/K. Connection principal isolation (two-principal)", () => {
  const service = new ConnectionService();
  let principalA: string;
  let principalB: string;

  beforeAll(async () => {
    const db = getDb();
    const a = await db.principal.create({ data: { name: "Connector Isolation A" } });
    const b = await db.principal.create({ data: { name: "Connector Isolation B" } });
    principalA = a.id;
    principalB = b.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalA } }).catch(() => undefined);
    await db.principal.delete({ where: { id: principalB } }).catch(() => undefined);
    await disconnectDb();
  });

  it("A cannot get B's connection by id", async () => {
    const bConn = await service.create({
      principalId: principalB,
      provider: "faketest",
      externalAccountId: "b@isolation-test.example",
    });
    await expect(service.get(principalA, bConn.id)).rejects.toThrow(ConnectionNotFoundError);
  });

  it("A cannot disable B's connection by id (and B's connection is unaffected)", async () => {
    const bConn = await service.create({
      principalId: principalB,
      provider: "faketest",
      externalAccountId: "b2@isolation-test.example",
    });
    await expect(service.disable(principalA, bConn.id)).rejects.toThrow(ConnectionNotFoundError);

    const stillActive = await service.get(principalB, bConn.id);
    expect(stillActive.status).toBe("PENDING");
  });

  it("A cannot remove B's connection by id (and B's connection still exists)", async () => {
    const bConn = await service.create({
      principalId: principalB,
      provider: "faketest",
      externalAccountId: "b3@isolation-test.example",
    });
    await expect(service.remove(principalA, bConn.id)).rejects.toThrow(ConnectionNotFoundError);

    const stillThere = await service.get(principalB, bConn.id);
    expect(stillThere.id).toBe(bConn.id);
  });

  it("A's connection list never includes B's connections", async () => {
    await service.create({ principalId: principalB, provider: "faketest", externalAccountId: "b4@isolation-test.example" });
    const aList = await service.list(principalA);
    expect(aList.every((c) => c.principalId === principalA)).toBe(true);
  });
});

describe("J. Gateway remains the authorization boundary", () => {
  it("ConnectorRegistry and ConnectionService expose no method that executes a provider action", () => {
    // Structural guarantee: the registry/service surface is discovery and
    // record-keeping only. Anything that DOES something (send an email,
    // create a calendar event) must be a Skill going through
    // gatewayExecute — this module has no "execute" or "call" method for
    // any provider to bypass that with.
    const registry = new ConnectorRegistry();
    const registryMethods = Object.getOwnPropertyNames(ConnectorRegistry.prototype);
    const serviceMethods = Object.getOwnPropertyNames(ConnectionService.prototype);
    const forbidden = /execute|invoke|call|send|perform/i;
    expect(registryMethods.filter((m) => forbidden.test(m))).toEqual([]);
    expect(serviceMethods.filter((m) => forbidden.test(m))).toEqual([]);
    void registry;
  });
});
