import express from "express";
import { z } from "zod";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { handleInterfaceMessage, MAX_INPUT_CHARS } from "../application/dispatcher.js";
import { createTask, listTasks, createReminder, listReminders } from "../skills/system/tasks.js";
import { search as searchMemory, MEMORY_TYPE_VALUES } from "../skills/system/memory.js";
import { searchKnowledgeItems, getKnowledgeItem, listKnowledgeSources, ingestKnowledge, KNOWLEDGE_KIND_VALUES } from "../skills/system/knowledge.js";
import { listActivity, summarizeActivity } from "../skills/system/activity.js";
import {
  listAuditLog,
  decideApproval,
  listPendingApprovals,
  getApproval,
  type ApprovalCode,
} from "../gateway/index.js";
import { getConnectionService, getConnectorRegistry, ConnectionNotFoundError, OAuthStateInvalidError, OAuthStateExpiredError } from "../connectors/index.js";
import { GoogleOAuthConfigError, GoogleOAuthApiError } from "../connectors/google/oauthClient.js";
import { registerSkillActions, verifyProductionActions } from "../skills/manifest.js";
import { registerGoogleConnector } from "../connectors/google/index.js";
import { startGoogleAuthorization, completeGoogleAuthorization } from "../connectors/google/authorization.js";
import { BearerTokenAuthenticator, getPrincipalProfile, type Authenticator } from "../identity/index.js";
import { asyncRoute, authenticate, cors, errorHandler, identityOf, parseCorsOrigins, rejectPrincipalOverride } from "./middleware.js";

// The HTTP interface. It is an ADAPTER: it authenticates the caller into an
// IdentityContext, then hands the request to Jarvis or to a skill. It never
// reads a principal from the request, and it has no database access — every
// personal operation goes Skill → Gateway. See docs/api/README.md for the
// contract clients (GuideHub, mobile, scripts) can rely on.

registerGoogleConnector();
registerSkillActions(); // production ActionDefinitions (approvals decided over HTTP must find them)

export const API_VERSION = "2";

const APPROVAL_HTTP_STATUS: Record<Exclude<ApprovalCode, "OK">, number> = {
  NOT_FOUND: 404,
  EXPIRED: 410,
  CONSUMED: 409,
  ALREADY_DECIDED: 409,
  FORBIDDEN: 403,
  UNAVAILABLE: 409,
};

export interface AppOptions {
  authenticator?: Authenticator;
  corsOrigins?: string[];
}

export function createApp(options: AppOptions = {}) {
  const authenticator = options.authenticator ?? new BearerTokenAuthenticator();
  const app = express();

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Angel-API-Version", API_VERSION);
    next();
  });
  app.use(cors(options.corsOrigins ?? parseCorsOrigins(process.env.ANGEL_OS_CORS_ORIGINS)));
  // 256kb: room for one 100k-character knowledge document as JSON
  app.use(express.json({ limit: "256kb" }));

  // ── Public ──────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "angel-os", version: "0.1.0" });
  });

  // Google's redirect arrives through the user's browser and cannot carry a
  // bearer token. Its authentication is the principal-bound, single-use
  // `state` (see connectors/oauth/state.ts) — not a caller-supplied identity.
  const callbackQuerySchema = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() });
  app.get(
    "/api/integrations/google/calendar/callback",
    asyncRoute(async (req, res) => {
      const parsed = callbackQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Malformed callback request." });
      if (parsed.data.error) return res.status(400).json({ error: "Google authorization was denied or failed." });
      if (!parsed.data.code || !parsed.data.state) return res.status(400).json({ error: "Missing code or state." });
      try {
        const { externalAccountId } = await completeGoogleAuthorization(parsed.data.code, parsed.data.state);
        // Never return tokens — only a safe confirmation.
        return res.json({ status: "connected", provider: "google", externalAccountId });
      } catch (err) {
        if (err instanceof OAuthStateInvalidError || err instanceof OAuthStateExpiredError) return res.status(400).json({ error: err.message });
        if (err instanceof GoogleOAuthConfigError) return res.status(500).json({ error: err.message });
        if (err instanceof GoogleOAuthApiError) return res.status(502).json({ error: "Google rejected the authorization request." });
        throw err;
      }
    })
  );

  // ── Everything below requires an authenticated identity ─────────────────
  const api = express.Router();
  api.use(authenticate(authenticator));
  api.use(rejectPrincipalOverride);

  // Who am I, and through what? The first call a client makes.
  api.get(
    "/me",
    asyncRoute(async (req, res) => {
      const identity = identityOf(req);
      const profile = await getPrincipalProfile(identity.principalId);
      res.json({
        principal: profile,
        interface: identity.interfaceSource,
        authMethod: identity.authMethod,
        requestId: identity.requestId,
      });
    })
  );

  const jarvisRequestSchema = z.object({ input: z.string().min(1).max(MAX_INPUT_CHARS) });
  api.post(
    "/jarvis",
    asyncRoute(async (req, res) => {
      const parsed = jarvisRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      res.json(await handleInterfaceMessage(identityOf(req), parsed.data.input));
    })
  );

  api.get(
    "/tasks",
    asyncRoute(async (req, res) => {
      res.json(await listTasks({ principalId: identityOf(req).principalId, agentKey: JARVIS_AGENT_KEY }));
    })
  );

  const createTaskSchema = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    dueAt: z.string().datetime().optional(),
  });
  api.post(
    "/tasks",
    asyncRoute(async (req, res) => {
      const parsed = createTaskSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      res.json(
        await createTask(identityOf(req), {
          title: parsed.data.title,
          description: parsed.data.description,
          dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : undefined,
        })
      );
    })
  );

  api.get(
    "/reminders",
    asyncRoute(async (req, res) => {
      res.json(await listReminders({ principalId: identityOf(req).principalId, agentKey: JARVIS_AGENT_KEY }));
    })
  );

  const createReminderSchema = z.object({
    message: z.string().min(1),
    remindAt: z.string().datetime(),
    taskId: z.string().uuid().optional(),
  });
  api.post(
    "/reminders",
    asyncRoute(async (req, res) => {
      const parsed = createReminderSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      res.json(
        await createReminder(identityOf(req), {
          message: parsed.data.message,
          remindAt: new Date(parsed.data.remindAt),
          taskId: parsed.data.taskId,
        })
      );
    })
  );

  const memorySearchSchema = z.object({
    q: z.string().max(500).default(""),
    type: z.enum(MEMORY_TYPE_VALUES).optional(),
    subject: z.string().max(120).optional(),
  });
  api.get(
    "/memory/search",
    asyncRoute(async (req, res) => {
      const parsed = memorySearchSchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { q, type, subject } = parsed.data;
      res.json(await searchMemory({ principalId: identityOf(req).principalId, agentKey: JARVIS_AGENT_KEY, query: { query: q, ...(type ? { type } : {}), ...(subject ? { subject } : {}) } }));
    })
  );

  // Knowledge OS: structured, principal-owned knowledge. Reads go through the READ lane;
  // ingestion is an ActionDefinition (voice credentials get an approval request).
  const knowledgeSearchSchema = z.object({ q: z.string().max(500).default(""), kind: z.enum(KNOWLEDGE_KIND_VALUES).optional(), limit: z.coerce.number().int().min(1).max(50).optional() });
  api.get(
    "/knowledge/search",
    asyncRoute(async (req, res) => {
      const parsed = knowledgeSearchSchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      res.json(await searchKnowledgeItems(identityOf(req), { agentKey: JARVIS_AGENT_KEY, query: parsed.data.q, kinds: parsed.data.kind ? [parsed.data.kind] : undefined, limit: parsed.data.limit }));
    })
  );
  api.get(
    "/knowledge/sources",
    asyncRoute(async (req, res) => {
      res.json(await listKnowledgeSources(identityOf(req), { agentKey: JARVIS_AGENT_KEY }));
    })
  );
  api.get(
    "/knowledge/items/:id",
    asyncRoute(async (req, res) => {
      res.json(await getKnowledgeItem(identityOf(req), { agentKey: JARVIS_AGENT_KEY, itemId: req.params.id }));
    })
  );
  const ingestSchema = z.object({
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(100_000),
    format: z.enum(["markdown", "text"]).optional(),
    sourceKind: z.string().max(40).optional(),
    uri: z.string().max(500).optional(),
  }).strict();
  api.post(
    "/knowledge/ingest",
    asyncRoute(async (req, res) => {
      const parsed = ingestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      res.json(await ingestKnowledge(identityOf(req), parsed.data));
    })
  );

  // Activity: the user-facing life history. Deliberately separate from /audit.
  const activityQuerySchema = z.object({
    range: z.enum(["today", "yesterday", "week"]).default("today"),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });
  api.get(
    "/activity",
    asyncRoute(async (req, res) => {
      const parsed = activityQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      res.json(await listActivity({ principalId: identityOf(req).principalId, agentKey: JARVIS_AGENT_KEY, ...parsed.data }));
    })
  );
  api.get(
    "/activity/summary",
    asyncRoute(async (req, res) => {
      const parsed = activityQuerySchema.pick({ range: true }).safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      res.json(await summarizeActivity({ principalId: identityOf(req).principalId, agentKey: JARVIS_AGENT_KEY, range: parsed.data.range }));
    })
  );

  // Audit: the security/system trace.
  api.get(
    "/audit",
    asyncRoute(async (req, res) => {
      res.json(await listAuditLog(identityOf(req).principalId));
    })
  );

  // Approvals. The caller is always the authenticated identity; an approval
  // that does not exist and one that belongs to someone else are the same 404.
  api.get(
    "/approvals",
    asyncRoute(async (req, res) => {
      res.json(await listPendingApprovals(identityOf(req)));
    })
  );

  api.get(
    "/approvals/:id",
    asyncRoute(async (req, res) => {
      const outcome = await getApproval(identityOf(req), req.params.id);
      if (!outcome.ok) return res.status(APPROVAL_HTTP_STATUS[outcome.code as Exclude<ApprovalCode, "OK">]).json({ error: outcome.message });
      res.json(outcome.approval);
    })
  );

  // Decisions take NO parameters: what runs is exactly what was stored when
  // the action was proposed. A body carrying anything is refused, so a
  // client cannot even try to change what it is approving.
  const noBody = z.object({}).strict();
  for (const [route, decision] of [["approve", "APPROVED"], ["deny", "DENIED"]] as const) {
    api.post(
      `/approvals/:id/${route}`,
      asyncRoute(async (req, res) => {
        if (!noBody.safeParse(req.body ?? {}).success) {
          return res.status(400).json({ error: "Approval decisions take no parameters." });
        }
        const outcome = await decideApproval(identityOf(req), req.params.id, decision);
        if (!outcome.ok) return res.status(APPROVAL_HTTP_STATUS[outcome.code as Exclude<ApprovalCode, "OK">]).json({ error: outcome.message, code: outcome.code });
        res.json({
          message: outcome.message,
          executed: outcome.executed ?? false,
          execution: outcome.execution ? { status: outcome.execution.status, message: outcome.execution.message } : undefined,
          approval: outcome.approval,
        });
      })
    );
  }

  // Connections: metadata only (ConnectionSummary never carries credentials).
  api.get(
    "/connections",
    asyncRoute(async (req, res) => {
      res.json(await getConnectionService().list(identityOf(req).principalId));
    })
  );
  api.get(
    "/connections/:id",
    asyncRoute(async (req, res) => {
      try {
        res.json(await getConnectionService().get(identityOf(req).principalId, req.params.id));
      } catch (err) {
        if (err instanceof ConnectionNotFoundError) return res.status(404).json({ error: "Connection not found." });
        throw err;
      }
    })
  );
  api.get("/connectors", (_req, res) => {
    res.json(
      getConnectorRegistry()
        .list()
        .map((p) => ({
          providerKey: p.providerKey,
          displayName: p.displayName,
          requiresAuthorization: p.requiresAuthorization(),
          capabilities: p.listCapabilities(),
        }))
    );
  });

  api.get(
    "/integrations/google/calendar/connect",
    asyncRoute(async (req, res) => {
      try {
        res.json(await startGoogleAuthorization(identityOf(req).principalId));
      } catch (err) {
        if (err instanceof GoogleOAuthConfigError) return res.status(500).json({ error: err.message });
        throw err;
      }
    })
  );

  api.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

export const app = createApp();

const port = Number(process.env.PORT ?? 3000);

if (process.env.NODE_ENV !== "test") {
  // Startup invariant: every production ActionDefinition has its skill,
  // agent and permission registered. If not, do not serve.
  verifyProductionActions()
    .then(() => {
      app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`Angel OS API listening on http://localhost:${port}`);
      });
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : "Action registry check failed.");
      process.exit(1);
    });
}
