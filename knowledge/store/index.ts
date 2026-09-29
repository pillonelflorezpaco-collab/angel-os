import { createHash } from "node:crypto";
import type { KnowledgeItem, KnowledgeKind, KnowledgeRelationKind, KnowledgeSource, Prisma } from "@prisma/client";
import { getDb } from "../../db/client/index.js";
import { PublicError } from "../../core/errors.js";
import { runPipeline, PipelineError, normalizeText, LIMITS, type SourceFormat } from "../pipeline/index.js";

// Postgres persistence for Knowledge OS. Every query is scoped by
// principalId in the same statement; the store performs NO authorization
// beyond ownership — permission, risk policy and approval live above it
// (skills/system/knowledge.ts + the gateway).

export class KnowledgeNotFoundError extends PublicError {
  constructor() {
    super("That knowledge item wasn't found.");
  }
}
export class KnowledgeInvalidError extends PublicError {}

export interface IngestInput {
  title: string;
  sourceKind: string;
  uri?: string;
  format: SourceFormat;
  content: string;
}

export interface IngestOutcome {
  sourceId: string;
  /** True if this exact content was already ingested for this principal (nothing new was written). */
  duplicate: boolean;
  itemCount: number;
  relationCount: number;
  truncatedItems: number;
}

export interface KnowledgeHit {
  id: string;
  kind: KnowledgeKind;
  title: string;
  excerpt: string;
  confidence: number | null;
  eventAt: Date | null;
  sourceId: string | null;
  sourceTitle: string | null;
  /** Another ACTIVE item CONTRADICTS this one (or vice versa). Contradictions are surfaced, never hidden. */
  contradicted: boolean;
}

export interface KnowledgeRelationView {
  id: string;
  kind: KnowledgeRelationKind;
  direction: "OUT" | "IN";
  note: string | null;
  other: { id: string; kind: KnowledgeKind; title: string; status: string };
}

export interface KnowledgeItemView extends KnowledgeItem {
  sourceTitle: string | null;
  relations: KnowledgeRelationView[];
}

const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");

function excerptOf(body: string, query: string): string {
  const idx = query ? body.toLowerCase().indexOf(query.toLowerCase()) : -1;
  const start = Math.max(0, (idx === -1 ? 0 : idx) - 60);
  return body.slice(start, start + 240).trim();
}

export class LocalKnowledgeStore {
  async ingest(principalId: string, input: IngestInput): Promise<IngestOutcome> {
    const db = getDb();
    const normalized = normalizeText(input.content);
    const hash = contentHash(`${input.format}\n${normalized}`);
    const existing = await db.knowledgeSource.findUnique({ where: { principalId_contentHash: { principalId, contentHash: hash } } });
    if (existing) {
      const itemCount = await db.knowledgeItem.count({ where: { sourceId: existing.id, principalId } });
      return { sourceId: existing.id, duplicate: true, itemCount, relationCount: 0, truncatedItems: 0 };
    }

    let result;
    try {
      result = runPipeline(normalized, input.format, input.title);
    } catch (err) {
      if (err instanceof PipelineError) throw new KnowledgeInvalidError(err.message);
      throw err;
    }

    try {
      return await db.$transaction(async (tx) => {
        const source = await tx.knowledgeSource.create({
          data: { principalId, title: input.title, kind: input.sourceKind, uri: input.uri, contentHash: hash },
        });
        const ids = new Map<number, string>();
        for (const c of result.candidates) {
          const item = await tx.knowledgeItem.create({
            data: {
              principalId, kind: c.kind, title: c.title, body: c.body, origin: "INGESTED", sourceId: source.id,
              confidence: c.confidence, eventAt: c.eventAt,
            },
          });
          ids.set(c.key, item.id);
        }
        for (const r of result.relations) {
          await tx.knowledgeRelation.create({ data: { principalId, fromId: ids.get(r.fromKey)!, toId: ids.get(r.toKey)!, kind: r.kind } });
        }
        return { sourceId: source.id, duplicate: false, itemCount: result.candidates.length, relationCount: result.relations.length, truncatedItems: result.truncated };
      });
    } catch (err) {
      // A concurrent identical ingest won the unique (principal, contentHash): report it as the duplicate it is.
      if ((err as { code?: string }).code === "P2002") {
        const won = await db.knowledgeSource.findUnique({ where: { principalId_contentHash: { principalId, contentHash: hash } } });
        if (won) return { sourceId: won.id, duplicate: true, itemCount: await db.knowledgeItem.count({ where: { sourceId: won.id, principalId } }), relationCount: 0, truncatedItems: 0 };
      }
      throw err;
    }
  }

  async addItem(
    principalId: string,
    input: { kind: KnowledgeKind; title: string; body: string; confidence?: number; eventAt?: Date }
  ): Promise<KnowledgeItem> {
    if (input.title.length > LIMITS.MAX_TITLE_CHARS || input.body.length > LIMITS.MAX_BODY_CHARS) throw new KnowledgeInvalidError("That item is too long.");
    return getDb().knowledgeItem.create({
      data: {
        principalId, kind: input.kind, title: input.title, body: input.body, origin: "MANUAL",
        confidence: input.confidence ?? (input.kind === "HYPOTHESIS" ? 0.5 : null), eventAt: input.eventAt,
      },
    });
  }

  async relate(principalId: string, input: { fromId: string; toId: string; kind: KnowledgeRelationKind; note?: string }) {
    if (input.fromId === input.toId) throw new KnowledgeInvalidError("An item cannot be related to itself.");
    const db = getDb();
    // Both endpoints must be THIS principal's, active items — checked here for a clear error, and by a database trigger regardless.
    const found = await db.knowledgeItem.findMany({ where: { id: { in: [input.fromId, input.toId] }, principalId, status: "ACTIVE" }, select: { id: true } });
    if (found.length !== 2) throw new KnowledgeNotFoundError();
    try {
      return await db.knowledgeRelation.create({ data: { principalId, fromId: input.fromId, toId: input.toId, kind: input.kind, note: input.note } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new KnowledgeInvalidError("Those items are already related that way.");
      throw err;
    }
  }

  async retractItem(principalId: string, id: string, reason: string): Promise<KnowledgeItem> {
    const db = getDb();
    const { count } = await db.knowledgeItem.updateMany({
      where: { id, principalId, status: "ACTIVE" },
      data: { status: "RETRACTED", retractedAt: new Date(), retractedReason: reason },
    });
    if (count === 0) {
      const exists = await db.knowledgeItem.findFirst({ where: { id, principalId }, select: { status: true } });
      if (!exists) throw new KnowledgeNotFoundError();
      throw new KnowledgeInvalidError("That item is already retracted.");
    }
    return db.knowledgeItem.findFirstOrThrow({ where: { id, principalId } });
  }

  /** Removes a source and everything derived from it (items and their relations cascade). */
  async deleteSource(principalId: string, id: string): Promise<{ items: number }> {
    const db = getDb();
    const items = await db.knowledgeItem.count({ where: { sourceId: id, principalId } });
    const { count } = await db.knowledgeSource.deleteMany({ where: { id, principalId } });
    if (count === 0) throw new KnowledgeNotFoundError();
    return { items };
  }

  async search(principalId: string, input: { query: string; kinds?: KnowledgeKind[]; limit?: number }): Promise<KnowledgeHit[]> {
    const db = getDb();
    const where: Prisma.KnowledgeItemWhereInput = {
      principalId,
      status: "ACTIVE",
      ...(input.kinds?.length ? { kind: { in: input.kinds } } : {}),
      ...(input.query ? { OR: [{ title: { contains: input.query, mode: "insensitive" } }, { body: { contains: input.query, mode: "insensitive" } }] } : {}),
    };
    const items = await db.knowledgeItem.findMany({ where, orderBy: { updatedAt: "desc" }, take: Math.min(input.limit ?? 20, 50), include: { source: { select: { title: true } } } });
    if (items.length === 0) return [];
    const ids = items.map((i) => i.id);
    const contradictions = await db.knowledgeRelation.findMany({
      where: { principalId, kind: "CONTRADICTS", OR: [{ fromId: { in: ids } }, { toId: { in: ids } }], from: { status: "ACTIVE" }, to: { status: "ACTIVE" } },
      select: { fromId: true, toId: true },
    });
    const contradicted = new Set(contradictions.flatMap((r) => [r.fromId, r.toId]));
    return items.map((i) => ({
      id: i.id, kind: i.kind, title: i.title, excerpt: excerptOf(i.body, input.query), confidence: i.confidence, eventAt: i.eventAt,
      sourceId: i.sourceId, sourceTitle: i.source?.title ?? null, contradicted: contradicted.has(i.id),
    }));
  }

  async getItem(principalId: string, id: string): Promise<KnowledgeItemView> {
    const db = getDb();
    const item = await db.knowledgeItem.findFirst({ where: { id, principalId }, include: { source: { select: { title: true } } } });
    if (!item) throw new KnowledgeNotFoundError();
    const [out, inn] = await Promise.all([
      db.knowledgeRelation.findMany({ where: { fromId: id, principalId }, include: { to: { select: { id: true, kind: true, title: true, status: true } } } }),
      db.knowledgeRelation.findMany({ where: { toId: id, principalId }, include: { from: { select: { id: true, kind: true, title: true, status: true } } } }),
    ]);
    const relations: KnowledgeRelationView[] = [
      ...out.map((r) => ({ id: r.id, kind: r.kind, direction: "OUT" as const, note: r.note, other: r.to })),
      ...inn.map((r) => ({ id: r.id, kind: r.kind, direction: "IN" as const, note: r.note, other: r.from })),
    ];
    const { source, ...rest } = item;
    return { ...rest, sourceTitle: source?.title ?? null, relations };
  }

  async listSources(principalId: string): Promise<(KnowledgeSource & { itemCount: number })[]> {
    const db = getDb();
    const sources = await db.knowledgeSource.findMany({ where: { principalId }, orderBy: { ingestedAt: "desc" }, take: 100, include: { _count: { select: { items: true } } } });
    return sources.map(({ _count, ...s }) => ({ ...s, itemCount: _count.items }));
  }
}

let store: LocalKnowledgeStore | undefined;
export function getKnowledgeStore(): LocalKnowledgeStore {
  return (store ??= new LocalKnowledgeStore());
}
