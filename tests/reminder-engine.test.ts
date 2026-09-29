import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { ReminderEngine, claimNextReminder, sweepStaleSends, backoffMs, MAX_DELIVERY_ATTEMPTS } from "../reminders/index.js";
import { markSent, markSendStarted } from "../reminders/claim.js";
import { runAsSystem } from "../identity/index.js";
import { listAuditLog } from "../gateway/index.js";
import { DeliveryDispatcher, type Deliverer, type DeliveryOutcome, type DeliveryRequest } from "../application/delivery.js";
import { localTimeOnDay, zonedTimeToUtc, formatLocalTime, localDateString } from "../core/time.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";
import { withAuditFailures } from "./helpers/fakeActions.js";

const T0 = new Date("2040-06-01T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

describe("reminder engine", () => {
  let a: string;
  let b: string;
  let now = T0;
  const sent: DeliveryRequest[] = [];
  let script: (req: DeliveryRequest) => Promise<DeliveryOutcome> | DeliveryOutcome;
  const deliverer: Deliverer = { dispatch: async (req) => { sent.push(req); return script(req); } };
  const OK: DeliveryOutcome = { channel: "TELEGRAM", result: { status: "DELIVERED" } };

  const engineFor = (principalId: string, extra: Partial<ConstructorParameters<typeof ReminderEngine>[0]> = {}) =>
    new ReminderEngine({ principalId, deliverer, now: () => now, ...extra });
  const tick = (principalId = a, extra = {}) => engineFor(principalId, extra).tick();
  const mk = (principalId: string, message: string, remindAt: Date, extra: Record<string, unknown> = {}) =>
    getDb().reminder.create({ data: { principalId, message, remindAt, ...extra } });
  const row = (id: string) => getDb().reminder.findUniqueOrThrow({ where: { id } });
  const audit = async (principalId: string, type: string) => (await listAuditLog(principalId, 300)).filter((e) => e.eventType === type);

  beforeAll(async () => {
    a = (await createPrincipal("Engine A", "America/Bogota")).id;
    b = (await createPrincipal("Engine B", "UTC")).id;
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(async () => {
    now = T0;
    sent.length = 0;
    script = () => OK;
    // each test starts from a clean queue for both principals
    await getDb().reminder.deleteMany({ where: { principalId: { in: [a, b] } } });
    await getDb().activity.deleteMany({ where: { principalId: { in: [a, b] } } });
  });

  // ── Atomic claim ────────────────────────────────────────────────────────
  describe("atomic claim", () => {
    it("of many workers racing for ONE reminder, exactly one claims it", async () => {
      const r = await mk(a, "solo", at(-MIN));
      const results = await Promise.all(Array.from({ length: 12 }, () => claimNextReminder(a, now, 120_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const claimed = await row(r.id);
      expect(claimed).toMatchObject({ status: "CLAIMED", deliveryAttempts: 1 });
      expect(claimed.leaseUntil!.getTime()).toBe(now.getTime() + 120_000);
    });

    it("racing for N reminders: every reminder is claimed exactly once, none twice", async () => {
      const ids = (await Promise.all(Array.from({ length: 6 }, (_, i) => mk(a, `m${i}`, at(-(i + 1) * MIN))))).map((r) => r.id);
      const results = await Promise.all(Array.from({ length: 20 }, () => claimNextReminder(a, now, 120_000)));
      const got = results.filter(Boolean).map((c) => c!.id);
      expect(got.sort()).toEqual([...ids].sort());
      expect(new Set(got).size).toBe(6);
    });

    it("only claims due reminders of the configured principal, oldest first", async () => {
      await mk(a, "future", at(10 * MIN));
      await mk(b, "other principal", at(-MIN));
      const newer = await mk(a, "newer", at(-1 * MIN));
      const older = await mk(a, "older", at(-5 * MIN));
      expect((await claimNextReminder(a, now, 1000))?.id).toBe(older.id);
      expect((await claimNextReminder(a, now, 1000))?.id).toBe(newer.id);
      expect(await claimNextReminder(a, now, 1000)).toBeNull();
    });

    it("dismissed, sent, failed and unconfirmed reminders are never claimed", async () => {
      for (const status of ["DISMISSED", "SENT", "FAILED", "UNCONFIRMED"] as const) await mk(a, status, at(-MIN), { status });
      expect(await claimNextReminder(a, now, 1000)).toBeNull();
    });

    it("a stale lease recovers when the worker died BEFORE starting to send", async () => {
      const r = await mk(a, "crash-before-send", at(-MIN));
      const first = await claimNextReminder(a, now, 60_000);
      expect(first?.attempt).toBe(1);
      expect(await claimNextReminder(a, at(30_000), 60_000)).toBeNull(); // lease still valid
      const again = await claimNextReminder(a, at(61_000), 60_000); // worker crashed; lease expired
      expect(again).toMatchObject({ id: r.id, attempt: 2 });
    });

    it("a stale lease after the send STARTED is not re-sent: it becomes UNCONFIRMED", async () => {
      const r = await mk(a, "crash-after-send", at(-MIN));
      const c = (await claimNextReminder(a, now, 60_000))!;
      expect(await markSendStarted(c.id, c.attempt, now)).toBe(true);
      expect(await claimNextReminder(a, at(61_000), 60_000)).toBeNull();
      expect(await sweepStaleSends(a, at(61_000))).toEqual([r.id]);
      expect((await row(r.id)).status).toBe("UNCONFIRMED");
      expect(await claimNextReminder(a, at(10 * 60_000), 60_000)).toBeNull();
    });

    it("the attempt number fences a stale worker: a superseded claim cannot record a result", async () => {
      const r = await mk(a, "fence", at(-MIN));
      const first = (await claimNextReminder(a, now, 60_000))!;
      const second = (await claimNextReminder(a, at(61_000), 60_000))!;
      expect(second.attempt).toBe(2);
      expect(await markSent(r.id, first.attempt, at(62_000), "TELEGRAM")).toBe(false);
      expect(await markSent(r.id, second.attempt, at(62_000), "TELEGRAM")).toBe(true);
    });

    it("backoff grows and is capped", () => {
      expect(backoffMs(1)).toBe(30_000);
      expect(backoffMs(2)).toBe(60_000);
      expect(backoffMs(30)).toBe(15 * 60_000);
    });
  });

  // ── Engine behaviour ────────────────────────────────────────────────────
  describe("delivery", () => {
    it("delivers a due reminder, records SENT, and stamps audit as SYSTEM", async () => {
      const r = await mk(a, "call John", at(-MIN));
      const stats = await tick();
      expect(stats.outcomes).toEqual(["DELIVERED"]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ principalId: a, message: "⏰ call John", idempotencyKey: `reminder:${r.id}` });
      expect(sent[0].correlationId).toBeTruthy();
      const done = await row(r.id);
      expect(done).toMatchObject({ status: "SENT", deliveryChannel: "TELEGRAM", deliveryAttempts: 1, lastDeliveryError: null });
      expect(done.deliveredAt!.getTime()).toBe(now.getTime());
      for (const type of ["REMINDER_DELIVERY_STARTED", "REMINDER_DELIVERED"]) {
        const e = (await audit(a, type)).find((x) => (x.metadata as { reminderId?: string }).reminderId === r.id);
        expect(e, type).toMatchObject({ interfaceSource: "SYSTEM", principalId: a });
        expect(e!.requestId).toBeTruthy();
      }
    });

    it("does not deliver a future reminder, and an empty queue is fine", async () => {
      const r = await mk(a, "later", at(5 * MIN));
      expect((await tick()).processed).toBe(0);
      expect(sent).toHaveLength(0);
      expect((await row(r.id)).status).toBe("PENDING");
      now = at(5 * MIN); // exactly due
      expect((await tick()).outcomes).toEqual(["DELIVERED"]);
    });

    it("an overdue reminder is delivered and says when it was due, in the principal's timezone", async () => {
      await mk(a, "old news", new Date("2040-06-01T10:00:00.000Z")); // 05:00 in Bogota, two hours before now
      await tick();
      expect(sent[0].message).toBe("⏰ old news (due 2040-06-01 05:00)");
    });

    it("only ever delivers for the configured principal, and passes only that principal to the channel", async () => {
      await mk(b, "B's reminder", at(-MIN));
      const mine = await mk(a, "A's reminder", at(-MIN));
      await tick(a);
      expect(sent.map((s) => s.principalId)).toEqual([a]);
      expect((await getDb().reminder.findFirstOrThrow({ where: { principalId: b } })).status).toBe("PENDING");
      expect((await row(mine.id)).status).toBe("SENT");
    });

    it("a reminder row cannot redirect delivery: the request carries no destination", async () => {
      await mk(a, "no chat id", at(-MIN));
      await tick();
      expect(Object.keys(sent[0]).sort()).toEqual(["correlationId", "idempotencyKey", "message", "principalId"]);
    });
  });

  describe("failure semantics", () => {
    it("a retryable failure returns to PENDING after a backoff, then succeeds", async () => {
      const r = await mk(a, "flaky", at(-MIN));
      script = () => ({ channel: "TELEGRAM", result: { status: "FAILED", code: "RATE_LIMITED", retryable: true } });
      expect((await tick()).outcomes).toEqual(["RETRY_SCHEDULED"]);
      const waiting = await row(r.id);
      expect(waiting).toMatchObject({ status: "PENDING", lastDeliveryError: "RATE_LIMITED", deliveryAttempts: 1 });
      expect(waiting.nextAttemptAt!.getTime()).toBe(now.getTime() + backoffMs(1));

      expect((await tick()).processed).toBe(0); // still backing off
      now = at(backoffMs(1) + 1);
      script = () => OK;
      expect((await tick()).outcomes).toEqual(["DELIVERED"]);
      expect(await row(r.id)).toMatchObject({ status: "SENT", deliveryAttempts: 2 });
    });

    it("retries are bounded: after the maximum attempts it is FAILED, not retried forever", async () => {
      const r = await mk(a, "never works", at(-MIN));
      script = () => ({ channel: "TELEGRAM", result: { status: "FAILED", code: "RATE_LIMITED", retryable: true } });
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
        await tick();
        now = at((i + 1) * 20 * MIN);
      }
      expect(await row(r.id)).toMatchObject({ status: "FAILED", deliveryAttempts: MAX_DELIVERY_ATTEMPTS, lastDeliveryError: "RATE_LIMITED" });
      const calls = sent.length;
      await tick();
      expect(sent).toHaveLength(calls);
    });

    it("a non-retryable failure is FAILED immediately, with a safe code", async () => {
      const r = await mk(a, "no channel", at(-MIN));
      script = () => ({ channel: null, result: { status: "FAILED", code: "NO_CHANNEL", retryable: false } });
      expect((await tick()).outcomes).toEqual(["FAILED"]);
      expect(await row(r.id)).toMatchObject({ status: "FAILED", lastDeliveryError: "NO_CHANNEL" });
    });

    it("an UNCONFIRMED outcome is recorded as such and is NEVER re-sent", async () => {
      const r = await mk(a, "maybe sent", at(-MIN));
      script = () => ({ channel: "TELEGRAM", result: { status: "UNCONFIRMED", code: "TELEGRAM_UNCONFIRMED" } });
      expect((await tick()).outcomes).toEqual(["UNCONFIRMED"]);
      expect(await row(r.id)).toMatchObject({ status: "UNCONFIRMED", lastDeliveryError: "TELEGRAM_UNCONFIRMED" });
      now = at(60 * MIN);
      script = () => OK;
      await tick();
      expect(sent).toHaveLength(1); // no automatic second send
      expect((await audit(a, "REMINDER_DELIVERY_UNCONFIRMED")).length).toBeGreaterThan(0);
    });

    it("a deliverer that throws is treated as UNCONFIRMED, not as delivered or failed", async () => {
      const r = await mk(a, "throws", at(-MIN));
      script = () => { throw new Error("socket exploded: token=SECRET123"); };
      expect((await tick()).outcomes).toEqual(["UNCONFIRMED"]);
      const done = await row(r.id);
      expect(done.status).toBe("UNCONFIRMED");
      expect(JSON.stringify(done)).not.toContain("SECRET123");
    });

    it("delivery succeeded but persisting SENT failed: reported honestly, never re-sent, ends UNCONFIRMED", async () => {
      const r = await mk(a, "persist fails", at(-MIN));
      const delegate = getDb().reminder as unknown as { updateMany: (args: { data: { status?: string } }) => Promise<unknown> };
      const original = delegate.updateMany;
      delegate.updateMany = function (args) {
        return args.data.status === "SENT" ? Promise.reject(new Error("db unavailable")) : original.call(delegate, args);
      };
      let outcome;
      try { outcome = (await tick()).outcomes; } finally { delegate.updateMany = original; }
      expect(outcome).toEqual(["DELIVERED_UNPERSISTED"]);
      expect(sent).toHaveLength(1);
      const stuck = await row(r.id);
      expect(stuck).toMatchObject({ status: "CLAIMED" });
      expect(stuck.sendStartedAt).not.toBeNull();
      expect((await audit(a, "REMINDER_DELIVERY_UNCONFIRMED")).some((e) => (e.metadata as { reason?: string }).reason === "delivered_but_not_persisted")).toBe(true);
      expect((await audit(a, "REMINDER_DELIVERED")).some((e) => (e.metadata as { reminderId?: string }).reminderId === r.id)).toBe(false);

      now = at(10 * MIN); // lease expires
      const next = await tick();
      expect(next.sweptUnconfirmed).toBe(1);
      expect(sent).toHaveLength(1); // duplicate delivery avoided
      expect((await row(r.id)).status).toBe("UNCONFIRMED");
    });

    it("if the STARTED audit cannot be written, nothing is sent (fail closed) and the reminder is retried later", async () => {
      const r = await mk(a, "audit down", at(-MIN));
      const out = await withAuditFailures((t) => t === "REMINDER_DELIVERY_STARTED", () => tick());
      expect(out.outcomes).toEqual(["ABORTED_BEFORE_SEND"]);
      expect(sent).toHaveLength(0);
      expect((await row(r.id)).status).toBe("PENDING");
      now = at(backoffMs(1) + 1);
      expect((await tick()).outcomes).toEqual(["DELIVERED"]);
    });

    it("if only the DELIVERED audit fails, the reminder is still SENT (state is the truth, audit is best effort)", async () => {
      const r = await mk(a, "audit late failure", at(-MIN));
      const out = await withAuditFailures((t) => t === "REMINDER_DELIVERED", () => tick());
      expect(out.outcomes).toEqual(["DELIVERED"]);
      expect((await row(r.id)).status).toBe("SENT");
    });
  });

  describe("idempotency and concurrency", () => {
    it("two workers ticking at once deliver each reminder exactly once", async () => {
      const ids = (await Promise.all(Array.from({ length: 5 }, (_, i) => mk(a, `dup${i}`, at(-(i + 1) * MIN))))).map((r) => r.id);
      script = async () => { await new Promise((r) => setTimeout(r, 5)); return OK; };
      const [s1, s2, s3] = await Promise.all([tick(), tick(), tick()]);
      expect(s1.processed + s2.processed + s3.processed).toBe(5);
      expect(sent).toHaveLength(5);
      expect(new Set(sent.map((s) => s.idempotencyKey)).size).toBe(5);
      for (const id of ids) expect((await row(id)).status).toBe("SENT");
    });

    it("a reminder already SENT is never delivered again by later ticks", async () => {
      await mk(a, "once", at(-MIN));
      await tick();
      now = at(120 * MIN);
      await tick();
      await tick();
      expect(sent).toHaveLength(1);
    });

    it("after a crash before sending, a second worker delivers it once", async () => {
      const r = await mk(a, "recover me", at(-MIN));
      await claimNextReminder(a, now, 60_000); // worker 1 claims, then dies
      expect((await tick()).processed).toBe(0); // lease still held
      now = at(61_000);
      expect((await tick()).outcomes).toEqual(["DELIVERED"]);
      expect(sent).toHaveLength(1);
      expect(await row(r.id)).toMatchObject({ status: "SENT", deliveryAttempts: 2 });
    });
  });

  describe("worker lifecycle", () => {
    it("run() stops on abort; an in-flight delivery finishes first", async () => {
      const r = await mk(a, "in flight", at(-MIN));
      const controller = new AbortController();
      let release!: () => void;
      script = () => new Promise((resolve) => { release = () => resolve(OK); });
      const running = engineFor(a).run(controller.signal, 10);
      await new Promise((res) => setTimeout(res, 150)); // it is now inside the slow delivery
      controller.abort();
      release();
      await running;
      expect((await row(r.id)).status).toBe("SENT");
      const calls = sent.length;
      await new Promise((res) => setTimeout(res, 50));
      expect(sent).toHaveLength(calls); // loop is stopped
    });

    it("a tick error does not stop the loop", async () => {
      const controller = new AbortController();
      const bad = new ReminderEngine({ principalId: "00000000-0000-0000-0000-00000000dead", deliverer, now: () => now });
      const running = bad.run(controller.signal, 10); // principal doesn't exist → each tick throws
      await new Promise((res) => setTimeout(res, 100));
      controller.abort();
      await expect(running).resolves.toBeUndefined();
    });
  });

  describe("audit and activity stay separate", () => {
    it("a delivery makes ONE activity row; retries and failures make audit rows but no activity", async () => {
      const r = await mk(a, "secret reminder body 991", at(-MIN));
      script = () => ({ channel: "TELEGRAM", result: { status: "FAILED", code: "RATE_LIMITED", retryable: true } });
      await tick();
      expect(await getDb().activity.count({ where: { principalId: a, type: "REMINDER_DELIVERED" } })).toBe(0);
      now = at(backoffMs(1) + 1);
      script = () => OK;
      await tick();
      const acts = await getDb().activity.findMany({ where: { principalId: a, type: "REMINDER_DELIVERED" } });
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ refType: "reminder", refId: r.id, interfaceSource: "SYSTEM", summary: "Reminder delivered" });
      const auditRows = (await listAuditLog(a, 300)).filter((e) => (e.metadata as { reminderId?: string }).reminderId === r.id);
      expect(auditRows.length).toBeGreaterThanOrEqual(4); // started×2, failed, delivered
      // neither record copies the reminder text
      expect(JSON.stringify(acts)).not.toContain("secret reminder body");
      expect(JSON.stringify(auditRows)).not.toContain("secret reminder body");
    });
  });

  // ── Timezones ───────────────────────────────────────────────────────────
  describe("timezone-safe scheduling and due evaluation", () => {
    const NY = "America/New_York";

    it("'tomorrow at 10:00' is resolved in the principal's zone: Bogota, UTC and Tokyo differ", () => {
      const nowUtc = new Date("2040-06-01T12:00:00.000Z");
      expect(localTimeOnDay(nowUtc, "America/Bogota", 1, 10, 0).toISOString()).toBe("2040-06-02T15:00:00.000Z");
      expect(localTimeOnDay(nowUtc, "UTC", 1, 10, 0).toISOString()).toBe("2040-06-02T10:00:00.000Z");
      expect(localTimeOnDay(nowUtc, "Asia/Tokyo", 1, 10, 0).toISOString()).toBe("2040-06-02T01:00:00.000Z");
    });

    it("date boundary: 'tomorrow' is the principal's tomorrow, not the server's", () => {
      const lateBogota = new Date("2040-06-02T03:30:00.000Z"); // still June 1st, 22:30 in Bogota
      expect(localDateString(lateBogota, "America/Bogota")).toBe("2040-06-01");
      expect(localTimeOnDay(lateBogota, "America/Bogota", 1, 9, 0).toISOString()).toBe("2040-06-02T14:00:00.000Z"); // 9:00 on June 2nd local
    });

    it("across the DST change the wall-clock time is kept (the UTC offset moves)", () => {
      const before = localTimeOnDay(new Date("2035-03-10T15:00:00.000Z"), NY, 1, 9, 0); // Sun Mar 11 2035: DST starts
      expect(before.toISOString()).toBe("2035-03-11T13:00:00.000Z"); // 09:00 EDT (UTC-4)
      expect(formatLocalTime(before, NY)).toBe("09:00");
      const winter = localTimeOnDay(new Date("2035-03-09T15:00:00.000Z"), NY, 0, 9, 0);
      expect(winter.toISOString()).toBe("2035-03-09T14:00:00.000Z"); // 09:00 EST (UTC-5)
    });

    it("a local time that does not exist (spring-forward gap) resolves deterministically to a valid instant", () => {
      const gap = zonedTimeToUtc(2035, 3, 11, 2, 30, NY);
      expect(zonedTimeToUtc(2035, 3, 11, 2, 30, NY).toISOString()).toBe(gap.toISOString()); // stable
      expect(["01:30", "03:30"]).toContain(formatLocalTime(gap, NY)); // never the nonexistent 02:30
      const ambiguous = zonedTimeToUtc(2035, 11, 4, 1, 30, NY); // fall-back: 01:30 happens twice
      expect(formatLocalTime(ambiguous, NY)).toBe("01:30");
    });

    it("due evaluation is a pure UTC comparison: Tokyo 09:00 is due at 00:00Z, not at server-local 09:00", async () => {
      const tokyo = (await createPrincipal("Tokyo", "Asia/Tokyo")).id;
      try {
        const due = localTimeOnDay(new Date("2040-06-01T12:00:00.000Z"), "Asia/Tokyo", 1, 9, 0); // 2040-06-02T00:00Z
        expect(due.toISOString()).toBe("2040-06-02T00:00:00.000Z");
        await mk(tokyo, "tokyo morning", due);
        now = new Date(due.getTime() - 1);
        expect((await tick(tokyo)).processed).toBe(0);
        now = due;
        expect((await tick(tokyo)).outcomes).toEqual(["DELIVERED"]);
      } finally { await deletePrincipal(tokyo); }
    });

    it("an invalid principal timezone falls back to UTC instead of crashing delivery", async () => {
      const weird = (await createPrincipal("Weird tz", "Not/AZone")).id;
      try {
        await mk(weird, "still delivered", new Date(now.getTime() - 3 * 60 * MIN));
        expect((await tick(weird)).outcomes).toEqual(["DELIVERED"]);
        expect(sent[0].message).toMatch(/\(due 2040-06-01 09:00\)$/); // UTC
      } finally { await deletePrincipal(weird); }
    });
  });

  it("the dispatcher tries the next channel only when a port has no destination", async () => {
    const calls: string[] = [];
    const port = (name: "TELEGRAM" | "MOBILE", result: import("../application/delivery.js").DeliveryResult) => ({ interfaceSource: name, deliver: async () => { calls.push(name); return result; } });
    const req = { principalId: a, message: "m", idempotencyKey: "k", correlationId: "c" };
    const d1 = await new DeliveryDispatcher([port("TELEGRAM", { status: "FAILED", code: "NO_DESTINATION", retryable: false }), port("MOBILE", { status: "DELIVERED" })]).dispatch(req);
    expect(d1).toMatchObject({ channel: "MOBILE", result: { status: "DELIVERED" } });
    calls.length = 0;
    const d2 = await new DeliveryDispatcher([port("TELEGRAM", { status: "UNCONFIRMED", code: "X" }), port("MOBILE", { status: "DELIVERED" })]).dispatch(req);
    expect(d2.channel).toBe("TELEGRAM"); // unknown outcome: do NOT fall through to a second channel
    expect(calls).toEqual(["TELEGRAM"]);
    expect((await new DeliveryDispatcher([]).dispatch(req)).result).toMatchObject({ status: "FAILED", code: "NO_CHANNEL" });
  });
});
