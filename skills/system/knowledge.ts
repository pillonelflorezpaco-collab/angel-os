import { gatewayExecute } from "../../gateway/index.js";
import { MarkdownKnowledgeProvider } from "../../knowledge/markdown/index.js";
import type { KnowledgeProvider, KnowledgeDocumentContent, KnowledgeDocumentSummary, KnowledgeSearchResult } from "../../knowledge/types/index.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";

// The ONLY way Knowledge is read:
//
//   caller (with an explicit IdentityContext)
//     → this skill → gatewayExecute (READ permission for the agent, audited)
//     → KnowledgeProvider
//
// The provider does no authorization — it just reads. Every access is
// permission-checked and audited here, so a future Context/Jarvis module
// can never read Markdown around the gateway. NOTE: the documents
// themselves are still global files (single-owner deployment); the
// permission gate is per principal, the content is not. See
// docs/architecture/consolidation-build8.md.

export const SKILL_KEY = "system.knowledge";
export const RESOURCE = "angel:knowledge";
export const ACTION = "KNOWLEDGE_READ";

let provider: KnowledgeProvider = new MarkdownKnowledgeProvider();

/** Test seam: substitute the provider (e.g. to prove it is never reached when access is denied). */
export function setKnowledgeProvider(next: KnowledgeProvider | null): void {
  provider = next ?? new MarkdownKnowledgeProvider();
}

export interface KnowledgeReadInput {
  /** The agent the read is permission-checked for. */
  agentKey: string;
}

const IDENTITY_REQUIRED: Result = { status: "FAILED", message: "I can't do that without knowing who you are." };

function read<T>(identity: IdentityContext, agentKey: string, parameters: Record<string, unknown>, fn: () => Promise<T>): Promise<Result> {
  let explicit: IdentityContext;
  try {
    explicit = assertExplicitIdentity(identity);
  } catch {
    return Promise.resolve(IDENTITY_REQUIRED);
  }
  return gatewayExecute(
    { principalId: explicit.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: ACTION, parameters },
    fn,
    "skill.system.knowledge"
  );
}

export const searchKnowledge = (identity: IdentityContext, input: KnowledgeReadInput & { query: string; limit?: number }) =>
  read<KnowledgeSearchResult[]>(identity, input.agentKey, { op: "search", query: input.query, limit: input.limit ?? null }, () => provider.search(input.query, input.limit));

export const listKnowledge = (identity: IdentityContext, input: KnowledgeReadInput) =>
  read<KnowledgeDocumentSummary[]>(identity, input.agentKey, { op: "list" }, () => provider.listDocuments());

export const readKnowledge = (identity: IdentityContext, input: KnowledgeReadInput & { slug: string }) =>
  read<KnowledgeDocumentContent | null>(identity, input.agentKey, { op: "read", slug: input.slug }, () => provider.readDocument(input.slug));
