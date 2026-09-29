import type { ConnectorProvider } from "./index.js";

// Provider-neutral calendar domain types. Deliberately NOT a copy of
// Google's event schema (Google's events carry dozens of fields Angel OS
// doesn't need — conferenceData, extendedProperties, reminders overrides,
// etc.). Only what Jarvis/Skills actually use. A future
// TelegramConnector/AppleConnector/etc. exposing calendar-like data would
// map onto these same types, never onto Google-specific ones.

export interface Calendar {
  id: string;
  provider: string;
  displayName: string;
  primary: boolean;
  timezone: string | null;
}

export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled";

export interface CalendarEvent {
  id: string;
  calendarId: string;
  provider: string;
  title: string;
  description: string | null;
  /** Always a real Date — normalized from whatever timezone/format the provider used. */
  start: Date;
  end: Date;
  allDay: boolean;
  /** IANA timezone name as reported by the provider, if any (start/end are still normalized UTC Dates regardless). */
  timezone: string | null;
  location: string | null;
  attendees: string[];
  status: CalendarEventStatus;
}

export interface ListEventsParams {
  calendarId: string;
  timeMin: Date;
  timeMax: Date;
}

export interface GetEventParams {
  calendarId: string;
  eventId: string;
}

/** Opaque to everything except the connector that issued it — the skill never inspects its shape, only passes it through. */
export interface ResolvedCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/**
 * Extends ConnectorProvider with read-only calendar operations. A
 * provider-specific extension (not every connector is calendar-capable),
 * but still provider-neutral in shape — GoogleCalendarConnector implements
 * this today; a future AppleCalendarConnector would implement the same
 * interface. No Google SDK type appears here.
 */
export interface CalendarConnector extends ConnectorProvider {
  listCalendars(credential: ResolvedCredential): Promise<Calendar[]>;
  listEvents(credential: ResolvedCredential, params: ListEventsParams): Promise<CalendarEvent[]>;
  getEvent(credential: ResolvedCredential, params: GetEventParams): Promise<CalendarEvent | null>;
}
