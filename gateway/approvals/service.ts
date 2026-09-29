import type { Agent, ApprovalRequest, ApprovalStatus } from "@prisma/client";
import { getDb } from "../../db/client/index.js";
import { checkPermission } from "../permissions/index.js";
import { recordAuditEvent } from "../audit/index.js";
import { getActionDefinition } from "../actions/registry.js";
import { payloadHash } from "../actions/binding.js";
import type { ActionProposal, ExecutionContext } from "../actions/types.js";
import { canApproveFrom, routeFor } from "../policy.js";
import { executeApproval, runAction } from "../execution.js";
import { transition } from "./state.js";
import { expireIfStale, isStale } from "./expiry.js";
import { now } from "../clock.js";
import { runWithIdentity, currentIdentity, assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";

// The approval service. Every function takes the authenticated
// IdentityContext — never a bare principalId from a request — and every
// query is scoped by identity.principalId in its WHERE clause.
//
//   PROPOSE  proposeAction()   → creates a PENDING approval (or runs directly if policy allows)
//   APPROVE  decideApproval()  → PENDING → APPROVED | DENIED
//   EXECUTE  (execution.ts)    → APPROVED → CONSUMED, then the action runs, once

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

export type ApprovalCode = "OK" | "NOT_FOUND" | "EXPIRED" | "CONSUMED" | "ALREADY_DECIDED" | "FORBIDDEN" | "UNAVAILABLE";

export const APPROVAL_MESSAGES = {
  NOT_FOUND: "Approval not found.",
  EXPIRED: "Approval expired.",
  CONSUMED: "Approval already consumed.",
  ALREADY_DECIDED: "Approval already decided.",
  FORBIDDEN: "You are not authorized to approve this action.",
  UNAVAILABLE: "That action is no longer available.",
} as const;

export interface ApprovalView {
  id: string;
  status: ApprovalStatus;
  skillKey: string;
  action: string;
  resource: string;
  summary: string;
  risk: string | null;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  consumedAt: Date | null;
  executionStatus: string | null;
  /** Present only when a single approval is fetched. */
  parameters?: unknown;
}

export interface ApprovalOutcome {
  ok: boolean;
  code: ApprovalCode;
  message: string;
  approval?: ApprovalView;
  /** True only if the approved action actually ran to success. */
  executed?: boolean;
  execution?: Result;
}

type Row = ApprovalRequest & { agent: Agent };

function view(row: Row, withParameters: boolean): ApprovalView {
  const def = getActionDefinition(row.skillKey, row.action);
  let summary = `${row.action} on ${row.resource}`;
  if (def) {
    const parsed = def.schema.safeParse(row.parameters);
    if (parsed.success) summary = def.describe(parsed.data);
  }
  return {
    id: row.id,
    status: row.status,
    skillKey: row.skillKey,
    action: row.action,
    resource: row.resource,
    summary,
    risk: def?.risk ?? null,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    consumedAt: row.consumedAt,
    executionStatus: row.executionStatus,
    ...(withParameters ? { parameters: row.parameters } : {}),
  };
}

const fail = (code: Exclude<ApprovalCode, "OK">): ApprovalOutcome => ({ ok: false, code, message: APPROVAL_MESSAGES[code] });

// ── PROPOSE ───────────────────────────────────────────────────────────────

/**
 * The gateway entry for definition-based actions. Validates parameters,
 * checks permission, applies the interface policy, then either runs the
 * action directly (read-only / low-risk) or stores an exact-binding
 * approval request. Nothing runs on the sensitive path until a human
 * approves the stored request.
 */
export const IDENTITY_REQUIRED_MESSAGE = "I can't do that without knowing who you are.";

/**
 * The explicit identity is the ONLY authority. It is validated at runtime,
 * and if an ambient (ALS) identity exists for a DIFFERENT principal the call
 * is refused: a caller that got its identities crossed changes nothing.
 * Returns null (and records the conflict) when the call must fail closed.
 */
async function authoritativeIdentity(identity: unknown, action: string): Promise<IdentityContext | null> {
  let explicit: IdentityContext;
  try {
    explicit = assertExplicitIdentity(identity);
  } catch {
    return null; // no principal to attribute an audit row to
  }
  const ambient = currentIdentity();
  if (ambient && ambient.principalId !== explicit.principalId) {
    await recordAuditEvent({
      principalId: ambient.principalId,
      eventType: "ACTION_DENIED",
      resource: "identity",
      action,
      result: "DENIED",
      source: "gateway.approvals",
      metadata: { reason: "identity_conflict" },
    });
    return null;
  }
  return explicit;
}

export async function proposeAction(identity: IdentityContext, proposal: ActionProposal): Promise<Result> {
  const authoritative = await authoritativeIdentity(identity, `PROPOSE:${proposal?.action}`);
  if (!authoritative) return { status: "FAILED", message: IDENTITY_REQUIRED_MESSAGE };
  return runWithIdentity(authoritative, () => proposeInner(authoritative, proposal));
}

async function proposeInner(identity: IdentityContext, proposal: ActionProposal): Promise<Result> {
  const def = getActionDefinition(proposal.skillKey, proposal.action);
  if (!def) return { status: "FAILED", message: APPROVAL_MESSAGES.UNAVAILABLE };

  const parsed = def.schema.safeParse(proposal.parameters);
  if (!parsed.success) return { status: "FAILED", message: "Those details aren't valid, so nothing was done." };

  const denied = async (reason: string): Promise<Result> => {
    await recordAuditEvent({
      principalId: identity.principalId,
      agentKey: def.agentKey,
      eventType: "ACTION_DENIED",
      resource: def.resource,
      action: def.action,
      result: "DENIED",
      source: "gateway.approvals",
      metadata: { reason },
    });
    return { status: "DENIED", message: `Action '${def.action}' on '${def.resource}' is not permitted.` };
  };

  const permission = await checkPermission({
    principalId: identity.principalId,
    agentKey: def.agentKey,
    skillKey: def.skillKey,
    resource: def.resource,
    action: def.action,
  });
  if (permission.state === "DENIED") return denied("permission_denied");
  // The permission row must describe the same kind of action the definition is.
  if (permission.category !== def.category) return denied("category_mismatch");

  let route = routeFor(identity.interfaceSource, def.category, def.risk);
  if (route === "REFUSE") return denied("interface_policy");
  if (permission.state === "APPROVAL_REQUIRED") route = "APPROVAL";

  if (route === "DIRECT") {
    const ctx: ExecutionContext = {
      principalId: identity.principalId,
      agentKey: def.agentKey,
      interfaceSource: identity.interfaceSource,
      requestId: identity.requestId,
      idempotencyKey: identity.requestId,
    };
    return runAction(def, ctx, parsed.data, { risk: def.risk, direct: true });
  }

  const at = now();
  const hash = payloadHash({
    principalId: identity.principalId,
    skillKey: def.skillKey,
    resource: def.resource,
    action: def.action,
    parameters: parsed.data,
  });
  const db = getDb();
  const agent = await db.agent.findUniqueOrThrow({ where: { key: def.agentKey } });

  const findLivePending = () =>
    db.approvalRequest.findFirst({
      where: { principalId: identity.principalId, payloadHash: hash, status: "PENDING", expiresAt: { gt: at } },
      include: { agent: true },
    });

  // A retried proposal (network retry, double tap) returns the SAME pending approval.
  let row: Row | null = await findLivePending();
  if (!row) {
    // A stale PENDING row for the same payload would block the unique index; expire it first.
    const stale = await db.approvalRequest.findFirst({
      where: { principalId: identity.principalId, payloadHash: hash, status: "PENDING" },
      include: { agent: true },
    });
    if (stale) await expireIfStale(stale, at);
    try {
      row = await db.approvalRequest.create({
        data: {
          principalId: identity.principalId,
          agentId: agent.id,
          skillKey: def.skillKey,
          resource: def.resource,
          action: def.action,
          parameters: parsed.data as object,
          payloadHash: hash,
          interfaceSource: identity.interfaceSource,
          requestId: identity.requestId,
          requestedAt: at,
          expiresAt: new Date(at.getTime() + (def.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS)),
        },
        include: { agent: true },
      });
      await recordAuditEvent({
        principalId: identity.principalId,
        agentKey: def.agentKey,
        eventType: "APPROVAL_CREATED",
        resource: def.resource,
        action: def.action,
        result: "PENDING",
        source: "gateway.approvals",
        metadata: { approvalId: row.id, payloadHash: hash, risk: def.risk },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      row = await findLivePending(); // lost a creation race: return the winner's approval
      if (!row) throw err;
    }
  }

  const v = view(row, false);
  return {
    status: "PENDING_APPROVAL",
    message: `Approval needed: ${v.summary}. Expires at ${row.expiresAt.toISOString()}. Nothing has been done yet.`,
    approvalId: row.id,
  };
}

// ── READ ──────────────────────────────────────────────────────────────────

export function listPendingApprovals(identity: IdentityContext): Promise<ApprovalView[]> {
  return runWithIdentity(identity, async () => {
    const at = now();
    const rows = await getDb().approvalRequest.findMany({
      where: { principalId: identity.principalId, status: "PENDING" },
      include: { agent: true },
      orderBy: { requestedAt: "desc" },
      take: 100,
    });
    const live: ApprovalView[] = [];
    for (const row of rows) {
      if (isStale(row, at)) await expireIfStale(row, at);
      else live.push(view(row, false));
    }
    return live;
  });
}

export function getApproval(identity: IdentityContext, approvalId: string): Promise<ApprovalOutcome> {
  return runWithIdentity(identity, async () => {
    const row = await getDb().approvalRequest.findFirst({
      where: { id: approvalId, principalId: identity.principalId },
      include: { agent: true },
    });
    if (!row) return fail("NOT_FOUND");
    await expireIfStale(row, now());
    const fresh = await getDb().approvalRequest.findFirstOrThrow({ where: { id: row.id, principalId: identity.principalId }, include: { agent: true } });
    return { ok: true, code: "OK" as const, message: "OK", approval: view(fresh, true) };
  });
}

// ── APPROVE / DENY (and, on approve, EXECUTE) ────────────────────────────

export async function decideApproval(
  identity: IdentityContext,
  approvalId: string,
  decision: "APPROVED" | "DENIED"
): Promise<ApprovalOutcome> {
  const authoritative = await authoritativeIdentity(identity, `DECIDE_APPROVAL:${decision}`);
  if (!authoritative) return fail("FORBIDDEN");
  return runWithIdentity(authoritative, () => decideInner(authoritative, approvalId, decision));
}

async function decideInner(identity: IdentityContext, approvalId: string, decision: "APPROVED" | "DENIED"): Promise<ApprovalOutcome> {
  const at = now();
  const db = getDb();
  const row: Row | null = await db.approvalRequest.findFirst({
    where: { id: approvalId, principalId: identity.principalId },
    include: { agent: true },
  });
  if (!row) {
    // Same answer for "does not exist" and "belongs to someone else".
    await recordAuditEvent({
      principalId: identity.principalId,
      eventType: "ACTION_DENIED",
      resource: "approval",
      action: `DECIDE_APPROVAL:${decision}`,
      result: "DENIED",
      source: "gateway.approvals",
      metadata: { reason: "not_owner_or_not_found" },
    });
    return fail("NOT_FOUND");
  }

  if (await expireIfStale(row, at)) return fail("EXPIRED");

  const def = getActionDefinition(row.skillKey, row.action);
  if (decision === "APPROVED") {
    if (!def) return fail("UNAVAILABLE");
    if (!canApproveFrom(identity.interfaceSource, def.risk)) {
      await recordAuditEvent({
        principalId: identity.principalId,
        agentKey: row.agent.key,
        eventType: "ACTION_DENIED",
        resource: row.resource,
        action: row.action,
        result: "DENIED",
        source: "gateway.approvals",
        metadata: { approvalId: row.id, reason: "interface_policy" },
      });
      return fail("FORBIDDEN");
    }
  }

  const won = await transition({
    id: row.id,
    principalId: identity.principalId,
    from: "PENDING",
    to: decision,
    now: at,
    data: { decidedAt: at, decidedVia: identity.interfaceSource },
  });
  if (!won) {
    const fresh = await db.approvalRequest.findFirst({ where: { id: row.id, principalId: identity.principalId }, include: { agent: true } });
    if (!fresh) return fail("NOT_FOUND");
    if (await expireIfStale(fresh, at)) return fail("EXPIRED");
    return fail(fresh.status === "CONSUMED" ? "CONSUMED" : "ALREADY_DECIDED");
  }

  await recordAuditEvent({
    principalId: identity.principalId,
    agentKey: row.agent.key,
    eventType: decision === "APPROVED" ? "APPROVAL_APPROVED" : "APPROVAL_DENIED",
    resource: row.resource,
    action: row.action,
    result: decision === "APPROVED" ? "SUCCESS" : "DENIED",
    source: "gateway.approvals",
    metadata: { approvalId: row.id, payloadHash: row.payloadHash },
  });

  if (decision === "DENIED") {
    const updated = await db.approvalRequest.findFirstOrThrow({ where: { id: row.id, principalId: identity.principalId }, include: { agent: true } });
    return { ok: true, code: "OK", message: "Denied. Nothing was executed.", approval: view(updated, false), executed: false };
  }

  const outcome = await executeApproval(identity, row.id);
  const updated = await db.approvalRequest.findFirstOrThrow({ where: { id: row.id, principalId: identity.principalId }, include: { agent: true } });
  const executed = outcome.claimed && outcome.result.status === "EXECUTED";
  let message: string;
  if (executed) message = `Approved and executed. ${outcome.result.message}`;
  else if (outcome.claimed) message = `Approved, but the action failed and was not completed. ${outcome.result.message}`;
  else message = `Approved, but it was not executed. ${outcome.result.message}`;
  return { ok: true, code: "OK", message, approval: view(updated, false), executed, execution: outcome.result };
}
