import type { ActivityType, Prisma } from "@prisma/client";
import { getDb } from "../db/client/index.js";
import { currentIdentity } from "../identity/context.js";
import { logInternalError } from "../core/errors.js";

// Activity = the user-facing life history ("what happened?"). It is NOT
// the audit log ("what did the system do, and was it allowed?") and must
// never be used as one: audit rows are written by the gateway for every
// action including denials and failures; activity rows are written only
// when something meaningful actually happened. The two share no table and
// no code path. See docs/architecture/interfaces-and-identity.md.

/** A life-area slug, e.g. "learning" or "fitness". Free-form but constrained, so it stays a tag and can't carry content. */
export const LIFE_AREA_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface RecordActivityInput {
  principalId: string;
  type: ActivityType;
  /** Short, generic description. Reference the subject through refType/refId — do not copy memory, task, or note content here. */
  summary: string;
  area?: string;
  refType?: string;
  refId?: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Records that something happened. Best-effort by design: activity is a
 * derived view, so a failure to record it must never fail (or hide) the
 * action that already succeeded. Failures go to the redacted developer log.
 * The interface it came from is read from the authenticated request, never
 * supplied by the caller.
 */
export async function recordActivity(input: RecordActivityInput): Promise<void> {
  try {
    if (input.area !== undefined && !LIFE_AREA_PATTERN.test(input.area)) {
      throw new Error("invalid life area slug");
    }
    await getDb().activity.create({
      data: {
        principalId: input.principalId,
        type: input.type,
        summary: input.summary.slice(0, 200),
        area: input.area,
        refType: input.refType,
        refId: input.refId,
        occurredAt: input.occurredAt,
        interfaceSource: currentIdentity()?.interfaceSource,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logInternalError("activity.record", err);
  }
}

export interface ActivityWindow {
  from: Date;
  to: Date;
}

export async function listActivities(principalId: string, window: ActivityWindow, opts: { types?: ActivityType[]; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  return getDb().activity.findMany({
    where: {
      principalId,
      occurredAt: { gte: window.from, lt: window.to },
      ...(opts.types?.length ? { type: { in: opts.types } } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
}

export interface ActivitySummary {
  total: number;
  byType: Record<string, number>;
  byArea: Record<string, number>;
}

export async function summarizeActivities(principalId: string, window: ActivityWindow): Promise<ActivitySummary> {
  const where = { principalId, occurredAt: { gte: window.from, lt: window.to } };
  const [byType, byArea] = await Promise.all([
    getDb().activity.groupBy({ by: ["type"], where, _count: { _all: true } }),
    getDb().activity.groupBy({ by: ["area"], where: { ...where, area: { not: null } }, _count: { _all: true } }),
  ]);
  return {
    total: byType.reduce((n, r) => n + r._count._all, 0),
    byType: Object.fromEntries(byType.map((r) => [r.type, r._count._all])),
    byArea: Object.fromEntries(byArea.map((r) => [r.area as string, r._count._all])),
  };
}
