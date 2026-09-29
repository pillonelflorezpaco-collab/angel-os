import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { proposeAction } from "../gateway/index.js";
import { DEFAULT_APPROVAL_TTL_MS } from "../gateway/approvals/service.js";
import { setClock } from "../gateway/clock.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";
import { ACTIONS, FAKE_SKILL, calls, resetCalls, registerFakeActions, ensureExecRegistry, grantAllFake, identityFor, goodParams } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

const T0 = new Date("2031-06-01T09:00:00.000Z");

describe("approval HTTP contract (GuideHub / API)", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  let authB: { Authorization: string };
  let authVoice: { Authorization: string };
  let n = 0;
  const propose = async (action: string = ACTIONS.SEND, params: Record<string, unknown> = { ...goodParams, body: `api-${++n}-${Math.random()}` }) =>
    (await proposeAction(identityFor(a), { skillKey: FAKE_SKILL, action, parameters: params })).approvalId!;

  beforeAll(async () => {
    registerFakeActions();
    await ensureExecRegistry();
    a = (await createPrincipal("Approval API A")).id;
    b = (await createPrincipal("Approval API B")).id;
    await grantAllFake(a);
    await grantAllFake(b);
    const tokens = getApiTokenService();
    authA = { Authorization: `Bearer ${(await tokens.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    authB = { Authorization: `Bearer ${(await tokens.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "b" })).token}` };
    authVoice = { Authorization: `Bearer ${(await tokens.create({ principalId: a, interfaceSource: "VOICE", label: "v" })).token}` };
  });
  afterAll(async () => {
    await deletePrincipal(a);
    await deletePrincipal(b);
    await disconnectDb();
  });
  beforeEach(() => { resetCalls(); setClock(() => T0); });
  afterEach(() => setClock(null));

  describe("authentication", () => {
    it("every approval route requires a valid token (401, no detail)", async () => {
      const id = await propose();
      for (const [method, path] of [["get", "/api/approvals"], ["get", `/api/approvals/${id}`], ["post", `/api/approvals/${id}/approve`], ["post", `/api/approvals/${id}/deny`]] as const) {
        const res = await request(app)[method](path).send({});
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized." });
      }
      expect(calls).toHaveLength(0);
    });

    it("a client-supplied principalId is rejected with 400 (body, query, header) and nothing is decided", async () => {
      const id = await propose();
      const inBody = await request(app).post(`/api/approvals/${id}/approve`).set(authA).send({ principalId: b });
      const inQuery = await request(app).post(`/api/approvals/${id}/approve?principalId=${b}`).set(authA).send({});
      const inHeader = await request(app).post(`/api/approvals/${id}/approve`).set(authA).set("X-Principal-Id", b).send({});
      expect([inBody.status, inQuery.status, inHeader.status]).toEqual([400, 400, 400]);
      expect((await getDb().approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
      expect(calls).toHaveLength(0);
    });

    it("decision endpoints take no parameters: a body trying to alter the action is refused, nothing runs", async () => {
      const id = await propose(ACTIONS.SEND, { to: "real@example.com", body: "the stored body" });
      const res = await request(app).post(`/api/approvals/${id}/approve`).set(authA).send({ parameters: { to: "evil@example.com", body: "swapped" } });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
      const ok = await request(app).post(`/api/approvals/${id}/approve`).set(authA).send({});
      expect(ok.status).toBe(200);
      expect(calls[0].params).toEqual({ to: "real@example.com", body: "the stored body" }); // stored, never the client's
    });

    it("the old /decide route is gone", async () => {
      const id = await propose();
      expect((await request(app).post(`/api/approvals/${id}/decide`).set(authA).send({ decision: "APPROVED" })).status).toBe(404);
    });
  });

  describe("list / get / approve / deny", () => {
    it("lists only the caller's pending approvals, with a safe summary", async () => {
      const id = await propose();
      const listA = await request(app).get("/api/approvals").set(authA);
      const listB = await request(app).get("/api/approvals").set(authB);
      expect(listA.status).toBe(200);
      const item = (listA.body as { id: string; summary: string; parameters?: unknown }[]).find((x) => x.id === id)!;
      expect(item.summary).toMatch(/^Send test message to/);
      expect(item.parameters).toBeUndefined();
      expect((listB.body as { id: string }[]).map((x) => x.id)).not.toContain(id);
    });

    it("get one returns the exact stored parameters to its owner, 404 to anyone else", async () => {
      const id = await propose(ACTIONS.SEND, { to: "who@example.com", body: "look" });
      const mine = await request(app).get(`/api/approvals/${id}`).set(authA);
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ id, status: "PENDING", parameters: { to: "who@example.com", body: "look" } });
      const theirs = await request(app).get(`/api/approvals/${id}`).set(authB);
      const missing = await request(app).get(`/api/approvals/00000000-0000-0000-0000-000000000abc`).set(authB);
      expect(theirs.status).toBe(404);
      expect(theirs.body).toEqual(missing.body);
      expect(theirs.body).toEqual({ error: "Approval not found." });
    });

    it("approve executes once and says so; a second approve is 409 'already consumed'", async () => {
      const id = await propose();
      const first = await request(app).post(`/api/approvals/${id}/approve`).set(authA).send({});
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ executed: true, execution: { status: "EXECUTED" }, approval: { status: "CONSUMED" } });
      const second = await request(app).post(`/api/approvals/${id}/approve`).set(authA).send({});
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ error: "Approval already consumed.", code: "CONSUMED" });
      expect(calls).toHaveLength(1);
    });

    it("a failed execution is 200 for the decision but executed:false with the failure stated", async () => {
      const id = await propose(ACTIONS.FAIL);
      const res = await request(app).post(`/api/approvals/${id}/approve`).set(authA).send({});
      expect(res.status).toBe(200);
      expect(res.body.executed).toBe(false);
      expect(res.body.execution.status).toBe("FAILED");
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|secret-host/);
    });

    it("deny records the denial and runs nothing", async () => {
      const id = await propose();
      const res = await request(app).post(`/api/approvals/${id}/deny`).set(authA).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ executed: false, approval: { status: "DENIED" } });
      expect(calls).toHaveLength(0);
      expect((await request(app).post(`/api/approvals/${id}/approve`).set(authA).send({})).status).toBe(409);
    });

    it("another principal cannot approve or deny (404, identical to nonexistent); the approval stays pending", async () => {
      const id = await propose();
      const ap = await request(app).post(`/api/approvals/${id}/approve`).set(authB).send({});
      const de = await request(app).post(`/api/approvals/${id}/deny`).set(authB).send({});
      const missing = await request(app).post(`/api/approvals/00000000-0000-0000-0000-000000000def/approve`).set(authB).send({});
      expect([ap.status, de.status]).toEqual([404, 404]);
      expect(ap.body).toEqual(missing.body);
      expect(calls).toHaveLength(0);
      expect((await getDb().approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
    });

    it("an expired approval is 410 'Approval expired.' and never runs", async () => {
      const id = await propose();
      setClock(() => new Date(T0.getTime() + DEFAULT_APPROVAL_TTL_MS + 1));
      const res = await request(app).post(`/api/approvals/${id}/approve`).set(authA).send({});
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ error: "Approval expired." });
      expect(calls).toHaveLength(0);
    });

    it("a malformed id is a plain 404, not a server error", async () => {
      const res = await request(app).post(`/api/approvals/not-a-uuid/approve`).set(authA).send({});
      expect(res.status).toBe(404);
    });
  });

  describe("interface policy over HTTP", () => {
    it("a VOICE credential cannot approve a sensitive action (403), but can deny it", async () => {
      const id = await propose();
      const ap = await request(app).post(`/api/approvals/${id}/approve`).set(authVoice).send({});
      expect(ap.status).toBe(403);
      expect(ap.body.error).toBe("You are not authorized to approve this action.");
      expect(calls).toHaveLength(0);
      expect((await getDb().approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
      expect((await request(app).post(`/api/approvals/${id}/deny`).set(authVoice).send({})).status).toBe(200);
    });
  });
});
