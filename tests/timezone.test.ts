import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import {
  localDateString,
  localDayBounds,
  localTimeOnDay,
  normalizeTimeZone,
  formatLocalTime,
} from "../core/time.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import { SKILL_KEY as TASKS_SKILL, RESOURCE as TASKS_RESOURCE } from "../skills/system/tasks.js";
import * as calendarSkill from "../skills/integrations/calendar.js";
import { getConnectorRegistry } from "../connectors/registry/index.js";
import { getCredentialStore } from "../connectors/credentials/select.js";
import type { CalendarConnector, CalendarEvent, ListEventsParams } from "../connectors/types/calendar.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

// Server clock: 2026-09-29 00:30 UTC. In America/Bogota (UTC-5) it is
// still 2026-09-28 19:30 — the user's "today" is the 28th.
const SERVER_NOW = new Date("2026-09-29T00:30:00Z");
const BOGOTA = "America/Bogota";

/** Regression for audit finding F6: user-relative dates used the server's day. */
describe("core/time — user-relative dates", () => {
  it("the user's date differs from the server's UTC date at the boundary", () => {
    expect(SERVER_NOW.toISOString().slice(0, 10)).toBe("2026-09-29");
    expect(localDateString(SERVER_NOW, BOGOTA)).toBe("2026-09-28");
  });

  it("today = the user's local day, as UTC bounds", () => {
    const { start, end } = localDayBounds(SERVER_NOW, BOGOTA, 0);
    expect(start.toISOString()).toBe("2026-09-28T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-29T05:00:00.000Z");
  });

  it("tomorrow and yesterday are relative to the user's day", () => {
    expect(localDayBounds(SERVER_NOW, BOGOTA, 1).start.toISOString()).toBe("2026-09-29T05:00:00.000Z");
    expect(localDayBounds(SERVER_NOW, BOGOTA, -1).start.toISOString()).toBe("2026-09-27T05:00:00.000Z");
  });

  it("'tomorrow at 10:00' in Bogota is 15:00 UTC on the 29th", () => {
    expect(localTimeOnDay(SERVER_NOW, BOGOTA, 1, 10, 0).toISOString()).toBe("2026-09-29T15:00:00.000Z");
  });

  it("works for zones ahead of UTC (Asia/Tokyo is already on the 29th)", () => {
    const now = new Date("2026-09-28T20:00:00Z"); // 05:00 on the 29th in Tokyo
    expect(localDateString(now, "Asia/Tokyo")).toBe("2026-09-29");
    expect(localDayBounds(now, "Asia/Tokyo", 0).start.toISOString()).toBe("2026-09-28T15:00:00.000Z");
  });

  it("handles a DST change: Europe/Zurich's 2026-10-25 is 25 hours long", () => {
    const { start, end } = localDayBounds(new Date("2026-10-25T12:00:00Z"), "Europe/Zurich", 0);
    expect(start.toISOString()).toBe("2026-10-24T22:00:00.000Z"); // CEST, UTC+2
    expect(end.toISOString()).toBe("2026-10-25T23:00:00.000Z"); // CET, UTC+1
  });

  it("formats times in the user's timezone", () => {
    expect(formatLocalTime(new Date("2026-09-29T15:00:00Z"), BOGOTA)).toBe("10:00");
  });

  it("falls back to UTC for a missing or invalid timezone", () => {
    expect(normalizeTimeZone(null)).toBe("UTC");
    expect(normalizeTimeZone("Not/A_Zone")).toBe("UTC");
    expect(normalizeTimeZone(BOGOTA)).toBe(BOGOTA);
  });
});

describe("skills use the principal's timezone, not the server's", () => {
  let principalId: string;
  const listEventsSpy = vi.fn(async (_c: unknown, _p: ListEventsParams): Promise<CalendarEvent[]> => [
    {
      id: "tz-evt",
      calendarId: "primary",
      provider: "google",
      title: "Evening call",
      description: null,
      start: new Date("2026-09-29T00:00:00Z"), // 19:00 in Bogota
      end: new Date("2026-09-29T01:00:00Z"),
      allDay: false,
      timezone: BOGOTA,
      location: null,
      attendees: [],
      status: "confirmed",
    },
  ]);

  const fakeConnector: CalendarConnector = {
    providerKey: "google",
    displayName: "Fake Google Calendar (timezone test)",
    listCapabilities: () => [{ key: "calendar.read", category: "READ", description: "fake" }],
    requiresAuthorization: () => true,
    checkHealth: async () => ({ reachable: true, checkedAt: new Date() }),
    listCalendars: async () => [{ id: "primary", provider: "google", displayName: "Angel", primary: true, timezone: BOGOTA }],
    listEvents: (c, p) => listEventsSpy(c, p),
    getEvent: async () => null,
  };

  beforeAll(async () => {
    getConnectorRegistry().register(fakeConnector);
    principalId = (await createPrincipal("Timezone Principal", BOGOTA)).id;
    await grant(principalId, JARVIS_AGENT_KEY, TASKS_SKILL, TASKS_RESOURCE, "CREATE_REMINDER", "WRITE");
    await grant(principalId, JARVIS_AGENT_KEY, calendarSkill.SKILL_KEY, calendarSkill.RESOURCE, "READ", "READ");

    const connection = await getDb().connection.create({
      data: { principalId, provider: "google", externalAccountId: `tz-${principalId}@fake.example`, status: "ACTIVE" },
    });
    const ref = `google:connection:${connection.id}`;
    await getCredentialStore().setSecret(
      ref,
      JSON.stringify({ accessToken: "tz-access", refreshToken: "tz-refresh", expiresAt: "2099-01-01T00:00:00.000Z" })
    );
    await getDb().connection.update({ where: { id: connection.id }, data: { credentialRef: ref } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await deletePrincipal(principalId);
    await disconnectDb();
  });

  it("'What do I have today?' queries the user's local day and shows local times", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: SERVER_NOW });
    listEventsSpy.mockClear();

    const result = await new JarvisCore().handle({ principalId, input: "What do I have today?" });

    expect(result.status).toBe("EXECUTED");
    const params = listEventsSpy.mock.calls[0][1];
    expect(params.timeMin.toISOString()).toBe("2026-09-28T05:00:00.000Z");
    expect(params.timeMax.toISOString()).toBe("2026-09-29T05:00:00.000Z");
    expect(result.message).toContain("19:00 — Evening call");
  });

  it("'remind me tomorrow at 10' is 10:00 tomorrow in the user's timezone", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: SERVER_NOW });

    const result = await new JarvisCore().handle({ principalId, input: "Remind me tomorrow at 10 to call John" });

    expect(result.status).toBe("EXECUTED");
    const reminder = result.data as { remindAt: Date; message: string };
    // Server-day logic would have produced 2026-09-30T10:00Z.
    expect(new Date(reminder.remindAt).toISOString()).toBe("2026-09-29T15:00:00.000Z");
  });

  it("rejects an impossible reminder time instead of storing a wrong one", async () => {
    const result = await new JarvisCore().handle({ principalId, input: "Remind me tomorrow at 25 to do something" });
    expect(result.status).toBe("FAILED");
  });
});
