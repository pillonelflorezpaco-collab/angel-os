// The Action / Permission Gateway. Every skill executes through this module
// — never directly. This is what makes the rule real:
//
//   THE LLM NEVER GETS DIRECT AUTHORITY TO EXECUTE SENSITIVE ACTIONS.
//
// Path: Jarvis -> Skill -> Permission Gateway -> Approval if required
//       -> Action -> Audit Log

import { checkPermission } from "./permissions/index.js";
import { recordAuditEvent } from "./audit/index.js";
import { safeAudit } from "./audit/safe.js";
import type { ActionRequest, Result } from "../core/types/index.js";
import { toSafeError, logInternalError } from "../core/errors.js";
import { currentIdentity } from "../identity/context.js";

export type ActionExecutor = () => Promise<unknown>;

export async function gatewayExecute(
  request: ActionRequest,
  execute: ActionExecutor,
  source = "gateway"
): Promise<Result> {
  // Defence in depth: inside an authenticated interface request, the
  // principal an action targets must be the principal that authenticated.
  // Skills receive principalId explicitly, so a route or adapter that
  // passed the wrong one would otherwise act on someone else's data.
  // Refused before any permission lookup, and recorded against the
  // REQUESTER (not the targeted principal).
  const identity = currentIdentity();
  if (identity && identity.principalId !== request.principalId) {
    await recordAuditEvent({
      principalId: identity.principalId,
      agentKey: request.agentKey,
      eventType: "ACTION_DENIED",
      resource: request.resource,
      action: request.action,
      result: "DENIED",
      source,
      metadata: { reason: "principal_mismatch" },
    });
    return { status: "DENIED", message: "That action is not permitted." };
  }

  const check = await checkPermission({
    principalId: request.principalId,
    agentKey: request.agentKey,
    skillKey: request.skillKey,
    resource: request.resource,
    action: request.action,
  });

  if (check.state === "DENIED") {
    await recordAuditEvent({
      principalId: request.principalId,
      agentKey: request.agentKey,
      eventType: "ACTION_DENIED",
      resource: request.resource,
      action: request.action,
      result: "DENIED",
      source,
    });
    return {
      status: "DENIED",
      message: `Action '${request.action}' on '${request.resource}' is not permitted.`,
    };
  }

  if (check.state === "APPROVAL_REQUIRED") {
    // Closures cannot be approved: the executor would not be the approved
    // action. Approval-gated actions must be ActionDefinitions run through
    // proposeAction(). Fail closed rather than queue something that can
    // never faithfully execute.
    await recordAuditEvent({
      principalId: request.principalId,
      agentKey: request.agentKey,
      eventType: "ACTION_DENIED",
      resource: request.resource,
      action: request.action,
      result: "DENIED",
      source,
      metadata: { reason: "approval_required_needs_action_definition" },
    });
    return {
      status: "DENIED",
      message: `Action '${request.action}' on '${request.resource}' needs approval and cannot be run this way.`,
    };
  }

  // state === "ALLOWED". The legacy closure path is a READ lane. Anything
  // that changes state or acts on the world must be an ActionDefinition run
  // through proposeAction (interface policy, approval, exact binding). The
  // only exceptions are the explicit, temporary entries in
  // LEGACY_WRITE_ALLOWLIST. Unknown/missing categories fail closed.
  const category = check.category;
  const legacyOk = category === "READ" || (category === "WRITE" && isLegacyWriteAllowed(request));
  if (!legacyOk) {
    await recordAuditEvent({
      principalId: request.principalId,
      agentKey: request.agentKey,
      eventType: "ACTION_DENIED",
      resource: request.resource,
      action: request.action,
      result: "DENIED",
      source,
      metadata: { reason: "legacy_path_non_read", category: category ?? "unknown" },
    });
    return {
      status: "DENIED",
      message: `Action '${request.action}' on '${request.resource}' cannot be run this way.`,
    };
  }

  let data: unknown;
  try {
    data = await execute();
  } catch (err) {
    // Raw error text never reaches the user or the audit log: only
    // PublicError messages are shown, and the audit gets structured,
    // safe fields (error type, DB error code). Detail goes to the
    // redacted developer log.
    const safe = toSafeError(err);
    if (!safe.audit.public) logInternalError(`${request.skillKey}/${request.action}`, err);
    await safeAudit({
      principalId: request.principalId,
      agentKey: request.agentKey,
      eventType: "ACTION_FAILED",
      resource: request.resource,
      action: request.action,
      result: "FAILURE",
      source,
      metadata: safe.audit,
    });
    return { status: "FAILED", message: safe.publicMessage };
  }

  // The action already happened. Failing to WRITE THE AUDIT ROW must not
  // turn a success into a reported failure: report the truth (EXECUTED) and
  // flag that the audit record is missing.
  const audited = await safeAudit({
    principalId: request.principalId,
    agentKey: request.agentKey,
    eventType: "ACTION_EXECUTED",
    resource: request.resource,
    action: request.action,
    result: "SUCCESS",
    source,
  });
  return { status: "EXECUTED", message: "Action executed.", data, ...(audited ? {} : { auditUnconfirmed: true }) };
}

/**
 * TEMPORARY compatibility allow-list (BUILD #7). Exact
 * skill|resource|action triples that may still run as WRITE closures via
 * gatewayExecute because they have not been migrated to ActionDefinitions.
 * It is a frozen literal, matched exactly, and only ever applies to
 * category WRITE — EXECUTE never runs here. CREATE_REMINDER and
 * memory `remember` are NOT on it (both are ActionDefinitions now).
 * Remove entries as they migrate; adding one requires editing this file
 * and its test (tests/execution-guardrails.test.ts pins the exact list).
 */
export const LEGACY_WRITE_ALLOWLIST: readonly string[] = Object.freeze([
  "system.tasks|angel:tasks|CREATE_TASK",
  // update / remove / confirm memory share this action; no interface calls them today.
  "system.memory|angel:memory|MEMORY_WRITE",
]);

function isLegacyWriteAllowed(r: Pick<ActionRequest, "skillKey" | "resource" | "action">): boolean {
  return LEGACY_WRITE_ALLOWLIST.includes(`${r.skillKey}|${r.resource}|${r.action}`);
}

export { checkPermission, setPermission } from "./permissions/index.js";
export {
  proposeAction,
  listPendingApprovals,
  getApproval,
  decideApproval,
  APPROVAL_MESSAGES,
  type ApprovalOutcome,
  type ApprovalCode,
  type ApprovalView,
} from "./approvals/index.js";
export type { ActionDefinition, ExecutionContext } from "./actions/types.js";
export { recordAuditEvent, listAuditLog } from "./audit/index.js";
