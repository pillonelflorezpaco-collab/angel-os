import { getDb } from "../db/client/index.js";
import { recordAuditEvent } from "../gateway/audit/index.js";
import { safeAudit } from "../gateway/audit/safe.js";
import { now as clockNow } from "../gateway/clock.js";
import { recordActivity } from "../activity/service.js";
import { requireSystemIdentity, runAsSystem } from "../identity/system.js";
import { normalizeTimeZone, localDateString, formatLocalTime } from "../core/time.js";
import { logInternalError } from "../core/errors.js";
import type { Deliverer } from "../application/delivery.js";
import {
  claimNextReminder, sweepStaleSends, markSendStarted, markSent, markFailed, markUnconfirmed, MAX_DELIVERY_ATTEMPTS,
  type ClaimedReminder,
} from "./claim.js";

// The reminder engine: due reminders → claim → deliver → record. It runs
// ONLY as a SYSTEM identity bound to one configured principal, never inside
// an HTTP request, and never talks to a transport directly (it uses the
// application-level Deliverer).
//
// Honest failure model — it never claims more than it knows:
//   DELIVERED    the channel confirmed acceptance          → SENT
//   FAILED       definitely not sent (rejected/no channel)  → PENDING (retry) or FAILED
//   UNCONFIRMED  a send was attempted, outcome unknown      → UNCONFIRMED, NOT re-sent
// Delivery is at-most-once from Angel OS's side; true exactly-once is
// impossible without transport-level idempotency (Telegram has none).

export interface ReminderEngineDeps {
  /** The configured Angel principal. Everything this engine does is bound to it. */
  principalId: string;
  deliverer: Deliverer;
  leaseMs?: number;
  maxAttempts?: number;
  /** Max reminders handled per tick, so one tick cannot run forever. */
  batchLimit?: number;
  now?: () => Date;
}

export type ProcessOutcome =
  | "EMPTY"
  | "DELIVERED"
  | "RETRY_SCHEDULED"
  | "FAILED"
  | "UNCONFIRMED"
  | "DELIVERED_UNPERSISTED"
  | "LEASE_LOST"
  | "ABORTED_BEFORE_SEND";

export interface TickStats {
  processed: number;
  outcomes: ProcessOutcome[];
  sweptUnconfirmed: number;
}

const OVERDUE_NOTE_AFTER_MS = 10 * 60_000;

export class ReminderEngine {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly batchLimit: number;
  private readonly now: () => Date;

  constructor(private readonly deps: ReminderEngineDeps) {
    this.leaseMs = deps.leaseMs ?? 120_000;
    this.maxAttempts = deps.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
    this.batchLimit = deps.batchLimit ?? 25;
    this.now = deps.now ?? clockNow;
  }

  /** One pass: recover stale claims, then deliver due reminders until none are left (or the batch limit). */
  tick(signal?: AbortSignal): Promise<TickStats> {
    return runAsSystem(this.deps.principalId, "reminder-worker", async () => {
      const stats: TickStats = { processed: 0, outcomes: [], sweptUnconfirmed: 0 };
      const identity = requireSystemIdentity();

      const swept = await sweepStaleSends(identity.principalId, this.now());
      for (const id of swept) {
        stats.sweptUnconfirmed += 1;
        await safeAudit({
          principalId: identity.principalId,
          eventType: "REMINDER_DELIVERY_UNCONFIRMED",
          resource: "reminder",
          action: "DELIVER",
          result: "PENDING",
          source: "reminders.engine",
          metadata: { reminderId: id, reason: "worker_lost_after_send_started" },
        });
      }

      while (stats.processed < this.batchLimit && !signal?.aborted) {
        const outcome = await this.processOne();
        if (outcome === "EMPTY") break;
        stats.processed += 1;
        stats.outcomes.push(outcome);
      }
      return stats;
    });
  }

  /** Claims and delivers at most one reminder. Must run inside a SYSTEM identity. */
  async processOne(): Promise<ProcessOutcome> {
    const identity = requireSystemIdentity();
    if (identity.principalId !== this.deps.principalId) throw new Error("SYSTEM identity does not match the engine's principal.");

    const claimed = await claimNextReminder(identity.principalId, this.now(), this.leaseMs);
    if (!claimed) return "EMPTY";

    const base = {
      principalId: identity.principalId,
      resource: "reminder",
      action: "DELIVER",
      source: "reminders.engine",
    };
    const meta = { reminderId: claimed.id, attempt: claimed.attempt };

    // 1. STARTED must be recorded before anything is sent: fail closed.
    try {
      await recordAuditEvent({ ...base, eventType: "REMINDER_DELIVERY_STARTED", result: "PENDING", metadata: meta });
    } catch (err) {
      logInternalError("reminders.audit-started", err);
      await markFailed(claimed.id, claimed.attempt, this.now(), { code: "AUDIT_UNAVAILABLE", retryable: true }, this.maxAttempts);
      return "ABORTED_BEFORE_SEND";
    }

    // 2. Compose (timezone-aware) and fence: after this a crash means "unknown".
    const text = await this.compose(claimed);
    if (!(await markSendStarted(claimed.id, claimed.attempt, this.now()))) return "LEASE_LOST";

    // 3. The channel call. A port must not throw; if it does, the outcome is unknown.
    let channel: string | null = null;
    let result;
    try {
      const outcome = await this.deps.deliverer.dispatch({
        principalId: identity.principalId, // always the SYSTEM principal — never read from the reminder row
        message: text,
        idempotencyKey: `reminder:${claimed.id}`,
        correlationId: identity.requestId,
      });
      channel = outcome.channel;
      result = outcome.result;
    } catch (err) {
      logInternalError("reminders.deliver", err);
      result = { status: "UNCONFIRMED" as const, code: "DELIVERER_ERROR" };
    }

    // 4. Persist the truth, then audit (best effort — the row is the record).
    if (result.status === "DELIVERED") {
      if (!(await this.persist(() => markSent(claimed.id, claimed.attempt, this.now(), channel)))) {
        // Delivered, but we could not record it. Leave the row as it is
        // (CLAIMED + sendStartedAt): once its lease expires it becomes
        // UNCONFIRMED and is NOT re-sent. Never report this as clean success.
        await safeAudit({ ...base, eventType: "REMINDER_DELIVERY_UNCONFIRMED", result: "PENDING", metadata: { ...meta, channel, reason: "delivered_but_not_persisted" } });
        return "DELIVERED_UNPERSISTED";
      }
      await safeAudit({ ...base, eventType: "REMINDER_DELIVERED", result: "SUCCESS", metadata: { ...meta, channel } });
      // Life history: only a real delivery, never an internal retry. References the reminder, copies no text.
      await recordActivity({ principalId: identity.principalId, type: "REMINDER_DELIVERED", summary: "Reminder delivered", refType: "reminder", refId: claimed.id });
      return "DELIVERED";
    }

    if (result.status === "FAILED") {
      const next = await this.persist(() => markFailed(claimed.id, claimed.attempt, this.now(), result, this.maxAttempts));
      await safeAudit({ ...base, eventType: "REMINDER_DELIVERY_FAILED", result: "FAILURE", metadata: { ...meta, channel, code: result.code, retryable: result.retryable, next: next || "unpersisted" } });
      return next === "PENDING" ? "RETRY_SCHEDULED" : "FAILED";
    }

    await this.persist(() => markUnconfirmed(claimed.id, claimed.attempt, result.code));
    await safeAudit({ ...base, eventType: "REMINDER_DELIVERY_UNCONFIRMED", result: "PENDING", metadata: { ...meta, channel, code: result.code } });
    return "UNCONFIRMED";
  }

  private async compose(claimed: ClaimedReminder): Promise<string> {
    const principal = await getDb().principal.findUnique({ where: { id: claimed.principalId }, select: { timezone: true } });
    const timeZone = normalizeTimeZone(principal?.timezone);
    const overdue = this.now().getTime() - claimed.remindAt.getTime() > OVERDUE_NOTE_AFTER_MS;
    // Overdue reminders say when they were due, in the principal's own time.
    const due = overdue ? ` (due ${localDateString(claimed.remindAt, timeZone)} ${formatLocalTime(claimed.remindAt, timeZone)})` : "";
    return `⏰ ${claimed.message}${due}`;
  }

  /** Retries a persistence step a few times; returns its result, or false/undefined if it kept throwing. */
  private async persist<T>(fn: () => Promise<T>): Promise<T | false> {
    for (let i = 0; i < 3; i += 1) {
      try {
        return await fn();
      } catch (err) {
        logInternalError("reminders.persist", err);
        await new Promise((r) => setTimeout(r, 25 * (i + 1)));
      }
    }
    return false;
  }

  /** Polls until aborted. An in-flight reminder always finishes before shutdown. */
  async run(signal: AbortSignal, intervalMs = 15_000): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch (err) {
        logInternalError("reminders.tick", err);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}
