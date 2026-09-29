import type { AuditEventType, AuditResult } from "@prisma/client";
import { getDb } from "../../db/client/index.js";

export interface AuditEventInput {
  principalId: string;
  agentKey?: string;
  eventType: AuditEventType;
  resource?: string;
  action?: string;
  result: AuditResult;
  source: string;
  /** Never put secrets, tokens, or credentials here. */
  metadata?: Record<string, unknown>;
}

/**
 * Writes one audit event. Every meaningful permission/action event in the
 * system goes through this function — WHO (principal/agent), WHAT
 * (resource/action), WHEN (createdAt), WHY/SOURCE (source), RESULT (result).
 */
export async function recordAuditEvent(input: AuditEventInput) {
  const db = getDb();

  let agentId: string | undefined;
  if (input.agentKey) {
    const agent = await db.agent.findUnique({ where: { key: input.agentKey } });
    agentId = agent?.id;
  }

  return db.auditLog.create({
    data: {
      principalId: input.principalId,
      agentId,
      eventType: input.eventType,
      resource: input.resource,
      action: input.action,
      result: input.result,
      source: input.source,
      metadata: (input.metadata ?? {}) as object,
    },
  });
}

export async function listAuditLog(principalId: string, limit = 50) {
  const db = getDb();
  return db.auditLog.findMany({
    where: { principalId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
