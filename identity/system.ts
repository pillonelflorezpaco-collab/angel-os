import { randomUUID } from "node:crypto";
import { getDb } from "../db/client/index.js";
import { runWithIdentity, currentIdentity } from "./context.js";
import { createIdentity, type IdentityContext } from "./types.js";

// SYSTEM identity: how background work (the reminder worker) acts.
//
// It is not a user and not a credential. It is an in-process IdentityContext
// with interfaceSource "SYSTEM" that is bound to ONE explicit principal —
// the configured Angel principal. There is no way to build one without a
// principal, none from request data, and no token/link can carry the
// SYSTEM interface. Because it is an ordinary IdentityContext in
// AsyncLocalStorage, every existing guard applies unchanged: the gateway
// refuses an action for any other principal, and audit/activity rows are
// stamped interface=SYSTEM with the job's request id.

const PRINCIPAL_ID = /^[A-Za-z0-9-]{8,64}$/;

export function createSystemIdentity(principalId: string, job: string): IdentityContext {
  if (typeof principalId !== "string" || !PRINCIPAL_ID.test(principalId)) {
    throw new Error("A SYSTEM identity requires an explicit principal.");
  }
  if (!job) throw new Error("A SYSTEM identity requires a job name.");
  return createIdentity({
    principalId,
    interfaceSource: "SYSTEM",
    authMethod: "system",
    requestId: randomUUID(),
    metadata: { job },
  });
}

/** Verifies the configured principal exists, then runs `fn` as SYSTEM for it. */
export async function runAsSystem<T>(principalId: string, job: string, fn: (identity: IdentityContext) => Promise<T>): Promise<T> {
  const identity = createSystemIdentity(principalId, job);
  const exists = await getDb().principal.findUnique({ where: { id: principalId }, select: { id: true } });
  if (!exists) throw new Error("The configured SYSTEM principal does not exist.");
  return runWithIdentity(identity, () => fn(identity));
}

/** Background code calls this first: it refuses to run outside a SYSTEM identity. */
export function requireSystemIdentity(): IdentityContext {
  const identity = currentIdentity();
  if (!identity || identity.interfaceSource !== "SYSTEM" || identity.authMethod !== "system") {
    throw new Error("This operation requires a SYSTEM identity.");
  }
  return identity;
}
