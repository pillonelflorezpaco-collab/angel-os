import { listAuditLog } from "../gateway/index.js";
import { assertExplicitIdentity, type IdentityContext } from "../identity/index.js";

// The application-layer door to the security/system trace for interfaces (the API). The principal comes from
// the explicit IdentityContext — never from a parameter — and the rows are a client-safe view: the internal
// agent FK is dropped, and audit metadata never carries secrets or raw action parameters (the gateway hashes them).

export const MAX_AUDIT_LIMIT = 200;
export const DEFAULT_AUDIT_LIMIT = 50;

export interface AuditEntry {
  id: string;
  principalId: string;
  eventType: string;
  resource: string | null;
  action: string | null;
  result: string;
  source: string;
  interfaceSource: string | null;
  requestId: string | null;
  metadata: unknown;
  createdAt: Date;
}

export async function listOwnAudit(identity: IdentityContext, limit = DEFAULT_AUDIT_LIMIT): Promise<AuditEntry[]> {
  const who = assertExplicitIdentity(identity); // throws IdentityRequiredError: fail closed
  const bounded = Math.min(Math.max(Math.trunc(limit) || DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT);
  const rows = await listAuditLog(who.principalId, bounded);
  return rows.map((r) => ({
    id: r.id,
    principalId: r.principalId,
    eventType: r.eventType,
    resource: r.resource,
    action: r.action,
    result: r.result,
    source: r.source,
    interfaceSource: r.interfaceSource,
    requestId: r.requestId,
    metadata: r.metadata,
    createdAt: r.createdAt,
  }));
}
