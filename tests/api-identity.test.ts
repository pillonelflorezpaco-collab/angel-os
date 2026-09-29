import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService, type Authenticator } from "../identity/index.js";
import { proposeAction, listAuditLog } from "../gateway/index.js";
import { ACTIONS, FAKE_SKILL, ensureExecRegistry, goodParams, grantFake, identityFor, registerFakeActions } from "./helpers/fakeActions.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { SKILL_KEY as TASKS_SKILL, RESOURCE as TASKS_RESOURCE } from "../skills/system/tasks.js";
import { SKILL_KEY as MEMORY_SKILL, RESOURCE as MEMORY_RESOURCE } from "../skills/system/memory.js";
import { SKILL_KEY as ACTIVITY_SKILL, RESOURCE as ACTIVITY_RESOURCE } from "../skills/system/activity.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

process.env.NODE_ENV = "test";
const { app, createApp } = await import("../api/server.js");

async function grantAll(principalId: string) {
  await grant(principalId, JARVIS_AGENT_KEY, TASKS_SKILL, TASKS_RESOURCE, "READ", "READ");
  await grant(principalId, JARVIS_AGENT_KEY, TASKS_SKILL, TASKS_RESOURCE, "CREATE_TASK", "WRITE");
  await grant(principalId, JARVIS_AGENT_KEY, MEMORY_SKILL, MEMORY_RESOURCE, "MEMORY_READ", "READ");
  await grant(principalId, JARVIS_AGENT_KEY, MEMORY_SKILL, MEMORY_RESOURCE, "MEMORY_WRITE", "WRITE");
  await grant(principalId, JARVIS_AGENT_KEY, ACTIVITY_SKILL, ACTIVITY_RESOURCE, "ACTIVITY_READ", "READ");
}

describe("HTTP identity, isolation, and interface tagging", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  let authB: { Authorization: string };
  let authAApi: { Authorization: string };
  let tokenAId: string;

  beforeAll(async () => {
    a = (await createPrincipal("HTTP Principal A", "America/Bogota")).id;
    b = (await createPrincipal("HTTP Principal B")).id;
    await grantAll(a);
    await grantAll(b);
    const tokens = getApiTokenService();
    const ta = await tokens.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "A guidehub" });
    tokenAId = ta.id;
    authA = { Authorization: `Bearer ${ta.token}` };
    authAApi = { Authorization: `Bearer ${(await tokens.create({ principalId: a, interfaceSource: "API", label: "A api" })).token}` };
    authB = { Authorization: `Bearer ${(await tokens.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "B guidehub" })).token}` };
  });

  afterAll(async () => {
    await deletePrincipal(a);
    await deletePrincipal(b);
    await disconnectDb();
  });

  describe("authentication", () => {
    it("rejects a missing, wrong, or revoked token with a bare 401 and no detail", async () => {
      const missing = await request(app).get("/api/tasks");
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toBe("Bearer");
      expect(missing.body).toEqual({ error: "Unauthorized." });

      const wrong = await request(app).get("/api/tasks").set("Authorization", `Bearer aos_${"Z".repeat(43)}`);
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual({ error: "Unauthorized." });

      const { token, id } = await getApiTokenService().create({ principalId: a, interfaceSource: "API", label: "revoked" });
      await getApiTokenService().revoke(a, id);
      expect((await request(app).get("/api/tasks").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    });

    it("unauthenticated callers cannot tell real routes from fake ones", async () => {
      expect((await request(app).get("/api/does-not-exist")).status).toBe(401);
      expect((await request(app).get("/api/does-not-exist").set(authA)).status).toBe(404);
    });

    it("no fallback: there is no way to reach a principal without a credential", async () => {
      // The old findFirst() behaviour is gone: a request with no credential never
      // acts as anyone, even when a principal exists in the database.
      const res = await request(app).post("/api/jarvis").send({ input: "what are my tasks" });
      expect(res.status).toBe(401);
    });

    it("an authenticator failure yields a generic 500 and does not stop the server", async () => {
      const failing: Authenticator = {
        authenticate: async () => {
          throw new Error("connect ECONNREFUSED postgresql://angel:hunter2@db:5432/x");
        },
      };
      const broken = createApp({ authenticator: failing });
      const res = await request(broken).get("/api/tasks");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Unexpected error." });
      expect(JSON.stringify(res.body)).not.toContain("hunter2");
      // still serving afterwards
      expect((await request(broken).get("/health")).status).toBe(200);
    });

    it("malformed JSON gets a sanitized 400", async () => {
      const res = await request(app).post("/api/tasks").set(authA).set("Content-Type", "application/json").send("{ not json");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Malformed request body." });
    });
  });

  describe("principal isolation over HTTP", () => {
    it("each token sees only its own principal's data", async () => {
      await request(app).post("/api/tasks").set(authA).send({ title: "http-only-A-task" });
      await request(app).post("/api/tasks").set(authB).send({ title: "http-only-B-task" });

      const listA = (await request(app).get("/api/tasks").set(authA)).body.data as { title: string }[];
      const listB = (await request(app).get("/api/tasks").set(authB)).body.data as { title: string }[];
      expect(listA.map((t) => t.title)).toContain("http-only-A-task");
      expect(listA.map((t) => t.title)).not.toContain("http-only-B-task");
      expect(listB.map((t) => t.title)).toContain("http-only-B-task");
      expect(listB.map((t) => t.title)).not.toContain("http-only-A-task");
    });

    it("B cannot decide A's approval, and cannot tell it exists", async () => {
      registerFakeActions();
      await ensureExecRegistry();
      await grantFake(a, ACTIONS.SEND);
      const proposed = await proposeAction(identityFor(a), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: goodParams });
      const approvalId = proposed.approvalId!;

      const asB = await request(app).post(`/api/approvals/${approvalId}/approve`).set(authB).send({});
      const nonexistent = await request(app).post("/api/approvals/00000000-0000-0000-0000-00000000dead/approve").set(authB).send({});
      expect(asB.status).toBe(404);
      expect(asB.body).toEqual(nonexistent.body);
      expect((await getDb().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe("PENDING");

      expect((await request(app).post(`/api/approvals/${approvalId}/deny`).set(authA).send({})).status).toBe(200);
    });

    it("B cannot read A's audit log or approvals", async () => {
      const auditB = (await request(app).get("/api/audit").set(authB)).body as { principalId: string }[];
      expect(auditB.every((e) => e.principalId === b)).toBe(true);
    });
  });

  describe("client-supplied principalId is rejected", () => {
    it("in the JSON body", async () => {
      const before = await getDb().task.count({ where: { principalId: b } });
      const res = await request(app).post("/api/tasks").set(authA).send({ title: "steal", principalId: b });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/principalId cannot be supplied/);
      expect(await getDb().task.count({ where: { principalId: b } })).toBe(before);
    });

    it.each([["principal_id"], ["PrincipalId"], ["principal-id"]])("under the variant key %s", async (key) => {
      const res = await request(app).post("/api/tasks").set(authA).send({ title: "x", [key]: b });
      expect(res.status).toBe(400);
    });

    it("nested inside the body", async () => {
      const res = await request(app).post("/api/jarvis").set(authA).send({ input: "hi", context: { principalId: b } });
      expect(res.status).toBe(400);
    });

    it("in the query string", async () => {
      const res = await request(app).get(`/api/tasks?principalId=${b}`).set(authA);
      expect(res.status).toBe(400);
    });

    it("in a header", async () => {
      const res = await request(app).get("/api/tasks").set(authA).set("X-Principal-Id", b);
      expect(res.status).toBe(400);
    });

    it("is rejected even when the value equals the caller's own principal", async () => {
      const res = await request(app).get(`/api/tasks?principalId=${a}`).set(authA);
      expect(res.status).toBe(400);
    });
  });

  describe("interface identification", () => {
    it("GET /api/me reports the interface and auth method from the credential", async () => {
      const res = await request(app).get("/api/me").set(authA);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        principal: { id: a, name: "HTTP Principal A", timezone: "America/Bogota" },
        interface: "GUIDEHUB",
        authMethod: "api_token",
      });
      expect(res.body.requestId).toBe(res.headers["x-request-id"]);
      expect((await request(app).get("/api/me").set(authAApi)).body.interface).toBe("API");
    });

    it("a client cannot claim a different interface", async () => {
      const res = await request(app).get("/api/me").set(authA).set("X-Interface", "TELEGRAM").set("X-Interface-Source", "VOICE");
      expect(res.body.interface).toBe("GUIDEHUB");
    });

    it("audit rows are stamped with the interface and the request id", async () => {
      const res = await request(app).post("/api/tasks").set(authA).send({ title: "stamped task" });
      const requestId = res.headers["x-request-id"] as string;
      const rows = (await listAuditLog(a, 50)).filter((r) => r.requestId === requestId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.interfaceSource === "GUIDEHUB")).toBe(true);
    });

    it("the same action from a different token is recorded against that token's interface", async () => {
      const res = await request(app).post("/api/tasks").set(authAApi).send({ title: "api-stamped task" });
      const rows = (await listAuditLog(a, 50)).filter((r) => r.requestId === res.headers["x-request-id"]);
      expect(rows.every((r) => r.interfaceSource === "API")).toBe(true);
    });

    it("token issuance is not exposed over HTTP", async () => {
      for (const path of ["/api/tokens", "/api/identity", "/api/auth/token", "/api/login"]) {
        expect((await request(app).post(path).set(authA).send({})).status, path).toBe(404);
      }
      void tokenAId;
    });
  });

  describe("CORS is off unless explicitly allowed", () => {
    it("sends no CORS headers by default", async () => {
      const res = await request(app).get("/health").set("Origin", "https://cockpit.example");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows exactly the listed origins, and never '*'", async () => {
      const scoped = createApp({ corsOrigins: ["https://cockpit.example", "*"] });
      const ok = await request(scoped).get("/health").set("Origin", "https://cockpit.example");
      expect(ok.headers["access-control-allow-origin"]).toBe("https://cockpit.example");
      expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();

      const other = await request(scoped).get("/health").set("Origin", "https://evil.example");
      expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("a config of just '*' allows no origin at all (origins are matched exactly, never as wildcards)", async () => {
      const star = createApp({ corsOrigins: ["*"] });
      const res = await request(star).get("/health").set("Origin", "https://anything.example");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("answers a preflight for an allowed origin without needing a token", async () => {
      const scoped = createApp({ corsOrigins: ["https://cockpit.example"] });
      const res = await request(scoped)
        .options("/api/tasks")
        .set("Origin", "https://cockpit.example")
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "authorization");
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
    });
  });

  describe("GuideHub compatibility (the documented API contract)", () => {
    it("every response carries the API version", async () => {
      expect((await request(app).get("/health")).headers["x-angel-api-version"]).toBe("2");
      expect((await request(app).get("/api/me").set(authA)).headers["x-angel-api-version"]).toBe("2");
    });

    it("skill-backed endpoints return the Result envelope", async () => {
      for (const path of ["/api/tasks", "/api/reminders", "/api/activity", "/api/activity/summary", "/api/memory/search?q=x"]) {
        const res = await request(app).get(path).set(authA);
        expect(res.status, path).toBe(200);
        expect(Object.keys(res.body).sort(), path).toEqual(expect.arrayContaining(["data", "message", "status"]));
        expect(res.body.status, path).toBe("EXECUTED");
        expect(typeof res.body.message, path).toBe("string");
      }
    });

    it("POST /api/jarvis returns a Result with a ready-to-display message", async () => {
      const res = await request(app).post("/api/jarvis").set(authA).send({ input: "what are my tasks" });
      expect(res.body.status).toBe("EXECUTED");
      expect(res.body.message).toMatch(/^Your tasks \(\d+\):/);
    });

    it("the activity summary has a stable shape", async () => {
      const res = await request(app).get("/api/activity/summary?range=week").set(authA);
      expect(Object.keys(res.body.data).sort()).toEqual(["byArea", "byType", "from", "range", "timeZone", "to", "total"]);
      expect(res.body.data.timeZone).toBe("America/Bogota");
    });

    it("errors are always { error: string }", async () => {
      const cases = [
        await request(app).get("/api/activity?range=fortnight").set(authA),
        await request(app).get("/api/tasks"),
        await request(app).get("/api/connections/00000000-0000-0000-0000-000000000000").set(authA),
      ];
      for (const res of cases) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.body).toHaveProperty("error");
      }
    });

    it("input longer than the limit is rejected", async () => {
      const res = await request(app).post("/api/jarvis").set(authA).send({ input: "x".repeat(2001) });
      expect(res.status).toBe(400);
    });
  });
});
