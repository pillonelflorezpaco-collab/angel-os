import type { Memory, Prisma, PrismaClient } from "@prisma/client";
import { assertMemoryInvariants as assertInvariants, defaultProvenance } from "../types/invariants.js";
import { getDb } from "../../db/client/index.js";
import {
  MemoryInvalidError,
  MemoryNotFoundError,
  type AddMemoryInput,
  type MemoryProvider,
  type MemoryRecord,
  type MemoryRevisionRecord,
  type MutationActor,
  type SearchMemoryInput,
  type UpdateMemoryInput,
} from "../types/index.js";

type Tx = Prisma.TransactionClient;

/** Locks the row (scoped by owner) for the rest of the transaction; throws NotFound for anything not the principal's. */
async function lockOwned(tx: Tx, principalId: string, id: string): Promise<Memory> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "memories" WHERE "id" = ${id} AND "principalId" = ${principalId} FOR UPDATE`;
  if (locked.length === 0) throw new MemoryNotFoundError(id);
  return tx.memory.findFirstOrThrow({ where: { id, principalId } });
}

function snapshot(m: Memory, changeType: string, actor?: MutationActor): Prisma.MemoryRevisionUncheckedCreateInput {
  return {
    memoryId: m.id,
    principalId: m.principalId,
    changeType,
    previousContent: m.content,
    previousConfidence: m.confidence,
    previousStatus: m.status,
    previousValidFrom: m.validFrom,
    previousValidUntil: m.validUntil,
    previousExpiresAt: m.expiresAt,
    requestId: actor?.requestId,
    interfaceSource: actor?.interfaceSource,
    approvalId: actor?.approvalId,
  };
}

/**
 * Postgres-backed MemoryProvider. No external service required. Search is a
 * deterministic case-insensitive substring match plus structured filters
 * (type, subject, world-time validity). SECURITY: every query is scoped by
 * (id AND principalId) in the same statement; the provider performs NO
 * authorization beyond ownership — permission and approval live above it.
 */
export class LocalMemoryProvider implements MemoryProvider {
  async addMemory(input: AddMemoryInput): Promise<MemoryRecord> {
    const db = getDb();
    const provenance = input.provenance ?? defaultProvenance(input.type);
    const status = input.type === "INFERENCE" ? "UNCONFIRMED" : "ACTIVE";
    const confidence = input.confidence ?? (input.type === "INFERENCE" ? 0.5 : 1.0);
    assertInvariants({ type: input.type, provenance, status, confidence, validFrom: input.validFrom ?? null, validUntil: input.validUntil ?? null });

    if (input.derivedFromId) {
      // The origin must be the SAME principal's memory: provenance can never point across owners.
      const origin = await db.memory.findFirst({ where: { id: input.derivedFromId, principalId: input.principalId }, select: { id: true } });
      if (!origin) throw new MemoryNotFoundError(input.derivedFromId);
    }

    return db.memory.create({
      data: {
        principalId: input.principalId,
        type: input.type,
        content: input.content,
        source: input.source,
        confidence,
        status,
        expiresAt: input.expiresAt,
        provenance,
        sourceRef: input.sourceRef,
        subject: input.subject,
        occurredAt: input.occurredAt,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        derivedFromId: input.derivedFromId,
      },
    });
  }

  async searchMemory(input: SearchMemoryInput): Promise<MemoryRecord[]> {
    const db = getDb();
    const now = new Date();
    const asOf = input.asOf ?? now;
    const types = input.types ?? (input.type ? [input.type] : undefined);
    return db.memory.findMany({
      where: {
        principalId: input.principalId,
        ...(types ? { type: { in: types } } : {}),
        status: { in: ["ACTIVE", "UNCONFIRMED"] },
        content: { contains: input.query, mode: "insensitive" },
        ...(input.subject ? { subject: { contains: input.subject, mode: "insensitive" } } : {}),
        AND: [
          // System lifetime: kept for history, never retrieved once expired.
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          // World-time validity: only what is true as of `asOf`.
          { OR: [{ validFrom: null }, { validFrom: { lte: asOf } }] },
          { OR: [{ validUntil: null }, { validUntil: { gt: asOf } }] },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: input.limit ?? 20,
    });
  }

  async getMemory(principalId: string, id: string): Promise<MemoryRecord> {
    const m = await getDb().memory.findFirst({ where: { id, principalId } });
    if (!m) throw new MemoryNotFoundError(id);
    return m;
  }

  async listRevisions(principalId: string, id: string): Promise<MemoryRevisionRecord[]> {
    const db = getDb();
    if (!(await db.memory.findFirst({ where: { id, principalId }, select: { id: true } }))) throw new MemoryNotFoundError(id);
    return db.memoryRevision.findMany({ where: { memoryId: id, principalId }, orderBy: { changedAt: "desc" } });
  }

  async updateMemory(principalId: string, id: string, input: UpdateMemoryInput, actor?: MutationActor): Promise<MemoryRecord> {
    return (getDb() as PrismaClient).$transaction(async (tx) => {
      const current = await lockOwned(tx, principalId, id);
      if (current.status === "RETRACTED" || current.status === "EXPIRED") throw new MemoryInvalidError("That memory can no longer be changed.");
      const next = {
        content: input.content ?? current.content,
        confidence: input.confidence ?? current.confidence,
        subject: input.subject ?? current.subject,
        validFrom: input.validFrom ?? current.validFrom,
        validUntil: input.validUntil ?? current.validUntil,
        expiresAt: input.expiresAt ?? current.expiresAt,
      };
      assertInvariants({ type: current.type, provenance: current.provenance, status: current.status, confidence: next.confidence, validFrom: next.validFrom, validUntil: next.validUntil });
      // History first: the past is recorded in the same transaction as the change.
      await tx.memoryRevision.create({ data: snapshot(current, "UPDATE", actor) });
      return tx.memory.update({ where: { id }, data: next });
    });
  }

  async retractMemory(principalId: string, id: string, reason: string, actor?: MutationActor): Promise<MemoryRecord> {
    return (getDb() as PrismaClient).$transaction(async (tx) => {
      const current = await lockOwned(tx, principalId, id);
      if (current.status !== "ACTIVE" && current.status !== "UNCONFIRMED") throw new MemoryInvalidError("That memory is already retracted or expired.");
      await tx.memoryRevision.create({ data: snapshot(current, "RETRACT", actor) });
      return tx.memory.update({ where: { id }, data: { status: "RETRACTED", retractedAt: new Date(), retractedReason: reason } });
    });
  }

  async deleteMemory(principalId: string, id: string): Promise<void> {
    const { count } = await getDb().memory.deleteMany({ where: { id, principalId } });
    if (count === 0) throw new MemoryNotFoundError(id);
  }

  async confirmMemory(principalId: string, id: string, actor?: MutationActor): Promise<MemoryRecord> {
    return (getDb() as PrismaClient).$transaction(async (tx) => {
      const current = await lockOwned(tx, principalId, id);
      if (current.status === "RETRACTED" || current.status === "EXPIRED") throw new MemoryInvalidError("That memory can no longer be confirmed.");
      await tx.memoryRevision.create({ data: snapshot(current, "CONFIRM", actor) });
      // Confirmation promotes the STATUS and confidence only — the type stays what it was (an inference is still an inference).
      return tx.memory.update({ where: { id }, data: { status: "ACTIVE", lastConfirmedAt: new Date(), confidence: 1.0 } });
    });
  }
}
