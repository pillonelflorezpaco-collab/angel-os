// Runnable entry point for the Telegram interface (composition root):
//   TELEGRAM_BOT_TOKEN=... npm run telegram
// Wires the bot token (from the environment, never logged), the
// database-backed cursor, the adapter, and the poller. Not exercised
// against the real Telegram API in this repo's tests — see docs.
import { TelegramAdapter, TelegramBotApi, TelegramPoller } from "../interfaces/telegram/index.js";
import { DbCursorStore } from "../db/cursors.js";
import { registerSkillActions } from "../skills/manifest.js";
import { disconnectDb } from "../db/client/index.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put its token in .env.");
  process.exit(1);
}

registerSkillActions(); // approvals decided from Telegram buttons execute registered definitions

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

const poller = new TelegramPoller(new TelegramBotApi(token), new TelegramAdapter(), new DbCursorStore("TELEGRAM", "updates"));
console.log("Telegram interface started (long polling). Only linked private chats are answered.");
poller.run(controller.signal).finally(() => disconnectDb());
