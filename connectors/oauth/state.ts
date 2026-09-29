import { randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "../../db/client/index.js";

// See docs/SECURITY.md "OAuth state security". This is the explicit,
// documented substitute for "the session that started the flow" in an API
// that has no real authentication yet — NOT a pretense of production
// session security. A future real auth layer would bind this to a signed
// session cookie instead of a bare principalId; the state-binding
// mechanics here (single-use, short-lived, unguessable, verified with a
// constant-time comparison) stay the same either way.

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class OAuthStateInvalidError extends Error {
  constructor() {
    super("OAuth state is invalid, does not exist, or was already used.");
    this.name = "OAuthStateInvalidError";
  }
}

export class OAuthStateExpiredError extends Error {
  constructor() {
    super("OAuth state has expired. Restart the authorization flow.");
    this.name = "OAuthStateExpiredError";
  }
}

export interface CreateStateInput {
  principalId: string;
  provider: string;
  redirectUri: string;
}

export interface ConsumeStateResult {
  principalId: string;
  provider: string;
  redirectUri: string;
}

export class OAuthStateService {
  /** Issues a fresh, unguessable, single-use state token bound to this principal and provider. */
  async create(input: CreateStateInput): Promise<string> {
    const db = getDb();
    const state = randomBytes(32).toString("base64url");
    await db.oAuthState.create({
      data: {
        principalId: input.principalId,
        provider: input.provider,
        state,
        redirectUri: input.redirectUri,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    return state;
  }

  /**
   * Validates and atomically consumes a state token from an OAuth
   * callback. Prevents state reuse (a second consume of the same token
   * always fails — `consumedAt` is set in the same conditional update that
   * checks it's still null) and principal confusion (the caller never
   * supplies a principalId here at all; the state token IS the only
   * evidence of which principal started the flow — the callback route
   * must never accept a principalId as a separate parameter alongside
   * `state`, or the binding is worthless).
   */
  async consume(state: string, provider: string): Promise<ConsumeStateResult> {
    const db = getDb();

    // Look up first so we can distinguish "invalid" from "expired" for a
    // clearer error, but the actual consumption is the atomic update below
    // — this lookup result is never trusted as the basis for the decision.
    const existing = await db.oAuthState.findUnique({ where: { state } });
    if (!existing || existing.provider !== provider || !constantTimeEqual(existing.state, state)) {
      throw new OAuthStateInvalidError();
    }

    const { count } = await db.oAuthState.updateMany({
      where: { state, provider, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) {
      // Existed but consumedAt wasn't null — someone already consumed it
      // (reuse attempt). Treat identically to "invalid": no information
      // about prior use is leaked back to the caller.
      throw new OAuthStateInvalidError();
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new OAuthStateExpiredError();
    }

    return { principalId: existing.principalId, provider: existing.provider, redirectUri: existing.redirectUri };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

let service: OAuthStateService | undefined;

export function getOAuthStateService(): OAuthStateService {
  if (!service) service = new OAuthStateService();
  return service;
}
