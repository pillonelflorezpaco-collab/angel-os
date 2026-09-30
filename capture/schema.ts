import { z } from "zod";

// What a model may SAY about a sentence. Closed-world and untrusted: a model returns candidate records and questions — never a
// principal, interface, permission, risk, approval state, action key, table, query, credential or destination. Anything outside
// this vocabulary is rejected (whole output for unknown top-level keys, one candidate for an invalid candidate).

export const CANDIDATE_TYPES = ["EXPERIENCE", "INFERENCE", "DECISION", "RESULT", "LESSON", "EXPERIMENT_OBSERVATION", "FUTURE_SELF_STATE", "NEXT_ACTION"] as const;
export type CandidateType = (typeof CANDIDATE_TYPES)[number];
export const LIMITS = { candidates: 8, clarifications: 3, outputChars: 20_000, textChars: 2000 } as const;

const text = z.string().trim().min(1).max(LIMITS.textChars);
const short = z.string().trim().min(1).max(300);
/** Model metadata only. It is shown to the user and never becomes a stored confidence or a truth value. */
const confidence = z.number().min(0).max(1).optional();
/** A full timestamp or a plain date (read as that day, UTC). Anything else is invalid. */
const when = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(v) && !Number.isNaN(Date.parse(v)), "invalid date").optional();
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const candidateSchema = z.discriminatedUnion("type", [
  strict({ type: z.literal("EXPERIENCE"), content: text, occurredAt: when, confidence }),
  strict({ type: z.literal("INFERENCE"), content: text, confidence }),
  strict({
    type: z.literal("DECISION"), title: short, decision: text, question: text.optional(), reasoning: text.optional(), expectedOutcome: text.optional(), lookbackDate: when,
    options: z.array(strict({ label: short, pros: text.optional(), cons: text.optional() })).min(2).max(6).optional(), chosenOption: short.optional(), confidence,
  }),
  strict({ type: z.literal("RESULT"), statement: text, subject: strict({ kind: z.enum(["GOAL", "PROJECT", "DECISION"]), title: short }), value: z.number().finite().optional(), unit: z.string().trim().min(1).max(40).optional(), confidence }),
  strict({ type: z.literal("LESSON"), content: text, confidence }),
  strict({ type: z.literal("EXPERIMENT_OBSERVATION"), experiment: strict({ hypothesis: text }), text, observedAt: when, confidence }),
  strict({ type: z.literal("FUTURE_SELF_STATE"), aspiration: strict({ title: short }), current: text, gap: text.optional(), desired: text,
    /** Indexes of EXPERIENCE candidates in this same interpretation that are the evidence for the change. */ evidenceFrom: z.array(z.number().int().min(0).max(LIMITS.candidates - 1)).max(5), confidence }),
  strict({ type: z.literal("NEXT_ACTION"), title: short, confidence }),
]);
export type Candidate = z.infer<typeof candidateSchema>;

export const clarificationSchema = strict({ question: text, options: z.array(short).max(4).optional() });
export type Clarification = z.infer<typeof clarificationSchema>;

/** The envelope. Candidates are validated one by one afterwards, so a bad one cannot take a good one down with it. */
const envelope = strict({ summary: text.optional(), candidates: z.array(z.unknown()).max(LIMITS.candidates), clarifications: z.array(z.unknown()).max(LIMITS.clarifications).optional() });

export interface RejectedCandidate { index: number; reason: string; type?: string }
export interface ParsedInterpretation { candidates: { index: number; candidate: Candidate }[]; clarifications: Clarification[]; rejected: RejectedCandidate[]; summary: string | null; failClosed: string | null }

const size = (v: unknown) => { try { return JSON.stringify(v)?.length ?? 0; } catch { return Infinity; } };

export function parseInterpretation(raw: unknown): ParsedInterpretation {
  const closed = (reason: string): ParsedInterpretation => ({ candidates: [], clarifications: [], rejected: [], summary: null, failClosed: reason });
  if (size(raw) > LIMITS.outputChars) return closed("The interpretation was too large.");
  const env = envelope.safeParse(raw);
  if (!env.success) return closed("The interpretation was not in the expected shape."); // unknown top-level keys (principalId, actions, sql…) end here
  const candidates: ParsedInterpretation["candidates"] = [];
  const rejected: RejectedCandidate[] = [];
  env.data.candidates.forEach((item, index) => {
    const type = item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string" ? String((item as { type: string }).type).slice(0, 40) : undefined;
    const p = candidateSchema.safeParse(item);
    if (p.success) candidates.push({ index, candidate: p.data });
    else rejected.push({ index, type, reason: type && !(CANDIDATE_TYPES as readonly string[]).includes(type) ? "That kind of record isn't something Jarvis can capture." : "That candidate had missing, unknown or invalid fields." });
  });
  const clarifications: Clarification[] = [];
  for (const c of env.data.clarifications ?? []) { const p = clarificationSchema.safeParse(c); if (p.success) clarifications.push(p.data); }
  return { candidates, clarifications, rejected, summary: env.data.summary ?? null, failClosed: null };
}
