// The subset of the Telegram Bot API update shape the adapter reads.
// Anything not listed here is ignored on purpose.

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  /** The message the pressed button was attached to; its chat is where the reply goes. */
  message?: { message_id: number; chat: { id: number; type: "private" | "group" | "supergroup" | "channel" } };
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramButton {
  text: string;
  /** Opaque callback payload (Telegram limit: 64 bytes). */
  data: string;
}

export interface TelegramReply {
  chatId: number;
  text: string;
  /** Inline keyboard rows. */
  buttons?: TelegramButton[][];
  /** Set when replying to a button press: the query must be answered so the client stops its spinner. */
  answerCallbackId?: string;
}
