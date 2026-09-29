import express from "express";
import { z } from "zod";
import { getDb } from "../db/client/index.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import { createTask, listTasks, createReminder, listReminders } from "../skills/system/tasks.js";
import { search as searchMemory } from "../skills/system/memory.js";
import {
  listAuditLog,
  decideApproval,
  listPendingApprovals,
  ApprovalOwnershipError,
  ApprovalNotPendingError,
} from "../gateway/index.js";
import { getConnectionService, getConnectorRegistry, ConnectionNotFoundError, getOAuthStateService, OAuthStateInvalidError, OAuthStateExpiredError } from "../connectors/index.js";
import { getCredentialStore } from "../connectors/credentials/select.js";
import { GoogleOAuthClient, GoogleOAuthConfigError, GoogleOAuthApiError, loadGoogleOAuthConfig } from "../connectors/google/oauthClient.js";
import { registerGoogleConnector } from "../connectors/google/index.js";
import { recordAuditEvent } from "../gateway/audit/index.js";

registerGoogleConnector();

const app = express();
app.use(express.json());

const jarvis = new JarvisCore();

/** Resolves the (currently singleton) Principal, creating it if this is a fresh database. */
async function getOrCreatePrincipal(): Promise<string> {
  const db = getDb();
  const existing = await db.principal.findFirst();
  if (existing) return existing.id;
  const created = await db.principal.create({ data: { name: "Angel" } });
  return created.id;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "angel-os", version: "0.1.0" });
});

const jarvisRequestSchema = z.object({ input: z.string().min(1) });

app.post("/api/jarvis", async (req, res) => {
  const parsed = jarvisRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const principalId = await getOrCreatePrincipal();
  const result = await jarvis.handle({ principalId, input: parsed.data.input });
  res.json(result);
});

app.get("/api/tasks", async (_req, res) => {
  const principalId = await getOrCreatePrincipal();
  const result = await listTasks({ principalId, agentKey: JARVIS_AGENT_KEY });
  res.json(result);
});

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  dueAt: z.string().datetime().optional(),
});

app.post("/api/tasks", async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const principalId = await getOrCreatePrincipal();
  const result = await createTask({
    principalId,
    agentKey: JARVIS_AGENT_KEY,
    title: parsed.data.title,
    description: parsed.data.description,
    dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : undefined,
  });
  res.json(result);
});

app.get("/api/reminders", async (_req, res) => {
  const principalId = await getOrCreatePrincipal();
  const result = await listReminders({ principalId, agentKey: JARVIS_AGENT_KEY });
  res.json(result);
});

const createReminderSchema = z.object({
  message: z.string().min(1),
  remindAt: z.string().datetime(),
  taskId: z.string().uuid().optional(),
});

app.post("/api/reminders", async (req, res) => {
  const parsed = createReminderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const principalId = await getOrCreatePrincipal();
  const result = await createReminder({
    principalId,
    agentKey: JARVIS_AGENT_KEY,
    message: parsed.data.message,
    remindAt: new Date(parsed.data.remindAt),
    taskId: parsed.data.taskId,
  });
  res.json(result);
});

app.get("/api/memory/search", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const principalId = await getOrCreatePrincipal();
  // Fixes the audit finding that this route called MemoryProvider directly,
  // bypassing the permission gateway. Now: API -> Skill -> Gateway ->
  // Permission -> MemoryProvider, same as every other route.
  const result = await searchMemory({
    principalId,
    agentKey: JARVIS_AGENT_KEY,
    query: { query },
  });
  res.json(result);
});

app.get("/api/audit", async (_req, res) => {
  const principalId = await getOrCreatePrincipal();
  const results = await listAuditLog(principalId);
  res.json(results);
});

app.get("/api/approvals", async (_req, res) => {
  const principalId = await getOrCreatePrincipal();
  const results = await listPendingApprovals(principalId);
  res.json(results);
});

const decideApprovalSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]) });

app.post("/api/approvals/:id/decide", async (req, res) => {
  const parsed = decideApprovalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const principalId = await getOrCreatePrincipal();
  try {
    const result = await decideApproval(principalId, req.params.id, parsed.data.decision, "api");
    res.json(result);
  } catch (err) {
    if (err instanceof ApprovalOwnershipError) {
      // Same response for "not found" and "belongs to someone else" — no
      // signal to an attacker about which approval ids exist.
      return res.status(404).json({ error: "Approval not found." });
    }
    if (err instanceof ApprovalNotPendingError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: "Unexpected error." });
  }
});

// Read-only, no-secret connection metadata — no OAuth routes, no
// provider-specific routes, per Build #2's explicit scope. Every response
// goes through ConnectionSummary (connectors/types/index.ts), which never
// includes credentialRef or metadata.
app.get("/api/connections", async (_req, res) => {
  const principalId = await getOrCreatePrincipal();
  const results = await getConnectionService().list(principalId);
  res.json(results);
});

app.get("/api/connections/:id", async (req, res) => {
  const principalId = await getOrCreatePrincipal();
  try {
    const result = await getConnectionService().get(principalId, req.params.id);
    res.json(result);
  } catch (err) {
    if (err instanceof ConnectionNotFoundError) {
      return res.status(404).json({ error: "Connection not found." });
    }
    res.status(500).json({ error: "Unexpected error." });
  }
});

app.get("/api/connectors", (_req, res) => {
  const providers = getConnectorRegistry()
    .list()
    .map((p) => ({
      providerKey: p.providerKey,
      displayName: p.displayName,
      requiresAuthorization: p.requiresAuthorization(),
      capabilities: p.listCapabilities(),
    }));
  res.json(providers);
});

// ── Google OAuth (Calendar, read-only) ──────────────────────────────────────
//
// Minimal routes per Build #3's explicit scope: initiate + callback only.
// No token is ever returned in a response body or query string here — see
// docs/SECURITY.md "OAuth state security" and "Credential handling
// (Connector Layer)".

function googleRedirectUri(): string {
  const uri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!uri) {
    throw new GoogleOAuthConfigError("GOOGLE_OAUTH_REDIRECT_URI must be set to use the Google connector.");
  }
  return uri;
}

app.get("/api/integrations/google/calendar/connect", async (_req, res) => {
  try {
    const config = loadGoogleOAuthConfig();
    const redirectUri = googleRedirectUri();
    const principalId = await getOrCreatePrincipal();

    const state = await getOAuthStateService().create({ principalId, provider: "google", redirectUri });
    const oauthClient = new GoogleOAuthClient(config);
    const authorizeUrl = oauthClient.buildAuthUrl({ state, redirectUri });

    // JSON rather than a blind redirect: this API has no browser session
    // concept yet (see docs/SECURITY.md), so returning the URL for the
    // caller to navigate to is more honest than pretending a redirect
    // here means something it doesn't.
    res.json({ authorizeUrl });
  } catch (err) {
    if (err instanceof GoogleOAuthConfigError) {
      return res.status(500).json({ error: err.message });
    }
    res.status(500).json({ error: "Unexpected error." });
  }
});

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

app.get("/api/integrations/google/calendar/callback", async (req, res) => {
  const parsed = callbackQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Malformed callback request." });
  }

  if (parsed.data.error) {
    // User denied consent, or Google reported an error — never treat this
    // as success, and there is no principal to attribute this to yet
    // (state hasn't been consumed), so nothing is audited here beyond the
    // response itself.
    return res.status(400).json({ error: "Google authorization was denied or failed." });
  }

  if (!parsed.data.code || !parsed.data.state) {
    return res.status(400).json({ error: "Missing code or state." });
  }

  let consumed;
  try {
    consumed = await getOAuthStateService().consume(parsed.data.state, "google");
  } catch (err) {
    if (err instanceof OAuthStateInvalidError) return res.status(400).json({ error: err.message });
    if (err instanceof OAuthStateExpiredError) return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: "Unexpected error." });
  }

  try {
    const config = loadGoogleOAuthConfig();
    const oauthClient = new GoogleOAuthClient(config);
    const tokens = await oauthClient.exchangeCode(parsed.data.code, consumed.redirectUri);
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
      resource: `connector:google`,
      action: "OAUTH_CALLBACK",
      result: "SUCCESS",
      source: "api",
      metadata: { connectionId: connection.id, provider: "google", externalAccountId: userInfo.email },
    });

    // Never return tokens — only safe, non-secret confirmation.
    res.json({ status: "connected", provider: "google", externalAccountId: userInfo.email });
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
    if (err instanceof GoogleOAuthConfigError) {
      return res.status(500).json({ error: err.message });
    }
    if (err instanceof GoogleOAuthApiError) {
      return res.status(502).json({ error: "Google rejected the authorization request." });
    }
    res.status(500).json({ error: "Unexpected error completing Google authorization." });
  }
});

const port = Number(process.env.PORT ?? 3000);

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Angel OS API listening on http://localhost:${port}`);
  });
}

export { app };
