import { readerIdentity, IDENTITY_REQUIRED } from "../readerIdentity.js";
import type { IdentityContext } from "../../identity/index.js";
import { withConnectionRefreshLock } from "../../connectors/service/refreshLock.js";
import { getDb } from "../../db/client/index.js";
import { gatewayExecute } from "../../gateway/index.js";
import { recordAuditEvent } from "../../gateway/audit/index.js";
import { getCredentialStore } from "../../connectors/credentials/select.js";
import { getConnectorRegistry } from "../../connectors/registry/index.js";
import { GoogleOAuthClient, loadGoogleOAuthConfig } from "../../connectors/google/oauthClient.js";
import type { CalendarConnector, CalendarEvent, ResolvedCredential } from "../../connectors/types/calendar.js";
import type { Result } from "../../core/types/index.js";
import { PublicError } from "../../core/errors.js";
import { localDayBounds, formatLocalTime } from "../../core/time.js";
import { getPrincipalTimeZone } from "../system/principal.js";

// The Calendar Skill: the ONLY place in Angel OS allowed to touch a
// calendar connector. It never bypasses gatewayExecute, never accesses
// Prisma for provider data directly (Prisma here is only used to load the
// Connection record and to mark it ACTIVE/ERROR — the actual calendar data
// always comes from the connector), and never handles a raw OAuth token
// itself beyond passing it through to the connector call.

export const SKILL_KEY = "integrations.calendar";
export const RESOURCE = "angel:calendar";
// A single READ action, deliberately, per Build #3's instruction to seed
// the minimum permission required — one CALENDAR/READ permission row
// covers list calendars, list events, get event, and "today", exactly
// like system.tasks's single READ action covers listTasks.
const ACTION = "READ";

export class ConnectionMissingError extends PublicError {
  constructor() {
    super("No active Google Calendar connection for this principal. Connect Google Calendar first.");
  }
}

export class CredentialMissingError extends PublicError {
  constructor() {
    super("Google Calendar connection has no stored credential. Reconnect required.");
  }
}

export class CredentialExpiredError extends PublicError {
  constructor() {
    super("Google Calendar authorization has expired or been revoked. Reconnect required.");
  }
}

interface StoredCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string; // ISO
}

function credentialRef(connectionId: string): string {
  // Encodes the connection (and therefore the principal, transitively —
  // Connection is principal-scoped) into the ref, so a leaked ref alone
  // still identifies exactly one connection's secret, never a bare
  // guessable name shared across principals.
  return `google:connection:${connectionId}`;
}

async function loadConnection(principalId: string) {
  const db = getDb();
  // Principal-scoped by construction — provider+principalId, never an id
  // supplied by a caller.
  return db.connection.findFirst({
    where: { principalId, provider: "google", status: { in: ["ACTIVE", "ERROR"] } },
    orderBy: { updatedAt: "desc" },
  });
}

async function markConnectionError(connectionId: string, principalId: string, reason: string) {
  const db = getDb();
  await db.connection.updateMany({ where: { id: connectionId, principalId }, data: { status: "ERROR" } });
  await recordAuditEvent({
    principalId,
    eventType: "CONNECTION_FAILED",
    resource: `connector:google`,
    action: "CALENDAR_ACCESS",
    result: "FAILURE",
    source: "skill.integrations.calendar",
    metadata: { connectionId, reason },
  });
}

/**
 * NOTE (accepted debt): token refresh below is an internal credential-MAINTENANCE
 * write (external POST + credential-store rewrite) that happens during a calendar
 * READ. It touches only this principal's own connection secret and is not
 * user-visible state, but it is still a mutation inside the READ lane. It is now
 * single-flight (connectors/service/refreshLock.ts): concurrent reads share ONE
 * refresh call. Moving it out into a connection-maintenance action stays a follow-up.
 *
 * Resolves a usable access token for this principal's Google connection,
 * refreshing it first if it's expired (or about to be). `oauthClientOverride`
 * exists purely for testing — production code never passes it, so a real
 * GoogleOAuthClient (and therefore real Google OAuth config) is only ever
 * constructed on the refresh path that actually needs it, not on every read.
 */
export async function resolveCredential(
  principalId: string,
  oauthClientOverride?: GoogleOAuthClient
): Promise<{ connectionId: string; credential: ResolvedCredential }> {
  const connection = await loadConnection(principalId);
  if (!connection) throw new ConnectionMissingError();
  if (!connection.credentialRef) throw new CredentialMissingError();

  const store = getCredentialStore();
  let raw: string;
  try {
    raw = await store.getSecret(connection.credentialRef);
  } catch {
    throw new CredentialMissingError();
  }

  const stored = JSON.parse(raw) as StoredCredential;
  const isFresh = (c: StoredCredential) => new Date(c.expiresAt).getTime() - Date.now() >= 60_000; // refresh 60s before expiry
  const use = (c: StoredCredential, expiresAt = new Date(c.expiresAt)) => ({
    connectionId: connection.id,
    credential: { accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt },
  });

  if (isFresh(stored)) return use(stored);

  // Single-flight: only one caller refreshes; the others wait and then reuse the refreshed credential.
  const credentialRef = connection.credentialRef;
  return withConnectionRefreshLock(connection.id, async () => {
    // Re-read after acquiring the lock — another caller (or process) may have refreshed while we waited.
    let current = stored;
    try {
      current = JSON.parse(await store.getSecret(credentialRef)) as StoredCredential;
    } catch {
      throw new CredentialMissingError();
    }
    if (isFresh(current)) return use(current);

    if (!current.refreshToken) {
      await markConnectionError(connection.id, principalId, "access token expired, no refresh token available");
      throw new CredentialExpiredError();
    }

    const oauthClient = oauthClientOverride ?? new GoogleOAuthClient(loadGoogleOAuthConfig());
    let refreshed;
    try {
      refreshed = await oauthClient.refreshAccessToken(current.refreshToken);
    } catch {
      await markConnectionError(connection.id, principalId, "refresh_token rejected by Google (likely revoked)");
      throw new CredentialExpiredError();
    }

    const next: StoredCredential = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
      expiresAt: refreshed.expiresAt.toISOString(),
    };
    await store.setSecret(credentialRef, JSON.stringify(next));
    return use(next, refreshed.expiresAt);
  });
}

function getGoogleCalendarConnector(): CalendarConnector {
  // Registry lookup, never a hardcoded `new GoogleCalendarConnector()` —
  // this is what lets a test swap in a fake connector by registering it
  // under the same "google" key before calling the skill.
  return getConnectorRegistry().getOrThrow("google") as unknown as CalendarConnector;
}

async function withGoogleCalendar<T>(
  principalId: string,
  fn: (connector: CalendarConnector, credential: ResolvedCredential) => Promise<T>
): Promise<T> {
  const { credential } = await resolveCredential(principalId);
  const connector = getGoogleCalendarConnector();
  return fn(connector, credential);
}

export interface CalendarSkillInput {
  agentKey: string;
}

export async function listCalendars(identity: IdentityContext, raw: CalendarSkillInput): Promise<Result> {
  const who = readerIdentity(identity);
  if (!who) return IDENTITY_REQUIRED;
  const input = { ...raw, principalId: who.principalId };
  return gatewayExecute(
    { principalId: input.principalId, agentKey: input.agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: ACTION, parameters: {} },
    () => withGoogleCalendar(input.principalId, (connector, credential) => connector.listCalendars(credential)),
    "skill.integrations.calendar"
  );
}

export interface ListEventsInput extends CalendarSkillInput {
  calendarId: string;
  timeMin: Date;
  timeMax: Date;
}

export async function listEvents(identity: IdentityContext, raw: ListEventsInput): Promise<Result> {
  const who = readerIdentity(identity);
  if (!who) return IDENTITY_REQUIRED;
  const input = { ...raw, principalId: who.principalId };
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: ACTION,
      parameters: { calendarId: input.calendarId, timeMin: input.timeMin.toISOString(), timeMax: input.timeMax.toISOString() },
    },
    () =>
      withGoogleCalendar(input.principalId, (connector, credential) =>
        connector.listEvents(credential, { calendarId: input.calendarId, timeMin: input.timeMin, timeMax: input.timeMax })
      ),
    "skill.integrations.calendar"
  );
}

export interface GetEventInput extends CalendarSkillInput {
  calendarId: string;
  eventId: string;
}

export async function getEvent(identity: IdentityContext, raw: GetEventInput): Promise<Result> {
  const who = readerIdentity(identity);
  if (!who) return IDENTITY_REQUIRED;
  const input = { ...raw, principalId: who.principalId };
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: ACTION,
      parameters: { calendarId: input.calendarId, eventId: input.eventId },
    },
    () =>
      withGoogleCalendar(input.principalId, (connector, credential) =>
        connector.getEvent(credential, { calendarId: input.calendarId, eventId: input.eventId })
      ),
    "skill.integrations.calendar"
  );
}

export interface TodayResult {
  timeZone: string;
  events: CalendarEvent[];
}

/**
 * "What do I have today?" — today's events on the principal's primary
 * calendar. "Today" is the principal's local day in their configured
 * timezone, never the server's day.
 */
export async function today(identity: IdentityContext, raw: CalendarSkillInput): Promise<Result> {
  const who = readerIdentity(identity);
  if (!who) return IDENTITY_REQUIRED;
  const input = { ...raw, principalId: who.principalId };
  return gatewayExecute(
    { principalId: input.principalId, agentKey: input.agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: ACTION, parameters: { query: "today" } },
    () =>
      withGoogleCalendar(input.principalId, async (connector, credential): Promise<TodayResult> => {
        const timeZone = await getPrincipalTimeZone(input.principalId);
        const calendars = await connector.listCalendars(credential);
        const primary = calendars.find((c) => c.primary) ?? calendars[0];
        if (!primary) return { timeZone, events: [] };

        const { start, end } = localDayBounds(new Date(), timeZone, 0);
        const events = await connector.listEvents(credential, { calendarId: primary.id, timeMin: start, timeMax: end });
        return { timeZone, events };
      }),
    "skill.integrations.calendar"
  );
}

/** Formats events for Jarvis's reply, with times shown in the principal's timezone. */
export function formatEventsAsContext(events: CalendarEvent[], timeZone: string): string {
  if (events.length === 0) return "No events today.";
  const lines = events.map((e) => {
    const time = e.allDay ? "All day" : formatLocalTime(e.start, timeZone);
    return `${time} — ${e.title}`;
  });
  return lines.join("\n");
}
