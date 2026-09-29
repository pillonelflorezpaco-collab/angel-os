import { listTasks } from "../../skills/system/tasks.js";
import { search as searchMemory } from "../../skills/system/memory.js";
import { MarkdownKnowledgeProvider } from "../../knowledge/markdown/index.js";
import type { ContextRequest, ContextEngine } from "../types/index.js";
import type { ContextPackage } from "../../core/types/index.js";
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
 * Knowledge documents are the principal's own hand-curated files, not
 * principal-scoped records, so they are read directly (path-safe, see
 * knowledge/markdown).
 */
export class DeterministicContextEngine implements ContextEngine {
  private readonly knowledge = new MarkdownKnowledgeProvider();

  async buildContext(request: ContextRequest): Promise<ContextPackage> {
    const [tasksResult, memoryResult, knowledgeHits] = await Promise.all([
      listTasks({ principalId: request.principalId, agentKey: request.agentKey }),
      searchMemory({ principalId: request.principalId, agentKey: request.agentKey, query: { query: request.query, limit: 5 } }),
      this.knowledge.search(request.query, 3),
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

    return {
      currentTasks,
      relevantMemories,
      relevantKnowledge: knowledgeHits.map((k) => ({ slug: k.slug, title: k.title, excerpt: k.excerpt })),
      withheld,
      notes: [],
    };
  }
}
