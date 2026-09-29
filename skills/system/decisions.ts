import { getDb } from "../../db/client/index.js";
import { gatewayExecute } from "../../gateway/index.js";
import type { Result } from "../../core/types/index.js";

// Fixes the Jarvis Core bypass found in the audit: decision.query used to
// query Prisma directly from core/index.ts. Decision reads now go through
// this skill and the gateway, same as every other domain operation.

export const SKILL_KEY = "system.decisions";
export const RESOURCE = "angel:decisions";

export interface QueryDecisionsInput {
  principalId: string;
  agentKey: string;
  topic: string;
}

export async function queryDecisions(input: QueryDecisionsInput): Promise<Result> {
  return gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: "DECISION_READ",
      parameters: { topic: input.topic },
    },
    async () => {
      const db = getDb();
      return db.decision.findMany({
        where: { principalId: input.principalId, title: { contains: input.topic, mode: "insensitive" } },
        orderBy: { decidedAt: "desc" },
      });
    },
    "skill.system.decisions"
  );
}
