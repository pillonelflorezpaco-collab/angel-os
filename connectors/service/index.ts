import { getDb } from "../../db/client/index.js";
import { recordAuditEvent } from "../../gateway/audit/index.js";
import type { ConnectionSummary } from "../types/index.js";

/** Thrown when a connection id doesn't exist, or exists but belongs to a different principal — same shape as MemoryNotFoundError/ApprovalOwnershipError. */
export class ConnectionNotFoundError extends Error {
  constructor(id: string) {
    super(`Connection ${id} not found for this principal.`);
    this.name = "ConnectionNotFoundError";
  }
}

function toSummary(row: {
  id: string;
  principalId: string;
  provider: string;
  externalAccountId: string;
  displayName: string | null;
  status: "PENDING" | "ACTIVE" | "DISABLED" | "ERROR";
  createdAt: Date;
  updatedAt: Date;
}): ConnectionSummary {
  // Deliberately picks fields, excluding credentialRef and metadata, so a
  // caller can't accidentally leak either through a generic "return the
  // row" pattern. credentialRef is not a secret itself, but nothing
  // outside this module needs it.
  return {
    id: row.id,
    principalId: row.principalId,
    provider: row.provider,
    externalAccountId: row.externalAccountId,
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateConnectionInput {
  principalId: string;
  provider: string;
  externalAccountId: string;
  displayName?: string;
  source?: string;
}

/**
 * All operations here are principal-scoped exactly like Memory and
 * Approvals: every read/write that targets an existing connection is
 * scoped by `{ id, principalId }` in the same query, never fetched by id
 * alone — see docs/SECURITY.md "Connection principal isolation".
 */
export class ConnectionService {
  async list(principalId: string): Promise<ConnectionSummary[]> {
    const db = getDb();
    const rows = await db.connection.findMany({ where: { principalId }, orderBy: { createdAt: "desc" } });
    return rows.map(toSummary);
  }

  async get(principalId: string, id: string): Promise<ConnectionSummary> {
    const db = getDb();
    const row = await db.connection.findFirst({ where: { id, principalId } });
    if (!row) throw new ConnectionNotFoundError(id);
    return toSummary(row);
  }

  async create(input: CreateConnectionInput): Promise<ConnectionSummary> {
    const db = getDb();
    const row = await db.connection.create({
      data: {
        principalId: input.principalId,
        provider: input.provider,
        externalAccountId: input.externalAccountId,
        displayName: input.displayName,
        status: "PENDING",
      },
    });

    await recordAuditEvent({
      principalId: input.principalId,
      eventType: "CONNECTION_CREATED",
      resource: `connector:${input.provider}`,
      action: "CREATE_CONNECTION",
      result: "SUCCESS",
      source: input.source ?? "connectors.service",
      metadata: { connectionId: row.id, provider: input.provider, externalAccountId: input.externalAccountId },
    });

    return toSummary(row);
  }

  async disable(principalId: string, id: string, source = "connectors.service"): Promise<ConnectionSummary> {
    const db = getDb();
    const { count } = await db.connection.updateMany({
      where: { id, principalId },
      data: { status: "DISABLED" },
    });
    if (count === 0) throw new ConnectionNotFoundError(id);

    const row = await db.connection.findUniqueOrThrow({ where: { id } });

    await recordAuditEvent({
      principalId,
      eventType: "CONNECTION_DISABLED",
      resource: `connector:${row.provider}`,
      action: "DISABLE_CONNECTION",
      result: "SUCCESS",
      source,
      metadata: { connectionId: id },
    });

    return toSummary(row);
  }

  async remove(principalId: string, id: string, source = "connectors.service"): Promise<void> {
    const db = getDb();
    // Read provider before delete purely for audit metadata; the delete
    // itself is still scoped by {id, principalId} so a cross-principal
    // remove matches zero rows regardless.
    const existing = await db.connection.findFirst({ where: { id, principalId } });
    const { count } = await db.connection.deleteMany({ where: { id, principalId } });
    if (count === 0) throw new ConnectionNotFoundError(id);

    await recordAuditEvent({
      principalId,
      eventType: "CONNECTION_REMOVED",
      resource: existing ? `connector:${existing.provider}` : undefined,
      action: "REMOVE_CONNECTION",
      result: "SUCCESS",
      source,
      metadata: { connectionId: id },
    });
  }
}

let service: ConnectionService | undefined;

export function getConnectionService(): ConnectionService {
  if (!service) {
    service = new ConnectionService();
  }
  return service;
}
