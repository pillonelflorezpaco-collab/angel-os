import { AsyncLocalStorage } from "node:async_hooks";
import type { IdentityContext } from "./types.js";

// Carries the authenticated identity through one request so the audit log
// and activity stream can record WHERE an action came from without every
// skill having to thread it through its arguments.
//
// This is deliberately NOT how principalId reaches skills: skills still
// receive principalId explicitly. The store is only consulted to (a)
// stamp interface/requestId on audit and activity rows, and (b) let the
// gateway refuse any action whose principalId differs from the
// authenticated identity — defence in depth against a route or adapter
// that passes the wrong principal.

const store = new AsyncLocalStorage<IdentityContext>();

export function runWithIdentity<T>(identity: IdentityContext, fn: () => T): T {
  return store.run(identity, fn);
}

export function currentIdentity(): IdentityContext | undefined {
  return store.getStore();
}
