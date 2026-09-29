import type { ContextPackage } from "../../core/types/index.js";

export interface ContextRequest {
  principalId: string;
  /** The agent the context is assembled for — permissions are checked against it, exactly as for a direct request. */
  agentKey: string;
  query: string;
}

export interface ContextEngine {
  /** Assembles a small, relevant context package instead of loading everything. */
  buildContext(request: ContextRequest): Promise<ContextPackage>;
}
