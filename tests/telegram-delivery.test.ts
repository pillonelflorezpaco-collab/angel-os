import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { TelegramBotApi, TelegramApiError, TelegramDeliveryPort } from "../interfaces/telegram/index.js";
import { DeliveryDispatcher } from "../application/delivery.js";
import { ReminderEngine } from "../reminders/index.js";
import { getExternalIdentityService } from "../identity/index.js";
import { listAuditLog } from "../gateway/index.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";

const T0 = new Date("2041-01-01T12:00:00.000Z");
const svc = getExternalIdentityService();

describe("Telegram proactive delivery (fake transport)", () => {
  let a: string;
  let b: string;
  let tgA: number;
  let tgB: number;
  const outbox: { chatId: number; text: string }[] = [];
  let failWith: unknown = null;
  const sender = { sendMessage: async (chatId: number, text: string) => { if (failWith) throw failWith; outbox.push({ chatId, text }); } };
  const port = () => new TelegramDeliveryPort(sender, svc);
  const req = (principalId: string) => ({ principalId, message: "⏰ hi", idempotencyKey: "reminder:x", correlationId: "c" });

  beforeAll(async () => {
    a = (await createPrincipal("TGD A")).id;
    b = (await createPrincipal("TGD B")).id;
    tgA = 500_000_000 + Math.floor(Math.random() * 300_000_000);
    tgB = tgA + 1;
    await svc.link({ principalId: a, interfaceSource: "TELEGRAM", externalId: String(tgA) });
    await svc.link({ principalId: b, interfaceSource: "TELEGRAM", externalId: String(tgB) });
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => { outbox.length = 0; failWith = null; });

  it("delivers to the principal's own linked Telegram account only", async () => {
    expect(await port().deliver(req(a))).toEqual({ status: "DELIVERED" });
    expect(await port().deliver(req(b))).toEqual({ status: "DELIVERED" });
    expect(outbox).toEqual([{ chatId: tgA, text: "⏰ hi" }, { chatId: tgB, text: "⏰ hi" }]);
  });

  it("a principal with no linked Telegram account gets FAILED/NO_DESTINATION and nothing is sent", async () => {
    const c = (await createPrincipal("TGD C")).id;
    try {
      expect(await port().deliver(req(c))).toEqual({ status: "FAILED", code: "NO_DESTINATION", retryable: false });
      expect(outbox).toHaveLength(0);
    } finally { await deletePrincipal(c); }
  });

  it("an unlinked (revoked) account is no longer a destination", async () => {
    const d = (await createPrincipal("TGD D")).id;
    try {
      const ext = String(tgA + 50);
      const { id } = await svc.link({ principalId: d, interfaceSource: "TELEGRAM", externalId: ext });
      expect((await port().deliver(req(d))).status).toBe("DELIVERED");
      await svc.unlink(d, id);
      expect((await port().deliver(req(d)))).toMatchObject({ status: "FAILED", code: "NO_DESTINATION" });
    } finally { await deletePrincipal(d); }
  });

  it("an invalid stored destination is refused before any network call", async () => {
    const stub = { listActiveExternalIds: async () => ["-1001234", "abc", "0", "1".repeat(20), "12 34"] };
    for (const bad of await stub.listActiveExternalIds()) {
      const p = new TelegramDeliveryPort(sender, { listActiveExternalIds: async () => [bad] });
      expect(await p.deliver(req(a)), bad).toEqual({ status: "FAILED", code: "INVALID_DESTINATION", retryable: false });
    }
    expect(outbox).toHaveLength(0);
  });

  it("normalizes Telegram failures: 4xx rejected, 429 retryable, 5xx / timeout / network unconfirmed", async () => {
    failWith = new TelegramApiError("sendMessage", 403);
    expect(await port().deliver(req(a))).toEqual({ status: "FAILED", code: "TELEGRAM_REJECTED", retryable: false });
    failWith = new TelegramApiError("sendMessage", 400);
    expect((await port().deliver(req(a)))).toMatchObject({ status: "FAILED", retryable: false });
    failWith = new TelegramApiError("sendMessage", 429, 5);
    expect(await port().deliver(req(a))).toEqual({ status: "FAILED", code: "RATE_LIMITED", retryable: true });
    for (const err of [new TelegramApiError("sendMessage", 502), new TelegramApiError("sendMessage"), new Error("ECONNRESET")]) {
      failWith = err;
      expect(await port().deliver(req(a))).toEqual({ status: "UNCONFIRMED", code: "TELEGRAM_UNCONFIRMED" });
    }
  });

  it("the real Bot API client times out a hung send (no HTTP status → unconfirmed) and never leaks the token", async () => {
    const token = "123456:SECRET-BOT-TOKEN";
    const hung = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error(`fetch failed for https://api.telegram.org/bot${token}/sendMessage`))))) as unknown as typeof fetch;
    const api = new TelegramBotApi(token, hung, "https://api.telegram.org", 30);
    const p = new TelegramDeliveryPort(api, svc);
    const out = await p.deliver(req(a));
    expect(out).toEqual({ status: "UNCONFIRMED", code: "TELEGRAM_UNCONFIRMED" });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    await expect(api.sendMessage(1, "x")).rejects.toSatisfy((e: unknown) => e instanceof TelegramApiError && !e.message.includes("SECRET"));
  });

  describe("end to end through the engine (SYSTEM → dispatcher → Telegram port → fake API)", () => {
    const engine = (principalId: string, now = T0) => new ReminderEngine({ principalId, deliverer: new DeliveryDispatcher([port()]), now: () => now });

    it("a due reminder reaches only its own principal's Telegram chat", async () => {
      const ra = await getDb().reminder.create({ data: { principalId: a, message: "for A", remindAt: new Date(T0.getTime() - 1000) } });
      await getDb().reminder.create({ data: { principalId: b, message: "for B", remindAt: new Date(T0.getTime() - 1000) } });
      await engine(a).tick();
      expect(outbox).toEqual([{ chatId: tgA, text: "⏰ for A" }]);
      expect((await getDb().reminder.findUniqueOrThrow({ where: { id: ra.id } })).deliveryChannel).toBe("TELEGRAM");
      await engine(b).tick();
      expect(outbox.map((o) => o.chatId)).toEqual([tgA, tgB]);
    });

    it("a Telegram rejection is FAILED with a safe code (no provider text in the row or the audit)", async () => {
      const r = await getDb().reminder.create({ data: { principalId: a, message: "will bounce", remindAt: new Date(T0.getTime() - 1000) } });
      failWith = new TelegramApiError("sendMessage", 403);
      await engine(a).tick();
      const row = await getDb().reminder.findUniqueOrThrow({ where: { id: r.id } });
      expect(row).toMatchObject({ status: "FAILED", lastDeliveryError: "TELEGRAM_REJECTED", deliveryChannel: null });
      const failed = (await listAuditLog(a, 100)).find((e) => e.eventType === "REMINDER_DELIVERY_FAILED" && (e.metadata as { reminderId?: string }).reminderId === r.id);
      expect(failed?.metadata).toMatchObject({ code: "TELEGRAM_REJECTED", channel: "TELEGRAM", retryable: false });
    });

    it("a rate-limited send is retried after the backoff and then delivered once", async () => {
      const r = await getDb().reminder.create({ data: { principalId: a, message: "rate limited", remindAt: new Date(T0.getTime() - 1000) } });
      failWith = new TelegramApiError("sendMessage", 429, 1);
      await engine(a).tick();
      expect((await getDb().reminder.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PENDING");
      failWith = null;
      await engine(a, new Date(T0.getTime() + 31_000)).tick();
      expect((await getDb().reminder.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("SENT");
      expect(outbox.filter((o) => o.text === "⏰ rate limited")).toHaveLength(1);
    });

    it("no bot token, chat id or reminder text ends up in the audit log", async () => {
      const r = await getDb().reminder.create({ data: { principalId: a, message: "private text 7731", remindAt: new Date(T0.getTime() - 1000) } });
      await engine(a).tick();
      const rows = (await listAuditLog(a, 200)).filter((e) => (e.metadata as { reminderId?: string }).reminderId === r.id);
      expect(rows.length).toBeGreaterThan(0);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain("private text 7731");
      expect(dump).not.toContain(String(tgA));
    });
  });
});
