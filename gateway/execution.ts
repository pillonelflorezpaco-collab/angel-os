import type { Agent, ApprovalRequest } from "@prisma/client";
import { getDb } from "../db/client/index.js";
import { checkPermission } from "./permissions/index.js";
import { recordAuditEvent } from "./audit/index.js";
import { safeAudit } from "./audit/safe.js";
import { getActionDefinition } from "./actions/registry.js";
import { payloadHash } from "./actions/binding.js";
import type { ActionDefinition, ExecutionContext } from "./actions/types.js";
import { transition } from "./approvals/state.js";
import { expireIfStale } from "./approvals/expiry.js";
import { now } from "./clock.js";
import { toSafeError, logInternalError } from "../core/errors.js";
import { runWithIdentity, type IdentityContext } from "../identity/index.js";
import type { Result } from "../core/types/index.js";

// The execution layer: the only code that invokes ActionDefinition.execute.
//
// Execution guarantees (see docs/architecture/approval-and-execution.md):
//   * parameters come from the STORED approval row, re-hashed and re-validated;
//   * permission is re-checked at execution time (revocation wins);
//   * the row is CLAIMED (APPROVED → CONSUMED) by one atomic conditional
//     UPDATE before anything runs — only the claimant executes;
//   * AT-MOST-ONCE: a crash after the claim leaves executionStatus STARTED
//     and the action is never re-run automatically.

type Row = ApprovalRequest & { agent: Agent };

export interface ExecutionOutcome {
  /** True only if THIS call claimed the approval and ran the action. */
  claimed: boolean;
  result: Result;
  /** Set when the approval could not be claimed. */
  reason?: "EXPIRED" | "CONSUMED" | "NOT_APPROVED" | "UNAVAILABLE" | "DENIED" | "INTEGRITY";
}

/** Runs a definition with STARTED/SUCCEEDED/FAILED audit. Used for both approved and direct execution. */
export async function runAction(
  def: ActionDefinition<any>,
  ctx: ExecutionContext,
  params: unknown,
  auditExtra: Record<string, unknown>
): Promise<Result> {
  const base = {
    principalId: ctx.principalId,
    agentKey: ctx.agentKey,
    resource: def.resource,
    action: def.action,
    source: "gateway.execution",
  };
  // STARTED is written BEFORE the action and is required: if it cannot be
  // recorded, nothing runs (fail closed).
  await recordAuditEvent({ ...base, eventType: "ACTION_EXECUTION_STARTED", result: "PENDING", metadata: { ...auditExtra } });
  let data: unknown;
  try {
    data = await def.execute(ctx, params);
  } catch (err) {
    const safe = toSafeError(err);
    if (!safe.audit.public) logInternalError(`${def.skillKey}/${def.action}`, err);
    await safeAudit({ ...base, eventType: "ACTION_EXECUTION_FAILED", result: "FAILURE", metadata: { ...auditExtra, ...safe.audit } });
    return { status: "FAILED", message: safe.publicMessage };
  }
  // The effect happened. A failure to write its audit row must not be
  // reported as a failed action; it is reported as an audit gap.
  const audited = await safeAudit({ ...base, eventType: "ACTION_EXECUTION_SUCCEEDED", result: "SUCCESS", metadata: { ...auditExtra } });
  return {
    status: "EXECUTED",
    message: def.successMessage ? def.successMessage(data, params) : "Done.",
    data,
    ...(audited ? {} : { auditUnconfirmed: true }),
  };
}

/** Executes an APPROVED approval exactly as approved. Never called with caller-supplied parameters. */
export function executeApproval(identity: IdentityContext, approvalId: string): Promise<ExecutionOutcome> {
  return runWithIdentity(identity, () => executeApprovalInner(identity, approvalId));
}

async function executeApprovalInner(identity: IdentityContext, approvalId: string): Promise<ExecutionOutcome> {
  const at = now();
  const row: Row | null = await getDb().approvalRequest.findFirst({
    where: { id: approvalId, principalId: identity.principalId },
    include: { agent: true },
  });
  const notClaimed = (reason: NonNullable<ExecutionOutcome["reason"]>, message: string): ExecutionOutcome => ({
    claimed: false,
    reason,
    result: { status: "FAILED", message },
  });
  if (!row) return notClaimed("NOT_APPROVED", "Approval not found.");

  if (await expireIfStale(row, at)) return notClaimed("EXPIRED", "Approval expired.");
  if (row.status === "CONSUMED") return notClaimed("CONSUMED", "Approval already consumed.");
  if (row.status !== "APPROVED") return notClaimed("NOT_APPROVED", "This action has not been approved.");

  const def = getActionDefinition(row.skillKey, row.action);
  if (!def) return notClaimed("UNAVAILABLE", "That action is no longer available.");

  // Integrity: the stored binding must still hash to what was approved.
  const expectedHash = payloadHash({
    principalId: row.principalId,
    skillKey: row.skillKey,
    resource: row.resource,
    action: row.action,
    parameters: row.parameters,
  });
  const parsed = def.schema.safeParse(row.parameters);
  if (expectedHash !== row.payloadHash || !parsed.success) {
    await recordAuditEvent({
      principalId: row.principalId,
      agentKey: row.agent.key,
      eventType: "ACTION_DENIED",
      resource: row.resource,
      action: row.action,
      result: "DENIED",
      source: "gateway.execution",
      metadata: { approvalId: row.id, reason: "integrity_check_failed" },
    });
    return notClaimed("INTEGRITY", "This approval failed an integrity check and was not executed.");
  }

  // Approval never overrides the permission table: a revoked permission wins.
  const permission = await checkPermission({
    principalId: row.principalId,
    agentKey: def.agentKey,
    skillKey: row.skillKey,
    resource: row.resource,
    action: row.action,
  });
  if (permission.state === "DENIED") {
    await recordAuditEvent({
      principalId: row.principalId,
      agentKey: def.agentKey,
      eventType: "ACTION_DENIED",
      resource: row.resource,
      action: row.action,
      result: "DENIED",
      source: "gateway.execution",
      metadata: { approvalId: row.id, reason: "permission_revoked" },
    });
    return {
      claimed: false,
      reason: "DENIED",
      result: { status: "DENIED", message: "That action is no longer permitted, so it was not executed." },
    };
  }

  // The claim. Exactly one concurrent caller gets `true`.
  const claimed = await transition({
    id: row.id,
    principalId: row.principalId,
    from: "APPROVED",
    to: "CONSUMED",
    now: at,
    data: { consumedAt: at, executionStatus: "STARTED" },
  });
  if (!claimed) {
    const fresh = await getDb().approvalRequest.findUnique({ where: { id: row.id }, include: { agent: true } });
    if (fresh && (await expireIfStale(fresh, at))) return notClaimed("EXPIRED", "Approval expired.");
    return notClaimed("CONSUMED", "Approval already consumed.");
  }

  const auditExtra = { approvalId: row.id, payloadHash: row.payloadHash, risk: def.risk };
  await recordAuditEvent({
    principalId: row.principalId,
    agentKey: def.agentKey,
    eventType: "APPROVAL_CONSUMED",
    resource: row.resource,
    action: row.action,
    result: "SUCCESS",
    source: "gateway.approvals",
    metadata: auditExtra,
  });

  const ctx: ExecutionContext = {
    principalId: row.principalId,
    agentKey: def.agentKey,
    interfaceSource: identity.interfaceSource,
    requestId: identity.requestId,
    idempotencyKey: row.id,
    approvalId: row.id,
  };
  const result = await runAction(def, ctx, parsed.data, auditExtra);
  try {
    await getDb().approvalRequest.update({
      where: { id: row.id },
      data: { executionStatus: result.status === "EXECUTED" ? "SUCCEEDED" : "FAILED" },
    });
  } catch (err) {
    // The action's outcome is known; only the bookkeeping failed. The row
    // stays CONSUMED/STARTED (never re-run) and the result is still returned truthfully.
    logInternalError("approval.execution-status", err);
  }
  return { claimed: true, result };
}
