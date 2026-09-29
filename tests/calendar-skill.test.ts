import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { setPermission } from "../gateway/permissions/index.js";
import { listAuditLog } from "../gateway/index.js";
import { getConnectorRegistry } from "../connectors/registry/index.js";
import { getCredentialStore } from "../connectors/credentials/select.js";
import { GoogleOAuthClient } from "../connectors/google/oauthClient.js";
import * as calendarSkill from "../skills/integrations/calendar.js";
import { resolveCredential, ConnectionMissingError, CredentialMissingError, CredentialExpiredError } from "../skills/integrations/calendar.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import type { CalendarConnector, CalendarEvent, ListEventsParams, ResolvedCredential } from "../connectors/types/calendar.js";
import type { ConnectorCapability, ConnectorHealth } from "../connectors/types/index.js";

const FAKE_EVENTS: CalendarEvent[] = [
  {
    id: "evt1",
    calendarId: "primary",
    provider: "google",
    title: "Gym",
    description: null,
    start: new Date(),
    end: new Date(),
    allDay: false,
    timezone: "UTC",
    location: null,
    attendees: [],
    status: "confirmed",
  },
];

class FakeCalendarConnector implements CalendarConnector {
  readonly providerKey = "google";
  readonly displayName = "Fake Google Calendar";
  listEventsSpy = vi.fn(async (_c: ResolvedCredential, _p: ListEventsParams) => FAKE_EVENTS);

  listCapabilities(): ConnectorCapability[] {
    return [{ key: "calendar.read", category: "READ", description: "fake" }];
  }
  requiresAuthorization(): boolean {
    return true;
  }
  async checkHealth(): Promise<ConnectorHealth> {
    return { reachable: true, checkedAt: new Date() };
  }
  async listCalendars(): Promise<{ id: string; provider: string; displayName: string; primary: boolean; timezone: string | null }[]> {
    return [{ id: "primary", provider: "google", displayName: "Angel", primary: true, timezone: "UTC" }];
  }
  async listEvents(credential: ResolvedCredential, params: ListEventsParams): Promise<CalendarEvent[]> {
    return this.listEventsSpy(credential, params);
  }
  async getEvent(): Promise<CalendarEvent | null> {
    return FAKE_EVENTS[0];
  }
}

async function makeActiveGoogleConnection(principalId: string, secret: { accessToken: string; refreshToken: string | null; expiresAt: string }) {
  const db = getDb();
  const connection = await db.connection.create({
    data: {
      principalId,
      provider: "google",
      externalAccountId: `${principalId}-${Date.now()}-${Math.random().toString(36).slice(2)}@fake.example`,
      status: "ACTIVE",
    },
  });
  const ref = `google:connection:${connection.id}`;
  await getCredentialStore().setSecret(ref, JSON.stringify(secret));
  await db.connection.update({ where: { id: connection.id }, data: { credentialRef: ref } });
  return connection;
}

describe("skills/integrations/calendar.ts", () => {
  const fakeConnector = new FakeCalendarConnector();
  let principalId: string;
  const agentKey = "test-calendar-agent";

  beforeAll(async () => {
    getConnectorRegistry().register(fakeConnector);

    const db = getDb();
    const principal = await db.principal.create({ data: { name: "Calendar Skill Test Principal" } });
    principalId = principal.id;
    await db.agent.upsert({ where: { key: agentKey }, update: {}, create: { key: agentKey, name: "Test Calendar Agent" } });
    await db.agent.upsert({ where: { key: JARVIS_AGENT_KEY }, update: {}, create: { key: JARVIS_AGENT_KEY, name: "Jarvis Core" } });
    await db.skill.upsert({
      where: { key: calendarSkill.SKILL_KEY },
      update: {},
      create: { key: calendarSkill.SKILL_KEY, name: "Calendar" },
    });
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
    await db.agent.delete({ where: { key: agentKey } }).catch(() => undefined);
    await disconnectDb();
  });

  it("READ denied (no permission row): connector is never called", async () => {
    fakeConnector.listEventsSpy.mockClear();
    const result = await calendarSkill.listEvents({
      principalId,
      agentKey,
      calendarId: "primary",
      timeMin: new Date(),
      timeMax: new Date(),
    });
    expect(result.status).toBe("DENIED");
    expect(fakeConnector.listEventsSpy).not.toHaveBeenCalled();
  });

  it("missing connection: fails with ConnectionMissingError, connector never reached", async () => {
    for (const key of [agentKey, JARVIS_AGENT_KEY]) {
      await setPermission({
        principalId,
        agentKey: key,
        skillKey: calendarSkill.SKILL_KEY,
        resource: calendarSkill.RESOURCE,
        action: "READ",
        category: "READ",
        state: "ALLOWED",
      });
    }
    fakeConnector.listEventsSpy.mockClear();
    const result = await calendarSkill.listEvents({
      principalId,
      agentKey,
      calendarId: "primary",
      timeMin: new Date(),
      timeMax: new Date(),
    });
    expect(result.status).toBe("FAILED");
    expect(result.message).toContain("No active Google Calendar connection");
    expect(fakeConnector.listEventsSpy).not.toHaveBeenCalled();
  });

  it("missing credential (connection exists, credentialRef null): fails with CredentialMissingError", async () => {
    const db = getDb();
    const connection = await db.connection.create({
      data: { principalId, provider: "google", externalAccountId: `${principalId}@no-cred.example`, status: "ACTIVE" },
    });
    const result = await calendarSkill.listEvents({
      principalId,
      agentKey,
      calendarId: "primary",
      timeMin: new Date(),
      timeMax: new Date(),
    });
    expect(result.status).toBe("FAILED");
    expect(result.message).toContain("Reconnect required");
    await db.connection.delete({ where: { id: connection.id } });
  });

  it("READ allowed with a valid credential: connector is called and events are returned", async () => {
    await makeActiveGoogleConnection(principalId, {
      accessToken: "valid-access-token",
      refreshToken: "valid-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    fakeConnector.listEventsSpy.mockClear();
    const result = await calendarSkill.listEvents({
      principalId,
      agentKey,
      calendarId: "primary",
      timeMin: new Date(),
      timeMax: new Date(),
    });
    expect(result.status).toBe("EXECUTED");
    expect(fakeConnector.listEventsSpy).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual(FAKE_EVENTS);

    // The credential passed to the connector is the resolved access token,
    // never anything else — and it's never present in the Result or audit.
    const [passedCredential] = fakeConnector.listEventsSpy.mock.calls[0];
    expect(passedCredential.accessToken).toBe("valid-access-token");
  });

  it("secret redaction: the access/refresh token never appears in the audit log", async () => {
    const logs = await listAuditLog(principalId, 100);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("valid-access-token");
    expect(serialized).not.toContain("valid-refresh-token");
  });

  it("provider failure (connector throws): mapped to FAILED, error audited, no crash", async () => {
    const originalImpl = fakeConnector.listEventsSpy.getMockImplementation();
    fakeConnector.listEventsSpy.mockImplementationOnce(async () => {
      throw new Error("simulated Google API outage");
    });
    const result = await calendarSkill.listEvents({
      principalId,
      agentKey,
      calendarId: "primary",
      timeMin: new Date(),
      timeMax: new Date(),
    });
    expect(result.status).toBe("FAILED");
    const logs = await listAuditLog(principalId, 10);
    expect(logs[0].eventType).toBe("ACTION_FAILED");
    if (originalImpl) fakeConnector.listEventsSpy.mockImplementation(originalImpl);
  });

  it("Jarvis Core resolves 'What do I have today?' to the calendar skill", async () => {
    const jarvis = new JarvisCore();
    fakeConnector.listEventsSpy.mockClear();
    const result = await jarvis.handle({ principalId, input: "What do I have today?" });
    expect(result.status).toBe("EXECUTED");
    expect(result.message).toContain("Today's calendar");
    expect(result.message).toContain("Gym");
    expect(fakeConnector.listEventsSpy).toHaveBeenCalled();
  });
});

describe("resolveCredential — token refresh (mocked GoogleOAuthClient, no real network)", () => {
  let principalId: string;

  beforeAll(async () => {
    const db = getDb();
    const principal = await db.principal.create({ data: { name: "Refresh Test Principal" } });
    principalId = principal.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
    await disconnectDb();
  });

  it("refreshes an expired access token when a refresh token is available, and persists the new one", async () => {
    const connection = await makeActiveGoogleConnection(principalId, {
      accessToken: "expired-access-token",
      refreshToken: "still-valid-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });

    const fakeOAuthClient = {
      refreshAccessToken: vi.fn(async () => ({
        accessToken: "refreshed-access-token",
        refreshToken: "still-valid-refresh-token",
        expiresAt: new Date(Date.now() + 3600_000),
        scope: "https://www.googleapis.com/auth/calendar.readonly",
      })),
    } as unknown as GoogleOAuthClient;

    const { credential } = await resolveCredential(principalId, fakeOAuthClient);
    expect(credential.accessToken).toBe("refreshed-access-token");
    expect(fakeOAuthClient.refreshAccessToken).toHaveBeenCalledWith("still-valid-refresh-token");

    // Persisted for next time — read it back through the store directly.
    const stored = await getCredentialStore().getSecret(`google:connection:${connection.id}`);
    expect(JSON.parse(stored).accessToken).toBe("refreshed-access-token");
  });

  it("marks the connection ERROR and throws CredentialExpiredError when the refresh token is revoked", async () => {
    await makeActiveGoogleConnection(principalId, {
      accessToken: "expired-access-token-2",
      refreshToken: "revoked-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const failingOAuthClient = {
      refreshAccessToken: vi.fn(async () => {
        throw new Error("invalid_grant: token has been revoked");
      }),
    } as unknown as GoogleOAuthClient;

    await expect(resolveCredential(principalId, failingOAuthClient)).rejects.toThrow(CredentialExpiredError);

    const db = getDb();
    const conn = await db.connection.findFirstOrThrow({ where: { principalId, provider: "google" }, orderBy: { updatedAt: "desc" } });
    expect(conn.status).toBe("ERROR");

    const logs = await listAuditLog(principalId, 10);
    expect(logs.some((l) => l.eventType === "CONNECTION_FAILED")).toBe(true);
  });

  it("throws CredentialExpiredError immediately (no refresh attempt) when there is no refresh token", async () => {
    await makeActiveGoogleConnection(principalId, {
      accessToken: "expired-no-refresh",
      refreshToken: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(resolveCredential(principalId)).rejects.toThrow(CredentialExpiredError);
  });

  it("throws ConnectionMissingError for a principal with no google connection at all", async () => {
    const db = getDb();
    const isolated = await db.principal.create({ data: { name: "No Connection Principal" } });
    await expect(resolveCredential(isolated.id)).rejects.toThrow(ConnectionMissingError);
    await db.principal.delete({ where: { id: isolated.id } });
  });
});

describe("two-principal isolation — calendar connections and credentials", () => {
  const fakeConnector = new FakeCalendarConnector();
  let principalA: string;
  let principalB: string;
  const agentKey = "test-calendar-isolation-agent";

  beforeAll(async () => {
    getConnectorRegistry().register(fakeConnector);
    const db = getDb();
    const a = await db.principal.create({ data: { name: "Calendar Isolation A" } });
    const b = await db.principal.create({ data: { name: "Calendar Isolation B" } });
    principalA = a.id;
    principalB = b.id;
    await db.agent.upsert({ where: { key: agentKey }, update: {}, create: { key: agentKey, name: "Isolation Agent" } });
    for (const principalId of [principalA, principalB]) {
      await setPermission({
        principalId,
        agentKey,
        skillKey: calendarSkill.SKILL_KEY,
        resource: calendarSkill.RESOURCE,
        action: "READ",
        category: "READ",
        state: "ALLOWED",
      });
    }
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalA } }).catch(() => undefined);
    await db.principal.delete({ where: { id: principalB } }).catch(() => undefined);
    await db.agent.delete({ where: { key: agentKey } }).catch(() => undefined);
    await disconnectDb();
  });

  it("A's calendar read never resolves B's connection/credential, even if only B has one connected", async () => {
    await makeActiveGoogleConnection(principalB, {
      accessToken: "b-only-access-token",
      refreshToken: "b-only-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    // A has no connection at all — must fail with ConnectionMissingError,
    // never accidentally pick up B's.
    const result = await calendarSkill.listEvents({
      principalId: principalA,
      agentKey,
      calendarId: "primary",
      timeMin: new Date(),
      timeMax: new Date(),
    });
    expect(result.status).toBe("FAILED");
    expect(result.message).toContain("No active Google Calendar connection");
  });

  it("both A and B connected: each read only ever uses its own credential", async () => {
    await makeActiveGoogleConnection(principalA, {
      accessToken: "a-access-token",
      refreshToken: "a-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    fakeConnector.listEventsSpy.mockClear();
    await calendarSkill.listEvents({ principalId: principalA, agentKey, calendarId: "primary", timeMin: new Date(), timeMax: new Date() });
    const [credA] = fakeConnector.listEventsSpy.mock.calls[fakeConnector.listEventsSpy.mock.calls.length - 1];
    expect(credA.accessToken).toBe("a-access-token");

    await calendarSkill.listEvents({ principalId: principalB, agentKey, calendarId: "primary", timeMin: new Date(), timeMax: new Date() });
    const [credB] = fakeConnector.listEventsSpy.mock.calls[fakeConnector.listEventsSpy.mock.calls.length - 1];
    expect(credB.accessToken).toBe("b-only-access-token");
    expect(credB.accessToken).not.toBe(credA.accessToken);
  });
});
