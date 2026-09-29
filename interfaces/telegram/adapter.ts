import { randomUUID } from "node:crypto";
import { getExternalIdentityService, createIdentity, type ExternalIdentityService, type IdentityContext } from "../../identity/index.js";
import { handleInterfaceMessage } from "../../application/dispatcher.js";
import { decide, listPending, type DecisionReply, type PendingApprovalSummary } from "../../application/approvals.js";
import type { Result } from "../../core/types/index.js";
import type { OutboundKind, TelegramButton, TelegramCallbackQuery, TelegramReply, TelegramUpdate } from "./types.js";

// Telegram is an ADAPTER, not a second brain. Its whole job:
//
//   Telegram update → resolve the sender to a principal → dispatcher → Result → reply text
//
// No intent parsing, no permission logic, no database or skill access
// lives here. This file must not import from db/, skills/, gateway/,
// memory/, context/ or connectors/ — tests/interfaces-boundary.test.ts
// enforces that.

/** Telegram's hard limit is 4096; leave headroom. */
const MAX_REPLY_CHARS = 3900;

const HELP_TEXT = [
  "I'm Jarvis. Try:",
  "• What do I have today?",
  "• Remind me tomorrow at 10 to call John",
  "• What are my tasks? / What are my reminders?",
  "• Remember that …",
  "• What do I know about …?",
  "• What happened today? / What have I done this week?",
  "• /pending — actions waiting for your approval",
].join("\n");

// Approval buttons carry only the approval id and a verb. What gets executed
// is what the server stored when the action was proposed — a button (or a
// forged callback) can never change it. Who pressed is taken from
// Telegram's `from`, resolved to a principal; the id alone grants nothing.
const CALLBACK_PATTERN = /^apv:([0-9a-f-]{36}):([ad])$/;

function approvalButtons(approvalId: string): TelegramButton[] {
  return [
    { text: "✅ Approve", data: `apv:${approvalId}:a` },
    { text: "❌ Deny", data: `apv:${approvalId}:d` },
  ];
}

export interface TelegramAdapterDeps {
  identities: Pick<ExternalIdentityService, "resolve">;
  dispatch: (identity: IdentityContext, input: string) => Promise<Result>;
  approvals: {
    list: (identity: IdentityContext) => Promise<PendingApprovalSummary[]>;
    decide: (identity: IdentityContext, approvalId: string, decision: "APPROVED" | "DENIED") => Promise<DecisionReply>;
  };
}

export class TelegramAdapter {
  private readonly deps: TelegramAdapterDeps;

  constructor(deps?: Partial<TelegramAdapterDeps>) {
    this.deps = {
      identities: deps?.identities ?? getExternalIdentityService(),
      dispatch: deps?.dispatch ?? handleInterfaceMessage,
      approvals: deps?.approvals ?? { list: listPending, decide },
    };
  }

  /**
   * Turns one update into at most one reply. Returns null — and sends
   * nothing — for anything that should be ignored: non-message updates,
   * non-text messages, bots, group/channel chats (a reply there would be
   * visible to other people), and senders not linked to any principal
   * (no reply, so the bot doesn't reveal that it exists or what it does).
   */
  async handleUpdate(update: TelegramUpdate): Promise<TelegramReply | null> {
    if (update.callback_query) return this.handleCallback(update);
    const message = update.message;
    if (!message?.text || !message.from || message.from.is_bot) return null;
    if (message.chat.type !== "private") return null;

    const identity = await this.identify(update, message.from.id);
    if (!identity) return null;

    const text = message.text.trim();
    if (text === "/start" || text === "/help") return { chatId: message.chat.id, text: HELP_TEXT, audit: auditOf(identity, "help") };
    if (text === "/pending") return this.pendingReply(identity, message.chat.id);

    const result = await this.deps.dispatch(identity, text);
    return {
      chatId: message.chat.id,
      text: truncate(result.message),
      // A proposal that needs approval is shown with the buttons that decide THAT stored approval.
      buttons: result.status === "PENDING_APPROVAL" && result.approvalId ? [approvalButtons(result.approvalId)] : undefined,
      audit: auditOf(identity, "message"),
    };
  }

  private async identify(update: TelegramUpdate, telegramUserId: number): Promise<IdentityContext | null> {
    const resolved = await this.deps.identities.resolve("TELEGRAM", String(telegramUserId));
    if (!resolved) return null;
    return createIdentity({
      principalId: resolved.principalId,
      interfaceSource: "TELEGRAM",
      authMethod: "external_identity",
      requestId: randomUUID(),
      credentialId: resolved.id,
      metadata: { updateId: String(update.update_id) },
    });
  }

  private async pendingReply(identity: IdentityContext, chatId: number): Promise<TelegramReply> {
    const pending = (await this.deps.approvals.list(identity)).slice(0, 5);
    if (pending.length === 0) return { chatId, text: "Nothing is waiting for your approval.", audit: auditOf(identity, "pending") };
    const lines = pending.map((p, i) => `${i + 1}. ${p.summary}`);
    return {
      chatId,
      text: truncate(`Waiting for your approval:\n${lines.join("\n")}`),
      audit: auditOf(identity, "pending"),
      buttons: pending.map((p, i) => [
        { text: `✅ Approve ${i + 1}`, data: `apv:${p.id}:a` },
        { text: `❌ Deny ${i + 1}`, data: `apv:${p.id}:d` },
      ]),
    };
  }

  private async handleCallback(update: TelegramUpdate): Promise<TelegramReply | null> {
    const cb: TelegramCallbackQuery = update.callback_query!;
    if (cb.from.is_bot || !cb.message || cb.message.chat.type !== "private") return null;
    const identity = await this.identify(update, cb.from.id);
    if (!identity) return null; // unlinked account: silent, like messages

    const match = CALLBACK_PATTERN.exec(cb.data ?? "");
    const chatId = cb.message.chat.id;
    if (!match) return { chatId, text: "That button isn't valid.", answerCallbackId: cb.id, audit: auditOf(identity, "invalid_button") };

    const reply = await this.deps.approvals.decide(identity, match[1], match[2] === "a" ? "APPROVED" : "DENIED");
    return { chatId, text: truncate(reply.message), answerCallbackId: cb.id, audit: auditOf(identity, "approval") };
  }
}

const auditOf = (identity: IdentityContext, kind: OutboundKind) => ({ principalId: identity.principalId, requestId: identity.requestId, kind });

function truncate(text: string): string {
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text;
}
