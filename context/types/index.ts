import type { ContextPackage } from "../../core/types/index.js";

export interface ContextRequest {
  principalId: string;
  query: string;
}

export interface ContextEngine {
  /** Assembles a small, relevant context package instead of loading everything. */
  buildContext(request: ContextRequest): Promise<ContextPackage>;
}
