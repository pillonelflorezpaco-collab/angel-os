import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/client/index.js";
import { safeAudit } from "../gateway/audit/safe.js";
import { assertInterfaceSource, assertUserInterface, type InterfaceSource } from "./interfaces.js";

// Token format: "aos_" + 43 base64url chars (256 bits of randomness).
// Only the SHA-256 hash is stored. The plaintext exists in memory at
// creation and is returned once — it can never be read back.

const TOKEN_PATTERN = /^aos_[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function looksLikeApiToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export interface VerifiedToken {
  id: string;
  principalId: string;
  interfaceSource: InterfaceSource;
}

export interface TokenSummary {
  id: string;
  interfaceSource: string;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export class ApiTokenService {
  /** Creates a token. The returned `token` is the only time the plaintext is available. */
  async create(input: { principalId: string; interfaceSource: string; label: string; actor?: string }): Promise<{ id: string; token: string }> {
    const interfaceSource = assertUserInterface(input.interfaceSource);
    const token = `aos_${randomBytes(32).toString("base64url")}`;
    const row = await getDb().apiToken.create({
      data: { principalId: input.principalId, interfaceSource, label: input.label, tokenHash: hashToken(token) },
    });
    // Audit: who, for which principal/interface, which token id. Never the token or its hash.
    await safeAudit({
      principalId: input.principalId,
      eventType: "TOKEN_CREATED",
      resource: "api_token",
      action: "CREATE_TOKEN",
      result: "SUCCESS",
      source: "identity.admin",
      metadata: { actor: input.actor ?? "cli", tokenId: row.id, targetInterface: interfaceSource },
    });
    return { id: row.id, token };
  }

  /** Returns the token's principal and interface, or null if unknown or revoked. */
  async verify(token: string): Promise<VerifiedToken | null> {
    if (!looksLikeApiToken(token)) return null;
    const row = await getDb().apiToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.revokedAt) return null;
    return { id: row.id, principalId: row.principalId, interfaceSource: assertInterfaceSource(row.interfaceSource) };
  }

  /** Revokes a token — scoped by principal, so one principal cannot revoke another's. Returns whether one was revoked. */
  async revoke(principalId: string, id: string, actor = "cli"): Promise<boolean> {
    const { count } = await getDb().apiToken.updateMany({ where: { id, principalId, revokedAt: null }, data: { revokedAt: new Date() } });
    await safeAudit({
      principalId,
      eventType: "TOKEN_REVOKED",
      resource: "api_token",
      action: "REVOKE_TOKEN",
      result: count === 1 ? "SUCCESS" : "DENIED",
      source: "identity.admin",
      metadata: { actor, tokenId: id, outcome: count === 1 ? "revoked" : "no_active_token" },
    });
    return count === 1;
  }

  async list(principalId: string): Promise<TokenSummary[]> {
    const rows = await getDb().apiToken.findMany({ where: { principalId }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => ({ id: r.id, interfaceSource: r.interfaceSource, label: r.label, createdAt: r.createdAt, revokedAt: r.revokedAt }));
  }
}

let service: ApiTokenService | undefined;
export function getApiTokenService(): ApiTokenService {
  return (service ??= new ApiTokenService());
}
