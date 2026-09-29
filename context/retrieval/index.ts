import { getDb } from "../../db/client/index.js";
import { getMemoryProvider } from "../../memory/index.js";
import { MarkdownKnowledgeProvider } from "../../knowledge/markdown/index.js";
import type { ContextRequest, ContextEngine } from "../types/index.js";
import type { ContextPackage } from "../../core/types/index.js";

/**
 * Deterministic v0.1 retrieval: current open tasks + a handful of memory
 * hits + a handful of knowledge hits, all scoped to the query and
 * principal. Deliberately does NOT load the full database into context —
 * see docs/ARCHITECTURE.md "Context Engine".
 */
export class DeterministicContextEngine implements ContextEngine {
  private readonly knowledge = new MarkdownKnowledgeProvider();

  async buildContext(request: ContextRequest): Promise<ContextPackage> {
    const db = getDb();
    const memoryProvider = getMemoryProvider();

    const [tasks, memories, knowledgeHits] = await Promise.all([
      db.task.findMany({
        where: { principalId: request.principalId, status: { in: ["TODO", "IN_PROGRESS"] } },
        orderBy: { dueAt: "asc" },
        take: 10,
      }),
      memoryProvider.searchMemory({
        principalId: request.principalId,
        query: request.query,
        limit: 5,
      }),
      this.knowledge.search(request.query, 3),
    ]);

    return {
      currentTasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      relevantMemories: memories.map((m) => ({ id: m.id, content: m.content, type: m.type })),
      relevantKnowledge: knowledgeHits.map((k) => ({
        slug: k.slug,
        title: k.title,
        excerpt: k.excerpt,
      })),
      notes: [],
    };
  }
}
