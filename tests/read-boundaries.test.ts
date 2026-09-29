import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { proposeAction } from "../gateway/index.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";
import { ACTIONS, FAKE_SKILL, registerFakeActions, ensureExecRegistry, grantAllFake, identityFor, goodParams } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

// Audit and approval READ routes: verified (not rewritten) to guarantee
// authentication, principal scoping, no client override, and redaction.
describe("audit and approval read routes", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  let authB: { Authorization: string };

  beforeAll(async () => {
    registerFakeActions();
    await ensureExecRegistry();
    a = (await createPrincipal("Read A")).id;
    b = (await createPrincipal("Read B")).id;
    await grantAllFake(a);
    await grantAllFake(b);
    const t = getApiTokenService();
    authA = { Authorization: `Bearer ${(await t.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    authB = { Authorization: `Bearer ${(await t.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "b" })).token}` };
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("every read route requires authentication", async () => {
    const id = (await proposeAction(identityFor(a), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: goodParams })).approvalId!;
    for (const path of ["/api/audit", "/api/approvals", `/api/approvals/${id}`]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized." });
    }
  });

  it("a client cannot pick the principal (query, header): 400, no data", async () => {
    for (const path of ["/api/audit", "/api/approvals"]) {
      expect((await request(app).get(`${path}?principalId=${b}`).set(authA)).status, path).toBe(400);
      expect((await request(app).get(path).set(authA).set("X-Principal-Id", b)).status, path).toBe(400);
    }
  });

  it("audit returns only the caller's rows, and the rows carry no secrets or raw parameters", async () => {
    const secret = "TOP-SECRET-BODY-5521";
    const r = await proposeAction(identityFor(a), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { to: "x@example.com", body: secret } });
    await proposeAction(identityFor(b), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { to: "b@example.com", body: "b body" } });
    const rowsA = (await request(app).get("/api/audit").set(authA)).body as { principalId: string }[];
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((e) => e.principalId === a)).toBe(true);
    expect(JSON.stringify(rowsA)).not.toContain(secret);
    expect(JSON.stringify(rowsA)).not.toContain("x@example.com");
    const rowsB = (await request(app).get("/api/audit").set(authB)).body as { principalId: string }[];
    expect(rowsB.every((e) => e.principalId === b)).toBe(true);
    expect(r.approvalId).toBeTruthy();
  });

  it("approvals: lists only the caller's; another principal's approval is a 404 identical to a missing one", async () => {
    const id = (await proposeAction(identityFor(a), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { ...goodParams, body: "scoped" } })).approvalId!;
    expect(((await request(app).get("/api/approvals").set(authB)).body as { id: string }[]).some((x) => x.id === id)).toBe(false);
    const other = await request(app).get(`/api/approvals/${id}`).set(authB);
    const missing = await request(app).get(`/api/approvals/00000000-0000-0000-0000-00000000f00d`).set(authB);
    expect([other.status, other.body]).toEqual([missing.status, missing.body]);
    expect(other.status).toBe(404);
  });

  it("the rows are never writable through these routes (GET only)", async () => {
    for (const method of ["post", "put", "delete", "patch"] as const) {
      expect((await request(app)[method]("/api/audit").set(authA).send({})).status).toBe(404);
    }
  });
});
