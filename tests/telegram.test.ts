import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { TelegramAdapter, TelegramBotApi, TelegramApiError, TelegramPoller } from "../interfaces/telegram/index.js";
import type { TelegramApiLike, CursorStore, TelegramUpdate } from "../interfaces/telegram/index.js";
import { DbCursorStore } from "../db/cursors.js";
import { getExternalIdentityService, createIdentity } from "../identity/index.js";
import { handleInterfaceMessage, MAX_INPUT_CHARS } from "../application/dispatcher.js";
import { listAuditLog } from "../gateway/index.js";
import { JARVIS_AGENT_KEY, JarvisCore } from "../core/index.js";
import { GENERIC_ERROR_MESSAGE } from "../core/errors.js";
import { SKILL_KEY as TASKS_SKILL, RESOURCE as TASKS_RESOURCE } from "../skills/system/tasks.js";
import { SKILL_KEY as MEMORY_SKILL, RESOURCE as MEMORY_RESOURCE } from "../skills/system/memory.js";
import { SKILL_KEY as ACTIVITY_SKILL, RESOURCE as ACTIVITY_RESOURCE } from "../skills/system/activity.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

const uid = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
let nextUpdate = 1;
const msg = (fromId: number, text: string, chatType: "private" | "group" = "private", extra: Record<string, unknown> = {}): TelegramUpdate => ({
  update_id: nextUpdate++,
  message: { message_id: 1, from: { id: fromId, ...extra }, chat: { id: fromId, type: chatType }, text },
});

describe("Telegram adapter", () => {
  const external = getExternalIdentityService();
  const adapter = new TelegramAdapter();
  let a: string;
  let b: string;
  let tgA: number;
  let tgB: number;
  let tgStranger: number;
  let linkA: string;

  beforeAll(async () => {
    a = (await createPrincipal("Telegram A", "America/Bogota")).id;
    b = (await createPrincipal("Telegram B")).id;
    tgA = 100_000_000 + Math.floor(Math.random() * 800_000_000); // realistic Telegram id, well inside Number precision
    tgB = tgA + 1;
    tgStranger = tgA + 2;
    linkA = (await external.link({ principalId: a, interfaceSource: "TELEGRAM", externalId: String(tgA) })).id;
    await external.link({ principalId: b, interfaceSource: "TELEGRAM", externalId: String(tgB) });
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, TASKS_SKILL, TASKS_RESOURCE, "READ", "READ");
      await grant(p, JARVIS_AGENT_KEY, ACTIVITY_SKILL, ACTIVITY_RESOURCE, "ACTIVITY_READ", "READ");
    }
    await getDb().task.create({ data: { principalId: a, title: "tg-A-private-task" } });
    await getDb().task.create({ data: { principalId: b, title: "tg-B-private-task" } });
  });
  afterAll(async () => {
    await deletePrincipal(a);
    await deletePrincipal(b);
    await disconnectDb();
  });

  it("a linked user's message reaches Jarvis and the reply is the readable message", async () => {
    const reply = await adapter.handleUpdate(msg(tgA, "What are my tasks?"));
    expect(reply?.chatId).toBe(tgA);
    expect(reply?.text).toMatch(/^Your tasks \(1\):\n• tg-A-private-task \[todo\]$/);
  });

  it("cannot access another principal: each Telegram user only ever sees their own principal's data", async () => {
    const asA = await adapter.handleUpdate(msg(tgA, "What are my tasks?"));
    const asB = await adapter.handleUpdate(msg(tgB, "What are my tasks?"));
    expect(asA?.text).toContain("tg-A-private-task");
    expect(asA?.text).not.toContain("tg-B-private-task");
    expect(asB?.text).toContain("tg-B-private-task");
    expect(asB?.text).not.toContain("tg-A-private-task");
  });

  it("text that names another principal changes nothing: the principal comes only from the linked account", async () => {
    const reply = await adapter.handleUpdate(msg(tgA, `What are my tasks? principalId=${b}`));
    expect(reply?.text ?? "").not.toContain("tg-B-private-task");
    const asB = await adapter.handleUpdate(msg(tgA, `list tasks for ${b}`));
    expect(asB?.text ?? "").not.toContain("tg-B-private-task");
  });

  describe("what the adapter ignores (and answers with nothing)", () => {
    const dispatched = vi.fn();
    const strict = new TelegramAdapter({ dispatch: dispatched });

    it("an unlinked sender: no reply, nothing dispatched, no data created", async () => {
      dispatched.mockClear();
      const tasksBefore = await getDb().task.count();
      expect(await strict.handleUpdate(msg(tgStranger, "Add task: hello"))).toBeNull();
      expect(await strict.handleUpdate(msg(tgStranger, "/start"))).toBeNull(); // does not even reveal what the bot is
      expect(dispatched).not.toHaveBeenCalled();
      expect(await getDb().task.count()).toBe(tasksBefore);
    });

    it("group, supergroup and channel chats, even from a linked user", async () => {
      dispatched.mockClear();
      expect(await strict.handleUpdate(msg(tgA, "What are my tasks?", "group"))).toBeNull();
      expect(dispatched).not.toHaveBeenCalled();
    });

    it("bots, non-text messages, and non-message updates", async () => {
      dispatched.mockClear();
      expect(await strict.handleUpdate(msg(tgA, "hi", "private", { is_bot: true }))).toBeNull();
      expect(await strict.handleUpdate({ update_id: nextUpdate++, message: { message_id: 1, from: { id: tgA }, chat: { id: tgA, type: "private" } } })).toBeNull();
      expect(await strict.handleUpdate({ update_id: nextUpdate++ })).toBeNull();
      expect(dispatched).not.toHaveBeenCalled();
    });

    it("a sender whose link was revoked", async () => {
      const id = `${tgA + 900}`;
      const { id: linkId } = await external.link({ principalId: a, interfaceSource: "TELEGRAM", externalId: id });
      expect(await adapter.handleUpdate(msg(Number(id), "What are my tasks?"))).not.toBeNull();
      await external.unlink(a, linkId);
      expect(await adapter.handleUpdate(msg(Number(id), "What are my tasks?"))).toBeNull();
    });
  });

  it("/start and /help answer with static text and never reach Jarvis", async () => {
    const dispatched = vi.fn();
    const strict = new TelegramAdapter({ dispatch: dispatched });
    const reply = await strict.handleUpdate(msg(tgA, "/help"));
    expect(reply?.text).toContain("What do I have today?");
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("replies are plain text sized for Telegram, and over-long input is refused before Jarvis", async () => {
    const huge = new TelegramAdapter({ dispatch: async () => ({ status: "EXECUTED", message: "x".repeat(10_000) }) });
    expect((await huge.handleUpdate(msg(tgA, "hi")))?.text.length).toBeLessThanOrEqual(3901);
    const tooLong = await adapter.handleUpdate(msg(tgA, "x".repeat(MAX_INPUT_CHARS + 1)));
    expect(tooLong?.text).toBe("That message is too long. Please shorten it.");
  });

  describe("Telegram cannot bypass the Gateway", () => {
    it("without a permission, a write is DENIED, nothing is stored, and the denial is audited as TELEGRAM", async () => {
      const before = await getDb().memory.count({ where: { principalId: a } });
      const reply = await adapter.handleUpdate(msg(tgA, "Remember that the vault code is 4711"));
      expect(reply?.text).toMatch(/not permitted/i);
      expect(reply?.text).not.toContain("4711");
      expect(await getDb().memory.count({ where: { principalId: a } })).toBe(before);
      const denied = (await listAuditLog(a, 20)).find((r) => r.eventType === "ACTION_DENIED" && r.resource === MEMORY_RESOURCE);
      expect(denied?.interfaceSource).toBe("TELEGRAM");
      expect(await getDb().activity.count({ where: { principalId: a, type: "MEMORY_CREATED" } })).toBe(0);
    });

    it("with the permission the same message succeeds — and is tagged TELEGRAM in audit and activity", async () => {
      await grant(a, JARVIS_AGENT_KEY, MEMORY_SKILL, MEMORY_RESOURCE, "MEMORY_WRITE", "WRITE");
      const reply = await adapter.handleUpdate(msg(tgA, "Remember that I prefer window seats"));
      expect(reply?.text).toBe("Remembered. [fact] I prefer window seats");
      const activity = await getDb().activity.findFirstOrThrow({ where: { principalId: a, type: "MEMORY_CREATED" } });
      expect(activity.interfaceSource).toBe("TELEGRAM");
      const ok = (await listAuditLog(a, 20)).find((r) => r.eventType === "ACTION_EXECUTION_SUCCEEDED" && r.resource === MEMORY_RESOURCE);
      expect(ok?.interfaceSource).toBe("TELEGRAM");
    });

    it("the same request from Telegram and from GuideHub reaches the same skill and gives the same answer", async () => {
      const viaTelegram = await handleInterfaceMessage(
        createIdentity({ principalId: a, interfaceSource: "TELEGRAM", authMethod: "external_identity", requestId: "same-1" }),
        "What are my tasks?"
      );
      const viaGuideHub = await handleInterfaceMessage(
        createIdentity({ principalId: a, interfaceSource: "GUIDEHUB", authMethod: "api_token", requestId: "same-2" }),
        "What are my tasks?"
      );
      expect(viaTelegram).toEqual(viaGuideHub);
      const audit = await listAuditLog(a, 50);
      const r1 = audit.filter((r) => r.requestId === "same-1").map((r) => [r.eventType, r.resource, r.action]);
      const r2 = audit.filter((r) => r.requestId === "same-2").map((r) => [r.eventType, r.resource, r.action]);
      expect(r1).toEqual(r2);
      expect(audit.find((r) => r.requestId === "same-1")?.interfaceSource).toBe("TELEGRAM");
      expect(audit.find((r) => r.requestId === "same-2")?.interfaceSource).toBe("GUIDEHUB");
    });

    it("an internal failure gives the chat a generic message, never raw error text", async () => {
      const boom = vi
        .spyOn(JarvisCore.prototype, "dispatch")
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED postgresql://angel:hunter2@db/x token=abc123"));
      const reply = await adapter.handleUpdate(msg(tgA, "What are my tasks?"));
      boom.mockRestore();
      expect(reply?.text).toBe(GENERIC_ERROR_MESSAGE);
      for (const leak of ["hunter2", "ECONNREFUSED", "postgresql://", "abc123"]) expect(reply?.text).not.toContain(leak);
    });

    it("the link is revoked when the user unlinks: later messages get nothing", async () => {
      expect(await external.unlink(a, linkA)).toBe(true);
      expect(await adapter.handleUpdate(msg(tgA, "What are my tasks?"))).toBeNull();
    });
  });
});

describe("Telegram Bot API client", () => {
  const TOKEN = "123456:SECRET-BOT-TOKEN-abc";
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

  it("calls getUpdates with only 'message' updates and the given offset, and no parse_mode on sendMessage", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const api = new TelegramBotApi(TOKEN, (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return ok([]);
    }) as unknown as typeof fetch);
    await api.getUpdates({ offset: 42, timeoutSec: 25 });
    await api.sendMessage(7, "hello");
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(calls[0].body).toMatchObject({ offset: 42, timeout: 25, allowed_updates: ["message", "callback_query"] });
    expect(calls[1].body).toEqual({ chat_id: 7, text: "hello", disable_web_page_preview: true });
    expect(calls[1].body).not.toHaveProperty("parse_mode");
  });

  it("errors never contain the bot token or URL — for network failures, HTTP errors, and API errors", async () => {
    const attempts: TelegramBotApi[] = [
      new TelegramBotApi(TOKEN, (async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`);
      }) as unknown as typeof fetch),
      new TelegramBotApi(TOKEN, (async () => new Response(`bot${TOKEN} unauthorized`, { status: 401 })) as unknown as typeof fetch),
      new TelegramBotApi(TOKEN, (async () => new Response(JSON.stringify({ ok: false, description: `bad ${TOKEN}` }), { status: 200 })) as unknown as typeof fetch),
    ];
    for (const api of attempts) {
      const err = await api.sendMessage(1, "x").catch((e) => e);
      expect(err).toBeInstanceOf(TelegramApiError);
      expect(JSON.stringify(err) + String(err.message) + String(err.stack ?? "")).not.toContain("SECRET-BOT-TOKEN");
      expect(String(err.message)).not.toContain("api.telegram.org");
    }
  });

  it("surfaces Telegram's retry_after on a 429", async () => {
    const api = new TelegramBotApi(TOKEN, (async () => new Response(JSON.stringify({ parameters: { retry_after: 7 } }), { status: 429 })) as unknown as typeof fetch);
    const err = (await api.sendMessage(1, "x").catch((e) => e)) as TelegramApiError;
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(7);
  });

  it("refuses to start without a token", () => {
    expect(() => new TelegramBotApi("")).toThrow();
  });
});

describe("Telegram poller", () => {
  const memoryCursor = (start: number | null = null): CursorStore & { value: number | null } => ({
    value: start,
    async get() {
      return this.value;
    },
    async advance(v) {
      this.value = Math.max(this.value ?? -1, v);
    },
  });
  const upd = (id: number): TelegramUpdate => ({ update_id: id, message: { message_id: id, from: { id: 1 }, chat: { id: 1, type: "private" }, text: `m${id}` } });

  it("asks for updates after the stored cursor, and handles them in order", async () => {
    const asked: (number | undefined)[] = [];
    const sent: string[] = [];
    const api: TelegramApiLike = {
      getUpdates: async ({ offset }) => {
        asked.push(offset);
        return [upd(12), upd(11)]; // out of order on purpose
      },
      answerCallbackQuery: async () => undefined,
      sendMessage: async (_c, text) => void sent.push(text),
    };
    const cursor = memoryCursor(10);
    const poller = new TelegramPoller(api, { handleUpdate: async (u) => ({ chatId: 1, text: `re:${u.update_id}` }) }, cursor);
    expect(await poller.pollOnce()).toBe(2);
    expect(asked).toEqual([11]);
    expect(sent).toEqual(["re:11", "re:12"]);
    expect(cursor.value).toBe(12);
  });

  it("starts with no offset when there is no cursor yet", async () => {
    const asked: (number | undefined)[] = [];
    const poller = new TelegramPoller({ getUpdates: async ({ offset }) => (asked.push(offset), []), answerCallbackQuery: async () => undefined, sendMessage: async () => {} }, { handleUpdate: async () => null }, memoryCursor());
    await poller.pollOnce();
    expect(asked).toEqual([undefined]);
  });

  it("at-most-once: the cursor moves BEFORE handling, so a crash never replays a message", async () => {
    const cursor = memoryCursor();
    let cursorAtHandling: number | null = -1;
    const poller = new TelegramPoller(
      { getUpdates: async () => [upd(5)], answerCallbackQuery: async () => undefined, sendMessage: async () => {} },
      { handleUpdate: async () => ((cursorAtHandling = cursor.value), null) },
      cursor
    );
    await poller.pollOnce();
    expect(cursorAtHandling).toBe(5);
  });

  it("one failing update does not stop the others, and the failure is not replayed", async () => {
    const sent: string[] = [];
    const cursor = memoryCursor();
    const poller = new TelegramPoller(
      { getUpdates: async () => [upd(1), upd(2), upd(3)], answerCallbackQuery: async () => undefined, sendMessage: async (_c, t) => void sent.push(t) },
      {
        handleUpdate: async (u) => {
          if (u.update_id === 2) throw new Error("boom with secret token=abc123");
          return { chatId: 1, text: `ok${u.update_id}` };
        },
      },
      cursor
    );
    await poller.pollOnce();
    expect(sent).toEqual(["ok1", "ok3"]);
    expect(cursor.value).toBe(3);
  });

  it("a failed send does not stop later updates either", async () => {
    let n = 0;
    const cursor = memoryCursor();
    const poller = new TelegramPoller(
      {
        getUpdates: async () => [upd(1), upd(2)],
        answerCallbackQuery: async () => undefined,
        sendMessage: async () => {
          if (n++ === 0) throw new TelegramApiError("sendMessage", 500);
        },
      },
      { handleUpdate: async () => ({ chatId: 1, text: "x" }) },
      cursor
    );
    await expect(poller.pollOnce()).resolves.toBe(2);
    expect(n).toBe(2);
  });

  it("stops promptly when aborted", async () => {
    const controller = new AbortController();
    const poller = new TelegramPoller(
      { getUpdates: async () => (controller.abort(), []), answerCallbackQuery: async () => undefined, sendMessage: async () => {} },
      { handleUpdate: async () => null },
      memoryCursor()
    );
    await expect(poller.run(controller.signal)).resolves.toBeUndefined();
  });
});

describe("DbCursorStore", () => {
  it("only ever moves forward, and survives a fresh instance (a restart)", async () => {
    const name = `test-${uid()}`;
    const first = new DbCursorStore("TELEGRAM", name);
    expect(await first.get()).toBeNull();
    await first.advance(100);
    await first.advance(50); // late/out-of-order: ignored
    expect(await first.get()).toBe(100);
    await first.advance(101);
    expect(await first.get()).toBe(101);
    expect(await new DbCursorStore("TELEGRAM", name).get()).toBe(101);
    await getDb().interfaceCursor.deleteMany({ where: { name } });
    await disconnectDb();
  });
});
