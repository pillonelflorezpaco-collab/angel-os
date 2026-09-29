import type { DeliveryPort, DeliveryRequest, DeliveryResult } from "../../application/delivery.js";
import type { ExternalIdentityService } from "../../identity/index.js";
import { TelegramApiError } from "./api.js";

// Telegram as a DeliveryPort. The ONLY place a proactive message is sent.
// Destination = the principal's own linked Telegram account (a private chat
// id equals the Telegram user id). Nothing in the request can choose it.
// This file must not import db/, skills/, gateway/ — the boundary tests
// enforce that for everything under interfaces/.

const TELEGRAM_ID = /^[1-9]\d{0,14}$/;

export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<void>;
}

export class TelegramDeliveryPort implements DeliveryPort {
  readonly interfaceSource = "TELEGRAM" as const;

  constructor(
    private readonly api: TelegramSender,
    private readonly identities: Pick<ExternalIdentityService, "listActiveExternalIds">
  ) {}

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const linked = await this.identities.listActiveExternalIds(request.principalId, "TELEGRAM");
    if (linked.length === 0) return { status: "FAILED", code: "NO_DESTINATION", retryable: false };
    const externalId = linked[0]; // the principal's oldest active link
    if (!TELEGRAM_ID.test(externalId)) return { status: "FAILED", code: "INVALID_DESTINATION", retryable: false };

    try {
      await this.api.sendMessage(Number(externalId), request.message);
      return { status: "DELIVERED" };
    } catch (err) {
      if (err instanceof TelegramApiError && err.status !== undefined) {
        if (err.status === 429) return { status: "FAILED", code: "RATE_LIMITED", retryable: true };
        if (err.status >= 400 && err.status < 500) return { status: "FAILED", code: "TELEGRAM_REJECTED", retryable: false };
      }
      // No HTTP status (timeout / connection lost) or a 5xx: the request may
      // have reached Telegram. Honest answer: we don't know.
      return { status: "UNCONFIRMED", code: "TELEGRAM_UNCONFIRMED" };
    }
  }
}
