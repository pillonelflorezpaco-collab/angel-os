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
import { createReminder } from "../skills/system/tasks.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

const voiceSession = { id: "s", deviceId: "d", startedAt: new Date() };
const count = (principalId: string) => getDb().reminder.count({ where: { principalId } });

describe("CREATE_REMINDER as an ActionDefinition: interface policy end to end", () => {
  let a: string;
  let b: string;
  let tgA: number;
  let bearerA: { Authorization: string };
  let bearerB: { Authorization: string };
  let bearerVoiceA: { Authorization: string };

  beforeAll(async () => {
    a = (await createPrincipal("Reminder Create A", "America/Bogota")).id;
    b = (await createPrincipal("Reminder Create B", "UTC")).id;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_REMINDER", "WRITE");
      await grant(p, JARVIS_AGENT_KEY, "system.memory", "angel:memory", "MEMORY_WRITE", "WRITE");
    }
    tgA = 400_000_000 + Math.floor(Math.random() * 400_000_000);
    await getExternalIdentityService().link({ principalId: a, interfaceSource: "TELEGRAM", externalId: String(tgA) });
    const tokens = getApiTokenService();
    bearerA = { Authorization: `Bearer ${(await tokens.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    bearerB = { Authorization: `Bearer ${(await tokens.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "b" })).token}` };
    bearerVoiceA = { Authorization: `Bearer ${(await tokens.create({ principalId: a, interfaceSource: "VOICE", label: "v" })).token}` };
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => setClock(null));
  afterEach(() => setClock(null));

  const remindAt = new Date("2035-05-05T15:00:00.000Z");

  it("GuideHub/API: creates the reminder directly, with the exact stored instant", async () => {
    const before = await count(a);
    const res = await request(app).post("/api/reminders").set(bearerA).send({ message: "api reminder", remindAt: remindAt.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EXECUTED");
    expect(res.body.message).toBe("Reminder set for 2035-05-05 10:00: api reminder"); // shown in the principal's own timezone (Bogota)
    expect(await count(a)).toBe(before + 1);
    const row = await getDb().reminder.findFirstOrThrow({ where: { principalId: a, message: "api reminder" } });
    expect(row.remindAt.toISOString()).toBe(remindAt.toISOString());
    expect(row.status).toBe("PENDING");
  });

  it("the API rejects unknown fields and never accepts a principal", async () => {
    const extra = await request(app).post("/api/reminders").set(bearerA).send({ message: "x", remindAt: remindAt.toISOString(), chatId: 123 });
    expect(extra.status).toBe(200); // route schema strips unknown keys…
    const stored = await getDb().reminder.findFirstOrThrow({ where: { principalId: a, message: "x" } });
    expect(JSON.stringify(stored)).not.toContain("123"); // …and none of it reaches the reminder
    expect((await request(app).post("/api/reminders").set(bearerA).send({ message: "y", remindAt: remindAt.toISOString(), principalId: b })).status).toBe(400);
  });

  it("GuideHub identity via the dispatcher: 'remind me tomorrow at 10' creates directly", async () => {
    const before = await count(a);
    const r = await handleInterfaceMessage(identityFor(a, "GUIDEHUB"), "Remind me tomorrow at 10 to call John");
    expect(r.status).toBe("EXECUTED");
    expect(await count(a)).toBe(before + 1);
  });

  it("Telegram: creates directly", async () => {
    const before = await count(a);
    const reply = await new TelegramAdapter().handleUpdate({
      update_id: 9_000_001, message: { message_id: 1, from: { id: tgA }, chat: { id: tgA, type: "private" }, text: "Remind me tomorrow at 9 to stretch" },
    });
    expect(reply?.text).toMatch(/^Reminder set for \d{4}-\d{2}-\d{2} 09:00: stretch$/);
    expect(reply?.buttons).toBeUndefined();
    expect(await count(a)).toBe(before + 1);
  });

  describe("voice", () => {
    const say = (transcript: string) => handleVoiceInput(identityFor(a, "VOICE"), { transcript, session: voiceSession, confidence: 0.95 });
    const pending = () => getDb().approvalRequest.findMany({ where: { principalId: a, action: "CREATE_REMINDER", status: "PENDING" }, orderBy: { requestedAt: "desc" } });

    it("does NOT create the reminder immediately — it asks for approval", async () => {
      const before = await count(a);
      const out = await say("Remind me tomorrow at 8 to call the bank");
      expect(out.speech).toMatch(/needs your approval/);
      expect(out.speech).toMatch(/haven't done anything yet/);
      expect(await count(a)).toBe(before);
      const rows = await pending();
      expect(rows[0].interfaceSource).toBe("VOICE");
      expect((rows[0].parameters as { message: string }).message).toBe("call the bank");
    });

    it("an approved voice proposal creates exactly one reminder with exactly the proposed parameters", async () => {
      const before = await count(a);
      await say("Remind me tomorrow at 7 to water the plants");
      const row = (await pending()).find((r) => (r.parameters as { message: string }).message === "water the plants")!;
      const stored = row.parameters as { message: string; remindAt: string };
      const out = await decideApproval(identityFor(a, "GUIDEHUB"), row.id, "APPROVED");
      expect(out).toMatchObject({ ok: true, executed: true });
      expect(await count(a)).toBe(before + 1);
      const created = await getDb().reminder.findFirstOrThrow({ where: { principalId: a, message: "water the plants" } });
      expect(created.remindAt.toISOString()).toBe(stored.remindAt); // exact binding
      // a retry of the approval creates nothing more
      expect((await decideApproval(identityFor(a, "GUIDEHUB"), row.id, "APPROVED")).ok).toBe(false);
      expect(await count(a)).toBe(before + 1);
    });

    it("a denied voice proposal creates no reminder", async () => {
      const before = await count(a);
      await say("Remind me tomorrow at 6 to skip this");
      const row = (await pending()).find((r) => (r.parameters as { message: string }).message === "skip this")!;
      expect((await decideApproval(identityFor(a, "TELEGRAM"), row.id, "DENIED")).ok).toBe(true);
      expect(await count(a)).toBe(before);
    });

    it("an expired voice proposal creates no reminder", async () => {
      const before = await count(a);
      setClock(() => new Date("2036-01-01T00:00:00.000Z"));
      await say("Remind me tomorrow at 5 to expire");
      const row = (await pending()).find((r) => (r.parameters as { message: string }).message === "expire")!;
      setClock(() => new Date(new Date("2036-01-01T00:00:00.000Z").getTime() + DEFAULT_APPROVAL_TTL_MS + 1));
      expect(await decideApproval(identityFor(a, "GUIDEHUB"), row.id, "APPROVED")).toMatchObject({ ok: false, code: "EXPIRED" });
      expect(await count(a)).toBe(before);
    });

    it("policy pin: voice credentials may approve a LOW-risk reminder (but not sensitive actions — see approval-policy tests)", async () => {
      // policy: voice may approve LOW-risk actions (this is a design choice, pinned here)
      const before = await count(a);
      await say("Remind me tomorrow at 4 to approve by voice");
      const row = (await pending()).find((r) => (r.parameters as { message: string }).message === "approve by voice")!;
      expect((await decideApproval(identityFor(a, "VOICE"), row.id, "APPROVED")).ok).toBe(true);
      expect(await count(a)).toBe(before + 1);
    });

    it("the same request over the API with a VOICE credential is also an approval, not a direct write", async () => {
      const before = await count(a);
      const res = await request(app).post("/api/reminders").set(bearerVoiceA).send({ message: "voice via http", remindAt: remindAt.toISOString() });
      expect(res.body.status).toBe("PENDING_APPROVAL");
      expect(await count(a)).toBe(before);
    });

    it("voice 'remember that…' requires approval and stores nothing until approved", async () => {
      const before = await getDb().memory.count({ where: { principalId: a } });
      const out = await say("Remember that my locker code is 1234");
      expect(out.speech).toMatch(/needs your approval/);
      expect(await getDb().memory.count({ where: { principalId: a } })).toBe(before);
      const row = await getDb().approvalRequest.findFirstOrThrow({ where: { principalId: a, action: "MEMORY_WRITE", status: "PENDING" } });
      expect((await decideApproval(identityFor(a, "GUIDEHUB"), row.id, "APPROVED")).executed).toBe(true);
      expect(await getDb().memory.count({ where: { principalId: a } })).toBe(before + 1);
    });

    it("non-voice 'remember that…' still writes directly (Telegram/GuideHub)", async () => {
      const before = await getDb().memory.count({ where: { principalId: a } });
      const r = await handleInterfaceMessage(identityFor(a, "GUIDEHUB"), "Remember that I like tea");
      expect(r.status).toBe("EXECUTED");
      expect(await getDb().memory.count({ where: { principalId: a } })).toBe(before + 1);
    });
  });

  describe("isolation and validation", () => {
    it("a reminder is only ever created for the authenticated principal", async () => {
      await request(app).post("/api/reminders").set(bearerB).send({ message: "B only", remindAt: remindAt.toISOString() });
      expect(await getDb().reminder.count({ where: { principalId: a, message: "B only" } })).toBe(0);
      expect(await getDb().reminder.count({ where: { principalId: b, message: "B only" } })).toBe(1);
      await grant(a, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "READ", "READ");
      const listA = (await request(app).get("/api/reminders").set(bearerA)).body.data as { message: string }[];
      expect(listA.some((r) => r.message === "B only")).toBe(false);
    });

    it("a reminder cannot be attached to another principal's task", async () => {
      const task = await getDb().task.create({ data: { principalId: b, title: "B's task" } });
      const res = await request(app).post("/api/reminders").set(bearerA).send({ message: "steal", remindAt: remindAt.toISOString(), taskId: task.id });
      expect(res.body.status).toBe("FAILED");
      expect(await getDb().reminder.count({ where: { principalId: a, message: "steal" } })).toBe(0);
    });

    it("invalid parameters never create an approval or a reminder", async () => {
      const before = await count(a);
      const r = await createReminder(identityFor(a), { message: "   ", remindAt });
      expect(r.status).toBe("FAILED");
      const long = await createReminder(identityFor(a), { message: "x".repeat(501), remindAt });
      expect(long.status).toBe("FAILED");
      expect(await count(a)).toBe(before);
    });

    it("without the permission, creation is DENIED and audited", async () => {
      const c = (await createPrincipal("Reminder Create C")).id;
      try {
        const r = await createReminder(identityFor(c), { message: "nope", remindAt });
        expect(r.status).toBe("DENIED");
        expect(await count(c)).toBe(0);
        expect((await listAuditLog(c, 10)).some((e) => e.eventType === "ACTION_DENIED")).toBe(true);
      } finally { await deletePrincipal(c); }
    });
  });
});
