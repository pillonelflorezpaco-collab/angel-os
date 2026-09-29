import { recordAuditEvent } from "../gateway/index.js";
import { isProposable, listProposableActions, proposeFromModel } from "../skills/system/jarvis.js";
import { assertExplicitIdentity, type IdentityContext } from "../identity/index.js";
import { logInternalError } from "../core/errors.js";
import type { ContextPackage, Result } from "../core/types/index.js";
import { JARVIS_AGENT_KEY } from "../skills/agent.js";
import { parseModelOutput, LIMITS, type Proposal } from "./proposals.js";
import type { ModelProvider } from "./types.js";

// Jarvis orchestration: the model PROPOSES, the OS ENFORCES.
//
//   explicit identity → permission-aware context (data, built by Core) → ModelProvider (untrusted)
//     → strict validation of its output → for each proposal: proposeAction(identity, …)
//     → (permission · interface policy · risk policy · approval · exact binding · audit) → results
//
// The model cannot approve, cannot name a principal, cannot read around the gateway, and cannot make the
// user-visible outcome sound better than it was: the outcome lines are written HERE from real Results, and
// the model's own words are shown afterwards, labelled as the model's.

export const MODEL_TIMEOUT_MS = 15_000;
const SOURCE = "jarvis.orchestrator";

export interface OrchestrateOptions {
  provider: ModelProvider;
  /** Built by the caller (Jarvis Core) with the permission-aware context engine — the orchestrator itself reads nothing. */
  context: ContextPackage;
  timeoutMs?: number;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error("model timeout")); }, ms); });
  try { return await Promise.race([run(ctl.signal), timeout]); } finally { if (timer) clearTimeout(timer); }
}

const audit = (identity: IdentityContext, action: string | undefined, reason: string, metadata: Record<string, unknown> = {}) =>
  recordAuditEvent({ principalId: identity.principalId, agentKey: JARVIS_AGENT_KEY, eventType: "ACTION_REJECTED", resource: "orchestrator", action, result: "DENIED", source: SOURCE, metadata: { reason, ...metadata } })
    .catch((err) => logInternalError("orchestrator.audit", err));

const line = (p: Proposal, r: Result): string => {
  switch (r.status) {
    case "EXECUTED": return `✓ ${r.message}`;
    case "PENDING_APPROVAL": return `⏳ Needs your approval: ${r.message}`;
    case "DENIED": return `✗ Not allowed: ${p.action}`;
    default: return `✗ Failed: ${r.message}`;
  }
};

export async function orchestrate(identity: IdentityContext | undefined, userText: string, options: OrchestrateOptions): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return { status: "FAILED", message: "I can't do that without knowing who you are." }; }

  let raw: unknown;
  try {
    raw = await withTimeout((signal) => options.provider.propose({ userText, context: options.context, tools: listProposableActions() }, signal), options.timeoutMs ?? MODEL_TIMEOUT_MS);
  } catch (err) {
    logInternalError("orchestrator.model", err);
    await audit(who, undefined, "model unavailable", { provider: options.provider.name });
    return { status: "FAILED", message: "I couldn't work that out right now. Nothing was changed." };
  }

  const parsed = parseModelOutput(raw);
  for (const r of parsed.rejected) await audit(who, r.action, r.reason, { skillKey: r.skillKey, index: r.index, provider: options.provider.name });

  const lines: string[] = [];
  const results: { proposal: Proposal; result: Result }[] = [];
  for (const proposal of parsed.proposals) {
    // Only registered ActionDefinitions can be proposed. Reads, approvals and anything unknown never reach the gateway.
    if (!isProposable(proposal.skillKey, proposal.action)) {
      await audit(who, proposal.action, "unknown action", { skillKey: proposal.skillKey, provider: options.provider.name });
      lines.push(`✗ I can't do "${proposal.action}".`);
      continue;
    }
    let result: Result;
    try { result = await proposeFromModel(who, proposal); } catch (err) {
      logInternalError("orchestrator.propose", err);
      result = { status: "FAILED", message: "That didn't work." };
    }
    results.push({ proposal, result });
    lines.push(line(proposal, result));
  }
  if (parsed.rejected.length) lines.push(`(${parsed.rejected.length} suggestion${parsed.rejected.length === 1 ? "" : "s"} ignored as invalid.)`);
  if (parsed.reply) lines.push(`Jarvis says: ${parsed.reply}`);

  const executed = results.filter((r) => r.result.status === "EXECUTED").length;
  const status: Result["status"] = results.length === 0 ? "EXECUTED"
    : results.some((r) => r.result.status === "PENDING_APPROVAL") ? "PENDING_APPROVAL"
    : executed === results.length ? "EXECUTED"
    : results.every((r) => r.result.status === "DENIED") ? "DENIED" : "FAILED";
  return {
    status,
    message: lines.length ? lines.join("\n") : "I have nothing to do for that.",
    data: results.map(({ proposal, result }) => ({ skillKey: proposal.skillKey, action: proposal.action, status: result.status, approvalId: result.approvalId })),
  };
}

export { LIMITS };
