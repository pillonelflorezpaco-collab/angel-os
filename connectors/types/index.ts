import type { ActionCategory, ConnectionStatus } from "@prisma/client";

// The Integration / Connector Layer's shared vocabulary. Nothing in this
// file is Google/Telegram/WhatsApp-specific — a future GoogleConnector,
// TelegramConnector, etc. all implement ConnectorProvider without this
// file changing. See docs/ARCHITECTURE.md "Connector Layer".

/**
 * A capability a provider CAN offer, e.g. "calendar.read", "email.send".
 * Free-form string by convention "<domain>.<verb>", not an enum — a new
 * provider capability should never require a schema/type change here.
 *
 * IMPORTANT: a capability existing does not grant permission to use it.
 * Capability = "what this provider is technically able to do". Permission
 * (gateway/permissions) = "whether Angel OS is currently allowed to use
 * it". The two are deliberately separate — see docs/SECURITY.md
 * "Capability vs Permission".
 */
export type CapabilityKey = string;

export interface ConnectorCapability {
  key: CapabilityKey;
  /** Maps this capability onto the existing READ/WRITE/EXECUTE categories, so a Skill's permission row can reason about it consistently with every other resource. */
  category: ActionCategory;
  description: string;
}

/** Connector-reported health, independent of the Connection row's stored `status`. */
export interface ConnectorHealth {
  reachable: boolean;
  checkedAt: Date;
  detail?: string;
}

export class UnknownConnectorError extends Error {
  constructor(providerKey: string) {
    super(`No connector is registered for provider "${providerKey}".`);
    this.name = "UnknownConnectorError";
  }
}

/**
 * Provider-neutral interface every connector implements. Deliberately thin
 * for v0.1: identity, capability discovery, health, and whether
 * authorization is required — NOT action execution. A connector never
 * calls an external API directly on behalf of a Skill; see
 * docs/ARCHITECTURE.md "Connector vs Skill" for why actions stay owned by
 * Skills + the Gateway instead of living here.
 */
export interface ConnectorProvider {
  /** Stable identifier, e.g. "google", "telegram". Matches Connection.provider. */
  readonly providerKey: string;
  readonly displayName: string;

  /** What this provider is technically capable of — not what's currently permitted. */
  listCapabilities(): ConnectorCapability[];

  /** Whether this provider requires an authorization/OAuth-style flow before use (v0.1 does not implement that flow — see docs/ROADMAP.md). */
  requiresAuthorization(): boolean;

  /** Lightweight reachability/health check. Must not require valid credentials to answer "reachable: false" cleanly. */
  checkHealth(): Promise<ConnectorHealth>;
}

/** Public, non-secret view of a Connection — safe to log, safe to return over an API. */
export interface ConnectionSummary {
  id: string;
  principalId: string;
  provider: string;
  externalAccountId: string;
  displayName: string | null;
  status: ConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}
