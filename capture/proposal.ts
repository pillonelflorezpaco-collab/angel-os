import { createHash } from "node:crypto";
import { canonical } from "../orchestration/proposals.js";
import type { Candidate, CandidateType, Clarification, ParsedInterpretation, RejectedCandidate } from "./schema.js";

// PROPOSAL ENGINE (pure). Turns validated candidates into an inspectable proposal: for each candidate, either the ONE existing
// ActionDefinition that would record it (with exact parameters the server derived), or an honest reason it can't. Nothing here
// executes, reads a database or trusts the model beyond the words it was given. The server, not the model, chooses the action,
// the source label, the record ids (resolved by exact title among the owner's own records) and every default.

export interface NamedRef { id: string; title: string }
/** The owner's own records, read through the permission-checked skills. Titles are how a sentence names them; ids never go to the model. */
export interface KnownRefs { goals: NamedRef[]; projects: NamedRef[]; decisions: NamedRef[]; aspirations: NamedRef[]; experiments: NamedRef[] }
export const NO_REFS: KnownRefs = { goals: [], projects: [], decisions: [], aspirations: [], experiments: [] };

/** The only actions a capture can ever run. A stored or tampered proposal naming anything else is refused at confirmation. */
export const SUPPORTED_ACTIONS: readonly (readonly [string, string])[] = [
  ["system.memory", "MEMORY_CREATE"], ["system.decisions", "DECISION_RECORD"], ["system.life", "RESULT_RECORD"],
  ["system.learning", "EXPERIMENT_OBSERVE"], ["system.future", "ASPIRATION_STATE_RECORD"], ["system.tasks", "CREATE_TASK"],
];
export const isSupportedAction = (skillKey: string, action: string) => SUPPORTED_ACTIONS.some(([s, a]) => s === skillKey && a === action);
export const CAPTURE_SOURCE = "jarvis-capture";

export type ItemStatus = "READY" | "UNSUPPORTED" | "INVALID" | "NEEDS_CLARIFICATION";
export interface ProposedAction { skillKey: string; action: string; parameters: Record<string, unknown> }
export interface ProposalItem {
  index: number;
  type: CandidateType;
  status: ItemStatus;
  /** Server-written, plain-language line for the confirmation screen. */
  summary: string;
  note?: string;
  question?: Clarification;
  action?: ProposedAction;
  /** Indexes of items that must succeed first; their created record id replaces the {$ref} placeholder in the parameters. */
  dependsOn: number[];
  /** Model metadata, shown as-is. It never changes what is saved. */
  modelConfidence: number | null;
}
export interface Proposal { understood: string[]; items: ProposalItem[]; clarifications: Clarification[]; rejected: RejectedCandidate[]; failClosed: string | null; nothingSaved: true }

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export const isRef = (v: unknown): v is { $ref: number } => !!v && typeof v === "object" && Object.keys(v).length === 1 && Number.isInteger((v as { $ref?: unknown }).$ref);
const iso = (d?: string) => (d ? (d.length === 10 ? `${d}T00:00:00.000Z` : new Date(d).toISOString()) : undefined);
const clip = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n)}…` : t);

function resolve(list: NamedRef[], title: string): { id: string } | { question: Clarification; note: string } {
  const hits = list.filter((r) => norm(r.title) === norm(title));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length === 0) return { note: `I couldn't find “${clip(title, 80)}” among your records.`, question: { question: `Which existing record do you mean by “${clip(title, 80)}”?`, options: list.slice(0, 4).map((r) => clip(r.title, 80)) } };
  return { note: `More than one record is called “${clip(title, 80)}”.`, question: { question: `Which “${clip(title, 80)}” do you mean?`, options: hits.slice(0, 4).map((r) => clip(r.title, 80)) } };
}

export function buildProposal(parsed: ParsedInterpretation, refs: KnownRefs = NO_REFS): Proposal {
  const byIndex = new Map(parsed.candidates.map((c) => [c.index, c.candidate]));
  const items: ProposalItem[] = [];
  const done = new Map<number, ProposalItem>();

  const make = (index: number, c: Candidate): ProposalItem => {
    const base = { index, type: c.type, dependsOn: [] as number[], modelConfidence: "confidence" in c && typeof c.confidence === "number" ? c.confidence : null };
    const ready = (summary: string, action: ProposedAction, note?: string, dependsOn: number[] = []): ProposalItem => ({ ...base, status: "READY", summary, action, note, dependsOn });
    const stop = (status: ItemStatus, summary: string, note: string, question?: Clarification): ProposalItem => ({ ...base, status, summary, note, question });
    switch (c.type) {
      case "EXPERIENCE":
        return ready(`You experienced: ${clip(c.content)}`, { skillKey: "system.memory", action: "MEMORY_CREATE", parameters: { type: "EXPERIENCE", content: c.content, source: CAPTURE_SOURCE, ...(c.occurredAt ? { occurredAt: iso(c.occurredAt) } : {}) } }, "Saved as a lived experience.");
      case "INFERENCE":
        return ready(`Jarvis's reading (not a fact): ${clip(c.content)}`, { skillKey: "system.memory", action: "MEMORY_CREATE", parameters: { type: "INFERENCE", content: c.content, source: CAPTURE_SOURCE } }, "Saved as an unconfirmed inference. Confirming this proposal does not make it a fact.");
      case "LESSON":
        return ready(`A lesson you drew: ${clip(c.content)}`, { skillKey: "system.memory", action: "MEMORY_CREATE", parameters: { type: "LESSON", content: c.content, source: CAPTURE_SOURCE } });
      case "NEXT_ACTION":
        return ready(`A next action: ${clip(c.title)}`, { skillKey: "system.tasks", action: "CREATE_TASK", parameters: { title: c.title } });
      case "DECISION": {
        let chosenIndex: number | undefined;
        if (c.chosenOption !== undefined) {
          if (!c.options) return stop("INVALID", `Decision: ${clip(c.decision)}`, "A chosen option needs the list of options it was chosen from.");
          const at = c.options.findIndex((o) => norm(o.label) === norm(c.chosenOption!));
          if (at === -1) return stop("NEEDS_CLARIFICATION", `Decision: ${clip(c.decision)}`, "The chosen option is not one of the options listed.", { question: "Which of the options did you choose?", options: c.options.map((o) => clip(o.label, 80)).slice(0, 4) });
          chosenIndex = at;
        }
        return ready(`You decided: ${clip(c.decision)}`, { skillKey: "system.decisions", action: "DECISION_RECORD", parameters: {
          title: c.title, decision: c.decision, ...(c.question ? { question: c.question } : {}), ...(c.reasoning ? { reasoning: c.reasoning } : {}), ...(c.expectedOutcome ? { expected: c.expectedOutcome } : {}),
          ...(c.lookbackDate ? { reviewAt: iso(c.lookbackDate) } : {}), ...(c.options ? { options: c.options } : {}), ...(chosenIndex !== undefined ? { chosenIndex } : {}) } });
      }
      case "RESULT": {
        if ((c.value === undefined) !== (c.unit === undefined)) return stop("INVALID", `Result: ${clip(c.statement)}`, "A measurement needs both a value and a unit.");
        const list = c.subject.kind === "GOAL" ? refs.goals : c.subject.kind === "PROJECT" ? refs.projects : refs.decisions;
        const r = resolve(list, c.subject.title);
        if (!("id" in r)) return stop("NEEDS_CLARIFICATION", `Result: ${clip(c.statement)}`, r.note, r.question);
        return ready(`A result for the ${c.subject.kind.toLowerCase()} “${clip(c.subject.title, 80)}”: ${clip(c.statement)}`, { skillKey: "system.life", action: "RESULT_RECORD", parameters: { subjectKind: c.subject.kind, subjectId: r.id, statement: c.statement, ...(c.value !== undefined ? { value: c.value, unit: c.unit } : {}) } });
      }
      case "EXPERIMENT_OBSERVATION": {
        const r = resolve(refs.experiments, c.experiment.hypothesis);
        if (!("id" in r)) return stop("NEEDS_CLARIFICATION", `Observation: ${clip(c.text)}`, r.note, r.question);
        return ready(`An observation for the experiment “${clip(c.experiment.hypothesis, 80)}”: ${clip(c.text)}`, { skillKey: "system.learning", action: "EXPERIMENT_OBSERVE", parameters: { experimentId: r.id, text: c.text, ...(c.observedAt ? { observedAt: iso(c.observedAt) } : {}) } }, "An observation is not a conclusion; it does not change the experiment's status.");
      }
      case "FUTURE_SELF_STATE": {
        const summary = `Your current state for “${clip(c.aspiration.title, 80)}”: ${clip(c.current)}`;
        const r = resolve(refs.aspirations, c.aspiration.title);
        if (!("id" in r)) return stop("NEEDS_CLARIFICATION", summary, r.note, r.question);
        if (c.evidenceFrom.length === 0) return stop("UNSUPPORTED", summary, "A change to your Future Self state must cite evidence. Nothing in this sentence is recorded evidence, so nothing was proposed. Record the experience it rests on first (or say it in the same message).");
        const deps: number[] = [];
        for (const from of new Set(c.evidenceFrom)) {
          const src = byIndex.get(from);
          if (!src) return stop("INVALID", summary, `The evidence it points to (#${from}) is not a valid candidate.`);
          if (src.type !== "EXPERIENCE") return stop("INVALID", summary, `Only a lived experience can be evidence for a state (#${from} is ${src.type.toLowerCase()}). An inference, lesson or fact is not evidence.`);
          const built = done.get(from) ?? make(from, src);
          done.set(from, built);
          if (built.status !== "READY") return stop("INVALID", summary, `The experience it rests on (#${from}) can't be recorded, so this state can't be either.`);
          deps.push(from);
        }
        return ready(summary, { skillKey: "system.future", action: "ASPIRATION_STATE_RECORD", parameters: {
          aspirationId: r.id, current: c.current, ...(c.gap ? { gap: c.gap } : {}), desired: c.desired, evidence: deps.map((d) => ({ sourceKind: "MEMORY", sourceId: { $ref: d }, stance: "SUPPORTS" })) } }, "Recorded as a new dated state, with the experience(s) above linked as supporting evidence.", deps);
      }
    }
  };

  for (const { index, candidate } of parsed.candidates) { const item = done.get(index) ?? make(index, candidate); done.set(index, item); items.push(item); }
  items.sort((a, b) => a.index - b.index);
  const understood = items.map((i, n) => `${n + 1}. ${i.type}: ${i.summary}${i.status === "READY" ? "" : ` — ${i.status === "NEEDS_CLARIFICATION" ? "needs a clarification" : i.status.toLowerCase()}`}`);
  return { understood, items, clarifications: parsed.clarifications, rejected: parsed.rejected, failClosed: parsed.failClosed, nothingSaved: true };
}

/** What the confirmation will actually run, hashed: any change to an action, parameter, dependency or order changes the hash. */
export function proposalHash(items: ProposalItem[]): string {
  const runnable = items.filter((i) => i.status === "READY" && i.action).map((i) => ({ index: i.index, action: i.action, dependsOn: i.dependsOn }));
  return createHash("sha256").update(canonical(runnable)).digest("hex");
}
