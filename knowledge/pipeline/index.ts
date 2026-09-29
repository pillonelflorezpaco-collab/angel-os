/** Mirrors the database enum (kept local so the pipeline stays free of any database/client import). */
export type KnowledgeKind =
  | "FACT" | "CONCEPT" | "PRINCIPLE" | "METHOD" | "PERSON" | "EVENT" | "DATE" | "QUESTION" | "HYPOTHESIS" | "INSIGHT" | "CONTRADICTION" | "EXPERIENCE";

// The ingestion pipeline: INGEST → PARSE → EXTRACT → CLASSIFY → CONNECT.
// (STORE and RETRIEVE live in knowledge/store.) It is PURE and deterministic:
// no database, no network, no filesystem, no model. Input is untrusted text;
// output is a list of candidate items and candidate relations that the store
// validates and persists inside one transaction.
//
// Honesty rule: the pipeline never asserts more than the source did. An
// unmarked heading is a CONCEPT (a described subject); FACT / HYPOTHESIS /
// INSIGHT / PRINCIPLE ... appear ONLY where the text says so explicitly
// ("Fact: ...", "Hypothesis: ..."). Nothing is guessed. A future model-based
// extractor plugs in through the `Extractor` interface and may only PROPOSE
// candidates — they go through the same validation and the same
// ActionDefinition.

export const LIMITS = {
  MAX_CONTENT_CHARS: 100_000,
  MAX_ITEMS: 200,
  MAX_TITLE_CHARS: 200,
  MAX_BODY_CHARS: 8_000,
} as const;

export type SourceFormat = "markdown" | "text";

export interface ParsedLine {
  text: string;
}

export interface Section {
  /** 0 = text before the first heading. */
  level: number;
  heading: string | null;
  lines: string[];
}

export interface ParsedDocument {
  sections: Section[];
}

export interface Candidate {
  /** Position in the output list; relations refer to it. */
  key: number;
  kind: KnowledgeKind;
  title: string;
  body: string;
  confidence: number | null;
  eventAt: Date | null;
  /** The candidate this one is part of, or null. */
  parentKey: number | null;
}

export interface CandidateRelation {
  fromKey: number;
  toKey: number;
  kind: "PART_OF";
}

export interface PipelineResult {
  candidates: Candidate[];
  relations: CandidateRelation[];
  /** Items whose body exceeded the limit and was cut (reported, never silent). */
  truncated: number;
}

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface Extractor {
  extract(doc: ParsedDocument): { candidates: Candidate[]; relations: CandidateRelation[]; truncated: number };
}

// ── PARSE ────────────────────────────────────────────────────────────────

/** Strips control characters (keeping newline/tab), normalizes line endings. */
export function normalizeText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function parse(content: string, format: SourceFormat): ParsedDocument {
  const text = normalizeText(content);
  if (!text.trim()) throw new PipelineError("There is no content to ingest.");
  if (text.length > LIMITS.MAX_CONTENT_CHARS) throw new PipelineError("That document is too large to ingest.");
  const sections: Section[] = [{ level: 0, heading: null, lines: [] }];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = format === "markdown" && !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) sections.push({ level: heading[1].length, heading: heading[2].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return { sections };
}

// ── CLASSIFY ─────────────────────────────────────────────────────────────

const MARKERS: Record<string, KnowledgeKind> = {
  fact: "FACT",
  concept: "CONCEPT",
  principle: "PRINCIPLE",
  method: "METHOD",
  person: "PERSON",
  event: "EVENT",
  date: "DATE",
  question: "QUESTION",
  hypothesis: "HYPOTHESIS",
  insight: "INSIGHT",
  experience: "EXPERIENCE",
  contradiction: "CONTRADICTION",
};

const MARKED_LINE = /^\s*(?:[-*+]\s+)?(fact|concept|principle|method|person|event|date|question|hypothesis|insight|experience|contradiction)\s*:\s*(.+?)\s*$/i;
const MARKED_HEADING = /^(fact|concept|principle|method|person|event|date|question|hypothesis|insight|experience|contradiction)\s*:\s*(.+)$/i;

/** The kind an explicit marker names; anything unmarked is a CONCEPT — never a stronger claim. */
export function classifyKind(marker: string | undefined): KnowledgeKind {
  return marker ? (MARKERS[marker.toLowerCase()] ?? "CONCEPT") : "CONCEPT";
}

function defaultConfidence(kind: KnowledgeKind): number | null {
  return kind === "HYPOTHESIS" ? 0.5 : null; // a hypothesis is by definition not established
}

/** First real ISO calendar date in the text, or null. */
export function firstIsoDate(text: string): Date | null {
  const m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

// ── EXTRACT + CONNECT (deterministic default extractor) ──────────────────

export const markdownExtractor: Extractor = {
  extract(doc) {
    const candidates: Candidate[] = [];
    const relations: CandidateRelation[] = [];
    let truncated = 0;
    const clip = (s: string, max: number) => (s.length > max ? ((truncated += max === LIMITS.MAX_BODY_CHARS ? 1 : 0), s.slice(0, max)) : s);
    const add = (c: Omit<Candidate, "key">): number => {
      if (candidates.length >= LIMITS.MAX_ITEMS) throw new PipelineError(`That document produces more than ${LIMITS.MAX_ITEMS} items; split it.`);
      const key = candidates.length;
      candidates.push({ ...c, key });
      if (c.parentKey !== null) relations.push({ fromKey: key, toKey: c.parentKey, kind: "PART_OF" });
      return key;
    };
    const stack: { level: number; key: number }[] = []; // heading nesting → PART_OF

    for (const section of doc.sections) {
      let sectionKey: number | null = null;
      const bodyLines: string[] = [];
      const marked: { kind: KnowledgeKind; text: string }[] = [];
      for (const line of section.lines) {
        const m = MARKED_LINE.exec(line);
        if (m) marked.push({ kind: classifyKind(m[1]), text: m[2] });
        else bodyLines.push(line);
      }
      const body = bodyLines.join("\n").trim();

      if (section.heading !== null) {
        const hm = MARKED_HEADING.exec(section.heading);
        const kind = classifyKind(hm?.[1]);
        const title = (hm ? hm[2] : section.heading).trim();
        while (stack.length && stack[stack.length - 1].level >= section.level) stack.pop();
        sectionKey = add({
          kind,
          title: clip(title, LIMITS.MAX_TITLE_CHARS),
          body: clip(body, LIMITS.MAX_BODY_CHARS),
          confidence: defaultConfidence(kind),
          eventAt: kind === "EVENT" || kind === "DATE" ? firstIsoDate(title) ?? firstIsoDate(body) : null,
          parentKey: stack.length ? stack[stack.length - 1].key : null,
        });
        stack.push({ level: section.level, key: sectionKey });
      } else if (body) {
        // Text before the first heading (or a note with no structure at all): keep it retrievable as ONE
        // described subject titled by its source — never dropped, and never upgraded into a claim.
        sectionKey = add({ kind: "CONCEPT", title: "", body: clip(body, LIMITS.MAX_BODY_CHARS), confidence: null, eventAt: null, parentKey: null });
      }

      for (const item of marked) {
        add({
          kind: item.kind,
          title: clip(item.text, LIMITS.MAX_TITLE_CHARS),
          body: clip(item.text, LIMITS.MAX_BODY_CHARS),
          confidence: defaultConfidence(item.kind),
          eventAt: item.kind === "EVENT" || item.kind === "DATE" ? firstIsoDate(item.text) : null,
          parentKey: sectionKey ?? (stack.length ? stack[stack.length - 1].key : null),
        });
      }
    }
    return { candidates, relations, truncated };
  },
};

/** Runs the whole pipeline. `titleFallback` names an item that has no title of its own (a headingless note). */
export function runPipeline(content: string, format: SourceFormat, titleFallback: string, extractor: Extractor = markdownExtractor): PipelineResult {
  const doc = parse(content, format);
  const out = extractor.extract(doc);
  const candidates = out.candidates.map((c) => ({ ...c, title: c.title || titleFallback.slice(0, LIMITS.MAX_TITLE_CHARS) }));
  if (candidates.length === 0) throw new PipelineError("Nothing could be extracted: add headings or explicit markers like \"Fact: …\".");
  return { candidates, relations: out.relations, truncated: out.truncated };
}
