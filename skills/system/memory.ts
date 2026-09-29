import { getMemoryProvider } from "../../memory/index.js";
import { MemoryNotFoundError, type AddMemoryInput, type MemoryRecord, type SearchMemoryInput } from "../../memory/types/index.js";
import { PublicError } from "../../core/errors.js";
import { gatewayExecute, proposeAction } from "../../gateway/index.js";
import type { ActionDefinition } from "../../gateway/index.js";
import { MemoryType } from "@prisma/client";
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
const rememberParams = z
  .object({ type: z.enum(MEMORY_TYPES), content: z.string().trim().min(1).max(2000), source: z.string().min(1).max(100) })
  .strict();
type RememberParams = z.infer<typeof rememberParams>;

/**
 * "Remember that …" as a registered ActionDefinition (BUILD #7). LOW risk:
 * direct on GuideHub/API/Telegram, approval on voice (a misheard transcript
 * must not silently become a standing memory).
 */
export const rememberDefinition: ActionDefinition<RememberParams> = {
  skillKey: SKILL_KEY,
  action: "MEMORY_CREATE",
  resource: RESOURCE,
  category: "WRITE",
  risk: "LOW",
  agentKey: JARVIS_AGENT_KEY,
  schema: rememberParams,
  describe: (p) => `Remember (${p.type.toLowerCase()}): ${p.content}`,
  async execute(ctx, p) {
    const memory = await getMemoryProvider().addMemory({ ...p, principalId: ctx.principalId });
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

export function remember(identity: IdentityContext, memory: Omit<AddMemoryInput, "principalId">): Promise<Result> {
  return proposeAction(identity, {
    skillKey: SKILL_KEY,
    action: "MEMORY_CREATE",
    parameters: { type: memory.type, content: memory.content, source: memory.source },
  });
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
      parameters: { query: input.query.query },
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
  .object({ memoryId, content: z.string().trim().min(1).max(2000).optional(), confidence: z.number().min(0).max(1).optional() })
  .strict()
  .refine((p) => p.content !== undefined || p.confidence !== undefined, { message: "nothing to update" });
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
    ownedOrNotFound(() => getMemoryProvider().updateMemory(ctx.principalId, p.memoryId, { content: p.content, confidence: p.confidence })),
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
  execute: (ctx, p) => ownedOrNotFound(() => getMemoryProvider().confirmMemory(ctx.principalId, p.memoryId)),
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

export const updateMemory = (identity: IdentityContext, input: { memoryId: string; content?: string; confidence?: number }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "MEMORY_UPDATE", parameters: input });
export const confirmMemory = (identity: IdentityContext, input: { memoryId: string }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "MEMORY_CONFIRM", parameters: { memoryId: input.memoryId } });
export const deleteMemory = (identity: IdentityContext, input: { memoryId: string }) =>
  proposeAction(identity, { skillKey: SKILL_KEY, action: "MEMORY_DELETE", parameters: { memoryId: input.memoryId } });
