import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GuideHubConfigError, loadConfig, type GuideHubConfig } from "./config.js";
import { verifyPassphrase } from "./password.js";
import { forward, matchRule } from "./proxy.js";
import { SessionStore } from "./sessions.js";
import { LoginThrottle } from "./throttle.js";

// The GuideHub cockpit server (BFF). It authenticates the HUMAN (passphrase → server-side session cookie) and calls the Angel OS API
// with the cockpit's own bearer token, which never reaches the browser. It has no database, imports nothing from the backend, and
// forwards only allow-listed routes (guidehub/proxy.ts). See docs/guidehub/cockpit-design.md.

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "guidehub-cockpit";

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export interface AppDeps { config: GuideHubConfig; fetchImpl?: typeof fetch; now?: () => number }

export function createGuideHubApp(deps: AppDeps) {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const sessions = new SessionStore({ maxAgeMs: config.sessionMaxAgeMs, idleMs: config.sessionIdleMs, now });
  const throttle = new LoginThrottle({ perKeyMax: 5, globalMax: 20, windowMs: 15 * 60_000, now });
  const COOKIE = config.secureCookies ? "__Host-guidehub" : "guidehub";
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  const cookieOf = (req: Request): string | undefined => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return v.join("=");
    }
    return undefined;
  };
  const setCookie = (res: Response, value: string, maxAgeSec: number) =>
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.secureCookies ? "; Secure" : ""}`);
  const noStore = (res: Response) => res.setHeader("Cache-Control", "no-store");

  // Unsafe requests must carry the custom header (a cross-site form or simple fetch cannot) and, if the browser sent an Origin, a matching one.
  const csrf = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.headers[CSRF_HEADER] !== CSRF_VALUE) return res.status(403).json({ error: "Forbidden." });
    const origin = req.headers.origin;
    if (origin) {
      const expected = config.publicOrigin ?? `${req.protocol}://${req.headers.host}`;
      if (origin !== expected) return res.status(403).json({ error: "Forbidden." });
    }
    next();
  };
  const json = express.json({ limit: "64kb" });
  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    if (!sessions.touch(cookieOf(req))) return res.status(401).json({ error: "Sign in required." });
    next();
  };

  app.get("/healthz", (_req, res) => { noStore(res); res.json({ status: "ok" }); });

  // ── Session ──────────────────────────────────────────────────────────────
  app.post("/session", csrf, json, async (req, res) => {
    noStore(res);
    const key = req.ip ?? "unknown";
    const wait = throttle.retryAfterSec(key);
    if (wait > 0) { res.setHeader("Retry-After", String(wait)); return res.status(429).json({ error: "Too many attempts. Try again later." }); }
    const pass = (req.body as { passphrase?: unknown } | undefined)?.passphrase;
    if (typeof pass !== "string" || pass.length === 0 || pass.length > 256) { throttle.recordFailure(key); return res.status(401).json({ error: "Incorrect passphrase." }); }
    if (!(await verifyPassphrase(pass, config.passwordHash))) { throttle.recordFailure(key); return res.status(401).json({ error: "Incorrect passphrase." }); }
    throttle.recordSuccess(key);
    sessions.destroy(cookieOf(req)); // never reuse an id across a sign-in (no session fixation)
    setCookie(res, sessions.create(), Math.floor(config.sessionMaxAgeMs / 1000));
    res.json({ authenticated: true });
  });

  app.get("/session", async (req, res) => {
    noStore(res);
    if (!sessions.touch(cookieOf(req))) return res.json({ authenticated: false });
    const me = await forward({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, timeoutMs: config.upstreamTimeoutMs, fetchImpl: deps.fetchImpl }, { method: "GET", path: "/api/me", search: "", body: undefined });
    res.json({ authenticated: true, me: me.kind === "response" && me.status === 200 ? JSON.parse(me.body) : null });
  });

  app.delete("/session", csrf, (req, res) => {
    noStore(res);
    sessions.destroy(cookieOf(req));
    setCookie(res, "", 0);
    res.json({ authenticated: false });
  });

  // ── API proxy (default deny) ─────────────────────────────────────────────
  app.all("/api/*", csrf, json, requireSession, async (req, res) => {
    noStore(res);
    const method = req.method;
    if (!matchRule(method, req.path) || (method !== "GET" && method !== "POST")) return res.status(404).json({ error: "Not available." });
    const search = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    if (method === "POST" && !req.is("application/json")) return res.status(415).json({ error: "JSON required." });
    const out = await forward({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, timeoutMs: config.upstreamTimeoutMs, fetchImpl: deps.fetchImpl }, { method, path: req.path, search, body: req.body });
    switch (out.kind) {
      case "response": return res.status(out.status).type("application/json").send(out.body);
      case "bad-request": return res.status(400).json({ error: out.error });
      case "misconfigured": console.error(`[guidehub ${randomUUID()}] the Angel OS API rejected the cockpit's token`); return res.status(502).json({ error: "The cockpit isn't configured correctly. Ask the operator." });
      default: return res.status(502).json({ error: "The Angel OS API is unavailable right now." });
    }
  });

  // ── Static frontend ──────────────────────────────────────────────────────
  app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: "deny", setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
  app.get("/", (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(PUBLIC_DIR, "index.html")); });
  app.use((_req, res) => { noStore(res); res.status(404).json({ error: "Not found." }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: number })?.status === "number" ? (err as { status: number }).status : 500;
    res.status(status >= 400 && status < 500 ? status : 500).json({ error: status === 413 ? "Request too large." : status >= 400 && status < 500 ? "Bad request." : "Something went wrong." });
  });

  return { app, sessions, throttle };
}

if (process.env.NODE_ENV !== "test" && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const config = loadConfig();
    const { app } = createGuideHubApp({ config });
    const host = process.env.GUIDEHUB_HOST ?? "127.0.0.1";
    app.listen(config.port, host, () => console.log(`GuideHub cockpit on http://${host}:${config.port} (API: ${config.apiBaseUrl})`));
  } catch (err) {
    console.error(err instanceof GuideHubConfigError ? err.message : "GuideHub failed to start.");
    process.exit(1);
  }
}
