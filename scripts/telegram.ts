// Runnable entry point for the Telegram interface (composition root):
//   TELEGRAM_BOT_TOKEN=... npm run telegram
// Wires the bot token (from the environment, never logged), the
// database-backed cursor, the adapter, and the poller. Not exercised
// against the real Telegram API in this repo's tests — see docs.
import { TelegramAdapter, TelegramBotApi, TelegramPoller } from "../interfaces/telegram/index.js";
import { auditOutboundReply } from "../application/outbound.js";
import { DbCursorStore } from "../db/cursors.js";
import { registerSkillActions, verifyProductionActions } from "../skills/manifest.js";
import { disconnectDb } from "../db/client/index.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put its token in .env.");
  process.exit(1);
}

registerSkillActions(); // approvals decided from Telegram buttons execute registered definitions

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

const poller = new TelegramPoller(new TelegramBotApi(token), new TelegramAdapter(), new DbCursorStore("TELEGRAM", "updates"), 25, auditOutboundReply("telegram"));
console.log("Telegram interface started (long polling). Only linked private chats are answered.");
verifyProductionActions().then(
  () => poller.run(controller.signal).finally(() => disconnectDb()),
  (err) => {
    console.error(err instanceof Error ? err.message : "Action registry check failed.");
    process.exit(1);
  }
);
