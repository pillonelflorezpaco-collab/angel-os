import { readerIdentity, IDENTITY_REQUIRED } from "../readerIdentity.js";
import { z } from "zod";
import { proposeAction } from "../../gateway/index.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import * as decisions from "../../life/decisions.js";
import { define } from "./life.js";
import { getDb } from "../../db/client/index.js";
import { gatewayExecute } from "../../gateway/index.js";
import type { Result } from "../../core/types/index.js";

// Fixes the Jarvis Core bypass found in the audit: decision.query used to
// query Prisma directly from core/index.ts. Decision reads now go through
// this skill and the gateway, same as every other domain operation.

export const SKILL_KEY = "system.decisions";
export const RESOURCE = "angel:decisions";

export interface QueryDecisionsInput {
  agentKey: string;
  topic: string;
}

export async function queryDecisions(identity: IdentityContext, raw: QueryDecisionsInput): Promise<Result> {
  const who = readerIdentity(identity);
  if (!who) return IDENTITY_REQUIRED;
  const input = { ...raw, principalId: who.principalId };
  const result = await gatewayExecute(
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
  if (result.status !== "EXECUTED") return result;
  const decisions = result.data as { title: string; decision: string }[];
  return {
    ...result,
    message: decisions.length
      ? `Decisions about "${input.topic}":\n` + decisions.map((d) => `• ${d.title}: ${d.decision}`).join("\n")
      : `No recorded decision about "${input.topic}".`,
  };
}

// ── Decision records (BUILD #13) ────────────────────────────────────────────
const id = z.string().uuid();
const text = z.string().trim().min(1).max(2000);
const short = z.string().trim().min(1).max(300);
const evidence = z.object({ kind: z.enum(["MEMORY", "KNOWLEDGE", "TASK", "NOTE"]), refId: id.optional(), note: text.optional() }).strict();
const option = z.object({ label: short, pros: text.optional(), cons: text.optional() }).strict();
const target = { skillKey: SKILL_KEY, resource: RESOURCE };

/**
 * A decision is history: recorded once, never rewritten. To change your mind, record a NEW
 * decision that supersedes it. Evidence labels are snapshotted from the owner's own rows.
 */
export const decisionRecordDefinition = define(
  {
    action: "DECISION_RECORD",
    schema: z.object({
      title: short, decision: text, question: text.optional(), context: text.optional(), reasoning: text.optional(), expected: text.optional(),
      reviewAt: z.string().datetime().optional(), projectId: id.optional(), supersedesId: id.optional(),
      options: z.array(option).min(2).max(6).optional(), chosenIndex: z.number().int().min(0).max(5).optional(),
      evidence: z.array(evidence).max(10).optional(),
    }).strict(),
    describe: (p) => `Record decision: ${p.title}`,
    run: (pid, p) => decisions.recordDecision(pid, { ...p, reviewAt: p.reviewAt ? new Date(p.reviewAt) : undefined }),
    message: (_r, p) => `Decision recorded: ${p.title}`,
    activity: (d: { id: string }) => ({ type: "DECISION", summary: "Recorded a decision", refType: "decision", refId: d.id }),
  },
  target
);

/** The look-back: compare what happened with what was expected. Set once. */
export const decisionReviewDefinition = define(
  {
    action: "DECISION_REVIEW",
    schema: z.object({ decisionId: id, outcome: text, lesson: text.optional() }).strict(),
    describe: (p) => `Review decision ${p.decisionId}`,
    run: (pid, p) => decisions.reviewDecision(pid, p.decisionId, p),
    message: () => "Decision reviewed.",
  },
  target
);

export const DECISION_DEFINITIONS = [decisionRecordDefinition, decisionReviewDefinition];

export function proposeDecision(identity: IdentityContext, action: "DECISION_RECORD" | "DECISION_REVIEW", parameters: unknown) {
  return proposeAction(identity, { skillKey: SKILL_KEY, action, parameters });
}

export async function readDecision(identity: IdentityContext, input: { agentKey: string; decisionId: string }) {
  return readOne(identity, input.agentKey, { op: "get", decisionId: input.decisionId }, (pid) => decisions.getDecision(pid, input.decisionId));
}
export async function listDecisionRecords(identity: IdentityContext, input: { agentKey: string; dueForReview?: boolean }) {
  return readOne(identity, input.agentKey, { op: "list", due: input.dueForReview ?? false }, (pid) => decisions.listDecisions(pid, { dueForReview: input.dueForReview }));
}
function readOne<T>(identity: IdentityContext, agentKey: string, parameters: Record<string, unknown>, fn: (principalId: string) => Promise<T>) {
  let explicit: IdentityContext;
  try { explicit = assertExplicitIdentity(identity); } catch { return Promise.resolve({ status: "FAILED", message: "I can't do that without knowing who you are." } as Result); }
  return gatewayExecute({ principalId: explicit.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: "DECISION_READ", parameters }, () => fn(explicit.principalId), "skill.system.decisions");
}
