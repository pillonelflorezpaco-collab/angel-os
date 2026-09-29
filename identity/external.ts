import { getDb } from "../db/client/index.js";
import { safeAudit } from "../gateway/audit/safe.js";
import { assertInterfaceSource, assertUserInterface, type InterfaceSource } from "./interfaces.js";

export class ExternalIdentityConflictError extends Error {
  constructor() {
    super("That external account is already linked. Unlink it first.");
    this.name = "ExternalIdentityConflictError";
  }
}

export interface ResolvedExternalIdentity {
  id: string;
  principalId: string;
  interfaceSource: InterfaceSource;
}

/**
 * Links an account on another platform (a Telegram user id, a voice
 * device id) to a principal. An interface adapter calls `resolve` to turn
 * "who sent this" into a principal; it never chooses the principal itself.
 */
export class ExternalIdentityService {
  async link(input: { principalId: string; interfaceSource: string; externalId: string; label?: string; actor?: string }): Promise<{ id: string }> {
    const interfaceSource = assertUserInterface(input.interfaceSource);
    const existing = await getDb().externalIdentity.findUnique({
      where: { interfaceSource_externalId: { interfaceSource, externalId: input.externalId } },
    });
    if (existing) {
      // Re-linking to a different principal must never happen silently.
      if (existing.revokedAt === null) {
        await this.auditLink(input.principalId, "IDENTITY_LINKED", "DENIED", { actor: input.actor ?? "cli", targetInterface: interfaceSource, outcome: "already_linked" });
        throw new ExternalIdentityConflictError();
      }
      // A revoked link can be reactivated, but only by re-linking it
      // explicitly — to the principal it is being linked to now.
      const revived = await getDb().externalIdentity.update({
        where: { id: existing.id },
        data: { principalId: input.principalId, revokedAt: null, label: input.label },
      });
      await this.auditLink(input.principalId, "IDENTITY_LINKED", "SUCCESS", { actor: input.actor ?? "cli", linkId: revived.id, targetInterface: interfaceSource, outcome: "relinked" });
      return { id: revived.id };
    }
    const row = await getDb().externalIdentity.create({
      data: { principalId: input.principalId, interfaceSource, externalId: input.externalId, label: input.label },
    });
    await this.auditLink(input.principalId, "IDENTITY_LINKED", "SUCCESS", { actor: input.actor ?? "cli", linkId: row.id, targetInterface: interfaceSource, outcome: "linked" });
    return { id: row.id };
  }

  /** Active linked external ids of one principal on one interface, oldest first. Used to find WHERE to deliver, never who to deliver to. */
  async listActiveExternalIds(principalId: string, interfaceSource: InterfaceSource): Promise<string[]> {
    const rows = await getDb().externalIdentity.findMany({ where: { principalId, interfaceSource, revokedAt: null }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => r.externalId);
  }

  private auditLink(principalId: string, eventType: "IDENTITY_LINKED" | "IDENTITY_UNLINKED", result: "SUCCESS" | "DENIED", metadata: Record<string, unknown>) {
    // The external account id itself is not recorded — only the link id.
    return safeAudit({ principalId, eventType, resource: "external_identity", action: eventType === "IDENTITY_LINKED" ? "LINK" : "UNLINK", result, source: "identity.admin", metadata });
  }

  async resolve(interfaceSource: InterfaceSource, externalId: string): Promise<ResolvedExternalIdentity | null> {
    const row = await getDb().externalIdentity.findUnique({
      where: { interfaceSource_externalId: { interfaceSource, externalId } },
    });
    if (!row || row.revokedAt) return null;
    return { id: row.id, principalId: row.principalId, interfaceSource };
  }

  /** Unlinks — scoped by principal, so one principal cannot unlink another's. */
  async unlink(principalId: string, id: string, actor = "cli"): Promise<boolean> {
    const { count } = await getDb().externalIdentity.updateMany({ where: { id, principalId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.auditLink(principalId, "IDENTITY_UNLINKED", count === 1 ? "SUCCESS" : "DENIED", { actor, linkId: id, outcome: count === 1 ? "unlinked" : "no_active_link" });
    return count === 1;
  }

  async list(principalId: string) {
    const rows = await getDb().externalIdentity.findMany({ where: { principalId }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => ({ id: r.id, interfaceSource: r.interfaceSource, label: r.label, createdAt: r.createdAt, revokedAt: r.revokedAt }));
  }
}

let service: ExternalIdentityService | undefined;
export function getExternalIdentityService(): ExternalIdentityService {
  return (service ??= new ExternalIdentityService());
}
