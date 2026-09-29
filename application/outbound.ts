import { createHash } from "node:crypto";
import { recordAuditEvent } from "../gateway/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";

// What leaves the system through an interface is audited: WHO it was for, WHICH kind of reply, WHEN, and
// whether it went out — never the text (replies can contain tasks, memories and other private content).
// A short content hash lets two audit rows for the same reply be correlated without storing it.

export interface OutboundEvent {
  principalId: string;
  requestId: string;
  kind: string;
  text: string;
  buttons: number;
  ok: boolean;
}

export function auditOutboundReply(interfaceName: string) {
  return async (e: OutboundEvent): Promise<void> => {
    await recordAuditEvent({
      principalId: e.principalId,
      agentKey: JARVIS_AGENT_KEY,
      eventType: e.ok ? "INTERFACE_REPLY_SENT" : "INTERFACE_REPLY_FAILED",
      resource: `interface:${interfaceName}`,
      action: "REPLY",
      result: e.ok ? "SUCCESS" : "FAILURE",
      source: `interfaces.${interfaceName}`,
      metadata: { kind: e.kind, requestId: e.requestId, chars: e.text.length, buttons: e.buttons, contentHash: createHash("sha256").update(e.text).digest("hex").slice(0, 16) },
    });
  };
}
