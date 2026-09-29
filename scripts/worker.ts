// Reminder worker: a separate process from the HTTP API (composition root).
//
//   ANGEL_OS_SYSTEM_PRINCIPAL_ID=<uuid> TELEGRAM_BOT_TOKEN=... npm run worker
//
// It acts as a SYSTEM identity bound to exactly that principal, polls for due
// reminders, and delivers them through the DeliveryDispatcher (Telegram is
// the only port today). SIGINT/SIGTERM finish the in-flight reminder, then exit.
import { ReminderEngine } from "../reminders/index.js";
import { DeliveryDispatcher } from "../application/delivery.js";
import { TelegramBotApi, TelegramDeliveryPort } from "../interfaces/telegram/index.js";
import { getExternalIdentityService } from "../identity/index.js";
import { registerSkillActions, verifyProductionActions } from "../skills/manifest.js";
import { disconnectDb } from "../db/client/index.js";

const principalId = process.env.ANGEL_OS_SYSTEM_PRINCIPAL_ID;
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!principalId) {
  console.error("ANGEL_OS_SYSTEM_PRINCIPAL_ID is not set: the worker only ever acts for one explicit principal.");
  process.exit(1);
}
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set: no delivery channel is configured.");
  process.exit(1);
}

registerSkillActions();
const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

const engine = new ReminderEngine({
  principalId,
  deliverer: new DeliveryDispatcher([new TelegramDeliveryPort(new TelegramBotApi(token), getExternalIdentityService())]),
});
const intervalMs = Number(process.env.ANGEL_OS_WORKER_INTERVAL_MS ?? 15_000);
console.log("Reminder worker started.");
verifyProductionActions().then(
  () => engine.run(controller.signal, intervalMs).finally(() => disconnectDb()),
  (err) => {
    console.error(err instanceof Error ? err.message : "Action registry check failed.");
    process.exit(1);
  }
);
