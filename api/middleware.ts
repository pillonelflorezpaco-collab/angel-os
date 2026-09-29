import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { logInternalError } from "../core/errors.js";
import { runWithIdentity, type Authenticator, type IdentityContext } from "../identity/index.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set only by `authenticate`, from a verified credential. Never from the request body, query, or headers. */
      identity?: IdentityContext;
    }
  }
}

/** The authenticated identity of this request. Throws if a route forgot to sit behind `authenticate`. */
export function identityOf(req: Request): IdentityContext {
  if (!req.identity) throw new Error("Route reached without an authenticated identity.");
  return req.identity;
}

/**
 * Express 4 does not catch a rejected promise from an async handler, so an
 * error thrown inside one (e.g. the database being unreachable) would
 * become an unhandled rejection and stop the whole process. Every async
 * route goes through this so it reaches `errorHandler` instead.
 */
export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Request → Authenticator → IdentityContext. 401 (with no detail) when the caller can't be authenticated. */
export function authenticate(authenticator: Authenticator): RequestHandler {
  return asyncRoute(async (req, res, next) => {
    const identity = await authenticator.authenticate({ headers: req.headers });
    if (!identity) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "Unauthorized." });
    }
    req.identity = identity;
    res.setHeader("X-Request-Id", identity.requestId);
    // Everything downstream of this request runs with the identity in
    // scope, so audit and activity rows are stamped with where it came from.
    return runWithIdentity(identity, () => next());
  });
}

const normalize = (key: string) => key.toLowerCase().replace(/[_-]/g, "");

function containsPrincipalKey(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (normalize(key) === "principalid" || containsPrincipalKey(child, depth + 1)) return true;
  }
  return false;
}

/**
 * A client must never be able to say "act as principal X". The principal
 * comes from the credential, so any attempt to supply one — in the body,
 * the query string, or a header — is rejected outright rather than
 * ignored: silently ignoring it would hide a client bug or an attack.
 */
export const rejectPrincipalOverride: RequestHandler = (req, res, next) => {
  if (containsPrincipalKey(req.body) || containsPrincipalKey(req.query) || req.headers["x-principal-id"] !== undefined) {
    return res.status(400).json({ error: "principalId cannot be supplied by the client." });
  }
  next();
};

/**
 * Opt-in CORS for a browser-based interface (e.g. a web cockpit). Off
 * unless `ANGEL_OS_CORS_ORIGINS` lists exact origins; "*" is never honoured.
 * No credentials mode: the bearer token is sent explicitly in a header.
 */
export function cors(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.filter((o) => o && o !== "*"));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
      res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}

export function parseCorsOrigins(value: string | undefined): string[] {
  return (value ?? "").split(",").map((o) => o.trim()).filter(Boolean);
}

/** Sanitizing terminal error handler: never sends error text, stack, or internals to the client. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const type = (err as { type?: string }).type;
  if (type === "entity.parse.failed") return res.status(400).json({ error: "Malformed request body." });
  if (type === "entity.too.large") return res.status(413).json({ error: "Request body too large." });
  logInternalError("api", err);
  res.status(500).json({ error: "Unexpected error." });
};
