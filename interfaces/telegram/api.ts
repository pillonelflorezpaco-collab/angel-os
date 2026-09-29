import type { TelegramButton, TelegramUpdate } from "./types.js";

// Minimal Telegram Bot API client: getUpdates + sendMessage, over plain
// fetch (injectable for tests). The bot token appears in the request URL
// path — so errors are rebuilt from safe fields (method, HTTP status) and
// never include the URL, the token, or the response body.

export class TelegramApiError extends Error {
  constructor(readonly method: string, readonly status?: number, readonly retryAfterSec?: number) {
    super(`Telegram API call "${method}" failed${status ? ` (HTTP ${status})` : ""}.`);
    this.name = "TelegramApiError";
  }
}

export interface TelegramApiLike {
  getUpdates(params: { offset?: number; timeoutSec: number; signal?: AbortSignal }): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, buttons?: TelegramButton[][]): Promise<void>;
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
}

export class TelegramBotApi implements TelegramApiLike {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = "https://api.telegram.org",
    /** Applies to calls without a caller-supplied signal (sends): a hung request must not hang the worker. */
    private readonly timeoutMs = 15_000
  ) {
    if (!token) throw new Error("A Telegram bot token is required.");
  }

  async getUpdates(params: { offset?: number; timeoutSec: number; signal?: AbortSignal }): Promise<TelegramUpdate[]> {
    // Only messages and approval-button presses are ever needed; asking for
    // nothing else keeps edited messages and channel posts out entirely.
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset: params.offset, timeout: params.timeoutSec, allowed_updates: ["message", "callback_query"] },
      params.signal
    );
  }

  async sendMessage(chatId: number, text: string, buttons?: TelegramButton[][]): Promise<void> {
    // No parse_mode on purpose: replies contain user-supplied text, and
    // plain text cannot be turned into formatting or links by it.
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(buttons?.length
        ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } }
        : {}),
    });
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TelegramApiError(method); // network failure: the underlying error can embed the URL
    }
    if (!res.ok) {
      let retryAfter: number | undefined;
      if (res.status === 429) {
        try {
          retryAfter = ((await res.json()) as { parameters?: { retry_after?: number } }).parameters?.retry_after;
        } catch {
          /* ignore */
        }
      }
      throw new TelegramApiError(method, res.status, retryAfter);
    }
    const payload = (await res.json()) as { ok: boolean; result: T };
    if (!payload.ok) throw new TelegramApiError(method, res.status);
    return payload.result;
  }
}
