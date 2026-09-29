// GuideHub cockpit configuration. Fails CLOSED: a missing or weak secret refuses to start rather than falling back to a default.
// The cockpit is a client of the Angel OS HTTP API and shares no code, database or process with the backend.

export interface GuideHubConfig {
  port: number;
  /** Base URL of the Angel OS API (no trailing slash). */
  apiBaseUrl: string;
  /** The cockpit's own GUIDEHUB bearer token. Lives only on the server; never sent to the browser. */
  apiToken: string;
  /** scrypt hash of the sign-in passphrase (see `npm run guidehub:password`). */
  passwordHash: string;
  /** Cookies get the Secure flag (and the __Host- prefix). Off only for plain-http localhost development. */
  secureCookies: boolean;
  /** Exact origin the browser uses to reach the cockpit; unsafe requests carrying another Origin are refused. Optional. */
  publicOrigin?: string;
  sessionMaxAgeMs: number;
  sessionIdleMs: number;
  trustProxy: boolean;
  upstreamTimeoutMs: number;
}

export class GuideHubConfigError extends Error {}

const need = (env: NodeJS.ProcessEnv, key: string): string => {
  const v = env[key]?.trim();
  if (!v) throw new GuideHubConfigError(`${key} must be set.`);
  return v;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GuideHubConfig {
  const apiToken = need(env, "GUIDEHUB_API_TOKEN");
  if (!/^aos_[A-Za-z0-9_-]{20,}$/.test(apiToken)) throw new GuideHubConfigError("GUIDEHUB_API_TOKEN is not an Angel OS token (aos_…).");
  const passwordHash = need(env, "GUIDEHUB_PASSWORD_HASH");
  if (!passwordHash.startsWith("scrypt$")) throw new GuideHubConfigError("GUIDEHUB_PASSWORD_HASH is not a scrypt hash; create one with `npm run guidehub:password`.");
  const apiBaseUrl = (env.GUIDEHUB_API_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiBaseUrl)) throw new GuideHubConfigError("GUIDEHUB_API_URL must be an http(s) URL.");
  const insecure = env.GUIDEHUB_INSECURE_COOKIES === "1";
  const publicOrigin = env.GUIDEHUB_PUBLIC_ORIGIN?.trim() || undefined;
  if (publicOrigin && !/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new GuideHubConfigError("GUIDEHUB_PUBLIC_ORIGIN must be an origin like https://cockpit.example.com.");
  return {
    port: Number(env.GUIDEHUB_PORT ?? 3100),
    apiBaseUrl,
    apiToken,
    passwordHash,
    secureCookies: !insecure,
    publicOrigin,
    sessionMaxAgeMs: 12 * 3600_000,
    sessionIdleMs: 2 * 3600_000,
    trustProxy: env.GUIDEHUB_TRUST_PROXY === "1",
    upstreamTimeoutMs: 20_000,
  };
}
