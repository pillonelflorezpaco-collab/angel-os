import type { MemoryStatus, MemoryType } from "@prisma/client";

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  source: string;
  confidence: number;
  status: MemoryStatus;
  createdAt: Date;
  updatedAt: Date;
  lastConfirmedAt: Date | null;
  expiresAt: Date | null;
}

export interface AddMemoryInput {
  principalId: string;
  type: MemoryType;
  content: string;
  source: string;
  confidence?: number;
  expiresAt?: Date;
}

export interface SearchMemoryInput {
  principalId: string;
  query: string;
  type?: MemoryType;
  limit?: number;
}

export interface UpdateMemoryInput {
  content?: string;
  confidence?: number;
  status?: MemoryStatus;
}

/** Thrown when `id` doesn't exist, or exists but belongs to a different principal. */
export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Memory ${id} not found for this principal.`);
    this.name = "MemoryNotFoundError";
  }
}

/**
 * Everything above the memory layer depends on this interface, never on a
 * specific provider. This is what keeps Mem0 (or any future provider) an
 * implementation detail instead of a hard dependency baked into Jarvis Core.
 *
 * SECURITY: every method that targets an existing memory by id also takes
 * `principalId`, and every implementation MUST scope its query by BOTH `id`
 * AND `principalId` in the same where-clause (never fetch by id alone and
 * check ownership after) — this is the fix for the memory IDOR found in the
 * security audit. The ownership check lives at this data-access boundary,
 * not in a caller, so no future caller can accidentally skip it.
 */
export interface MemoryProvider {
  addMemory(input: AddMemoryInput): Promise<MemoryRecord>;
  searchMemory(input: SearchMemoryInput): Promise<MemoryRecord[]>;
  updateMemory(principalId: string, id: string, input: UpdateMemoryInput): Promise<MemoryRecord>;
  deleteMemory(principalId: string, id: string): Promise<void>;
  /** Marks an UNCONFIRMED (inferred) memory as confirmed, promoting it toward ACTIVE. */
  confirmMemory(principalId: string, id: string): Promise<MemoryRecord>;
}
