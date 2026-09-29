import type { InterfaceSource } from "./interfaces.js";

/** How the caller proved who they are. Never a claim made by the client. */
export type AuthMethod = "api_token" | "external_identity" | "oauth_state" | "system";

/**
 * Who is acting, through what, and as part of which request. Created ONLY
 * by an authenticator (or an adapter that has resolved an external
 * identity) — never from client-supplied fields — and frozen so nothing
 * downstream can rewrite principalId.
 */
export interface IdentityContext {
  readonly principalId: string;
  readonly interfaceSource: InterfaceSource;
  readonly authMethod: AuthMethod;
  /** Unique per request; stamped on every audit row the request causes. */
  readonly requestId: string;
  /** Id of the credential used (ApiToken / ExternalIdentity). Not a secret. */
  readonly credentialId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** The transport-neutral view of a request that an Authenticator sees. */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The authentication boundary:  Request → Authenticator → IdentityContext.
 * Returns null when the caller cannot be authenticated. Implementations
 * must never throw the reason to the client. Adding production
 * authentication later (sessions, OIDC, passkeys) means adding another
 * Authenticator — no route or skill changes.
 */
export interface Authenticator {
  authenticate(request: AuthRequest): Promise<IdentityContext | null>;
}

export function createIdentity(fields: {
  principalId: string;
  interfaceSource: InterfaceSource;
  authMethod: AuthMethod;
  requestId: string;
  credentialId?: string;
  metadata?: Record<string, string>;
}): IdentityContext {
  return Object.freeze({ ...fields, metadata: fields.metadata ? Object.freeze({ ...fields.metadata }) : undefined });
}
