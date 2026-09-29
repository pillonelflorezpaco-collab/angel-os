import { Prisma } from "@prisma/client";
import { getDb } from "../db/client/index.js";

// Reminder claim/lease primitives. Everything that moves a reminder through
// its delivery lifecycle is one conditional SQL statement, so any number of
// workers/processes can run against the same table and exactly one of them
// gets a given reminder.
//
//   PENDING ─claim─► CLAIMED ─send─► SENT
//      ▲                │ ├─ retryable failure ─► PENDING (after backoff)
//      │                │ ├─ definite failure / attempts exhausted ─► FAILED
//      │ lease expired, │ └─ outcome unknown ─► UNCONFIRMED (never re-sent)
//      └─ send never ───┘
//          started
//
// `deliveryAttempts` doubles as the claim's fence token: a worker may only
// update the row while the attempt number it was given is still current.

export interface ClaimedReminder {
  id: string;
  principalId: string;
  message: string;
  remindAt: Date;
  attempt: number;
}

/** Atomically claims the oldest due reminder of ONE principal, or returns null. */
export async function claimNextReminder(principalId: string, now: Date, leaseMs: number): Promise<ClaimedReminder | null> {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const rows = await getDb().$queryRaw<{ id: string; principalId: string; message: string; remindAt: Date; deliveryAttempts: number }[]>(Prisma.sql`
    UPDATE "reminders" SET
      "status" = 'CLAIMED', "claimedAt" = ${now}, "leaseUntil" = ${leaseUntil},
      "deliveryAttempts" = "deliveryAttempts" + 1, "lastAttemptAt" = ${now},
      "sendStartedAt" = NULL, "updatedAt" = ${now}
    WHERE "id" = (
      SELECT "id" FROM "reminders"
      WHERE "principalId" = ${principalId} AND "remindAt" <= ${now}
        AND (
          ("status" = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now}))
          OR ("status" = 'CLAIMED' AND "leaseUntil" < ${now} AND "sendStartedAt" IS NULL)
        )
      ORDER BY "remindAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "principalId", "message", "remindAt", "deliveryAttempts"`);
  const row = rows[0];
  return row ? { id: row.id, principalId: row.principalId, message: row.message, remindAt: row.remindAt, attempt: row.deliveryAttempts } : null;
}

/**
 * Reminders whose worker died AFTER starting to send: the message may or
 * may not have gone out, so they are NOT retried — they become UNCONFIRMED.
 */
export async function sweepStaleSends(principalId: string, now: Date): Promise<string[]> {
  const rows = await getDb().$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "reminders" SET "status" = 'UNCONFIRMED', "lastDeliveryError" = 'LEASE_EXPIRED_AFTER_SEND', "updatedAt" = ${now}
    WHERE "principalId" = ${principalId} AND "status" = 'CLAIMED' AND "leaseUntil" < ${now} AND "sendStartedAt" IS NOT NULL
    RETURNING "id"`);
  return rows.map((r) => r.id);
}

const fence = (id: string, attempt: number) => ({ id, status: "CLAIMED" as const, deliveryAttempts: attempt });

/** Marks "about to call the channel". After this, a crash means the outcome is unknown. False if the claim was lost. */
export async function markSendStarted(id: string, attempt: number, now: Date): Promise<boolean> {
  const { count } = await getDb().reminder.updateMany({ where: fence(id, attempt), data: { sendStartedAt: now } });
  return count === 1;
}

/** SENT. Also accepted from UNCONFIRMED (same attempt): a confirmed delivery may upgrade a swept row. */
export async function markSent(id: string, attempt: number, now: Date, channel: string | null): Promise<boolean> {
  const { count } = await getDb().reminder.updateMany({
    where: { id, deliveryAttempts: attempt, status: { in: ["CLAIMED", "UNCONFIRMED"] } },
    data: { status: "SENT", deliveredAt: now, deliveryChannel: channel, lastDeliveryError: null, leaseUntil: null },
  });
  return count === 1;
}

export const MAX_DELIVERY_ATTEMPTS = 5;

/** Exponential backoff: 30s, 60s, 120s, 240s… capped at 15 min. */
export function backoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

/** A definite failure. Retryable ones return to PENDING after a backoff until attempts run out. Returns the resulting status, or null if the claim was lost. */
export async function markFailed(
  id: string,
  attempt: number,
  now: Date,
  failure: { code: string; retryable: boolean },
  maxAttempts = MAX_DELIVERY_ATTEMPTS
): Promise<"PENDING" | "FAILED" | null> {
  const retry = failure.retryable && attempt < maxAttempts;
  const { count } = await getDb().reminder.updateMany({
    where: fence(id, attempt),
    data: retry
      ? { status: "PENDING", nextAttemptAt: new Date(now.getTime() + backoffMs(attempt)), lastDeliveryError: failure.code, leaseUntil: null, sendStartedAt: null }
      : { status: "FAILED", lastDeliveryError: failure.code, leaseUntil: null },
  });
  return count === 1 ? (retry ? "PENDING" : "FAILED") : null;
}

export async function markUnconfirmed(id: string, attempt: number, code: string): Promise<boolean> {
  const { count } = await getDb().reminder.updateMany({
    where: fence(id, attempt),
    data: { status: "UNCONFIRMED", lastDeliveryError: code, leaseUntil: null },
  });
  return count === 1;
}
