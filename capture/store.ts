import { getDb } from "../db/client/index.js";
import { Prisma } from "@prisma/client";
import type { Proposal } from "./proposal.js";

// Draft persistence. Owner-scoped in the same statement; a draft is claimed exactly once with an atomic conditional update.
export const PROPOSAL_TTL_MS = 60 * 60_000;

export async function saveDraft(d: { principalId: string; interfaceSource: string; proposal: Proposal; proposalHash: string; now: Date }) {
  return getDb().captureProposal.create({ data: { principalId: d.principalId, interfaceSource: d.interfaceSource, proposal: d.proposal as unknown as Prisma.InputJsonValue, proposalHash: d.proposalHash, expiresAt: new Date(d.now.getTime() + PROPOSAL_TTL_MS) } });
}
export const getDraft = (principalId: string, id: string) => getDb().captureProposal.findFirst({ where: { id, principalId } });

/** Atomic single-use claim. Returns false when it isn't the owner's, isn't pending, or has expired. */
export async function claimDraft(principalId: string, id: string, to: "CONFIRMED" | "CANCELLED", now: Date): Promise<boolean> {
  const r = await getDb().captureProposal.updateMany({ where: { id, principalId, status: "PENDING", ...(to === "CONFIRMED" ? { expiresAt: { gt: now } } : {}) }, data: { status: to, decidedAt: now } });
  return r.count === 1;
}
export async function writeOutcome(principalId: string, id: string, outcome: unknown) {
  await getDb().captureProposal.updateMany({ where: { id, principalId, status: "CONFIRMED", outcome: { equals: Prisma.DbNull } }, data: { outcome: outcome as Prisma.InputJsonValue } });
}
