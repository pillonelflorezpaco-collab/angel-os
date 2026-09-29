import type { ApprovalStatus, Prisma } from "@prisma/client";
import { getDb } from "../../db/client/index.js";

// Approval state machine.
//
//   PENDING ──approve──► APPROVED ──execute (claim)──► CONSUMED   (terminal)
//      │                    │
//      ├──deny──► DENIED    └──expire──► EXPIRED                  (terminal)
//      └──expire─► EXPIRED
//
// DENIED, EXPIRED and CONSUMED are terminal. The same table is enforced by
// a database trigger (migration approval_execution_engine), so a bug here
// cannot produce an illegal transition either.

export const TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  PENDING: ["APPROVED", "DENIED", "EXPIRED"],
  APPROVED: ["CONSUMED", "EXPIRED"],
  DENIED: [],
  EXPIRED: [],
  CONSUMED: [],
};

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: ApprovalStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * The ONLY way an approval changes status: one conditional UPDATE whose
 * WHERE clause carries the principal, the expected current status, and —
 * for transitions that grant or spend authority (APPROVED, CONSUMED) — a
 * not-yet-expired check against the supplied time. Check and write are the
 * same statement, so of two concurrent callers exactly one gets count 1.
 */
export async function transition(params: {
  id: string;
  principalId: string;
  from: ApprovalStatus;
  to: ApprovalStatus;
  now: Date;
  data?: Prisma.ApprovalRequestUpdateManyMutationInput;
}): Promise<boolean> {
  if (!canTransition(params.from, params.to)) {
    throw new Error(`Illegal approval transition ${params.from} -> ${params.to}`);
  }
  const grantsAuthority = params.to === "APPROVED" || params.to === "CONSUMED";
  const { count } = await getDb().approvalRequest.updateMany({
    where: {
      id: params.id,
      principalId: params.principalId,
      status: params.from,
      ...(grantsAuthority ? { expiresAt: { gt: params.now } } : {}),
    },
    data: { ...params.data, status: params.to },
  });
  return count === 1;
}
