import type { MemoryStatus, MemoryType, ProvenanceKind } from "@prisma/client";
import { PublicError } from "../../core/errors.js";

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
  /** System lifetime: not retrieved after this instant. */
  expiresAt: Date | null;
  /** Where it came from. INFERRED <=> type INFERENCE (enforced in provider and database). */
  provenance: ProvenanceKind;
  sourceRef: string | null;
  subject: string | null;
  /** When the experience/event happened (world time). */
  occurredAt: Date | null;
  /** World-time validity window. */
  validFrom: Date | null;
  validUntil: Date | null;
  /** The memory this one was derived from (an inference's evidence, a lesson's experience). */
  derivedFromId: string | null;
  retractedAt: Date | null;
  retractedReason: string | null;
}

export interface AddMemoryInput {
  principalId: string;
  type: MemoryType;
  content: string;
  source: string;
  confidence?: number;
  expiresAt?: Date;
  /** Defaults from the type: INFERENCE -> INFERRED, EXPERIENCE -> EXPERIENCED, otherwise STATED. */
  provenance?: ProvenanceKind;
  sourceRef?: string;
  subject?: string;
  occurredAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  derivedFromId?: string;
}

export interface SearchMemoryInput {
  principalId: string;
  query: string;
  type?: MemoryType;
  types?: MemoryType[];
  subject?: string;
  /** Evaluate world-time validity at this instant (default: now). */
  asOf?: Date;
  limit?: number;
}

/** What may change on an existing memory. Type, provenance, owner and origin are immutable; status moves only through confirm/retract. */
export interface UpdateMemoryInput {
  content?: string;
  confidence?: number;
  subject?: string;
  validFrom?: Date;
  validUntil?: Date;
  expiresAt?: Date;
}

/** Who/what caused a change — recorded in the revision. Metadata only; never authorization. */
export interface MutationActor {
  requestId?: string;
  interfaceSource?: string;
  approvalId?: string;
}

export interface MemoryRevisionRecord {
  id: string;
  memoryId: string;
  changeType: string;
  previousContent: string;
  previousConfidence: number;
  previousStatus: MemoryStatus;
  previousValidFrom: Date | null;
  previousValidUntil: Date | null;
  previousExpiresAt: Date | null;
  changedAt: Date;
  requestId: string | null;
  interfaceSource: string | null;
  approvalId: string | null;
}

/** A memory would violate a semantic invariant (safe to show the user). */
export class MemoryInvalidError extends PublicError {}

/** Thrown when `id` doesn't exist, or exists but belongs to a different principal. */
export class MemoryNotFoundError extends PublicError {
  constructor(id: string) {
    super(`Memory ${id} not found for this principal.`);
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
  /** Any status (including retracted/expired) — the owner can always inspect their own history. */
  getMemory(principalId: string, id: string): Promise<MemoryRecord>;
  /** Append-only history of changes, newest first. */
  listRevisions(principalId: string, id: string): Promise<MemoryRevisionRecord[]>;
  updateMemory(principalId: string, id: string, input: UpdateMemoryInput, actor?: MutationActor): Promise<MemoryRecord>;
  /** Non-destructive: the memory stays for history but is no longer retrieved as belief. */
  retractMemory(principalId: string, id: string, reason: string, actor?: MutationActor): Promise<MemoryRecord>;
  deleteMemory(principalId: string, id: string): Promise<void>;
  /** Marks an UNCONFIRMED (inferred) memory as confirmed. The type stays what it was. */
  confirmMemory(principalId: string, id: string, actor?: MutationActor): Promise<MemoryRecord>;
}
