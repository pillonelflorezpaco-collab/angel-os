import type { ContextPackage } from "../../core/types/index.js";

import type { IdentityContext } from "../../identity/index.js";

export interface ContextRequest {
  /** Authoritative caller identity. Required: there is no context without a caller. The principal is derived from it. */
  identity: IdentityContext;
  /** The agent the context is assembled for — permissions are checked against it, exactly as for a direct request. */
  agentKey: string;
  query: string;
  /** Evaluate memory validity (world time) at this instant. Default: now. */
  asOf?: Date;
}

export interface ContextEngine {
  /** Assembles a small, relevant context package instead of loading everything. */
  buildContext(request: ContextRequest): Promise<ContextPackage>;
}
