import type {
  Calendar,
  CalendarConnector,
  CalendarEvent,
  CalendarEventStatus,
  GetEventParams,
  ListEventsParams,
  ResolvedCredential,
} from "../types/calendar.js";
import type { ConnectorCapability, ConnectorHealth } from "../types/index.js";
import type { FetchFn } from "./oauthClient.js";

/** Upper bound for any single Google call: a hung request must not hang a READ. */
const REQUEST_TIMEOUT_MS = 10_000;
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarApiError extends Error {
  constructor(message: string, readonly status?: number) {
    // NEVER include Authorization headers or the access token in this
    // message — only Google's safe error text and the HTTP status.
    super(message);
    this.name = "GoogleCalendarApiError";
  }
}

// Google's own event/calendar shapes, kept private to this file so no
// Google SDK/response type ever leaks into connectors/types (which
// GoogleCalendarConnector's own public interface, CalendarConnector, does
// not reference).
interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  timeZone?: string;
}
interface GoogleEventDateTime {
  date?: string; // all-day events
  dateTime?: string; // timed events
  timeZone?: string;
}
interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  location?: string;
  attendees?: { email: string }[];
  status?: string;
}

function normalizeStatus(status: string | undefined): CalendarEventStatus {
  if (status === "tentative") return "tentative";
  if (status === "cancelled") return "cancelled";
  return "confirmed";
}

function normalizeEvent(raw: GoogleEvent, calendarId: string): CalendarEvent {
  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime);
  const start = raw.start?.dateTime ?? raw.start?.date;
  const end = raw.end?.dateTime ?? raw.end?.date;
  return {
    id: raw.id,
    calendarId,
    provider: "google",
    title: raw.summary ?? "(untitled)",
    description: raw.description ?? null,
    start: start ? new Date(start) : new Date(NaN),
    end: end ? new Date(end) : new Date(NaN),
    allDay,
    timezone: raw.start?.timeZone ?? null,
    location: raw.location ?? null,
    attendees: (raw.attendees ?? []).map((a) => a.email),
    status: normalizeStatus(raw.status),
  };
}

export class GoogleCalendarConnector implements CalendarConnector {
  readonly providerKey = "google";
  readonly displayName = "Google Calendar";

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  listCapabilities(): ConnectorCapability[] {
    // Only calendar.read is declared. calendar.write is intentionally
    // absent from this list in this build — see docs/ARCHITECTURE.md
    // "Google Calendar connector".
    return [{ key: "calendar.read", category: "READ", description: "Read calendars and events." }];
  }

  requiresAuthorization(): boolean {
    return true;
  }

  async checkHealth(): Promise<ConnectorHealth> {
    // A capability/health check that doesn't require valid credentials —
    // reachability of Google's API surface, not "is this principal's
    // token valid" (that's answered per-call, by listEvents/etc. below).
    try {
      const res = await this.fetchFn(`${CALENDAR_API_BASE}/users/me/calendarList?maxResults=1`, {
        signal: AbortSignal.timeout(3000),
      });
      // Any response (even 401, since no token was sent) proves the API
      // is reachable; a network failure is what we're actually checking.
      return { reachable: true, checkedAt: new Date(), detail: `status ${res.status}` };
    } catch (err) {
      return {
        reachable: false,
        checkedAt: new Date(),
        detail: err instanceof Error ? err.message : "unreachable",
      };
    }
  }

  async listCalendars(credential: ResolvedCredential): Promise<Calendar[]> {
    const body = await this.get<{ items?: GoogleCalendarListEntry[] }>(
      `${CALENDAR_API_BASE}/users/me/calendarList`,
      credential
    );
    return (body.items ?? []).map((c) => ({
      id: c.id,
      provider: "google",
      displayName: c.summary ?? c.id,
      primary: Boolean(c.primary),
      timezone: c.timeZone ?? null,
    }));
  }

  async listEvents(credential: ResolvedCredential, params: ListEventsParams): Promise<CalendarEvent[]> {
    const url = new URL(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(params.calendarId)}/events`);
    url.searchParams.set("timeMin", params.timeMin.toISOString());
    url.searchParams.set("timeMax", params.timeMax.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const body = await this.get<{ items?: GoogleEvent[] }>(url.toString(), credential);
    return (body.items ?? []).map((e) => normalizeEvent(e, params.calendarId));
  }

  async getEvent(credential: ResolvedCredential, params: GetEventParams): Promise<CalendarEvent | null> {
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`;
    try {
      const body = await this.get<GoogleEvent>(url, credential);
      return normalizeEvent(body, params.calendarId);
    } catch (err) {
      if (err instanceof GoogleCalendarApiError && err.status === 404) return null;
      throw err;
    }
  }

  private async get<T>(url: string, credential: ResolvedCredential): Promise<T> {
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${credential.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body.error?.message ?? "";
      } catch {
        // ignore unparsable body
      }
      throw new GoogleCalendarApiError(
        `Google Calendar API request failed${detail ? `: ${detail.slice(0, 200)}` : "."}`,
        res.status
      );
    }
    return (await res.json()) as T;
  }
}
