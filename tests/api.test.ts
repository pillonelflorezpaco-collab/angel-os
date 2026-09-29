import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { RESOURCE as TASKS_RESOURCE, SKILL_KEY as TASKS_SKILL } from "../skills/system/tasks.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

// These tests originally called every endpoint with no credentials and got
// whichever principal findFirst() returned. Since the identity layer, every
// /api route requires a bearer token, and the principal comes from it. The
// assertions below are the original ones; only the authentication is new.
describe("API", () => {
  let principalId: string;
  let auth: { Authorization: string };

  beforeAll(async () => {
    principalId = (await createPrincipal("API Test Principal")).id;
    const { token } = await getApiTokenService().create({ principalId, interfaceSource: "GUIDEHUB", label: "api.test" });
    auth = { Authorization: `Bearer ${token}` };
    for (const action of ["READ", "CREATE_TASK", "CREATE_REMINDER"] as const) {
      await grant(principalId, JARVIS_AGENT_KEY, TASKS_SKILL, TASKS_RESOURCE, action, action === "READ" ? "READ" : "WRITE");
    }
  });

  afterAll(async () => {
    await deletePrincipal(principalId);
    await disconnectDb();
  });

  it("GET /health returns ok, without authentication", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("every /api route rejects an unauthenticated request", async () => {
    for (const path of ["/api/tasks", "/api/reminders", "/api/audit", "/api/approvals", "/api/connections", "/api/me", "/api/activity"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it("POST /api/tasks creates a task, GET /api/tasks retrieves it", async () => {
    const create = await request(app).post("/api/tasks").set(auth).send({ title: "Buy groceries" });
    expect(create.status).toBe(200);
    expect(create.body.status).toBe("EXECUTED");

    const list = await request(app).get("/api/tasks").set(auth);
    expect(list.status).toBe(200);
    const titles = (list.body.data as { title: string }[]).map((t) => t.title);
    expect(titles).toContain("Buy groceries");
  });

  it("POST /api/reminders creates a reminder, GET /api/reminders retrieves it", async () => {
    const remindAt = new Date(Date.now() + 60_000).toISOString();
    const create = await request(app).post("/api/reminders").set(auth).send({ message: "Call the dentist", remindAt });
    expect(create.status).toBe(200);
    expect(create.body.status).toBe("EXECUTED");

    const list = await request(app).get("/api/reminders").set(auth);
    const messages = (list.body.data as { message: string }[]).map((r) => r.message);
    expect(messages).toContain("Call the dentist");
  });

  it("POST /api/jarvis handles a natural-language request end to end", async () => {
    const res = await request(app).post("/api/jarvis").set(auth).send({ input: "what are my tasks" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EXECUTED");
  });

  it("rejects invalid payloads with 400", async () => {
    const res = await request(app).post("/api/tasks").set(auth).send({});
    expect(res.status).toBe(400);
  });
});
