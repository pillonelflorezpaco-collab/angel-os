import type { ActionCategory } from "@prisma/client";
import type { InterfaceSource } from "../identity/interfaces.js";
import type { RiskLevel } from "./actions/types.js";

// Interface-specific approval policy. It can only TIGHTEN what the
// permission table says — a permission row of APPROVAL_REQUIRED always means
// approval, whatever this returns; a DENIED row is never overridden.
//
//                     READ     LOW (write)   SENSITIVE   DANGEROUS
//   GUIDEHUB/WEB/...  direct   direct        approval    approval
//   API               direct   direct        approval    approval
//   TELEGRAM          direct   direct        approval    approval
//   VOICE             direct   approval      approval    refused (no voice path)
//
// Voice is stricter because a transcript can be wrong and a voice cannot be
// authenticated per-utterance: it may not APPROVE sensitive actions either —
// those need a screen (GuideHub / Telegram) where the exact action is shown.

export type Route = "DIRECT" | "APPROVAL" | "REFUSE";

export function routeFor(source: InterfaceSource, category: ActionCategory, risk: RiskLevel): Route {
  if (category === "EXECUTE" && risk === "LOW") risk = "SENSITIVE"; // EXECUTE is never "low"
  if (source === "VOICE" || source === "SYSTEM") {
    if (risk === "DANGEROUS") return "REFUSE";
    if (category === "READ") return "DIRECT";
    return "APPROVAL";
  }
  if (category === "READ") return "DIRECT";
  return risk === "LOW" ? "DIRECT" : "APPROVAL";
}

/** May an approval for an action of this risk be approved from this interface? Denying is always allowed. */
export function canApproveFrom(source: InterfaceSource, risk: RiskLevel): boolean {
  if (source === "SYSTEM") return false; // background work never approves anything
  if (source === "VOICE") return risk === "LOW";
  return true;
}
