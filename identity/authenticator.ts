import { randomUUID } from "node:crypto";
import { getApiTokenService, type ApiTokenService } from "./tokens.js";
import { createIdentity, type AuthRequest, type Authenticator, type IdentityContext } from "./types.js";

function bearerToken(headers: AuthRequest["headers"]): string | null {
  const raw = headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * Authenticates an API client by bearer token. The principal AND the
 * interface both come from the stored token — a client cannot assert
 * either. Anything wrong (missing header, malformed, unknown, revoked)
 * yields null, with no detail about which.
 */
export class BearerTokenAuthenticator implements Authenticator {
  constructor(private readonly tokens: ApiTokenService = getApiTokenService()) {}

  async authenticate(request: AuthRequest): Promise<IdentityContext | null> {
    const token = bearerToken(request.headers);
    if (!token) return null;
    const verified = await this.tokens.verify(token);
    if (!verified) return null;
    return createIdentity({
      principalId: verified.principalId,
      interfaceSource: verified.interfaceSource,
      authMethod: "api_token",
      requestId: randomUUID(),
      credentialId: verified.id,
    });
  }
}
