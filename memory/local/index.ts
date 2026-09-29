import { getDb } from "../../db/client/index.js";
import {
  MemoryNotFoundError,
  type AddMemoryInput,
  type MemoryProvider,
  type MemoryRecord,
  type SearchMemoryInput,
  type UpdateMemoryInput,
} from "../types/index.js";

/**
 * Postgres-backed MemoryProvider. No external service required — this is
 * the default for v0.1 and for local development. Search is a simple
 * case-insensitive substring match; deterministic and good enough for a
 * first version (see docs/MEMORY.md for the upgrade path to embeddings).
 */
export class LocalMemoryProvider implements MemoryProvider {
  async addMemory(input: AddMemoryInput): Promise<MemoryRecord> {
    const db = getDb();
    const memory = await db.memory.create({
      data: {
        principalId: input.principalId,
        type: input.type,
        content: input.content,
        source: input.source,
        confidence: input.confidence ?? (input.type === "INFERENCE" ? 0.5 : 1.0),
        status: input.type === "INFERENCE" ? "UNCONFIRMED" : "ACTIVE",
        expiresAt: input.expiresAt,
      },
    });
    return memory;
  }

  async searchMemory(input: SearchMemoryInput): Promise<MemoryRecord[]> {
    const db = getDb();
    const results = await db.memory.findMany({
      where: {
        principalId: input.principalId,
        type: input.type,
        status: { in: ["ACTIVE", "UNCONFIRMED"] },
        content: { contains: input.query, mode: "insensitive" },
      },
      orderBy: { updatedAt: "desc" },
      take: input.limit ?? 20,
    });
    return results;
  }

  async updateMemory(principalId: string, id: string, input: UpdateMemoryInput): Promise<MemoryRecord> {
    const db = getDb();
    // updateMany scoped by (id AND principalId) so a memory belonging to
    // another principal is simply not matched — never fetched, never
    // touched. The ownership check is the WHERE clause itself.
    const { count } = await db.memory.updateMany({
      where: { id, principalId },
      data: {
        content: input.content,
        confidence: input.confidence,
        status: input.status,
      },
    });
    if (count === 0) throw new MemoryNotFoundError(id);
    return db.memory.findUniqueOrThrow({ where: { id } });
  }

  async deleteMemory(principalId: string, id: string): Promise<void> {
    const db = getDb();
    const { count } = await db.memory.deleteMany({ where: { id, principalId } });
    if (count === 0) throw new MemoryNotFoundError(id);
  }

  async confirmMemory(principalId: string, id: string): Promise<MemoryRecord> {
    const db = getDb();
    const { count } = await db.memory.updateMany({
      where: { id, principalId },
      data: { status: "ACTIVE", lastConfirmedAt: new Date(), confidence: 1.0 },
    });
    if (count === 0) throw new MemoryNotFoundError(id);
    return db.memory.findUniqueOrThrow({ where: { id } });
  }
}
