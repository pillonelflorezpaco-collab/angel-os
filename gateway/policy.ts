import type { ActionCategory } from "@prisma/client";
import { isInterfaceSource, type InterfaceSource } from "../identity/interfaces.js";
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

/**
 * The per-interface policy as an EXHAUSTIVE table keyed by the canonical
 * registry (`INTERFACE_SOURCES`). Adding an interface without declaring its
 * policy here is a compile error, and an interface that is not in the
 * registry gets NO policy at all (see `policyFor`). Do not write
 * "if source !== VOICE && source !== SYSTEM" style logic — it is permissive
 * by default; this table is closed by construction.
 *
 *   strictWrites: non-READ actions always need approval (never DIRECT)
 *   maxApproveRisk: the highest risk this interface may APPROVE (null = none)
 */
export interface InterfacePolicy {
  strictWrites: boolean;
  maxApproveRisk: RiskLevel | null;
}

const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, SENSITIVE: 1, DANGEROUS: 2 };

export const INTERFACE_POLICY: Readonly<Record<InterfaceSource, InterfacePolicy>> = {
  GUIDEHUB: { strictWrites: false, maxApproveRisk: "DANGEROUS" },
  WEB: { strictWrites: false, maxApproveRisk: "DANGEROUS" },
  MOBILE: { strictWrites: false, maxApproveRisk: "DANGEROUS" },
  API: { strictWrites: false, maxApproveRisk: "DANGEROUS" },
  TELEGRAM: { strictWrites: false, maxApproveRisk: "DANGEROUS" },
  VOICE: { strictWrites: true, maxApproveRisk: "LOW" },
  SYSTEM: { strictWrites: true, maxApproveRisk: null }, // background work never approves anything
};

/** The policy for a KNOWN interface, or undefined for anything not in the canonical registry (fail closed). */
function policyFor(source: unknown): InterfacePolicy | undefined {
  return isInterfaceSource(source) ? INTERFACE_POLICY[source] : undefined;
}

export function routeFor(source: InterfaceSource, category: ActionCategory, risk: RiskLevel): Route {
  const policy = policyFor(source);
  if (!policy) return "REFUSE"; // unknown interface: never DIRECT, never APPROVAL either — nothing runs
  if (category === "EXECUTE" && risk === "LOW") risk = "SENSITIVE"; // EXECUTE is never "low"
  if (policy.strictWrites) {
    if (risk === "DANGEROUS") return "REFUSE";
    if (category === "READ") return "DIRECT";
    return "APPROVAL";
  }
  if (category === "READ") return "DIRECT";
  return risk === "LOW" ? "DIRECT" : "APPROVAL";
}

/** May an approval for an action of this risk be approved from this interface? Denying is always allowed. Unknown interface: never. */
export function canApproveFrom(source: InterfaceSource, risk: RiskLevel): boolean {
  const policy = policyFor(source);
  if (!policy || policy.maxApproveRisk === null) return false;
  return RISK_ORDER[risk] <= RISK_ORDER[policy.maxApproveRisk];
}
