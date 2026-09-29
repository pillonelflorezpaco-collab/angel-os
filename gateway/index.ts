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
import { payloadHash } from "./actions/binding.js";
import type { ActionRequest, Result } from "../core/types/index.js";
import { toSafeError, logInternalError } from "../core/errors.js";
import { currentIdentity } from "../identity/context.js";

export type ActionExecutor = () => Promise<unknown>;

function parametersFingerprint(r: ActionRequest): { payloadHash?: string } {
  try {
    return { payloadHash: payloadHash({ principalId: r.principalId, skillKey: r.skillKey, resource: r.resource, action: r.action, parameters: r.parameters }) };
  } catch {
    return {}; // parameters that cannot be canonicalized are simply not fingerprinted
  }
}

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

  // state === "ALLOWED". gatewayExecute is a READ compatibility lane and
  // NOTHING ELSE. Anything that changes state or acts on the world is an
  // ActionDefinition run through proposeAction (explicit identity, interface
  // policy, approval, exact binding). WRITE, EXECUTE and unknown categories
  // are refused here — there is no allow-list.
  const category = check.category;
  if (category !== "READ") {
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

  // The request's parameters are represented in audit as a canonical hash
  // only (a read query can be user content, so the raw values are not stored).
  const auditParams = parametersFingerprint(request);
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
      metadata: { ...safe.audit, ...auditParams },
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
    metadata: auditParams,
  });
  return { status: "EXECUTED", message: "Action executed.", data, ...(audited ? {} : { auditUnconfirmed: true }) };
}

export { checkPermission, setPermission } from "./permissions/index.js";
export {
  proposeAction,
  listPendingApprovals,
  getApproval,
  decideApproval,
  APPROVAL_MESSAGES,
  IDENTITY_REQUIRED_MESSAGE,
  type ApprovalOutcome,
  type ApprovalCode,
  type ApprovalView,
} from "./approvals/index.js";
export type { ActionDefinition, ExecutionContext } from "./actions/types.js";
export { describeActions, hasAction, type ActionSpec } from "./actions/catalog.js";
export { recordAuditEvent, listAuditLog } from "./audit/index.js";
