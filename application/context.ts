import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { formatContext } from "../context/format.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import type { ContextPackage } from "../core/types/index.js";
import type { IdentityContext } from "../identity/index.js";

// The application-layer door to context for interfaces (the API): an
// authenticated IdentityContext in, a permission-aware ContextPackage out.
// Interfaces never construct the engine or choose the agent themselves.

/** Upper bound on a context query, like every other user text. */
export const MAX_CONTEXT_QUERY_CHARS = 500;

const engine = new DeterministicContextEngine();

export async function getContext(identity: IdentityContext, query: string, asOf?: Date): Promise<ContextPackage> {
  return engine.buildContext({ identity, agentKey: JARVIS_AGENT_KEY, query: query.slice(0, MAX_CONTEXT_QUERY_CHARS), asOf });
}

export { formatContext };
