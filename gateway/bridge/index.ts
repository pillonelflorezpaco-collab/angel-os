// Architectural placeholder only. Angel OS does NOT connect to BlackOS /
// Black Circle / jarvis-1.0 today, and this file implements nothing.
//
// When a controlled bridge is eventually built, it must:
//   - go through this same Permission & Action Gateway (gateway/index.ts),
//     never bypass it
//   - use an explicit allowlist of resources/actions, never shared tables
//   - never let BlackOS read or write Angel OS's Postgres schema directly,
//     and vice versa
//
// See docs/ARCHITECTURE.md "Bridge to Business Jarvis / BlackOS" and
// docs/SECURITY.md for the constraints this must respect.

export interface BridgeConnector {
  readonly systemName: string;
  isEnabled(): boolean;
}

/** Not implemented in v0.1. Exists only so the module boundary is real. */
export class DisabledBridgeConnector implements BridgeConnector {
  readonly systemName = "blackos";
  isEnabled(): boolean {
    return false;
  }
}
