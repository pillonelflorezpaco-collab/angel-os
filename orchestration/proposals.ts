import { z } from "zod";

// Pure validation of untrusted model output. Nothing here consults the database or the registry.
// A proposal is exactly {skillKey, action, parameters}. Anything else on it — a principal id, an identity,
// an approval id, a "force" flag — makes the proposal REJECTED, because the model has no such powers.

export const LIMITS = { maxProposals: 5, maxOutputChars: 16_000, maxReplyChars: 1_500, maxParamsChars: 6_000, keyChars: 100 } as const;

const proposalShape = z
  .object({
    skillKey: z.string().min(1).max(LIMITS.keyChars),
    action: z.string().min(1).max(LIMITS.keyChars),
    parameters: z.record(z.unknown()),
  })
  .strict();

export interface Proposal { skillKey: string; action: string; parameters: Record<string, unknown> }
export interface Rejection { index: number; reason: string; skillKey?: string; action?: string }
export interface ParsedOutput { proposals: Proposal[]; reply: string | null; rejected: Rejection[] }

const sizeOf = (v: unknown): number => { try { return JSON.stringify(v)?.length ?? 0; } catch { return Infinity; } };

/** Stable key for de-duplication: same skill, action and canonically-serialised parameters. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export function parseModelOutput(raw: unknown): ParsedOutput {
  const empty: ParsedOutput = { proposals: [], reply: null, rejected: [] };
  if (sizeOf(raw) > LIMITS.maxOutputChars) return { ...empty, rejected: [{ index: -1, reason: "output too large" }] };
  // A bare string is treated as a plain reply with no proposals.
  if (typeof raw === "string") return { ...empty, reply: raw.trim().slice(0, LIMITS.maxReplyChars) || null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...empty, rejected: [{ index: -1, reason: "output is not an object" }] };
  const o = raw as Record<string, unknown>;
  const reply = typeof o.reply === "string" ? o.reply.trim().slice(0, LIMITS.maxReplyChars) || null : null;
  const items = Array.isArray(o.proposals) ? o.proposals : [];
  const rejected: Rejection[] = [];
  const proposals: Proposal[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (proposals.length >= LIMITS.maxProposals) return rejected.push({ index, reason: "too many proposals" });
    const parsed = proposalShape.safeParse(item);
    const label = item && typeof item === "object" ? { skillKey: String((item as any).skillKey ?? "").slice(0, LIMITS.keyChars), action: String((item as any).action ?? "").slice(0, LIMITS.keyChars) } : {};
    if (!parsed.success) return rejected.push({ index, reason: "malformed proposal (only skillKey, action and parameters are allowed)", ...label });
    if (sizeOf(parsed.data.parameters) > LIMITS.maxParamsChars) return rejected.push({ index, reason: "parameters too large", ...label });
    const key = `${parsed.data.skillKey}|${parsed.data.action}|${canonical(parsed.data.parameters)}`;
    if (seen.has(key)) return rejected.push({ index, reason: "duplicate proposal", ...label });
    seen.add(key);
    proposals.push(parsed.data);
  });
  return { proposals, reply, rejected };
}
