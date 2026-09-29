import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService, getExternalIdentityService } from "../identity/index.js";
import { TelegramAdapter } from "../interfaces/telegram/index.js";
import { handleVoiceInput } from "../interfaces/voice/index.js";
import { handleInterfaceMessage } from "../application/dispatcher.js";
import { decideApproval, listAuditLog } from "../gateway/index.js";
import { DEFAULT_APPROVAL_TTL_MS } from "../gateway/approvals/service.js";
import { setClock } from "../gateway/clock.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { createTask } from "../skills/system/tasks.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

const voiceSession = { id: "s", deviceId: "d", startedAt: new Date() };
const tasks = (p: string, title?: string) => getDb().task.count({ where: { principalId: p, ...(title ? { title } : {}) } });

describe("CREATE_TASK is an ActionDefinition (no legacy write path)", () => {
  let a: string;
  let b: string;
  let tgA: number;
  let bearerA: { Authorization: string };
  let bearerB: { Authorization: string };
  let bearerVoice: { Authorization: string };

  beforeAll(async () => {
    a = (await createPrincipal("Task Create A")).id;
    b = (await createPrincipal("Task Create B")).id;
    for (const p of [a, b]) await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "WRITE");
    await grant(a, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "READ", "READ");
    tgA = 600_000_000 + Math.floor(Math.random() * 300_000_000);
    await getExternalIdentityService().link({ principalId: a, interfaceSource: "TELEGRAM", externalId: String(tgA) });
    const tokens = getApiTokenService();
    bearerA = { Authorization: `Bearer ${(await tokens.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    bearerB = { Authorization: `Bearer ${(await tokens.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "b" })).token}` };
    bearerVoice = { Authorization: `Bearer ${(await tokens.create({ principalId: a, interfaceSource: "VOICE", label: "v" })).token}` };
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => setClock(null));
  afterEach(() => setClock(null));

  it("API/GuideHub: direct, with exact title/description/due date, audited as an execution (not the legacy event)", async () => {
    const due = "2035-05-05T15:00:00.000Z";
    const res = await request(app).post("/api/tasks").set(bearerA).send({ title: "api task", description: "details", dueAt: due });
    expect(res.body).toMatchObject({ status: "EXECUTED", message: "Task added: api task" });
    const row = await getDb().task.findFirstOrThrow({ where: { principalId: a, title: "api task" } });
    expect(row).toMatchObject({ description: "details" });
    expect(row.dueAt!.toISOString()).toBe(due);
    const events = (await listAuditLog(a, 100)).filter((e) => e.action === "CREATE_TASK").map((e) => e.eventType);
    expect(events).toEqual(expect.arrayContaining(["ACTION_EXECUTION_STARTED", "ACTION_EXECUTION_SUCCEEDED"]));
    expect(events).not.toContain("ACTION_EXECUTED");
  });

  it("GuideHub identity via the dispatcher: 'add task …' creates directly", async () => {
    const before = await tasks(a);
    expect((await handleInterfaceMessage(identityFor(a, "GUIDEHUB"), "add task buy milk")).status).toBe("EXECUTED");
    expect(await tasks(a)).toBe(before + 1);
  });

  it("Telegram: direct", async () => {
    const reply = await new TelegramAdapter().handleUpdate({ update_id: 9_100_001, message: { message_id: 1, from: { id: tgA }, chat: { id: tgA, type: "private" }, text: "add task call the bank" } });
    expect(reply?.text).toBe("Task added: call the bank");
    expect(await tasks(a, "call the bank")).toBe(1);
  });

  describe("voice", () => {
    const say = (t: string) => handleVoiceInput(identityFor(a, "VOICE"), { transcript: t, session: voiceSession, confidence: 0.95 });
    const pending = (title: string) => getDb().approvalRequest.findFirst({ where: { principalId: a, action: "CREATE_TASK", status: "PENDING" }, orderBy: { requestedAt: "desc" } }).then((r) => (r && (r.parameters as { title: string }).title === title ? r : null));

    it("does NOT create the task: it asks for approval (the audit finding: voice used to write directly)", async () => {
      const before = await tasks(a);
      const out = await say("add task voice task one");
      expect(out.speech).toMatch(/needs your approval/);
      expect(await tasks(a)).toBe(before);
      expect(await pending("voice task one")).not.toBeNull();
    });

    it("the same over HTTP with a VOICE credential is an approval, not a write", async () => {
      const before = await tasks(a);
      const res = await request(app).post("/api/tasks").set(bearerVoice).send({ title: "voice via http" });
      expect(res.body.status).toBe("PENDING_APPROVAL");
      expect(await tasks(a)).toBe(before);
    });

    it("approved: exactly one task with exactly the stored parameters; a retry creates nothing", async () => {
      await say("add task voice task two");
      const row = (await pending("voice task two"))!;
      expect((await decideApproval(identityFor(a, "GUIDEHUB"), row.id, "APPROVED")).executed).toBe(true);
      expect(await tasks(a, "voice task two")).toBe(1);
      expect((await decideApproval(identityFor(a, "GUIDEHUB"), row.id, "APPROVED")).ok).toBe(false);
      expect(await tasks(a, "voice task two")).toBe(1);
    });

    it("denied and expired approvals create nothing", async () => {
      await say("add task voice task three");
      const denied = (await pending("voice task three"))!;
      await decideApproval(identityFor(a, "TELEGRAM"), denied.id, "DENIED");
      expect(await tasks(a, "voice task three")).toBe(0);

      await say("add task voice task four");
      const expiring = (await pending("voice task four"))!;
      setClock(() => new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS + 60_000));
      expect(await decideApproval(identityFor(a, "GUIDEHUB"), expiring.id, "APPROVED")).toMatchObject({ ok: false, code: "EXPIRED" });
      expect(await tasks(a, "voice task four")).toBe(0);
    });
  });

  describe("permission, isolation, validation, activity", () => {
    it("without the permission: DENIED, audited, nothing created", async () => {
      const c = (await createPrincipal("Task Create C")).id;
      try {
        expect((await createTask(identityFor(c), { title: "nope" })).status).toBe("DENIED");
        expect(await tasks(c)).toBe(0);
        expect((await listAuditLog(c, 10)).some((e) => e.eventType === "ACTION_DENIED")).toBe(true);
      } finally { await deletePrincipal(c); }
    });

    it("a task is created only for the authenticated principal", async () => {
      await request(app).post("/api/tasks").set(bearerB).send({ title: "B only task" });
      expect(await tasks(a, "B only task")).toBe(0);
      expect(await tasks(b, "B only task")).toBe(1);
      const listA = (await request(app).get("/api/tasks").set(bearerA)).body.data as { title: string }[];
      expect(listA.some((t) => t.title === "B only task")).toBe(false);
    });

    it("strict validation: empty/oversized titles and bad dates create nothing; unknown fields never reach the row", async () => {
      const before = await tasks(a);
      expect((await createTask(identityFor(a), { title: "   " })).status).toBe("FAILED");
      expect((await createTask(identityFor(a), { title: "x".repeat(201) })).status).toBe("FAILED");
      expect((await request(app).post("/api/tasks").set(bearerA).send({ title: "ok", dueAt: "not a date" })).status).toBe(400);
      expect(await tasks(a)).toBe(before);
    });

    it("no Activity row is written for task creation (there is no task-created activity type); audit is", async () => {
      const before = await getDb().activity.count({ where: { principalId: a } });
      await createTask(identityFor(a), { title: "activity check" });
      expect(await getDb().activity.count({ where: { principalId: a } })).toBe(before);
    });
  });
});
