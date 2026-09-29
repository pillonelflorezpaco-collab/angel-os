import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { setPermission } from "../gateway/permissions/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { RESOURCE as TASKS_RESOURCE, SKILL_KEY as TASKS_SKILL } from "../skills/system/tasks.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

describe("API", () => {
  afterAll(async () => {
    await disconnectDb();
  });

  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  describe("with a permitted principal", () => {
    beforeAll(async () => {
      const db = getDb();
      // getOrCreatePrincipal() in the API picks findFirst(); ensure one
      // exists with the permissions the tasks/reminders endpoints need.
      const principal = (await db.principal.findFirst()) ?? (await db.principal.create({ data: { name: "Angel" } }));

      await db.agent.upsert({
        where: { key: JARVIS_AGENT_KEY },
        update: {},
        create: { key: JARVIS_AGENT_KEY, name: "Jarvis Core" },
      });
      await db.skill.upsert({
        where: { key: TASKS_SKILL },
        update: {},
        create: { key: TASKS_SKILL, name: "System Tasks" },
      });

      for (const action of ["READ", "CREATE_TASK", "CREATE_REMINDER"] as const) {
        await setPermission({
          principalId: principal.id,
          agentKey: JARVIS_AGENT_KEY,
          skillKey: TASKS_SKILL,
          resource: TASKS_RESOURCE,
          action,
          category: action === "READ" ? "READ" : "WRITE",
          state: "ALLOWED",
        });
      }
    });

    it("POST /api/tasks creates a task, GET /api/tasks retrieves it", async () => {
      const create = await request(app).post("/api/tasks").send({ title: "Buy groceries" });
      expect(create.status).toBe(200);
      expect(create.body.status).toBe("EXECUTED");

      const list = await request(app).get("/api/tasks");
      expect(list.status).toBe(200);
      const titles = (list.body.data as { title: string }[]).map((t) => t.title);
      expect(titles).toContain("Buy groceries");
    });

    it("POST /api/reminders creates a reminder, GET /api/reminders retrieves it", async () => {
      const remindAt = new Date(Date.now() + 60_000).toISOString();
      const create = await request(app).post("/api/reminders").send({ message: "Call the dentist", remindAt });
      expect(create.status).toBe(200);
      expect(create.body.status).toBe("EXECUTED");

      const list = await request(app).get("/api/reminders");
      const messages = (list.body.data as { message: string }[]).map((r) => r.message);
      expect(messages).toContain("Call the dentist");
    });

    it("POST /api/jarvis handles a natural-language request end to end", async () => {
      const res = await request(app).post("/api/jarvis").send({ input: "what are my tasks" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("EXECUTED");
    });

    it("rejects invalid payloads with 400", async () => {
      const res = await request(app).post("/api/tasks").send({});
      expect(res.status).toBe(400);
    });
  });
});
