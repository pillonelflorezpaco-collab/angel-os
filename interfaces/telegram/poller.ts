import { logInternalError } from "../../core/errors.js";
import type { TelegramApiLike } from "./api.js";
import { TelegramApiError } from "./api.js";
import type { TelegramUpdate, TelegramReply } from "./types.js";

/** Where polling left off, so a restart never replays old messages. */
export interface CursorStore {
  get(): Promise<number | null>;
  /** Moves the cursor forward; must never move it backward. */
  advance(updateId: number): Promise<void>;
}

export interface UpdateHandler {
  handleUpdate(update: TelegramUpdate): Promise<TelegramReply | null>;
}

export class TelegramPoller {
  constructor(
    private readonly api: TelegramApiLike,
    private readonly handler: UpdateHandler,
    private readonly cursor: CursorStore,
    private readonly longPollSec = 25
  ) {}

  /** Fetches and handles one batch of updates. Returns how many were fetched. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const last = await this.cursor.get();
    const updates = await this.api.getUpdates({
      offset: last === null ? undefined : last + 1,
      timeoutSec: this.longPollSec,
      signal,
    });
    updates.sort((a, b) => a.update_id - b.update_id);

    for (const update of updates) {
      // At-most-once: the cursor moves BEFORE the update is handled. If the
      // process dies mid-handling, that message is dropped rather than
      // replayed — for a channel that can create tasks and memories, a
      // missed message (the user just resends) is safer than a duplicate.
      await this.cursor.advance(update.update_id);
      try {
        const reply = await this.handler.handleUpdate(update);
        if (reply?.answerCallbackId) await this.api.answerCallbackQuery(reply.answerCallbackId);
        if (reply) await this.api.sendMessage(reply.chatId, reply.text, reply.buttons);
      } catch (err) {
        // One bad update must not stop the loop. Never log the message text.
        logInternalError("telegram.update", err);
      }
    }
    return updates.length;
  }

  /** Polls until aborted, backing off on errors (and honouring Telegram's retry_after). */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        failures += 1;
        logInternalError("telegram.poll", err);
        const retryAfter = err instanceof TelegramApiError ? err.retryAfterSec : undefined;
        await sleep(Math.max((retryAfter ?? 0) * 1000, Math.min(30_000, 1000 * 2 ** failures)), signal);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
