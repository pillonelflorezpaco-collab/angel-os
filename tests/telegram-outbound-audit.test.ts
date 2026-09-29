import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { TelegramAdapter, TelegramPoller } from "../interfaces/telegram/index.js";
import type { TelegramApiLike, CursorStore, TelegramUpdate } from "../interfaces/telegram/index.js";
import { getExternalIdentityService } from "../identity/index.js";
import { auditOutboundReply } from "../application/outbound.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

process.env.NODE_ENV = "test";

let nextUpdate = 5_000;
const msg = (fromId: number, text: string, chatType: "private" | "group" = "private"): TelegramUpdate => ({
  update_id: nextUpdate++,
  message: { message_id: 1, from: { id: fromId }, chat: { id: fromId, type: chatType }, text },
});
const memoryCursor = (): CursorStore => { let v: number | null = null; return { get: async () => v, advance: async (n) => { v = Math.max(v ?? n, n); } }; };
const apiWith = (updates: TelegramUpdate[], send: TelegramApiLike["sendMessage"]): TelegramApiLike => ({ getUpdates: async () => updates, answerCallbackQuery: async () => undefined, sendMessage: send });

describe("Telegram: what leaves the system is audited (and never its text)", () => {
  let a: string;
  let b: string;
  let tgA: number;
  let tgB: number;
  let tgStranger: number;
  const SECRET = "tg-outbound-secret-zzqqxx";

  const rows = (principalId: string) => getDb().auditLog.findMany({ where: { principalId, eventType: { in: ["INTERFACE_REPLY_SENT", "INTERFACE_REPLY_FAILED"] } }, orderBy: { createdAt: "asc" } });
  const run = async (updates: TelegramUpdate[], send: TelegramApiLike["sendMessage"] = async () => undefined, audit = auditOutboundReply("telegram")) => {
    const poller = new TelegramPoller(apiWith(updates, send), new TelegramAdapter(), memoryCursor(), 25, audit);
    await poller.pollOnce();
  };

  beforeAll(async () => {
    a = (await createPrincipal("TG audit A")).id;
    b = (await createPrincipal("TG audit B")).id;
    tgA = 100_000_000 + Math.floor(Math.random() * 800_000_000);
    tgB = tgA + 1;
    tgStranger = tgA + 2;
    const ext = getExternalIdentityService();
    await ext.link({ principalId: a, interfaceSource: "TELEGRAM", externalId: String(tgA) });
    await ext.link({ principalId: b, interfaceSource: "TELEGRAM", externalId: String(tgB) });
    for (const p of [a, b]) await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "READ", "READ");
    await getDb().task.create({ data: { principalId: a, title: SECRET } });
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("a sent reply is audited for the right principal with kind, size and a content hash — never the text", async () => {
    const sent: string[] = [];
    await run([msg(tgA, "What are my tasks?")], async (_c, text) => void sent.push(text));
    expect(sent[0]).toContain(SECRET);
    const [row] = (await rows(a)).slice(-1);
    expect(row).toMatchObject({ eventType: "INTERFACE_REPLY_SENT", result: "SUCCESS", action: "REPLY", resource: "interface:telegram", source: "interfaces.telegram", principalId: a });
    expect(row.metadata).toMatchObject({ kind: "message", chars: sent[0].length, buttons: 0 });
    expect((row.metadata as { contentHash: string }).contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(await rows(b)).toHaveLength(0); // nothing for the other principal
  });

  it("identical replies share a hash (correlation without content); different replies do not", async () => {
    const before = (await rows(a)).length;
    await run([msg(tgA, "What are my tasks?"), msg(tgA, "What are my tasks?"), msg(tgA, "/help")]);
    const fresh = (await rows(a)).slice(before);
    expect(fresh).toHaveLength(3);
    const hashes = fresh.map((r) => (r.metadata as { contentHash: string }).contentHash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(fresh.map((r) => (r.metadata as { kind: string }).kind)).toEqual(["message", "message", "help"]);
  });

  it("every reply kind is recorded: help, pending, approval buttons (counted), invalid button", async () => {
    const before = (await rows(a)).length;
    const cb = (data: string): TelegramUpdate => ({ update_id: nextUpdate++, callback_query: { id: "cb", from: { id: tgA }, message: { message_id: 1, chat: { id: tgA, type: "private" } }, data } });
    await run([msg(tgA, "/start"), msg(tgA, "/pending"), cb("nonsense")]);
    const kinds = (await rows(a)).slice(before).map((r) => (r.metadata as { kind: string }).kind);
    expect(kinds).toEqual(["help", "pending", "invalid_button"]);
  });

  it("a failed send is audited as INTERFACE_REPLY_FAILED, and the poll loop carries on to the next update", async () => {
    const before = (await rows(a)).length;
    let n = 0;
    await run([msg(tgA, "/help"), msg(tgA, "What are my tasks?")], async () => { if (n++ === 0) throw new Error("telegram down https://api.telegram.org/bot123:SECRET/sendMessage"); });
    const fresh = (await rows(a)).slice(before);
    expect(fresh.map((r) => [r.eventType, r.result])).toEqual([["INTERFACE_REPLY_FAILED", "FAILURE"], ["INTERFACE_REPLY_SENT", "SUCCESS"]]);
    expect(JSON.stringify(fresh)).not.toContain("SECRET");
  });

  it("a failing audit never blocks, duplicates or hides the reply", async () => {
    const sent: string[] = [];
    const audit = vi.fn(async () => { throw new Error("audit db down"); });
    await run([msg(tgA, "/help")], async (_c, text) => void sent.push(text), audit);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("nothing is sent — and so nothing is audited — for unlinked senders, groups, or ignored updates", async () => {
    const before = await getDb().auditLog.count({ where: { eventType: { in: ["INTERFACE_REPLY_SENT", "INTERFACE_REPLY_FAILED"] } } });
    const sent: string[] = [];
    await run([msg(tgStranger, "What are my tasks?"), msg(tgA, "What are my tasks?", "group"), { update_id: nextUpdate++ }], async (_c, t) => void sent.push(t));
    expect(sent).toEqual([]);
    expect(await getDb().auditLog.count({ where: { eventType: { in: ["INTERFACE_REPLY_SENT", "INTERFACE_REPLY_FAILED"] } } })).toBe(before);
  });

  it("the composition root wires the audit in (a poller started without it would leave replies unaudited)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("../scripts/telegram.ts", import.meta.url), "utf-8")).toMatch(/auditOutboundReply\("telegram"\)/);
  });
});
