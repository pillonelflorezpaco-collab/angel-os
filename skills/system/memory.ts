import { getMemoryProvider } from "../../memory/index.js";
import type { AddMemoryInput, MemoryRecord, SearchMemoryInput, UpdateMemoryInput } from "../../memory/types/index.js";
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
  action: "MEMORY_WRITE",
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
    action: "MEMORY_WRITE",
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

export interface UpdateInput {
  principalId: string;
  agentKey: string;
  memoryId: string;
  update: UpdateMemoryInput;
}

export async function update(input: UpdateInput): Promise<Result> {
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "MEMORY_WRITE",
      parameters: { memoryId: input.memoryId },
    },
    () => getMemoryProvider().updateMemory(input.principalId, input.memoryId, input.update),
    "skill.system.memory"
  );
}

export interface DeleteInput {
  principalId: string;
  agentKey: string;
  memoryId: string;
}

export async function remove(input: DeleteInput): Promise<Result> {
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "MEMORY_WRITE",
      parameters: { memoryId: input.memoryId },
    },
    () => getMemoryProvider().deleteMemory(input.principalId, input.memoryId),
    "skill.system.memory"
  );
}

export interface ConfirmInput {
  principalId: string;
  agentKey: string;
  memoryId: string;
}

export async function confirm(input: ConfirmInput): Promise<Result> {
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "MEMORY_WRITE",
      parameters: { memoryId: input.memoryId },
    },
    () => getMemoryProvider().confirmMemory(input.principalId, input.memoryId),
    "skill.system.memory"
  );
}
