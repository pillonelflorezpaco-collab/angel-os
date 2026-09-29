import type { ApprovalRequest, Agent } from "@prisma/client";
import { getDb } from "../../db/client/index.js";
import { recordAuditEvent } from "../audit/index.js";
import { transition } from "./state.js";

type Row = ApprovalRequest & { agent: Agent };

export function isStale(row: Pick<ApprovalRequest, "status" | "expiresAt">, now: Date): boolean {
  return (row.status === "PENDING" || row.status === "APPROVED") && row.expiresAt.getTime() <= now.getTime();
}

/**
 * Lazy expiry: called wherever an approval is read, decided, or executed,
 * so an expired approval is never treated as live even if no worker ever
 * ran. Returns true if this row is (now) EXPIRED. Only the caller whose
 * transition wins writes the audit event, so it is recorded exactly once.
 */
export async function expireIfStale(row: Row, now: Date): Promise<boolean> {
  if (row.status === "EXPIRED") return true;
  if (!isStale(row, now)) return false;
  const won = await transition({ id: row.id, principalId: row.principalId, from: row.status, to: "EXPIRED", now });
  if (won) {
    await recordAuditEvent({
      principalId: row.principalId,
      agentKey: row.agent.key,
      eventType: "APPROVAL_EXPIRED",
      resource: row.resource,
      action: row.action,
      result: "DENIED",
      source: "gateway.approvals",
      metadata: { approvalId: row.id, from: row.status },
    });
    return true;
  }
  // Lost the race: someone else decided or expired it. Report what it is now.
  const fresh = await getDb().approvalRequest.findUnique({ where: { id: row.id } });
  return fresh?.status === "EXPIRED";
}

/** Optional sweep for a background worker; correctness never depends on it running. */
export async function expireStaleApprovals(now: Date): Promise<number> {
  const rows = await getDb().approvalRequest.findMany({
    where: { status: { in: ["PENDING", "APPROVED"] }, expiresAt: { lte: now } },
    include: { agent: true },
    take: 500,
  });
  let expired = 0;
  for (const row of rows) if (await expireIfStale(row, now)) expired += 1;
  return expired;
}
