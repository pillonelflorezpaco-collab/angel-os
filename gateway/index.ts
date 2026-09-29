// The Action / Permission Gateway. Every skill executes through this module
// — never directly. This is what makes the rule real:
//
//   THE LLM NEVER GETS DIRECT AUTHORITY TO EXECUTE SENSITIVE ACTIONS.
//
// Path: Jarvis -> Skill -> Permission Gateway -> Approval if required
//       -> Action -> Audit Log

import { checkPermission } from "./permissions/index.js";
import { createApprovalRequest } from "./approvals/index.js";
import { recordAuditEvent } from "./audit/index.js";
import type { ActionRequest, Result } from "../core/types/index.js";

export type ActionExecutor = () => Promise<unknown>;

export async function gatewayExecute(
  request: ActionRequest,
  execute: ActionExecutor,
  source = "gateway"
): Promise<Result> {
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
    const approval = await createApprovalRequest({
      principalId: request.principalId,
      agentKey: request.agentKey,
      skillKey: request.skillKey,
      resource: request.resource,
      action: request.action,
      parameters: request.parameters,
    });
    return {
      status: "PENDING_APPROVAL",
      message: `Action '${request.action}' on '${request.resource}' requires your approval.`,
      approvalId: approval.id,
    };
  }

  // state === "ALLOWED"
  try {
    const data = await execute();
    await recordAuditEvent({
      principalId: request.principalId,
      agentKey: request.agentKey,
      eventType: "ACTION_EXECUTED",
      resource: request.resource,
      action: request.action,
      result: "SUCCESS",
      source,
    });
    return { status: "EXECUTED", message: "Action executed.", data };
  } catch (err) {
    await recordAuditEvent({
      principalId: request.principalId,
      agentKey: request.agentKey,
      eventType: "ACTION_FAILED",
      resource: request.resource,
      action: request.action,
      result: "FAILURE",
      source,
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return {
      status: "FAILED",
      message: err instanceof Error ? err.message : "Action failed.",
    };
  }
}

export { checkPermission, setPermission } from "./permissions/index.js";
export {
  createApprovalRequest,
  decideApproval,
  listPendingApprovals,
  getApproval,
  ApprovalOwnershipError,
  ApprovalNotPendingError,
} from "./approvals/index.js";
export { recordAuditEvent, listAuditLog } from "./audit/index.js";
