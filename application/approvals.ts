import { decideApproval, listPendingApprovals } from "../gateway/index.js";
import type { IdentityContext } from "../identity/index.js";

// The application-layer door to approvals for interface adapters, which may
// not import the gateway themselves. It takes an authenticated
// IdentityContext (never a principal id from a message) and returns plain,
// user-safe data — adapters format it, they never interpret it.

export interface PendingApprovalSummary {
  id: string;
  summary: string;
  expiresAt: Date;
}

export interface DecisionReply {
  ok: boolean;
  /** Safe to show the user as-is. */
  message: string;
}

export async function listPending(identity: IdentityContext): Promise<PendingApprovalSummary[]> {
  const rows = await listPendingApprovals(identity);
  return rows.map((r) => ({ id: r.id, summary: r.summary, expiresAt: r.expiresAt }));
}

export async function decide(identity: IdentityContext, approvalId: string, decision: "APPROVED" | "DENIED"): Promise<DecisionReply> {
  const outcome = await decideApproval(identity, approvalId, decision);
  return { ok: outcome.ok && (decision === "DENIED" || outcome.executed === true), message: outcome.message };
}
