// The interface registry: every way a request can reach Angel OS. An
// interface is only an adapter — it translates its transport into a
// request for the SAME backend. Nothing here (or anywhere) branches
// business logic per interface; the value is used to record where an
// action came from (audit, activity) and to fix a credential to the
// interface it was issued for.

export const INTERFACE_SOURCES = ["GUIDEHUB", "TELEGRAM", "VOICE", "MOBILE", "WEB", "API", "SYSTEM"] as const;

export type InterfaceSource = (typeof INTERFACE_SOURCES)[number];

export function isInterfaceSource(value: unknown): value is InterfaceSource {
  return typeof value === "string" && (INTERFACE_SOURCES as readonly string[]).includes(value);
}

export function assertInterfaceSource(value: unknown): InterfaceSource {
  if (!isInterfaceSource(value)) {
    throw new Error(`Unknown interface "${String(value)}". Expected one of: ${INTERFACE_SOURCES.join(", ")}.`);
  }
  return value;
}

/**
 * Interfaces a human can reach Angel OS through. SYSTEM (background work)
 * is deliberately NOT one of them: no API token and no external-account
 * link can ever be issued for it, so it can only be created in-process by
 * `createSystemIdentity` (identity/system.ts).
 */
export const USER_INTERFACE_SOURCES = INTERFACE_SOURCES.filter((s) => s !== "SYSTEM") as readonly Exclude<InterfaceSource, "SYSTEM">[];

export function assertUserInterface(value: unknown): Exclude<InterfaceSource, "SYSTEM"> {
  const source = assertInterfaceSource(value);
  if (source === "SYSTEM") throw new Error("SYSTEM is not a user interface: no credential can be issued for it.");
  return source;
}
