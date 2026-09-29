import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { OAuthStateService, OAuthStateInvalidError, OAuthStateExpiredError } from "../connectors/oauth/state.js";

describe("OAuthStateService — state binds an OAuth callback to a principal", () => {
  const service = new OAuthStateService();
  let principalA: string;
  let principalB: string;

  beforeAll(async () => {
    const db = getDb();
    const a = await db.principal.create({ data: { name: "OAuth Test Principal A" } });
    const b = await db.principal.create({ data: { name: "OAuth Test Principal B" } });
    principalA = a.id;
    principalB = b.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalA } }).catch(() => undefined);
    await db.principal.delete({ where: { id: principalB } }).catch(() => undefined);
    await disconnectDb();
  });

  it("creates a state token and consuming it returns the originating principal", async () => {
    const state = await service.create({
      principalId: principalA,
      provider: "google",
      redirectUri: "http://localhost:3000/callback",
    });
    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThan(20);

    const consumed = await service.consume(state, "google");
    expect(consumed.principalId).toBe(principalA);
    expect(consumed.redirectUri).toBe("http://localhost:3000/callback");
  });

  it("rejects state reuse — a second consume of the same token fails", async () => {
    const state = await service.create({
      principalId: principalA,
      provider: "google",
      redirectUri: "http://localhost:3000/callback",
    });
    await service.consume(state, "google");
    await expect(service.consume(state, "google")).rejects.toThrow(OAuthStateInvalidError);
  });

  it("rejects an unknown/mismatched state token", async () => {
    await expect(service.consume("totally-made-up-state-token", "google")).rejects.toThrow(OAuthStateInvalidError);
  });

  it("rejects a state token issued for a different provider", async () => {
    const state = await service.create({
      principalId: principalA,
      provider: "google",
      redirectUri: "http://localhost:3000/callback",
    });
    await expect(service.consume(state, "telegram")).rejects.toThrow(OAuthStateInvalidError);
  });

  it("principal binding: consuming a state issued for A never returns B's principalId, and there is no parameter to override it", async () => {
    const state = await service.create({
      principalId: principalA,
      provider: "google",
      redirectUri: "http://localhost:3000/callback",
    });
    const consumed = await service.consume(state, "google");
    expect(consumed.principalId).toBe(principalA);
    expect(consumed.principalId).not.toBe(principalB);
    // Structural check: consume() takes only (state, provider) — there is
    // no principalId parameter a caller could pass to attach someone
    // else's state to their own principal.
    expect(service.consume.length).toBe(2);
  });

  it("rejects an expired state token", async () => {
    const db = getDb();
    const state = await service.create({
      principalId: principalA,
      provider: "google",
      redirectUri: "http://localhost:3000/callback",
    });
    // Force expiry directly in the DB rather than waiting 10 real minutes.
    await db.oAuthState.update({ where: { state }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(service.consume(state, "google")).rejects.toThrow(OAuthStateExpiredError);
  });
});
