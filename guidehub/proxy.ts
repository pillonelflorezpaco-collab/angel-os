// The cockpit's ONLY door to the Angel OS API. Default deny: a request is forwarded only if its method AND path match an
// allow-list entry, and the server — never the browser — supplies the credentials. The browser cannot reach any other API route through here.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export interface Rule { method: "GET" | "POST"; path: RegExp; /** POST bodies for this route must be an empty object (approvals decide exactly what was stored). */ emptyBody?: boolean }

/** Step 1 of the cockpit: Today briefing, Ask Jarvis, approvals, and three inline actions. Grow this list deliberately, one screen at a time. */
export const ALLOWED: Rule[] = [
  { method: "GET", path: /^\/api\/me$/ },
  { method: "GET", path: /^\/api\/context$/ },
  { method: "GET", path: /^\/api\/approvals$/ },
  { method: "GET", path: new RegExp(`^/api/approvals/${UUID}$`) },
  { method: "POST", path: new RegExp(`^/api/approvals/${UUID}/(approve|deny)$`), emptyBody: true },
  { method: "POST", path: /^\/api\/jarvis$/ },
  { method: "GET", path: /^\/api\/decisions$/ },
  { method: "GET", path: /^\/api\/learning\/due$/ },
  { method: "POST", path: /^\/api\/actions\/system\.tasks\/TASK_COMPLETE$/ },
  { method: "POST", path: /^\/api\/actions\/system\.decisions\/DECISION_REVIEW$/ },
  { method: "POST", path: /^\/api\/actions\/system\.learning\/CARD_REVIEW$/ },
];

export function matchRule(method: string, path: string): Rule | undefined {
  return ALLOWED.find((r) => r.method === method && r.path.test(path));
}

export const MAX_QUERY_CHARS = 1000;

export interface ForwardInput { method: "GET" | "POST"; path: string; search: string; body: unknown }
export interface ForwardConfig { apiBaseUrl: string; apiToken: string; timeoutMs: number; fetchImpl?: typeof fetch }
export type ForwardResult = { kind: "response"; status: number; body: string } | { kind: "misconfigured" } | { kind: "unavailable" } | { kind: "bad-request"; error: string };

/**
 * Calls the upstream API as the cockpit's own token. Sends ONLY Authorization, Accept and (for POST) Content-Type — never the
 * browser's cookies or headers. An upstream 401 means the cockpit's own token is bad (a server problem), not "sign in again".
 */
export async function forward(cfg: ForwardConfig, input: ForwardInput): Promise<ForwardResult> {
  const rule = matchRule(input.method, input.path);
  if (!rule) return { kind: "bad-request", error: "Not available." };
  if (input.search.length > MAX_QUERY_CHARS) return { kind: "bad-request", error: "Query too long." };
  if (input.method === "POST" && rule.emptyBody && input.body && Object.keys(input.body as object).length > 0) return { kind: "bad-request", error: "This action takes no parameters." };
  const url = `${cfg.apiBaseUrl}${input.path}${input.method === "GET" ? input.search : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.apiToken}`, Accept: "application/json" };
  let init: RequestInit = { method: input.method, headers, signal: AbortSignal.timeout(cfg.timeoutMs) };
  if (input.method === "POST") {
    headers["Content-Type"] = "application/json";
    init = { ...init, body: JSON.stringify(rule.emptyBody ? {} : (input.body ?? {})) };
  }
  let res: Response;
  try {
    res = await (cfg.fetchImpl ?? fetch)(url, init);
  } catch {
    return { kind: "unavailable" };
  }
  if (res.status === 401) return { kind: "misconfigured" };
  const text = await res.text();
  try { JSON.parse(text); } catch { return { kind: "unavailable" }; } // an upstream that isn't speaking JSON is not passed through
  return { kind: "response", status: res.status, body: text };
}
