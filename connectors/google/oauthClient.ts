// Minimal Google OAuth 2.0 client using plain fetch — deliberately not the
// `googleapis` SDK, so no Google SDK type ever appears in Angel OS's
// domain interfaces (connectors/types) and no heavy dependency is added
// for what is, at bottom, three HTTP calls. `fetch` is injectable so tests
// never hit the real network (see tests/google-calendar.test.ts).

/** Upper bound for any single OAuth/userinfo call. */
const OAUTH_TIMEOUT_MS = 10_000;

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

// Minimum necessary scope for read-only Calendar access. Never request
// write/event-modification/broad scopes from this build.
export const GOOGLE_CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export class GoogleOAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthConfigError";
  }
}

export class GoogleOAuthApiError extends Error {
  constructor(message: string, readonly status?: number) {
    // NEVER include the request body, headers, or any token in this
    // message — only what Google's error response's safe fields say.
    super(message);
    this.name = "GoogleOAuthApiError";
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
}

export interface GoogleUserInfo {
  email: string;
  verifiedEmail: boolean;
}

export function loadGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GoogleOAuthConfigError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set to use the Google connector."
    );
  }
  return { clientId, clientSecret };
}

export type FetchFn = typeof fetch;

export class GoogleOAuthClient {
  constructor(private readonly config: GoogleOAuthConfig, private readonly fetchFn: FetchFn = fetch) {}

  buildAuthUrl(params: { state: string; redirectUri: string; scope?: string }): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", params.scope ?? GOOGLE_CALENDAR_READONLY_SCOPE);
    url.searchParams.set("access_type", "offline"); // required to receive a refresh token
    url.searchParams.set("prompt", "consent"); // ensures a refresh token even on re-auth
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
    const res = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    return this.parseTokenResponse(res, "exchange authorization code");
  }

  async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const res = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    });
    return this.parseTokenResponse(res, "refresh access token");
  }

  async fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const res = await this.fetchFn(GOOGLE_USERINFO_ENDPOINT, {
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new GoogleOAuthApiError("Failed to fetch Google account identity.", res.status);
    }
    const body = (await res.json()) as { email?: string; verified_email?: boolean };
    if (!body.email) {
      throw new GoogleOAuthApiError("Google did not return an account email.");
    }
    return { email: body.email, verifiedEmail: Boolean(body.verified_email) };
  }

  private async parseTokenResponse(res: Response, action: string): Promise<TokenResponse> {
    if (!res.ok) {
      // Google's error body can contain `error_description`, which is a
      // safe, human-readable string — never the token itself. Still
      // truncated defensively.
      let detail = "";
      try {
        const body = (await res.json()) as { error?: string; error_description?: string };
        detail = body.error_description ?? body.error ?? "";
      } catch {
        // ignore unparsable body
      }
      throw new GoogleOAuthApiError(`Failed to ${action}${detail ? `: ${detail.slice(0, 200)}` : "."}`, res.status);
    }
    const body = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
      scope: body.scope,
    };
  }
}
