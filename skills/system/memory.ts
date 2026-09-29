import { getMemoryProvider } from "../../memory/index.js";
import type { AddMemoryInput, SearchMemoryInput, UpdateMemoryInput } from "../../memory/types/index.js";
import { gatewayExecute } from "../../gateway/index.js";
import type { Result } from "../../core/types/index.js";

// Fixes the Jarvis Core bypass found in the audit: memory operations used to
// call MemoryProvider directly from core/index.ts, with no permission check
// and no audit trail. Every memory operation now goes through this skill,
// which routes through gatewayExecute like skills/system/tasks.ts does.

export const SKILL_KEY = "system.memory";
export const RESOURCE = "angel:memory";

export interface RememberInput {
  principalId: string;
  agentKey: string;
  memory: Omit<AddMemoryInput, "principalId">;
}

export async function remember(input: RememberInput): Promise<Result> {
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "MEMORY_WRITE",
      parameters: { type: input.memory.type, content: input.memory.content },
    },
    () => getMemoryProvider().addMemory({ ...input.memory, principalId: input.principalId }),
    "skill.system.memory"
  );
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
