import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client/index.js";
import { recordAuditEvent } from "../../gateway/audit/index.js";
import { createIdentity, runWithIdentity } from "../../identity/index.js";
import { getOAuthStateService } from "../oauth/state.js";
import { getCredentialStore } from "../credentials/select.js";
import { GoogleOAuthClient, GoogleOAuthConfigError, loadGoogleOAuthConfig } from "./oauthClient.js";

// The Google Calendar authorization flow as a service, so the HTTP layer
// stays pure HTTP (no database access in api/). Behaviour is unchanged
// from when this lived inline in the routes; see docs/SECURITY.md
// "OAuth state security".

function googleRedirectUri(): string {
  const uri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!uri) throw new GoogleOAuthConfigError("GOOGLE_OAUTH_REDIRECT_URI must be set to use the Google connector.");
  return uri;
}

/** Starts the flow for an already-authenticated principal. Returns the URL the user should open. */
export async function startGoogleAuthorization(principalId: string): Promise<{ authorizeUrl: string }> {
  const config = loadGoogleOAuthConfig();
  const redirectUri = googleRedirectUri();
  const state = await getOAuthStateService().create({ principalId, provider: "google", redirectUri });
  return { authorizeUrl: new GoogleOAuthClient(config).buildAuthUrl({ state, redirectUri }) };
}

/**
 * Completes the flow. The caller here is NOT authenticated by a bearer
 * token (it is Google's redirect through the user's browser): the
 * principal-bound, single-use `state` is the only evidence of who started
 * it. OAuthState errors propagate unchanged for the route to map.
 */
export async function completeGoogleAuthorization(code: string, state: string): Promise<{ externalAccountId: string }> {
  const consumed = await getOAuthStateService().consume(state, "google");

  const identity = createIdentity({
    principalId: consumed.principalId,
    interfaceSource: "API",
    authMethod: "oauth_state",
    requestId: randomUUID(),
  });

  return runWithIdentity(identity, async () => {
    try {
      const oauthClient = new GoogleOAuthClient(loadGoogleOAuthConfig());
      const tokens = await oauthClient.exchangeCode(code, consumed.redirectUri);
      const userInfo = await oauthClient.fetchUserInfo(tokens.accessToken);

      const db = getDb();
      const connection = await db.connection.upsert({
        where: {
          principalId_provider_externalAccountId: {
            principalId: consumed.principalId,
            provider: "google",
            externalAccountId: userInfo.email,
          },
        },
        create: {
          principalId: consumed.principalId,
          provider: "google",
          externalAccountId: userInfo.email,
          displayName: userInfo.email,
          status: "ACTIVE",
        },
        update: { status: "ACTIVE" },
      });

      const ref = `google:connection:${connection.id}`;
      await getCredentialStore().setSecret(
        ref,
        JSON.stringify({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt.toISOString(),
        })
      );
      await db.connection.update({ where: { id: connection.id }, data: { credentialRef: ref } });

      await recordAuditEvent({
        principalId: consumed.principalId,
        eventType: "CONNECTION_AUTHORIZED",
        resource: "connector:google",
        action: "OAUTH_CALLBACK",
        result: "SUCCESS",
        source: "api",
        metadata: { connectionId: connection.id, provider: "google", externalAccountId: userInfo.email },
      });

      return { externalAccountId: userInfo.email };
    } catch (err) {
      await recordAuditEvent({
        principalId: consumed.principalId,
        eventType: "CONNECTION_FAILED",
        resource: "connector:google",
        action: "OAUTH_CALLBACK",
        result: "FAILURE",
        source: "api",
        metadata: { reason: err instanceof Error ? err.name : "unknown" },
      });
      throw err;
    }
  });
}
