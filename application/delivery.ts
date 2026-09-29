import type { InterfaceSource } from "../identity/index.js";

// Outbound delivery: how Angel OS reaches a person on its own initiative
// (a due reminder). The mirror image of the inbound dispatcher.
//
//   engine (SYSTEM) → DeliveryDispatcher → DeliveryPort (one per interface) → transport
//
// A port is an ADAPTER behind an interface. The engine and the skills know
// nothing about Telegram (or any transport). Ports find the destination
// themselves from the principal's LINKED accounts — a request never carries
// a chat id, address or device, so reminder data cannot redirect a message.

export interface DeliveryRequest {
  /** Whose linked account to deliver to. */
  principalId: string;
  /** Plain text, already composed. */
  message: string;
  /** Stable per logical delivery (reminder id). Passed to transports that support idempotency; Telegram does not. */
  idempotencyKey: string;
  /** Ties the delivery to the job/request that caused it (for logs). */
  correlationId: string;
}

/**
 * Normalized outcome. UNCONFIRMED means the message MAY have been sent
 * (timeout, connection reset, 5xx): the caller must not treat it as
 * either delivered or failed, and must not retry it automatically.
 */
export type DeliveryResult =
  | { status: "DELIVERED" }
  | { status: "FAILED"; code: string; retryable: boolean }
  | { status: "UNCONFIRMED"; code: string };

export interface DeliveryPort {
  readonly interfaceSource: InterfaceSource;
  deliver(request: DeliveryRequest): Promise<DeliveryResult>;
}

export interface DeliveryOutcome {
  /** The interface tried last, or null if none is configured. */
  channel: InterfaceSource | null;
  result: DeliveryResult;
}

export interface Deliverer {
  dispatch(request: DeliveryRequest): Promise<DeliveryOutcome>;
}

/** Tries the configured ports in order; moves on only when a port has no destination for this principal. */
export class DeliveryDispatcher implements Deliverer {
  constructor(private readonly ports: readonly DeliveryPort[]) {}

  async dispatch(request: DeliveryRequest): Promise<DeliveryOutcome> {
    let last: DeliveryOutcome = { channel: null, result: { status: "FAILED", code: "NO_CHANNEL", retryable: false } };
    for (const port of this.ports) {
      let result: DeliveryResult;
      try {
        result = await port.deliver(request);
      } catch {
        // A port must not throw; if one does we cannot know what happened.
        result = { status: "UNCONFIRMED", code: "PORT_ERROR" };
      }
      last = { channel: port.interfaceSource, result };
      if (result.status === "FAILED" && result.code === "NO_DESTINATION") continue;
      return last;
    }
    return last;
  }
}
