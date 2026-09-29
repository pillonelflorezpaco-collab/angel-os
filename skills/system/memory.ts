import { getMemoryProvider } from "../../memory/index.js";
import { MemoryNotFoundError, type AddMemoryInput, type MemoryRecord, type SearchMemoryInput } from "../../memory/types/index.js";
import { PublicError } from "../../core/errors.js";
import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import type { ActionDefinition, ExecutionContext } from "../../gateway/index.js";
import { MemoryType, ProvenanceKind } from "@prisma/client";
import { assertMemoryInvariants, defaultProvenance } from "../../memory/types/invariants.js";
import { z } from "zod";
import type { IdentityContext } from "../../identity/index.js";
import { JARVIS_AGENT_KEY } from "../agent.js";
import type { Result } from "../../core/types/index.js";
import { recordActivity } from "../../activity/service.js";

// Fixes the Jarvis Core bypass found in the audit: memory operations used to
// call MemoryProvider directly from core/index.ts, with no permission check
// and no audit trail. Every memory operation now goes through this skill,
// which routes through gatewayExecute like skills/system/tasks.ts does.

export const SKILL_KEY = "system.memory";
export const RESOURCE = "angel:memory";

/**
 * One line per memory, always labelled with its type. An INFERENCE is
 * labelled as unconfirmed until the principal confirms it, and stays an
 * INFERENCE even after confirmation — nothing here or anywhere else
 * rewrites a memory's type.
 */
export function describeMemory(m: Pick<MemoryRecord, "type" | "status" | "content">): string {
  if (m.type === "INFERENCE") {
    return m.status === "ACTIVE" ? `[inference, confirmed] ${m.content}` : `[inference, unconfirmed] ${m.content}`;
  }
  return `[${m.type.toLowerCase()}] ${m.content}`;
}

const MEMORY_TYPES = Object.values(MemoryType) as [MemoryType, ...MemoryType[]];
/** The valid memory types (exported so interfaces can validate input without importing the database client). */
export const MEMORY_TYPE_VALUES = MEMORY_TYPES;
const PROVENANCE = Object.values(ProvenanceKind) as [ProvenanceKind, ...ProvenanceKind[]];
const instant = z.string().datetime();

const rememberParams = z
  .object({
    type: z.enum(MEMORY_TYPES),
    content: z.string().trim().min(1).max(2000),
    source: z.string().min(1).max(100),
    // Structured provenance and validity (Memory OS). All optional; defaults come from the type.
    provenance: z.enum(PROVENANCE).optional(),
    sourceRef: z.string().trim().min(1).max(300).optional(),
    subject: z.string().trim().min(1).max(120).optional(),
    confidence: z.number().min(0).max(1).optional(),
    occurredAt: instant.optional(),
    validFrom: instant.optional(),
    validUntil: instant.optional(),
    expiresAt: instant.optional(),
    derivedFromId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    // The same invariants the provider and the database enforce — rejected BEFORE any approval exists.
    try {
      assertMemoryInvariants({
        type: p.type,
        provenance: p.provenance ?? defaultProvenance(p.type),
        status: p.type === "INFERENCE" ? "UNCONFIRMED" : "ACTIVE",
        confidence: p.confidence ?? (p.type === "INFERENCE" ? 0.5 : 1),
        validFrom: p.validFrom ? new Date(p.validFrom) : null,
        validUntil: p.validUntil ? new Date(p.validUntil) : null,
      });
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : "invalid memory" });
    }
  });
type RememberParams = z.infer<typeof rememberParams>;

const toDate = (v: string | undefined) => (v ? new Date(v) : undefined);
const actorOf = (ctx: ExecutionContext) => ({ requestId: ctx.requestId, interfaceSource: ctx.interfaceSource, approvalId: ctx.approvalId });

/**
 * "Remember that …" as a registered ActionDefinition. LOW risk: direct on
 * GuideHub/API/Telegram, approval on voice (a misheard transcript must not
 * silently become a standing memory). Type is fixed at creation and can never
 * be changed later; an INFERENCE is created UNCONFIRMED and stays an INFERENCE.
 */
export const rememberDefinition: ActionDefinition<RememberParams> = {
  skillKey: SKILL_KEY,
  action: "MEMORY_CREATE",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: rememberParams,
  describe: (p) => `Remember (${p.type.toLowerCase()}${p.subject ? `, about ${p.subject}` : ""}): ${p.content}`,
  async execute(ctx, p) {
    const memory = await getMemoryProvider().addMemory({
      principalId: ctx.principalId,
      type: p.type,
      content: p.content,
      source: p.source,
      provenance: p.provenance,
      sourceRef: p.sourceRef,
      subject: p.subject,
      confidence: p.confidence,
      occurredAt: toDate(p.occurredAt),
      validFrom: toDate(p.validFrom),
      validUntil: toDate(p.validUntil),
      expiresAt: toDate(p.expiresAt),
      derivedFromId: p.derivedFromId,
    });
    // Life history, kept separate from the audit log the gateway writes.
    // References the memory instead of copying its content.
    await recordActivity({
      principalId: ctx.principalId,
      type: "MEMORY_CREATED",
      summary: `Remembered a ${memory.type.toLowerCase()}`,
      refType: "memory",
      refId: memory.id,
    });
    return memory;
  },
  successMessage: (memory) => `Remembered. ${describeMemory(memory as MemoryRecord)}`,
};

export interface RememberInput extends Omit<AddMemoryInput, "principalId" | "expiresAt" | "occurredAt" | "validFrom" | "validUntil"> {
  expiresAt?: Date;
  occurredAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
}

export function remember(identity: IdentityContext, memory: RememberInput): Promise<Result> {
  const iso = (d: Date | undefined) => (d ? d.toISOString() : undefined);
  const params: Record<string, unknown> = {
    type: memory.type,
    content: memory.content,
    source: memory.source,
    provenance: memory.provenance,
    sourceRef: memory.sourceRef,
    subject: memory.subject,
    confidence: memory.confidence,
    occurredAt: iso(memory.occurredAt),
    validFrom: iso(memory.validFrom),
    validUntil: iso(memory.validUntil),
    expiresAt: iso(memory.expiresAt),
    derivedFromId: memory.derivedFromId,
  };
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k]; // canonical: absent, not undefined
  return proposeAction(identity, { skillKey: SKILL_KEY, action: "MEMORY_CREATE", parameters: params });
}

export interface SearchInput {
  principalId: string;
  agentKey: string;
  query: Omit<SearchMemoryInput, "principalId">;
}

export async function search(input: SearchInput): Promise<Result> {
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "MEMORY_READ",
      parameters: { query: input.query.query, types: input.query.types ?? input.query.type ?? null, subject: input.query.subject ?? null, asOf: input.query.asOf ? input.query.asOf.toISOString() : null },
    },
    () => getMemoryProvider().searchMemory({ ...input.query, principalId: input.principalId }),
    "skill.system.memory"
  );
}

// ── Sensitive memory mutations (BUILD #8) ─────────────────────────────────
// update / confirm / delete are separate actions with separate permissions,
// each SENSITIVE (approval on every interface; voice and SYSTEM can never
// approve them). Ownership is enforced INSIDE execution by the principal-scoped
// provider methods — a memory id from another principal is simply "not found".
// No public route or Core intent exposes them yet.

const memoryId = z.string().uuid();

async function ownedOrNotFound<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof MemoryNotFoundError) throw new PublicError("That memory wasn't found.");
    throw err;
  }
}

const updateParams = z
  .object({
    memoryId,
    content: z.string().trim().min(1).max(2000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    subject: z.string().trim().min(1).max(120).optional(),
    validFrom: instant.optional(),
    validUntil: instant.optional(),
    expiresAt: instant.optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).some((k) => k !== "memoryId"), { message: "nothing to update" });
type UpdateParams = z.infer<typeof updateParams>;

export const memoryUpdateDefinition: ActionDefinition<UpdateParams> = {
  skillKey: SKILL_KEY,
  action: "MEMORY_UPDATE",
  resource: RESOURCE,
  category: "WRITE",
  risk: "SENSITIVE",
  agentKey: JARVIS_AGENT_KEY,
  schema: updateParams,
  describe: (p) => `Update memory ${p.memoryId}${p.content !== undefined ? `: "${p.content}"` : ""}`,
  execute: (ctx, p) =>
    ownedOrNotFound(() =>
      getMemoryProvider().updateMemory(
        ctx.principalId,
        p.memoryId,
        { content: p.content, confidence: p.confidence, subject: p.subject, validFrom: toDate(p.validFrom), validUntil: toDate(p.validUntil), expiresAt: toDate(p.expiresAt) },
        actorOf(ctx)
      )
    ),
  successMessage: () => "Memory updated.",
};

const idOnly = z.object({ memoryId }).strict();
type IdOnly = z.infer<typeof idOnly>;

export const memoryConfirmDefinition: ActionDefinition<IdOnly> = {
  skillKey: SKILL_KEY,
  action: "MEMORY_CONFIRM",
  resource: RESOURCE,
  category: "WRITE",
  risk: "SENSITIVE",
  agentKey: JARVIS_AGENT_KEY,
  schema: idOnly,
  describe: (p) => `Confirm memory ${p.memoryId} as a standing fact`,
  execute: (ctx, p) => ownedOrNotFound(() => getMemoryProvider().confirmMemory(ctx.principalId, p.memoryId, actorOf(ctx))),
  successMessage: () => "Memory confirmed.",
};

export const memoryDeleteDefinition: ActionDefinition<IdOnly> = {
  skillKey: SKILL_KEY,
  action: "MEMORY_DELETE",
  resource: RESOURCE,
  category: "WRITE",
  risk: "SENSITIVE",
  agentKey: JARVIS_AGENT_KEY,
  schema: idOnly,
  describe: (p) => `Permanently delete memory ${p.memoryId}`,
  execute: (ctx, p) => ownedOrNotFound(() => getMemoryProvider().deleteMemory(ctx.principalId, p.memoryId)),
  successMessage: () => "Memory deleted.",
};

export interface UpdateMemoryRequest {
  memoryId: string;
  content?: string;
  confidence?: number;
  subject?: string;
  validFrom?: Date;
  validUntil?: Date;
  expiresAt?: Date;
}

export function updateMemory(identity: IdentityContext, input: UpdateMemoryRequest): Promise<Result> {
  const params: Record<string, unknown> = { ...input };
  for (const k of ["validFrom", "validUntil", "expiresAt"] as const) if (input[k]) params[k] = input[k]!.toISOString();
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k]; // canonical: absent, not undefined
  return proposeAction(identity, { skillKey: SKILL_KEY, action: "MEMORY_UPDATE", parameters: params });
}
export const confirmMemory = (identity: IdentityContext, input: { memoryId: string }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "MEMORY_CONFIRM", parameters: { memoryId: input.memoryId } });
export const deleteMemory = (identity: IdentityContext, input: { memoryId: string }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "MEMORY_DELETE", parameters: { memoryId: input.memoryId } });

const retractParams = z.object({ memoryId, reason: z.string().trim().min(1).max(500) }).strict();
type RetractParams = z.infer<typeof retractParams>;

/**
 * Retraction: "this was wrong / no longer true". Non-destructive — the memory
 * stays for history (and its revisions), but is never retrieved as belief
 * again. SENSITIVE: it changes what Jarvis believes about Angel.
 */
export const memoryRetractDefinition: ActionDefinition<RetractParams> = {
  skillKey: SKILL_KEY,
  action: "MEMORY_RETRACT",
  resource: RESOURCE,
  category: "WRITE",
  risk: "SENSITIVE",
  agentKey: JARVIS_AGENT_KEY,
  schema: retractParams,
  describe: (p) => `Retract memory ${p.memoryId}: ${p.reason}`,
  execute: (ctx, p) => ownedOrNotFound(() => getMemoryProvider().retractMemory(ctx.principalId, p.memoryId, p.reason, actorOf(ctx))),
  successMessage: () => "Memory retracted. It is kept for history but no longer treated as true.",
};

export const retractMemory = (identity: IdentityContext, input: { memoryId: string; reason: string }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "MEMORY_RETRACT", parameters: { memoryId: input.memoryId, reason: input.reason } });

// ── Reads (READ lane, MEMORY_READ): the owner can always inspect their own memory and its history ──

export interface MemoryLookupInput {
  principalId: string;
  agentKey: string;
  memoryId: string;
}

export async function getMemoryById(input: MemoryLookupInput): Promise<Result> {
  return gatewayExecute(
    { principalId: input.principalId, agentKey: input.agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: "MEMORY_READ", parameters: { op: "get", memoryId: input.memoryId } },
    () => ownedOrNotFound(() => getMemoryProvider().getMemory(input.principalId, input.memoryId)),
    "skill.system.memory"
  );
}

export async function memoryHistory(input: MemoryLookupInput): Promise<Result> {
  return gatewayExecute(
    { principalId: input.principalId, agentKey: input.agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: "MEMORY_READ", parameters: { op: "history", memoryId: input.memoryId } },
    () => ownedOrNotFound(() => getMemoryProvider().listRevisions(input.principalId, input.memoryId)),
    "skill.system.memory"
  );
}
