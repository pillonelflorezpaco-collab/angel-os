import { createHash } from "node:crypto";
import { getDb } from "../../db/client/index.js";

// Single-flight for credential maintenance. Two concurrent calendar reads that both see an expired token
// must not both call the provider's refresh endpoint: providers that rotate refresh tokens would reject the
// second call and the connection would be wrongly marked ERROR.
//
// Two layers: an in-process map (callers in the same process share one promise) and a Postgres advisory
// transaction lock (callers in other processes queue behind it). The lock is transaction-scoped, so it is
// released on commit, rollback or a dropped connection — it can never be left held. The caller MUST re-check
// freshness after acquiring the lock (another process may have refreshed while it waited).

const inFlight = new Map<string, Promise<unknown>>();
const LOCK_TIMEOUT_MS = 30_000;

/** Two 32-bit halves of a SHA-256 of the connection id → a stable 64-bit advisory-lock key. */
function lockKey(connectionId: string): bigint {
  const h = createHash("sha256").update(`connection-refresh:${connectionId}`).digest();
  return h.readBigInt64BE(0);
}

export function withConnectionRefreshLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(connectionId) as Promise<T> | undefined;
  if (existing) return existing;
  const run = getDb()
    .$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(connectionId)})`;
        return fn();
      },
      { timeout: LOCK_TIMEOUT_MS, maxWait: LOCK_TIMEOUT_MS }
    )
    .finally(() => inFlight.delete(connectionId));
  inFlight.set(connectionId, run);
  return run;
}
