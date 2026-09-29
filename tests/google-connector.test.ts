import { describe, it, expect } from "vitest";
import { GoogleCalendarConnector, GoogleCalendarApiError } from "../connectors/google/calendarConnector.js";
import { GoogleOAuthClient, GoogleOAuthApiError } from "../connectors/google/oauthClient.js";
import { getConnectorRegistry, ConnectorRegistry } from "../connectors/registry/index.js";
import type { ResolvedCredential } from "../connectors/types/calendar.js";

const credential: ResolvedCredential = { accessToken: "fake-access-token", refreshToken: null, expiresAt: null };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GoogleCalendarConnector — capability discovery", () => {
  it("declares providerKey 'google' and only exposes calendar.read (never calendar.write)", () => {
    const connector = new GoogleCalendarConnector();
    expect(connector.providerKey).toBe("google");
    const caps = connector.listCapabilities();
    expect(caps.map((c) => c.key)).toEqual(["calendar.read"]);
    expect(caps.every((c) => c.category === "READ")).toBe(true);
    expect(caps.some((c) => c.key.includes("write"))).toBe(false);
  });

  it("requiresAuthorization is true", () => {
    expect(new GoogleCalendarConnector().requiresAuthorization()).toBe(true);
  });

  it("registers into the shared ConnectorRegistry and is discoverable by providerKey", () => {
    const registry = new ConnectorRegistry();
    registry.register(new GoogleCalendarConnector());
    expect(registry.isAvailable("google")).toBe(true);
    expect(registry.listCapabilities("google").map((c) => c.key)).toContain("calendar.read");
    void getConnectorRegistry; // shared singleton exercised in calendar-skill.test.ts instead
  });
});

describe("GoogleCalendarConnector — normalization (Google API mocked, never called for real)", () => {
  it("normalizes a timed event into the internal CalendarEvent shape", async () => {
    const connector = new GoogleCalendarConnector(
      fakeFetch(() =>
        jsonResponse({
          items: [
            {
              id: "evt1",
              summary: "Gym",
              start: { dateTime: "2026-09-29T09:00:00Z", timeZone: "UTC" },
              end: { dateTime: "2026-09-29T10:00:00Z", timeZone: "UTC" },
              attendees: [{ email: "angel@example.com" }],
              status: "confirmed",
            },
          ],
        })
      )
    );
    const events = await connector.listEvents(credential, {
      calendarId: "primary",
      timeMin: new Date("2026-09-29T00:00:00Z"),
      timeMax: new Date("2026-09-30T00:00:00Z"),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "evt1",
      title: "Gym",
      provider: "google",
      allDay: false,
      status: "confirmed",
      attendees: ["angel@example.com"],
    });
    expect(events[0].start.toISOString()).toBe("2026-09-29T09:00:00.000Z");
  });

  it("normalizes an all-day event with allDay: true", async () => {
    const connector = new GoogleCalendarConnector(
      fakeFetch(() =>
        jsonResponse({
          items: [{ id: "evt2", summary: "Birthday", start: { date: "2026-09-29" }, end: { date: "2026-09-30" } }],
        })
      )
    );
    const events = await connector.listEvents(credential, {
      calendarId: "primary",
      timeMin: new Date(),
      timeMax: new Date(),
    });
    expect(events[0].allDay).toBe(true);
  });

  it("maps a Google API error response into GoogleCalendarApiError without leaking the access token", async () => {
    const connector = new GoogleCalendarConnector(
      fakeFetch(() => jsonResponse({ error: { message: "Invalid Credentials" } }, 401))
    );
    let caught: unknown;
    try {
      await connector.listEvents(credential, { calendarId: "primary", timeMin: new Date(), timeMax: new Date() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GoogleCalendarApiError);
    expect((caught as GoogleCalendarApiError).status).toBe(401);
    expect((caught as Error).message).not.toContain(credential.accessToken);
  });

  it("getEvent returns null for a 404 instead of throwing", async () => {
    const connector = new GoogleCalendarConnector(fakeFetch(() => jsonResponse({ error: { message: "Not Found" } }, 404)));
    const result = await connector.getEvent(credential, { calendarId: "primary", eventId: "missing" });
    expect(result).toBeNull();
  });

  it("listCalendars normalizes the primary flag and timezone", async () => {
    const connector = new GoogleCalendarConnector(
      fakeFetch(() =>
        jsonResponse({
          items: [{ id: "primary", summary: "Angel", primary: true, timeZone: "Europe/Zurich" }],
        })
      )
    );
    const calendars = await connector.listCalendars(credential);
    expect(calendars[0]).toMatchObject({ id: "primary", primary: true, timezone: "Europe/Zurich", provider: "google" });
  });
});

describe("GoogleOAuthClient — token exchange (mocked)", () => {
  const config = { clientId: "test-client-id", clientSecret: "test-client-secret" };

  it("builds an authorize URL with the read-only calendar scope and no write scope", () => {
    const client = new GoogleOAuthClient(config);
    const url = client.buildAuthUrl({ state: "abc123", redirectUri: "http://localhost:3000/callback" });
    expect(url).toContain("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly");
    expect(url).not.toContain("calendar.events");
    expect(url).not.toContain("state=abc123".replace("abc123", "other-state"));
    expect(url).toContain("state=abc123");
  });

  it("exchanges a code for tokens without ever needing a real network call", async () => {
    const client = new GoogleOAuthClient(
      config,
      fakeFetch(() =>
        jsonResponse({
          access_token: "fake-access",
          refresh_token: "fake-refresh",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.readonly",
        })
      )
    );
    const tokens = await client.exchangeCode("fake-auth-code", "http://localhost:3000/callback");
    expect(tokens.accessToken).toBe("fake-access");
    expect(tokens.refreshToken).toBe("fake-refresh");
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("maps a failed token exchange to GoogleOAuthApiError without leaking the client secret", async () => {
    const client = new GoogleOAuthClient(
      config,
      fakeFetch(() => jsonResponse({ error: "invalid_grant", error_description: "Bad code" }, 400))
    );
    let caught: unknown;
    try {
      await client.exchangeCode("bad-code", "http://localhost:3000/callback");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GoogleOAuthApiError);
    expect((caught as Error).message).not.toContain(config.clientSecret);
  });

  it("fetchUserInfo returns the account email", async () => {
    const client = new GoogleOAuthClient(
      config,
      fakeFetch(() => jsonResponse({ email: "angel@example.com", verified_email: true }))
    );
    const info = await client.fetchUserInfo("fake-token");
    expect(info.email).toBe("angel@example.com");
  });
});
