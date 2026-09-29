import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getCredentialStore } from "../connectors/credentials/select.js";
import type { GoogleOAuthClient } from "../connectors/google/oauthClient.js";
import { resolveCredential, CredentialExpiredError } from "../skills/integrations/calendar.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";

process.env.NODE_ENV = "test";

async function connection(principalId: string, secret: { accessToken: string; refreshToken: string | null; expiresAt: string }) {
  const db = getDb();
  const c = await db.connection.create({ data: { principalId, provider: "google", externalAccountId: `${principalId}-${Math.random().toString(36).slice(2)}@fake.example`, status: "ACTIVE" } });
  const ref = `google:connection:${c.id}`;
  await getCredentialStore().setSecret(ref, JSON.stringify(secret));
  await db.connection.update({ where: { id: c.id }, data: { credentialRef: ref } });
  return { id: c.id, ref };
}
const expired = () => new Date(Date.now() - 1000).toISOString();
const fresh = () => new Date(Date.now() + 3600_000).toISOString();

/** A provider that ROTATES refresh tokens: each refresh token works exactly once. */
function rotatingProvider(initialRefresh: string, delayMs = 0) {
  const valid = new Set([initialRefresh]);
  let n = 0;
  const refreshAccessToken = vi.fn(async (token: string) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (!valid.delete(token)) throw new Error("invalid_grant: refresh token already used");
    n++;
    const next = `rotated-refresh-${n}`;
    valid.add(next);
    return { accessToken: `access-${n}`, refreshToken: next, expiresAt: new Date(Date.now() + 3600_000), scope: "s" };
  });
  return { client: { refreshAccessToken } as unknown as GoogleOAuthClient, refreshAccessToken };
}

describe("token refresh is single-flight", () => {
  let p: string;
  beforeAll(async () => { p = (await createPrincipal("Refresh lock")).id; });
  afterAll(async () => { await deletePrincipal(p); await disconnectDb(); });

  it("N concurrent reads of an expired token cause exactly ONE refresh; the connection is not wrongly marked ERROR by a rotated-token rejection", async () => {
    // one connection per principal (loadConnection picks the latest for the principal)
    const q = (await createPrincipal("Refresh lock 1")).id;
    try {
      const c = await connection(q, { accessToken: "old", refreshToken: "refresh-0", expiresAt: expired() });
      const { client, refreshAccessToken } = rotatingProvider("refresh-0", 60);
      const results = await Promise.all(Array.from({ length: 8 }, () => resolveCredential(q, client)));
      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
      expect(new Set(results.map((r) => r.credential.accessToken))).toEqual(new Set(["access-1"]));
      expect(JSON.parse(await getCredentialStore().getSecret(c.ref))).toMatchObject({ accessToken: "access-1", refreshToken: "rotated-refresh-1" });
      expect((await getDb().connection.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ACTIVE");
      // and a later read reuses it without refreshing again
      await resolveCredential(q, client);
      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    } finally { await deletePrincipal(q); }
  });

  it("a caller that waited on the lock re-checks and reuses a credential another process refreshed meanwhile (no second refresh)", async () => {
    const q = (await createPrincipal("Refresh lock 2")).id;
    try {
      const c = await connection(q, { accessToken: "old", refreshToken: "refresh-0", expiresAt: expired() });
      const { client, refreshAccessToken } = rotatingProvider("refresh-0");
      const key = createHash("sha256").update(`connection-refresh:${c.id}`).digest().readBigInt64BE(0);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const lockAcquired = new Promise<void>((r) => { locked = r; });
      // "another process": holds the advisory lock, refreshes out of band, then releases
      const other = getDb().$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;
        locked();
        await held;
      }, { timeout: 20_000 });
      await lockAcquired;
      const waiting = resolveCredential(q, client);
      await new Promise((r) => setTimeout(r, 150));
      expect(refreshAccessToken).not.toHaveBeenCalled(); // blocked behind the lock
      await getCredentialStore().setSecret(c.ref, JSON.stringify({ accessToken: "refreshed-elsewhere", refreshToken: "r", expiresAt: fresh() }));
      release();
      await other;
      expect((await waiting).credential.accessToken).toBe("refreshed-elsewhere");
      expect(refreshAccessToken).not.toHaveBeenCalled();
    } finally { await deletePrincipal(q); }
  });

  it("a failed refresh is reported to every concurrent caller, marks the connection ERROR once, and releases the lock so a later attempt can succeed", async () => {
    const q = (await createPrincipal("Refresh lock 3")).id;
    try {
      const c = await connection(q, { accessToken: "old", refreshToken: "revoked", expiresAt: expired() });
      const failing = { refreshAccessToken: vi.fn(async () => { await new Promise((r) => setTimeout(r, 40)); throw new Error("invalid_grant"); }) } as unknown as GoogleOAuthClient;
      const settled = await Promise.allSettled(Array.from({ length: 5 }, () => resolveCredential(q, failing)));
      expect(settled.every((s) => s.status === "rejected" && s.reason instanceof CredentialExpiredError)).toBe(true);
      expect((failing as any).refreshAccessToken).toHaveBeenCalledTimes(1);
      expect((await getDb().connection.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ERROR");
      expect(await getDb().auditLog.count({ where: { principalId: q, eventType: "CONNECTION_FAILED" } })).toBe(1);
      // the lock was released: the user reconnects (new secret) and the next read succeeds
      await getCredentialStore().setSecret(c.ref, JSON.stringify({ accessToken: "old", refreshToken: "good", expiresAt: expired() }));
      const ok = rotatingProvider("good");
      expect((await resolveCredential(q, ok.client)).credential.accessToken).toBe("access-1");
    } finally { await deletePrincipal(q); }
  });

  it("different connections never block each other, and a fresh token never touches the lock or the provider", async () => {
    const q1 = (await createPrincipal("Refresh lock 4a")).id;
    const q2 = (await createPrincipal("Refresh lock 4b")).id;
    try {
      await connection(q1, { accessToken: "a-old", refreshToken: "ra", expiresAt: expired() });
      await connection(q2, { accessToken: "b-old", refreshToken: "rb", expiresAt: expired() });
      const slow = rotatingProvider("ra", 300);
      const fast = rotatingProvider("rb");
      const t0 = Date.now();
      const fastDone = resolveCredential(q2, fast.client).then(() => Date.now() - t0);
      const slowDone = resolveCredential(q1, slow.client);
      expect(await fastDone).toBeLessThan(250);
      await slowDone;
      const q3 = (await createPrincipal("Refresh lock 4c")).id;
      try {
        await connection(q3, { accessToken: "still-good", refreshToken: "r", expiresAt: fresh() });
        const never = rotatingProvider("nothing");
        expect((await resolveCredential(q3, never.client)).credential.accessToken).toBe("still-good");
        expect(never.refreshAccessToken).not.toHaveBeenCalled();
      } finally { await deletePrincipal(q3); }
    } finally { await deletePrincipal(q1); await deletePrincipal(q2); }
  });
});
