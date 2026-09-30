import { gatewayExecute, proposeAction, recordAuditEvent } from "../../gateway/index.js";
import { now } from "../../gateway/clock.js";
import { canApproveFrom } from "../../gateway/policy.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import { logInternalError, PublicError } from "../../core/errors.js";
import { JARVIS_AGENT_KEY } from "../agent.js";
import { readLifeOverview } from "./life.js";
import { readFutureOverview } from "./future.js";
import { readExperiments } from "./learning.js";
import { listDecisionRecords } from "./decisions.js";
import { listTasks } from "./tasks.js";
import { getPrincipalTimeZone } from "./principal.js";
import { parseInterpretation } from "../../capture/schema.js";
import type { CaptureModelProvider, CaptureContext } from "../../capture/provider.js";
import { buildProposal, isRef, isSupportedAction, proposalHash, type KnownRefs, type Proposal, type ProposalItem } from "../../capture/proposal.js";
import * as store from "../../capture/store.js";

// Capture: USER TEXT → MODEL (interprets, untrusted) → strict parse → proposal (server-derived actions) → DRAFT (nothing saved) →
// the owner confirms → each mapped ActionDefinition runs through proposeAction (permission, interface policy, risk policy, approval,
// exact binding, audit) exactly as if the owner had clicked it. The model never sees identity or ids and never executes anything.
//
// The interpret/confirm/cancel steps themselves are gated like protected reads (CAPTURE_INTERPRET / CAPTURE_DECIDE): they change no
// domain data, they hold a draft. Domain writes only ever happen inside ActionDefinitions.

export const SKILL_KEY = "system.capture";
export const RESOURCE = "angel:capture";
export const INTERPRET_ACTION = "CAPTURE_INTERPRET";
export const DECIDE_ACTION = "CAPTURE_DECIDE";
export const MODEL_TIMEOUT_MS = 15_000;
export const MAX_TEXT_CHARS = 4000;
const SOURCE = "skill.system.capture";
const FAILED_IDENTITY: Result = { status: "FAILED", message: "I can't do that without knowing who you are." };
const NOT_FOUND: Result = { status: "FAILED", message: "That proposal wasn't found, or it is no longer pending." };

const dataOf = <T>(r: Result): T | null => (r.status === "EXECUTED" ? (r.data as T) : null);
const iso10 = (d: Date, tz: string) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d); } catch { return d.toISOString().slice(0, 10); } };

/** Owner's own records, through permission-checked reads. A domain the caller may not read simply contributes nothing (and can't be referenced). */
async function readRefs(identity: IdentityContext): Promise<{ refs: KnownRefs; context: Omit<CaptureContext, "today" | "timeZone"> }> {
  const agentKey = JARVIS_AGENT_KEY;
  const [life, future, experiments, decisions, tasks] = await Promise.all([
    readLifeOverview(identity, { agentKey }), readFutureOverview(identity, { agentKey }), readExperiments(identity, { agentKey }), listDecisionRecords(identity, { agentKey }), listTasks(identity, { agentKey }),
  ]);
  const l = dataOf<{ goals: { id: string; title: string }[]; projects: { id: string; name: string }[] }>(life);
  const refs: KnownRefs = {
    goals: l?.goals.map((g) => ({ id: g.id, title: g.title })) ?? [],
    projects: l?.projects.map((p) => ({ id: p.id, title: p.name })) ?? [],
    decisions: dataOf<{ id: string; title: string }[]>(decisions)?.map((d) => ({ id: d.id, title: d.title })) ?? [],
    aspirations: dataOf<{ id: string; title: string }[]>(future)?.map((a) => ({ id: a.id, title: a.title })) ?? [],
    experiments: dataOf<{ id: string; hypothesis: string; status: string }[]>(experiments)?.filter((e) => e.status !== "CONFIRMED" && e.status !== "REJECTED").map((e) => ({ id: e.id, title: e.hypothesis })) ?? [],
  };
  const titles = (r: { title: string }[]) => r.map((x) => x.title.slice(0, 200)).slice(0, 30);
  const open = (dataOf<{ title: string; status: string }[]>(tasks) ?? []).filter((t) => t.status === "TODO" || t.status === "IN_PROGRESS");
  return { refs, context: { goals: titles(refs.goals), projects: titles(refs.projects), decisions: titles(refs.decisions), aspirations: titles(refs.aspirations), experiments: titles(refs.experiments), openTasks: open.map((t) => t.title.slice(0, 200)).slice(0, 30) } };
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error("model timeout")); }, ms); });
  try { return await Promise.race([run(ctl.signal), timeout]); } finally { if (timer) clearTimeout(timer); }
}

const audit = (identity: IdentityContext, action: string, result: "SUCCESS" | "FAILURE" | "DENIED", metadata: Record<string, unknown>) =>
  recordAuditEvent({ principalId: identity.principalId, agentKey: JARVIS_AGENT_KEY, eventType: result === "SUCCESS" ? "ACTION_EXECUTED" : "ACTION_REJECTED", resource: RESOURCE, action, result, source: SOURCE, metadata })
    .catch((err) => logInternalError("capture.audit", err));

const view = (id: string, p: Proposal, expiresAt: Date) => ({
  proposalId: id, expiresAt: expiresAt.toISOString(), nothingSaved: true as const,
  understood: p.understood, items: p.items.map(({ index, type, status, summary, note, question, modelConfidence, dependsOn, action }) => ({ index, type, status, summary, note, question, modelConfidence, dependsOn, wouldRun: action ? `${action.skillKey}/${action.action}` : null })),
  clarifications: p.clarifications, rejected: p.rejected, failClosed: p.failClosed,
});

/** Interpret a sentence into a DRAFT proposal. Saves nothing but the draft; runs nothing. */
export async function interpretCapture(identity: IdentityContext, input: { text: string; provider: CaptureModelProvider }): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return FAILED_IDENTITY; }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return { status: "FAILED", message: "Tell me what happened, decided or learned." };
  if (text.length > MAX_TEXT_CHARS) return { status: "FAILED", message: `That is too long to interpret at once (the limit is ${MAX_TEXT_CHARS} characters).` };
  return gatewayExecute({ principalId: who.principalId, agentKey: JARVIS_AGENT_KEY, skillKey: SKILL_KEY, resource: RESOURCE, action: INTERPRET_ACTION, parameters: { chars: text.length, provider: input.provider.name } }, async () => {
    const { refs, context } = await readRefs(who);
    const timeZone = await getPrincipalTimeZone(who.principalId);
    const at = now();
    let raw: unknown;
    try { raw = await withTimeout((signal) => input.provider.interpret({ text, context: { today: iso10(at, timeZone), timeZone, ...context } }, signal), MODEL_TIMEOUT_MS); }
    catch (err) { logInternalError("capture.model", err); await audit(who, INTERPRET_ACTION, "FAILURE", { reason: "model unavailable", provider: input.provider.name }); throw new PublicError("I couldn't interpret that right now. Nothing was saved."); }
    const parsed = parseInterpretation(raw);
    const proposal = buildProposal(parsed, refs);
    const draft = await store.saveDraft({ principalId: who.principalId, interfaceSource: who.interfaceSource, proposal, proposalHash: proposalHash(proposal.items), now: at });
    await audit(who, INTERPRET_ACTION, "SUCCESS", { proposalId: draft.id, provider: input.provider.name, candidates: proposal.items.map((i) => `${i.type}:${i.status}`), rejected: proposal.rejected.length, failClosed: proposal.failClosed });
    return view(draft.id, proposal, draft.expiresAt);
  }, SOURCE);
}

export interface ItemOutcome { index: number; type: string; status: "EXECUTED" | "PENDING_APPROVAL" | "FAILED" | "DENIED" | "SKIPPED"; message: string; recordId?: string }

const substitute = (v: unknown, created: Map<number, string>): unknown => {
  if (isRef(v)) return created.get(v.$ref);
  if (Array.isArray(v)) return v.map((x) => substitute(x, created));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, created)]));
  return v;
};

/** Confirm (all, or only `accept`ed items). Each item is an ordinary proposed action; the gateway still decides every one. */
export async function confirmCapture(identity: IdentityContext, input: { proposalId: string; accept?: number[] }): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return FAILED_IDENTITY; }
  // Only an interface that may approve can confirm (policy: SYSTEM and unknown interfaces never can).
  if (!canApproveFrom(who.interfaceSource, "LOW")) return { status: "DENIED", message: "This interface can't confirm a proposal." };
  return gatewayExecute({ principalId: who.principalId, agentKey: JARVIS_AGENT_KEY, skillKey: SKILL_KEY, resource: RESOURCE, action: DECIDE_ACTION, parameters: { op: "confirm", proposalId: input.proposalId } }, async () => {
    const draft = await store.getDraft(who.principalId, input.proposalId);
    if (!draft) throw new NotFound();
    const proposal = draft.proposal as unknown as Proposal;
    if (proposalHash(proposal.items) !== draft.proposalHash) { await audit(who, DECIDE_ACTION, "DENIED", { proposalId: draft.id, reason: "hash mismatch" }); throw new PublicError("That proposal failed its integrity check, so nothing was run."); }
    if (!(await store.claimDraft(who.principalId, draft.id, "CONFIRMED", now()))) throw new NotFound();
    const accept = input.accept ? new Set(input.accept) : null;
    const runnable = proposal.items.filter((i) => i.status === "READY" && i.action && (!accept || accept.has(i.index)));
    const created = new Map<number, string>();
    const outcomes = new Map<number, ItemOutcome>();
    const skip = (i: ProposalItem, message: string) => outcomes.set(i.index, { index: i.index, type: i.type, status: "SKIPPED", message });
    const pending = [...runnable];
    while (pending.length) {
      const next = pending.findIndex((i) => i.dependsOn.every((d) => created.has(d) || !runnable.some((r) => r.index === d) || outcomes.has(d)));
      const item = pending.splice(next === -1 ? 0 : next, 1)[0];
      const blocker = item.dependsOn.find((d) => !created.has(d));
      if (blocker !== undefined) { skip(item, `Not run: it depends on #${blocker}, which was not saved.`); continue; }
      const a = item.action!;
      if (!isSupportedAction(a.skillKey, a.action)) { skip(item, "Not run: that action isn't one capture can perform."); await audit(who, DECIDE_ACTION, "DENIED", { proposalId: draft.id, reason: "unsupported action", skillKey: a.skillKey, action: a.action }); continue; }
      const r = await proposeAction(who, { skillKey: a.skillKey, action: a.action, parameters: substitute(a.parameters, created) });
      const recordId = r.status === "EXECUTED" && r.data && typeof (r.data as { id?: unknown }).id === "string" ? (r.data as { id: string }).id : undefined;
      if (recordId) created.set(item.index, recordId);
      outcomes.set(item.index, { index: item.index, type: item.type, status: r.status === "EXECUTED" || r.status === "PENDING_APPROVAL" || r.status === "DENIED" ? r.status : "FAILED", message: r.message, recordId });
    }
    for (const i of proposal.items) if (!outcomes.has(i.index)) outcomes.set(i.index, { index: i.index, type: i.type, status: "SKIPPED", message: i.status === "READY" ? "Not confirmed." : i.note ?? "Not proposed." });
    const list = [...outcomes.values()].sort((x, y) => x.index - y.index);
    await store.writeOutcome(who.principalId, draft.id, list);
    await audit(who, DECIDE_ACTION, "SUCCESS", { proposalId: draft.id, op: "confirm", outcomes: list.map((o) => `${o.type}:${o.status}`) });
    return { proposalId: draft.id, outcomes: list };
  }, SOURCE);
}

/** Cancel: nothing is ever written. */
export async function cancelCapture(identity: IdentityContext, input: { proposalId: string }): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return FAILED_IDENTITY; }
  return gatewayExecute({ principalId: who.principalId, agentKey: JARVIS_AGENT_KEY, skillKey: SKILL_KEY, resource: RESOURCE, action: DECIDE_ACTION, parameters: { op: "cancel", proposalId: input.proposalId } }, async () => {
    if (!(await store.claimDraft(who.principalId, input.proposalId, "CANCELLED", now()))) throw new NotFound();
    await audit(who, DECIDE_ACTION, "SUCCESS", { proposalId: input.proposalId, op: "cancel" });
    return { proposalId: input.proposalId, cancelled: true, nothingSaved: true };
  }, SOURCE);
}

class NotFound extends PublicError { constructor() { super(NOT_FOUND.message); } }

// ── Conversation helpers (Jarvis Core: "confirm" / "cancel" refer to the newest pending draft from this interface) ──
async function latestPendingId(who: IdentityContext): Promise<string | null> {
  const r = await gatewayExecute({ principalId: who.principalId, agentKey: JARVIS_AGENT_KEY, skillKey: SKILL_KEY, resource: RESOURCE, action: DECIDE_ACTION, parameters: { op: "latest" } },
    async () => (await store.latestPending(who.principalId, who.interfaceSource, now()))?.id ?? null, SOURCE);
  return r.status === "EXECUTED" ? (r.data as string | null) : null;
}
const NOTHING_PENDING: Result = { status: "FAILED", message: "There is nothing waiting to be confirmed." };
export async function confirmLatestCapture(identity: IdentityContext): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return FAILED_IDENTITY; }
  const id = await latestPendingId(who);
  return id ? confirmCapture(who, { proposalId: id }) : NOTHING_PENDING;
}
export async function cancelLatestCapture(identity: IdentityContext): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return FAILED_IDENTITY; }
  const id = await latestPendingId(who);
  return id ? cancelCapture(who, { proposalId: id }) : NOTHING_PENDING;
}

type ProposalView = ReturnType<typeof view>;
/** Plain-language text for a chat surface. The wording is the server's; nothing the model wrote is treated as an instruction. */
export function formatProposal(p: ProposalView): string {
  const lines: string[] = [];
  if (p.failClosed) return `${p.failClosed} Nothing was proposed and nothing has been saved.`;
  if (p.items.length) {
    lines.push("I understood:");
    p.items.forEach((i, n) => lines.push(`${n + 1}. ${i.type}: ${i.summary}${i.status === "READY" ? "" : ` — ${i.status === "NEEDS_CLARIFICATION" ? "needs a clarification" : "can't be saved"}${i.note ? ` (${i.note})` : ""}`}`));
  } else if (!p.clarifications.length) lines.push("I didn't find anything I can save from that.");
  for (const c of p.clarifications) lines.push(`Question: ${c.question}${c.options?.length ? ` (${c.options.join(" / ")})` : ""}`);
  for (const r of p.rejected) lines.push(`Not understood (item ${r.index + 1}): ${r.reason}`);
  const ready = p.items.filter((i) => i.status === "READY").length;
  lines.push(ready ? `Nothing has been saved yet. Say “confirm” to save the ${ready} ready item${ready === 1 ? "" : "s"}, or “cancel”.` : "Nothing has been saved.");
  return lines.join("\n");
}
const OUTCOME_WORDS: Record<ItemOutcome["status"], string> = { EXECUTED: "Saved", PENDING_APPROVAL: "Waiting for your approval", DENIED: "Not allowed", FAILED: "Failed — nothing saved", SKIPPED: "Not saved" };
export function formatOutcomes(outcomes: ItemOutcome[]): string {
  return outcomes.length ? outcomes.map((o) => `${o.index + 1}. ${o.type}: ${OUTCOME_WORDS[o.status]} — ${o.message}`).join("\n") : "There was nothing to save.";
}
