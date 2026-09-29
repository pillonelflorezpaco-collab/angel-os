import { listTasks } from "../../skills/system/tasks.js";
import { search as searchMemory } from "../../skills/system/memory.js";
import { searchKnowledge, searchKnowledgeItems } from "../../skills/system/knowledge.js";
import type { KnowledgeHit } from "../../knowledge/store/index.js";
import { assertExplicitIdentity, runWithIdentity } from "../../identity/index.js";
import type { ContextRequest, ContextEngine } from "../types/index.js";
import type { ContextPackage } from "../../core/types/index.js";
import type { KnowledgeSearchResult } from "../../knowledge/types/index.js";
import type { MemoryRecord } from "../../memory/types/index.js";

/**
 * Deterministic retrieval: open tasks + a few memory hits + a few
 * knowledge hits, scoped to the query and principal.
 *
 * Protected data (tasks, memories) is read ONLY through the same skills
 * any other request uses, so every read goes through gatewayExecute:
 * permission-checked for the requesting agent (missing permission =
 * DENIED), and audited as ACTION_EXECUTED / ACTION_DENIED. Being an
 * internal service grants no extra access. A denied section is left empty
 * and named in `withheld` — its data is never fetched, so it cannot leak.
 * Audit entries record the resource and action only, never memory content.
 *
 * Knowledge is read through the knowledge SKILL (READ permission, audited),
 * never from the Markdown provider directly. The caller's IdentityContext is
 * REQUIRED (no identity → no context, fail closed) and the principal is
 * derived from it; this module never touches the database or a provider.
 */
export class DeterministicContextEngine implements ContextEngine {
  async buildContext(request: ContextRequest): Promise<ContextPackage> {
    const identity = assertExplicitIdentity(request?.identity); // throws IdentityRequiredError
    return runWithIdentity(identity, () => this.build(identity.principalId, request));
  }

  private async build(principalId: string, request: ContextRequest): Promise<ContextPackage> {
    const [tasksResult, memoryResult, knowledgeResult, itemsResult] = await Promise.all([
      listTasks({ principalId, agentKey: request.agentKey }),
      searchMemory({ principalId, agentKey: request.agentKey, query: { query: request.query, limit: 5 } }),
      searchKnowledge(request.identity, { agentKey: request.agentKey, query: request.query, limit: 3 }),
      searchKnowledgeItems(request.identity, { agentKey: request.agentKey, query: request.query, limit: 5 }),
    ]);

    const withheld: string[] = [];

    let currentTasks: ContextPackage["currentTasks"] = [];
    if (tasksResult.status === "EXECUTED") {
      const tasks = tasksResult.data as { id: string; title: string; status: string; dueAt: Date | null }[];
      currentTasks = tasks
        .filter((t) => t.status === "TODO" || t.status === "IN_PROGRESS")
        .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity))
        .slice(0, 10)
        .map((t) => ({ id: t.id, title: t.title, status: t.status }));
    } else {
      withheld.push("tasks");
    }

    let relevantMemories: ContextPackage["relevantMemories"] = [];
    if (memoryResult.status === "EXECUTED") {
      // type and status are carried through unchanged: a FACT stays a
      // FACT, an INFERENCE stays an INFERENCE, and "confirmed" is derived,
      // never assumed.
      relevantMemories = (memoryResult.data as MemoryRecord[]).map((m) => ({
        id: m.id,
        content: m.content,
        type: m.type,
        status: m.status,
        confirmed: m.status === "ACTIVE",
      }));
    } else {
      withheld.push("memories");
    }

    // Structured knowledge (principal-owned) first, then curated documents. Contradicted items are
    // flagged, never dropped: the consumer must see that the world knowledge is disputed.
    let relevantKnowledge: ContextPackage["relevantKnowledge"] = [];
    if (itemsResult.status === "EXECUTED") {
      relevantKnowledge = (itemsResult.data as KnowledgeHit[]).map((k) => ({
        slug: `item:${k.id}`, title: k.title, excerpt: k.excerpt, kind: k.kind, contradicted: k.contradicted, confidence: k.confidence,
      }));
    }
    if (knowledgeResult.status === "EXECUTED") {
      relevantKnowledge = [...relevantKnowledge, ...(knowledgeResult.data as KnowledgeSearchResult[]).map((k) => ({ slug: k.slug, title: k.title, excerpt: k.excerpt }))];
    }
    // Withheld only when NEITHER source was readable (both need KNOWLEDGE_READ).
    if (knowledgeResult.status !== "EXECUTED" && itemsResult.status !== "EXECUTED") withheld.push("knowledge");

    return {
      currentTasks,
      relevantMemories,
      relevantKnowledge,
      withheld,
      notes: [],
    };
  }
}
