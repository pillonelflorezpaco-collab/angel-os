import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import type { ActionDefinition } from "../../gateway/index.js";
import { KnowledgeKind, KnowledgeRelationKind } from "@prisma/client";
import { z } from "zod";
import { getKnowledgeStore, KnowledgeNotFoundError } from "../../knowledge/store/index.js";
import { LIMITS } from "../../knowledge/pipeline/index.js";
import { PublicError } from "../../core/errors.js";
import { recordActivity } from "../../activity/service.js";
import { JARVIS_AGENT_KEY } from "../agent.js";
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

function read<T>(identity: IdentityContext, agentKey: string, parameters: Record<string, unknown>, fn: (principalId: string) => Promise<T>): Promise<Result> {
  let explicit: IdentityContext;
  try {
    explicit = assertExplicitIdentity(identity);
  } catch {
    return Promise.resolve(IDENTITY_REQUIRED);
  }
  return gatewayExecute(
    { principalId: explicit.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: ACTION, parameters },
    () => fn(explicit.principalId),
    "skill.system.knowledge"
  );
}

export const searchKnowledge = (identity: IdentityContext, input: KnowledgeReadInput & { query: string; limit?: number }) =>
  read<KnowledgeSearchResult[]>(identity, input.agentKey, { op: "search", query: input.query, limit: input.limit ?? null }, () => provider.search(input.query, input.limit));

export const listKnowledge = (identity: IdentityContext, input: KnowledgeReadInput) =>
  read<KnowledgeDocumentSummary[]>(identity, input.agentKey, { op: "list" }, () => provider.listDocuments());

export const readKnowledge = (identity: IdentityContext, input: KnowledgeReadInput & { slug: string }) =>
  read<KnowledgeDocumentContent | null>(identity, input.agentKey, { op: "read", slug: input.slug }, () => provider.readDocument(input.slug));

// ── Knowledge OS (structured, principal-owned) ──────────────────────────────
//
// READS go through the READ lane (KNOWLEDGE_READ). WRITES are ActionDefinitions
// (explicit identity, strict schema, interface policy, approval). The pipeline
// is deterministic and pure; content is stored and returned as inert text —
// ingested text is DATA, never instructions.

const KINDS = Object.values(KnowledgeKind) as [KnowledgeKind, ...KnowledgeKind[]];
const RELATION_KINDS = Object.values(KnowledgeRelationKind) as [KnowledgeRelationKind, ...KnowledgeRelationKind[]];
/** Valid values, exported so interfaces can validate input without importing the database client. */
export const KNOWLEDGE_KIND_VALUES = KINDS;
const instant = z.string().datetime();
const uuid = z.string().uuid();

const mapNotFound = <T>(op: () => Promise<T>): Promise<T> => op(); // KnowledgeNotFoundError is already a PublicError (safe to show)

const ingestParams = z
  .object({
    title: z.string().trim().min(1).max(LIMITS.MAX_TITLE_CHARS),
    sourceKind: z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_-]*$/i).default("note"),
    uri: z.string().trim().min(1).max(500).optional(),
    format: z.enum(["markdown", "text"]).default("markdown"),
    content: z.string().min(1).max(LIMITS.MAX_CONTENT_CHARS),
  })
  .strict();
type IngestParams = z.infer<typeof ingestParams>;

const activityFor = (principalId: string, summary: string, refType: string, refId: string) =>
  recordActivity({ principalId, type: "KNOWLEDGE_ADDED", summary, refType, refId });

export const knowledgeIngestDefinition: ActionDefinition<IngestParams> = {
  skillKey: SKILL_KEY,
  action: "KNOWLEDGE_INGEST",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: ingestParams,
  describe: (p) => `Ingest "${p.title}" (${p.content.length} characters, ${p.format}) into knowledge`,
  async execute(ctx, p) {
    const outcome = await getKnowledgeStore().ingest(ctx.principalId, p);
    if (!outcome.duplicate) await activityFor(ctx.principalId, "Added knowledge from a source", "knowledge_source", outcome.sourceId);
    return outcome;
  },
  successMessage: (o) => {
    const r = o as { duplicate: boolean; itemCount: number; truncatedItems: number };
    if (r.duplicate) return "That content was already in your knowledge base; nothing was added.";
    return `Ingested ${r.itemCount} knowledge item(s).${r.truncatedItems ? ` ${r.truncatedItems} were shortened to fit.` : ""}`;
  },
};

const addParams = z
  .object({
    kind: z.enum(KINDS),
    title: z.string().trim().min(1).max(LIMITS.MAX_TITLE_CHARS),
    body: z.string().trim().min(1).max(LIMITS.MAX_BODY_CHARS),
    confidence: z.number().min(0).max(1).optional(),
    eventAt: instant.optional(),
  })
  .strict();
type AddParams = z.infer<typeof addParams>;

export const knowledgeAddDefinition: ActionDefinition<AddParams> = {
  skillKey: SKILL_KEY,
  action: "KNOWLEDGE_ADD",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: addParams,
  describe: (p) => `Add knowledge (${p.kind.toLowerCase()}): ${p.title}`,
  async execute(ctx, p) {
    const item = await getKnowledgeStore().addItem(ctx.principalId, { kind: p.kind, title: p.title, body: p.body, confidence: p.confidence, eventAt: p.eventAt ? new Date(p.eventAt) : undefined });
    await activityFor(ctx.principalId, `Added a ${p.kind.toLowerCase()} to knowledge`, "knowledge_item", item.id);
    return item;
  },
  successMessage: (i, p) => `Added ${(i as { kind: string }).kind.toLowerCase()}: ${p.title}`,
};

const relateParams = z.object({ fromId: uuid, toId: uuid, kind: z.enum(RELATION_KINDS), note: z.string().trim().min(1).max(300).optional() }).strict()
  .refine((p) => p.fromId !== p.toId, { message: "An item cannot be related to itself." });
type RelateParams = z.infer<typeof relateParams>;

export const knowledgeRelateDefinition: ActionDefinition<RelateParams> = {
  skillKey: SKILL_KEY,
  action: "KNOWLEDGE_RELATE",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: relateParams,
  describe: (p) => `Relate knowledge ${p.fromId} ${p.kind} ${p.toId}`,
  execute: (ctx, p) => mapNotFound(() => getKnowledgeStore().relate(ctx.principalId, p)),
  successMessage: () => "Relation added.",
};

const retractParams = z.object({ itemId: uuid, reason: z.string().trim().min(1).max(500) }).strict();
type RetractParams = z.infer<typeof retractParams>;

/** Non-destructive: the item is kept (with its reason) but never retrieved as knowledge again. Terminal. */
export const knowledgeRetractDefinition: ActionDefinition<RetractParams> = {
  skillKey: SKILL_KEY,
  action: "KNOWLEDGE_RETRACT",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: retractParams,
  describe: (p) => `Retract knowledge ${p.itemId}: ${p.reason}`,
  execute: (ctx, p) => mapNotFound(() => getKnowledgeStore().retractItem(ctx.principalId, p.itemId, p.reason)),
  successMessage: () => "Knowledge item retracted. It is kept for history but no longer used.",
};

const deleteSourceParams = z.object({ sourceId: uuid }).strict();
type DeleteSourceParams = z.infer<typeof deleteSourceParams>;

/** Destructive: removes the source and every item and relation derived from it. Hence SENSITIVE (approval everywhere). */
export const knowledgeDeleteSourceDefinition: ActionDefinition<DeleteSourceParams> = {
  skillKey: SKILL_KEY,
  action: "KNOWLEDGE_DELETE_SOURCE",
  resource: RESOURCE,
  category: "WRITE",
  risk: "SENSITIVE",
  agentKey: JARVIS_AGENT_KEY,
  schema: deleteSourceParams,
  describe: (p) => `Permanently delete knowledge source ${p.sourceId} and everything derived from it`,
  execute: (ctx, p) => mapNotFound(() => getKnowledgeStore().deleteSource(ctx.principalId, p.sourceId)),
  successMessage: (r) => `Source deleted along with ${(r as { items: number }).items} item(s).`,
};

export interface KnowledgeIngestRequest {
  title: string;
  content: string;
  format?: "markdown" | "text";
  sourceKind?: string;
  uri?: string;
}
export const ingestKnowledge = (identity: IdentityContext, input: KnowledgeIngestRequest) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "KNOWLEDGE_INGEST", parameters: clean({ title: input.title, content: input.content, format: input.format, sourceKind: input.sourceKind, uri: input.uri }) });
export const addKnowledge = (identity: IdentityContext, input: { kind: KnowledgeKind; title: string; body: string; confidence?: number; eventAt?: Date }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "KNOWLEDGE_ADD", parameters: clean({ kind: input.kind, title: input.title, body: input.body, confidence: input.confidence, eventAt: input.eventAt?.toISOString() }) });
export const relateKnowledge = (identity: IdentityContext, input: { fromId: string; toId: string; kind: KnowledgeRelationKind; note?: string }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "KNOWLEDGE_RELATE", parameters: clean({ ...input }) });
export const retractKnowledge = (identity: IdentityContext, input: { itemId: string; reason: string }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "KNOWLEDGE_RETRACT", parameters: { itemId: input.itemId, reason: input.reason } });
export const deleteKnowledgeSource = (identity: IdentityContext, input: { sourceId: string }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "KNOWLEDGE_DELETE_SOURCE", parameters: { sourceId: input.sourceId } });

/** Canonical parameters: absent keys, never undefined. */
function clean(params: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  return params;
}

// Reads (READ lane; the same KNOWLEDGE_READ permission as the legacy document reads)
export const searchKnowledgeItems = (identity: IdentityContext, input: KnowledgeReadInput & { query: string; kinds?: KnowledgeKind[]; limit?: number }) =>
  read(identity, input.agentKey, { op: "items.search", query: input.query, kinds: input.kinds ?? null, limit: input.limit ?? null }, (principalId) =>
    getKnowledgeStore().search(principalId, { query: input.query, kinds: input.kinds, limit: input.limit }));
export const getKnowledgeItem = (identity: IdentityContext, input: KnowledgeReadInput & { itemId: string }) =>
  read(identity, input.agentKey, { op: "items.get", itemId: input.itemId }, (principalId) => mapNotFound(() => getKnowledgeStore().getItem(principalId, input.itemId)));
export const listKnowledgeSources = (identity: IdentityContext, input: KnowledgeReadInput) =>
  read(identity, input.agentKey, { op: "sources.list" }, (principalId) => getKnowledgeStore().listSources(principalId));
