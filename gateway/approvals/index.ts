import { getDb } from "../../db/client/index.js";
import { recordAuditEvent } from "../audit/index.js";

export interface CreateApprovalInput {
  principalId: string;
  agentKey: string;
  skillKey: string;
  resource: string;
  action: string;
  parameters?: Record<string, unknown>;
  reason?: string;
  expiresAt?: Date;
}

/** Creates a PENDING approval request instead of executing an action immediately. */
export async function createApprovalRequest(input: CreateApprovalInput) {
  const db = getDb();
  const agent = await db.agent.findUniqueOrThrow({ where: { key: input.agentKey } });

  const approval = await db.approvalRequest.create({
    data: {
      principalId: input.principalId,
      agentId: agent.id,
      skillKey: input.skillKey,
      resource: input.resource,
      action: input.action,
      parameters: (input.parameters ?? {}) as object,
      reason: input.reason,
      expiresAt: input.expiresAt,
    },
  });

  await recordAuditEvent({
    principalId: input.principalId,
    agentKey: input.agentKey,
    eventType: "ACTION_REQUESTED",
    resource: input.resource,
    action: input.action,
    result: "PENDING",
    source: "gateway.approvals",
    metadata: { approvalId: approval.id },
  });

  return approval;
}

export class ApprovalOwnershipError extends Error {
  constructor(approvalId: string) {
    super(`Approval ${approvalId} does not belong to this principal, or does not exist.`);
    this.name = "ApprovalOwnershipError";
  }
}

export class ApprovalNotPendingError extends Error {
  constructor(approvalId: string) {
    super(`Approval ${approvalId} is not PENDING (already decided, or a concurrent decision won).`);
    this.name = "ApprovalNotPendingError";
  }
}

/**
 * Decides a PENDING approval. Fixes two audit findings at once:
 *
 * 1. Ownership (IDOR): `principalId` is required and is part of the WHERE
 *    clause on the write itself — an approval belonging to a different
 *    principal is simply not matched, never fetched, never mutated.
 * 2. TOCTOU race: the PENDING -> APPROVED|REJECTED transition is a single
 *    atomic `updateMany` conditioned on `status: "PENDING"` in the same
 *    query. Postgres serializes concurrent UPDATEs to the same row, so of
 *    two simultaneous decide calls, only the one that lands first can
 *    match `status: "PENDING"` — the second's WHERE no longer matches
 *    (status has already changed) and its `count` comes back 0. There is
 *    no read-then-write gap: the check and the write are the same
 *    statement.
 */
export async function decideApproval(
  principalId: string,
  approvalId: string,
  decision: "APPROVED" | "REJECTED",
  source = "api"
) {
  const db = getDb();

  const { count } = await db.approvalRequest.updateMany({
    where: { id: approvalId, principalId, status: "PENDING" },
    data: { status: decision, decidedAt: new Date() },
  });

  if (count === 0) {
    // Distinguish "doesn't exist / wrong principal" from "existed, was
    // PENDING for the right principal, but lost the race or was already
    // decided" so callers get an accurate error — without ever having
    // mutated anything in either case.
    const existing = await db.approvalRequest.findUnique({ where: { id: approvalId } });
    if (!existing || existing.principalId !== principalId) {
      // Traceable denial — never a misleading ACTION_APPROVED/REJECTED
      // event, since nothing was decided.
      await recordAuditEvent({
        principalId,
        eventType: "ACTION_DENIED",
        resource: approvalId,
        action: `DECIDE_APPROVAL:${decision}`,
        result: "DENIED",
        source,
        metadata: { reason: "not_owner_or_not_found" },
      });
      throw new ApprovalOwnershipError(approvalId);
    }
    throw new ApprovalNotPendingError(approvalId);
  }

  const updated = await db.approvalRequest.findUniqueOrThrow({
    where: { id: approvalId },
    include: { agent: true },
  });

  await recordAuditEvent({
    principalId: updated.principalId,
    agentKey: updated.agent.key,
    eventType: decision === "APPROVED" ? "ACTION_APPROVED" : "ACTION_REJECTED",
    resource: updated.resource,
    action: updated.action,
    result: decision === "APPROVED" ? "SUCCESS" : "DENIED",
    source,
    metadata: { approvalId },
  });

  return updated;
}

export async function listPendingApprovals(principalId: string) {
  const db = getDb();
  return db.approvalRequest.findMany({
    where: { principalId, status: "PENDING" },
    orderBy: { requestedAt: "desc" },
  });
}

export async function getApproval(approvalId: string) {
  const db = getDb();
  return db.approvalRequest.findUnique({ where: { id: approvalId } });
}
