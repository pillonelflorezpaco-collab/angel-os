import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { TelegramAdapter, TelegramPoller } from "../interfaces/telegram/index.js";
import type { TelegramApiLike, TelegramUpdate, TelegramButton } from "../interfaces/telegram/index.js";
import { getExternalIdentityService, type IdentityContext } from "../identity/index.js";
import { proposeAction, listAuditLog } from "../gateway/index.js";
import { DEFAULT_APPROVAL_TTL_MS } from "../gateway/approvals/service.js";
import { setClock } from "../gateway/clock.js";
import { handleVoiceInput } from "../interfaces/voice/index.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";
import { ACTIONS, FAKE_SKILL, calls, resetCalls, registerFakeActions, ensureExecRegistry, grantAllFake, identityFor, goodParams } from "./helpers/fakeActions.js";

const T0 = new Date("2032-03-03T10:00:00.000Z");
let upd = 5_000_000;
const message = (fromId: number, text: string): TelegramUpdate => ({ update_id: upd++, message: { message_id: 1, from: { id: fromId }, chat: { id: fromId, type: "private" }, text } });
const press = (fromId: number, data: string, chatType: "private" | "group" = "private"): TelegramUpdate => ({
  update_id: upd++,
  callback_query: { id: `cb-${upd}`, from: { id: fromId }, message: { message_id: 9, chat: { id: fromId, type: chatType } }, data },
});

describe("Telegram approvals", () => {
  const external = getExternalIdentityService();
  let a: string;
  let b: string;
  let tgA: number;
  let tgB: number;
  let n = 0;
  let adapter: TelegramAdapter;

  // Stands in for Jarvis proposing an approval-gated action (no real skill does yet).
  const proposeViaDispatch = (identity: IdentityContext) =>
    proposeAction(identity, { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { ...goodParams, body: `tg-${++n}-${Math.random()}` } });

  beforeAll(async () => {
    registerFakeActions();
    await ensureExecRegistry();
    a = (await createPrincipal("TG Approval A")).id;
    b = (await createPrincipal("TG Approval B")).id;
    await grantAllFake(a);
    await grantAllFake(b);
    tgA = 300_000_000 + Math.floor(Math.random() * 500_000_000);
    tgB = tgA + 1;
    await external.link({ principalId: a, interfaceSource: "TELEGRAM", externalId: String(tgA) });
    await external.link({ principalId: b, interfaceSource: "TELEGRAM", externalId: String(tgB) });
    adapter = new TelegramAdapter({ dispatch: async (identity) => proposeViaDispatch(identity) });
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => { resetCalls(); setClock(() => T0); });
  afterEach(() => setClock(null));

  const buttonsOf = (reply: { buttons?: TelegramButton[][] } | null) => (reply?.buttons ?? []).flat();

  it("a proposal that needs approval is presented with Approve/Deny buttons for THAT approval, and nothing has run", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    expect(reply?.text).toMatch(/^Approval needed: Send test message to alice@example.com/);
    expect(reply?.text).toContain("Nothing has been done yet");
    const [approve, deny] = buttonsOf(reply);
    expect(approve.text).toMatch(/Approve/);
    expect(deny.text).toMatch(/Deny/);
    const id = (await getDb().approvalRequest.findFirstOrThrow({ where: { principalId: a }, orderBy: { requestedAt: "desc" } })).id;
    expect(approve.data).toBe(`apv:${id}:a`);
    expect(approve.data.length).toBeLessThanOrEqual(64);
    expect(calls).toHaveLength(0);
  });

  it("pressing Approve executes the stored action once and answers the callback", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    const approve = buttonsOf(reply)[0];
    const result = await adapter.handleUpdate(press(tgA, approve.data));
    expect(result?.text).toBe("Approved and executed. Test message sent.");
    expect(result?.answerCallbackId).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.interfaceSource).toBe("TELEGRAM");
  });

  it("pressing Deny runs nothing", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    const result = await adapter.handleUpdate(press(tgA, buttonsOf(reply)[1].data));
    expect(result?.text).toBe("Denied. Nothing was executed.");
    expect(calls).toHaveLength(0);
  });

  it("a duplicate press (Telegram retry / double tap) never executes twice", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    const data = buttonsOf(reply)[0].data;
    const [r1, r2] = await Promise.all([adapter.handleUpdate(press(tgA, data)), adapter.handleUpdate(press(tgA, data))]);
    // Racing presses: one wins; the loser sees either "already decided" (winner still executing) or "already consumed".
    const texts = [r1?.text, r2?.text];
    expect(texts.filter((t) => t === "Approved and executed. Test message sent.")).toHaveLength(1);
    expect(texts.filter((t) => t === "Approval already decided." || t === "Approval already consumed.")).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect((await adapter.handleUpdate(press(tgA, data)))?.text).toBe("Approval already consumed.");
    expect(calls).toHaveLength(1);
  });

  it("an expired approval cannot be approved from a button", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    setClock(() => new Date(T0.getTime() + DEFAULT_APPROVAL_TTL_MS + 1));
    const result = await adapter.handleUpdate(press(tgA, buttonsOf(reply)[0].data));
    expect(result?.text).toBe("Approval expired.");
    expect(calls).toHaveLength(0);
  });

  it("another linked user pressing someone else's button gets 'not found' and changes nothing", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    const data = buttonsOf(reply)[0].data;
    const result = await adapter.handleUpdate(press(tgB, data));
    expect(result?.text).toBe("Approval not found.");
    expect(calls).toHaveLength(0);
    const id = data.split(":")[1];
    expect((await getDb().approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
  });

  it("an unlinked Telegram account, a group chat, or a bot pressing a button gets no reply and changes nothing", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    const data = buttonsOf(reply)[0].data;
    expect(await adapter.handleUpdate(press(tgA + 9999, data))).toBeNull();
    expect(await adapter.handleUpdate(press(tgA, data, "group"))).toBeNull();
    const bot: TelegramUpdate = { update_id: upd++, callback_query: { id: "x", from: { id: tgA, is_bot: true }, message: { message_id: 1, chat: { id: tgA, type: "private" } }, data } };
    expect(await adapter.handleUpdate(bot)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("malformed or hostile callback data is rejected and never reaches the approval service", async () => {
    for (const bad of ["", "apv:", "apv:not-a-uuid:a", "apv:00000000-0000-0000-0000-000000000000:x", "other:1", `apv:${"0".repeat(36)}:a; DROP`]) {
      const r = await adapter.handleUpdate(press(tgA, bad));
      expect(r?.text, bad).toBe("That button isn't valid.");
    }
    expect(calls).toHaveLength(0);
  });

  it("the callback data carries no parameters: only an id and a verb", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    for (const b of buttonsOf(reply)) expect(b.data).toMatch(/^apv:[0-9a-f-]{36}:[ad]$/);
  });

  it("/pending lists only the caller's pending approvals with per-item buttons", async () => {
    const a1 = await adapter.handleUpdate(message(tgA, "send it"));
    const mineId = buttonsOf(a1)[0].data.split(":")[1];
    await adapter.handleUpdate(message(tgB, "send it")); // B's own
    const pending = await adapter.handleUpdate(message(tgA, "/pending"));
    expect(pending?.text).toMatch(/^Waiting for your approval:/);
    const ids = buttonsOf(pending).map((x) => x.data.split(":")[1]);
    expect(ids).toContain(mineId);
    const bIds = (await getDb().approvalRequest.findMany({ where: { principalId: b }, select: { id: true } })).map((r) => r.id);
    expect(ids.some((id) => bIds.includes(id))).toBe(false);
    const empty = await adapter.handleUpdate(message(tgB + 1000, "/pending"));
    expect(empty).toBeNull(); // unlinked
  });

  it("the Telegram execution is audited with interface TELEGRAM and the request id", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    const data = buttonsOf(reply)[0].data;
    await adapter.handleUpdate(press(tgA, data));
    const id = data.split(":")[1];
    const events = (await listAuditLog(a, 500)).filter((e) => (e.metadata as { approvalId?: string }).approvalId === id);
    expect(events.find((e) => e.eventType === "APPROVAL_APPROVED")?.interfaceSource).toBe("TELEGRAM");
    expect(events.find((e) => e.eventType === "ACTION_EXECUTION_SUCCEEDED")?.requestId).toBeTruthy();
  });

  it("the poller answers the callback query, then sends the result — and a retried update cannot double-execute", async () => {
    const reply = await adapter.handleUpdate(message(tgA, "send it"));
    const data = buttonsOf(reply)[0].data;
    const answered: string[] = [];
    const sent: string[] = [];
    const api: TelegramApiLike = {
      getUpdates: async () => [press(tgA, data), press(tgA, data)],
      sendMessage: async (_c, t) => { sent.push(t); },
      answerCallbackQuery: async (id) => { answered.push(id); },
    };
    let cursor = 0;
    const poller = new TelegramPoller(api, adapter, { get: async () => cursor || null, advance: async (u) => { cursor = Math.max(cursor, u); } });
    await poller.pollOnce();
    expect(answered).toHaveLength(2);
    expect(sent).toEqual(["Approved and executed. Test message sent.", "Approval already consumed."]);
    expect(calls).toHaveLength(1);
  });

  it("voice: an approval-needed result is spoken as 'not done yet — approve elsewhere', never as confirmed", async () => {
    const out = await handleVoiceInput(
      identityFor(a, "VOICE"),
      { transcript: "send the thing", session: { id: "s1", deviceId: "d1", startedAt: new Date() }, confidence: 0.99 },
      { dispatch: async (identity) => proposeAction(identity, { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { ...goodParams, body: `voice-${Math.random()}` } }) }
    );
    expect(out.speech).toMatch(/needs your approval/);
    expect(out.speech).toMatch(/haven't done anything yet/);
    expect(calls).toHaveLength(0);
  });
});
