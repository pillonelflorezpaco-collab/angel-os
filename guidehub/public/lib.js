// Pure helpers for the cockpit UI (no DOM, no network) so the rules from docs/guidehub/cockpit-design.md are unit-tested.

export const CSRF = { "X-Requested-With": "guidehub-cockpit" };

/** §4 of the design: one component, honest outcomes. `body` is the parsed JSON (or null). */
export function writeOutcome(httpStatus, body) {
  const message = typeof body?.message === "string" ? body.message : "";
  if (httpStatus === 401) return { kind: "auth", tone: "bad", text: "Your session ended. Sign in again." };
  if (httpStatus === 502) return { kind: "unavailable", tone: "bad", text: typeof body?.error === "string" ? body.error : "The service is unavailable right now." };
  if (httpStatus === 200 && body?.status === "EXECUTED") return { kind: "success", tone: "good", text: message || "Done." };
  if (httpStatus === 202 && body?.status === "PENDING_APPROVAL") return { kind: "pending", tone: "warn", text: message || "This needs your approval.", approvalId: body.approvalId };
  if (httpStatus === 403) return { kind: "denied", tone: "bad", text: "You don't have permission to do that." };
  if (httpStatus === 404) return { kind: "notFound", tone: "bad", text: "That item no longer exists." };
  if (httpStatus === 422) return { kind: "invalid", tone: "bad", text: message || "That didn't work." };
  if (httpStatus === 400) return { kind: "client", tone: "bad", text: "Something went wrong with that request." };
  return { kind: "error", tone: "bad", text: "Something went wrong." };
}

/** Approve/deny results resolve ONLY from the response — never optimistically. */
export function approvalOutcome(httpStatus, body, decision) {
  if (httpStatus === 200) {
    if (decision === "deny") return { tone: "neutral", done: true, text: "Denied. Nothing was changed." };
    if (body?.executed === true) return { tone: "good", done: true, text: "Approved and done." };
    return { tone: "bad", done: true, text: "Approved, but it failed. Nothing was changed." };
  }
  if (httpStatus === 409) return { tone: "neutral", done: true, text: "Already decided." };
  if (httpStatus === 410) return { tone: "neutral", done: true, text: "This request expired." };
  if (httpStatus === 403) return { tone: "bad", done: false, text: "This interface can't approve this action." };
  if (httpStatus === 404) return { tone: "neutral", done: true, text: "That request no longer exists." };
  if (httpStatus === 401) return { tone: "bad", done: false, text: "Your session ended. Sign in again." };
  return { tone: "bad", done: false, text: "Couldn't record your decision. Try again." };
}

/** null means NO EVIDENCE — never zero, never an empty bar. */
export function progressLabel(progress) {
  if (progress === null || progress === undefined) return "No measured readings yet";
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return pct >= 100 ? "Target reached by recorded readings — you decide when it's achieved" : `${pct}% by recorded readings`;
}

export function countdown(expiresAtIso, nowMs) {
  const ms = new Date(expiresAtIso).getTime() - nowMs;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "expired";
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  return `in ${h} h ${min % 60} min`;
}

const SECTION_NAMES = { tasks: "Tasks", memories: "Memories", knowledge: "Knowledge", decisions: "Decisions", history: "Recent activity", life: "Goals and projects", future: "Aspirations", learning: "Learning" };
const name = (s) => SECTION_NAMES[s] ?? s;

/** `withheld` and `unavailable` are never an empty state. */
export function sectionNotices(ctx) {
  return [
    ...(ctx?.withheld ?? []).map((s) => ({ section: s, kind: "withheld", text: `${name(s)}: not available to Jarvis (no permission).` })),
    ...(ctx?.unavailable ?? []).map((s) => ({ section: s, kind: "unavailable", text: `${name(s)}: couldn't be read right now.` })),
  ];
}

/** A memory keeps its type on screen: a guess is never shown as a fact. */
export function memoryLine(m) {
  if (m.type === "INFERENCE") return { label: m.confirmed ? "Inference (confirmed)" : "Jarvis thinks (unconfirmed)", text: m.content, guess: !m.confirmed };
  return { label: (m.type ?? "fact").toLowerCase(), text: m.content, guess: false };
}

export function learningLine(t) {
  return `${t.title} — ${t.minutesLast7Days} min in the last 7 days (self-reported), ${t.due} of ${t.cards} cards due`;
}

export function riskLabel(risk) {
  return risk === "DANGEROUS" ? "Dangerous" : risk === "SENSITIVE" ? "Sensitive" : "Routine";
}

export function formatWhen(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timeZone || undefined, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

export const GRADES = [
  { value: 0, label: "Again" },
  { value: 1, label: "Hard" },
  { value: 2, label: "Good" },
  { value: 3, label: "Easy" },
];

/**
 * The API returns lists in two shapes: a bare array (approvals) or a Result {status, data: [...]} (decisions, learning, …).
 * Returns the array, or null when the call did not succeed — so a failure is never mistaken for "an empty list".
 */
export function listFrom(httpStatus, body) {
  if (httpStatus !== 200) return null;
  if (Array.isArray(body)) return body;
  if (body?.status === "EXECUTED" && Array.isArray(body.data)) return body.data;
  return null;
}

// ── Step 2: Life ───────────────────────────────────────────────────────────
// The UI only OFFERS transitions the API allows (mirroring life/store.ts). The server stays the authority: a stale screen still gets a 422, never a bypass.

export const HORIZONS = [{ value: "SHORT", label: "Short term" }, { value: "MEDIUM", label: "Medium term" }, { value: "LONG", label: "Long term" }];

const words = (s) => String(s ?? "").toLowerCase().replace(/_/g, " ");
export const statusLabel = words;

/** ACTIVE ⇄ PAUSED; ACTIVE|PAUSED → COMPLETED; COMPLETED can be reopened; ARCHIVED is final. */
export function projectTransitions(status) {
  switch (status) {
    case "ACTIVE": return [{ to: "PAUSED", label: "Pause" }, { to: "COMPLETED", label: "Mark complete" }, { to: "ARCHIVED", label: "Archive" }];
    case "PAUSED": return [{ to: "ACTIVE", label: "Resume" }, { to: "COMPLETED", label: "Mark complete" }, { to: "ARCHIVED", label: "Archive" }];
    case "COMPLETED": return [{ to: "ACTIVE", label: "Reopen" }, { to: "ARCHIVED", label: "Archive" }];
    default: return [];
  }
}

/** `ask` says what the user must provide first: a reason (abandon) or an optional note (complete). Completion is the owner's claim, never automatic. */
export function questTransitions(status) {
  if (status === "PLANNED") return [{ action: "QUEST_START", label: "Start" }, { action: "QUEST_ABANDON", label: "Abandon", ask: "reason" }];
  if (status === "ACTIVE") return [{ action: "QUEST_COMPLETE", label: "Mark complete", ask: "note" }, { action: "QUEST_ABANDON", label: "Abandon", ask: "reason" }];
  return [];
}

export function taskTransitions(status) {
  return status === "TODO" || status === "IN_PROGRESS" ? [{ action: "TASK_COMPLETE", label: "Done" }, { action: "TASK_CANCEL", label: "Cancel" }] : [];
}

/** Terminal means terminal: these never get an edit or reopen control. */
export function isTerminal(kind, status) {
  const t = { goal: ["ACHIEVED", "ABANDONED"], quest: ["COMPLETED", "ABANDONED"], task: ["DONE", "CANCELLED"], project: ["ARCHIVED"], vision: ["ARCHIVED"] };
  return (t[kind] ?? []).includes(status);
}

/** A date input value (YYYY-MM-DD) → a UTC instant at noon, so the same calendar date shows everywhere. Invalid → null. */
export function dateToInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d.toISOString();
}

export function formatDateOnly(iso) {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", dateStyle: "medium" }).format(new Date(iso)); } catch { return String(iso); }
}

/**
 * Form values → an action body: strings trimmed, empty values dropped (the API wants ABSENT, not ""), date fields converted.
 * Never adds anything the user did not type: no ids of its own, no principal, no status.
 */
export function buildBody(values, dateFields = []) {
  const body = {};
  const invalid = [];
  for (const [k, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null) continue;
    const v = typeof raw === "string" ? raw.trim() : raw;
    if (v === "") continue;
    if (dateFields.includes(k)) {
      const iso = dateToInstant(v);
      if (!iso) { invalid.push(k); continue; }
      body[k] = iso;
    } else body[k] = v;
  }
  return { body, invalid };
}

export function taskCountsLine(c) {
  const parts = [`${c?.open ?? 0} open`, `${c?.done ?? 0} done`];
  if (c?.cancelled) parts.push(`${c.cancelled} cancelled`);
  return parts.join(" · ");
}

/** A 202 from a Life write means "waiting for you" — the item is NOT created/changed yet. */
export function lifeOutcome(httpStatus, body) {
  const o = writeOutcome(httpStatus, body);
  return o.kind === "pending" ? { ...o, text: "Sent for your approval — nothing has changed yet." } : o;
}

/** Only people not already linked to the project can be offered in the link picker. */
export function linkablePeople(all, linked) {
  const taken = new Set((linked ?? []).map((l) => l.personId ?? l.person?.id));
  return (all ?? []).filter((p) => !taken.has(p.id));
}

/** Hash routes: #/future-self, #/learning, #/today, #/life, #/life/projects/<uuid>, #/decisions, #/decisions/<uuid>. Anything else falls back to Today. */
export function parseRoute(hash) {
  const h = String(hash ?? "").replace(/^#\/?/, "");
  if (h === "" || h === "today") return { view: "today" };
  if (h === "life") return { view: "life" };
  const m = /^life\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(h);
  if (m) return { view: "project", id: m[1] };
  if (h === "capture") return { view: "capture" };
  if (h === "future-self") return { view: "future" };
  if (h === "learning") return { view: "learning" };
  if (h === "decisions") return { view: "decisions" };
  const d = /^decisions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(h);
  if (d) return { view: "decision", id: d[1] };
  return { view: "today" };
}

// ── Step 3: Decisions ──────────────────────────────────────────────────────
// A decision is HISTORY: recorded once, never edited. Changing your mind records a NEW decision that supersedes the old one (which can be
// superseded once). The look-back (outcome + lesson) is filled in exactly once and is never graded — expected and actual sit side by side.

export const LIMITS = { options: { min: 2, max: 6 }, evidence: 10 };
export const EVIDENCE_KINDS = [{ value: "NOTE", label: "A note" }, { value: "MEMORY", label: "A memory" }, { value: "KNOWLEDGE", label: "Knowledge" }, { value: "TASK", label: "A task" }];

/** Where a decision stands. `supersededBy` is only present on the detail read; a list row cannot know it. */
export function decisionStatus(d, nowMs) {
  if (d.supersededBy) return { kind: "superseded", label: "Replaced by a newer decision" };
  if (d.reviewedAt) return { kind: "reviewed", label: "Looked back on" };
  if (d.reviewAt && new Date(d.reviewAt).getTime() <= nowMs) return { kind: "due", label: "Time to look back" };
  if (d.reviewAt) return { kind: "waiting", label: `Look back on ${formatDateOnly(d.reviewAt)}` };
  return { kind: "recorded", label: "Recorded" };
}

/** A decision can be replaced only if it has not been already. Reviewing is allowed once, at any time before it is done. */
export const canSupersede = (d) => !d.supersededBy;
export const canReview = (d) => !d.reviewedAt;

/**
 * Form state → DECISION_RECORD body, with the same rules the server enforces (so the user sees them before sending; the server still decides).
 * options: [{label,pros,cons}], chosen: index or null, evidence: [{kind, refId?, note?}].
 * Never adds anything of its own: no principal, no status, no labels for evidence (the server snapshots those from the owner's own rows).
 */
export function buildDecisionBody(values, options = [], chosen = null, evidence = [], supersedesId = null) {
  const errors = [];
  const { body, invalid } = buildBody(values, ["reviewAt"]);
  for (const f of invalid) errors.push(`${f} isn't a valid date`);
  if (!body.title) errors.push("A title is needed.");
  if (!body.decision) errors.push("What did you decide?");
  const opts = options
    .map((o) => buildBody({ label: o.label, pros: o.pros, cons: o.cons }).body)
    .filter((o) => o.label);
  if (opts.length > 0) {
    if (opts.length < LIMITS.options.min) errors.push(`Give at least ${LIMITS.options.min} options, or none.`);
    if (opts.length > LIMITS.options.max) errors.push(`At most ${LIMITS.options.max} options.`);
    if (chosen !== null && chosen !== undefined) {
      // `chosen` indexes the ORIGINAL rows; re-map it onto the filtered list so an empty row above it cannot shift the choice.
      const original = options[chosen];
      const idx = original ? opts.findIndex((o) => o.label === buildBody({ label: original.label }).body.label) : -1;
      if (idx < 0) errors.push("The chosen option must have a label.");
      else body.chosenIndex = idx;
    }
    body.options = opts;
  } else if (chosen !== null && chosen !== undefined) errors.push("Choose among options you have listed.");
  const ev = [];
  for (const e of evidence) {
    if (e.kind === "NOTE") { const n = (e.note ?? "").trim(); if (n) ev.push({ kind: "NOTE", note: n }); }
    else if (e.refId) ev.push({ kind: e.kind, refId: e.refId });
  }
  if (ev.length > LIMITS.evidence) errors.push(`At most ${LIMITS.evidence} pieces of evidence.`);
  if (ev.length) body.evidence = ev;
  if (supersedesId) body.supersedesId = supersedesId;
  return { body, errors };
}

/** Evidence labels are the server's snapshots; the kind tells how far to trust them (a reference is not an upgrade). */
export function evidenceTag(kind) {
  return { MEMORY: "memory", KNOWLEDGE: "knowledge", TASK: "task", NOTE: "note" }[kind] ?? String(kind).toLowerCase();
}

/** Result measurement text — both value and unit, or neither. */
export function resultLine(r) {
  const m = r.value !== null && r.value !== undefined && r.unit ? ` — ${r.value} ${r.unit}` : "";
  return `${r.statement}${m}`;
}

/** A search hit → a picker row, whatever the source. Only fields the picker needs; never HTML. */
export function pickerRow(kind, hit) {
  if (kind === "MEMORY") return { refId: hit.id, title: hit.content, sub: memoryLine({ ...hit, confirmed: hit.confirmed ?? hit.status === "ACTIVE" }).label };
  if (kind === "KNOWLEDGE") return { refId: hit.id, title: hit.title, sub: hit.kind ? String(hit.kind).toLowerCase() : "knowledge" };
  return { refId: hit.id, title: hit.title, sub: statusLabel(hit.status) };
}

/**
 * A list row cannot say whether a NEWER decision replaced it, but the newer one names it (`supersedesId`). Marks the replaced ones,
 * so a superseded decision is never presented as "time to look back". Only sees the rows it is given (the API returns the latest 100).
 */
export function withSuperseded(list) {
  const replaced = new Map((list ?? []).filter((d) => d.supersedesId).map((d) => [d.supersedesId, d.id]));
  return (list ?? []).map((d) => ({ ...d, supersededBy: replaced.has(d.id) ? { id: replaced.get(d.id) } : null }));
}

/** A result about one decision: a statement, and a measurement only as a value AND a unit together. */
export function buildResultBody(values, subjectId) {
  const { body } = buildBody({ statement: values.statement, unit: values.unit });
  const errors = [];
  if (!body.statement) errors.push("Say what happened.");
  const rawValue = typeof values.value === "string" ? values.value.trim() : values.value;
  const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== "";
  if (hasValue) {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) errors.push("The value must be a number.");
    else body.value = n;
  }
  if (hasValue !== Boolean(body.unit)) errors.push("A measurement needs both a value and a unit.");
  return { body: { subjectKind: "DECISION", subjectId, ...body }, errors };
}

// ── Step 5: Future Self + Learning ─────────────────────────────────────────
// Wording only. Every rule about states, evidence and hypotheses lives on the server; the server's refusal is shown as-is.

export const HYPOTHESIS_LABELS = {
  CANDIDATE: "Candidate — proposed, nothing observed yet",
  OBSERVED: "Observed — something was seen",
  SUPPORTED: "Supported — evidence points this way",
  CONFIRMED: "Confirmed — held up in this experiment",
  REJECTED: "Rejected — did not hold up",
};
export const hypothesisLabel = (s) => HYPOTHESIS_LABELS[s] ?? String(s).toLowerCase();
export const HYPOTHESIS_ORDER = ["CANDIDATE", "OBSERVED", "SUPPORTED", "CONFIRMED", "REJECTED"];
/** A closed record has no controls; everything else is the server's call. */
export const isClosedExperiment = (s) => s === "CONFIRMED" || s === "REJECTED";

export const STANCES = [{ value: "SUPPORTS", label: "Supporting evidence" }, { value: "CONTRADICTS", label: "Contradicting evidence" }, { value: "CONTEXT", label: "Context only" }];
export const stanceLabel = (s) => STANCES.find((x) => x.value === s)?.label ?? String(s).toLowerCase();

/** What kind of evidence this is, from what the SERVER says the source is. Only lived records are "lived evidence". */
export function evidenceKindLabel(link) {
  if (link.sourceKind === "MEMORY") {
    if (link.memoryType === "EXPERIENCE") return "Lived experience";
    if (link.memoryType === "LESSON") return "Lesson";
    return `Memory (${String(link.memoryType ?? "unknown").toLowerCase()}) — not lived evidence`;
  }
  return { RESULT: "Result", DECISION: "Decision", TASK: "Task", QUEST: "Quest", LEARNING_SESSION: "Study session", METRIC_READING: "Metric reading", OBSERVATION: "Observation" }[link.sourceKind] ?? String(link.sourceKind).toLowerCase();
}

/** Text for one evidence link. A source that can no longer be read is said so, never guessed at. */
export function evidenceText(link) {
  if (link.retracted) return "This source was retracted later.";
  return link.label ?? "This source is no longer available.";
}

export function evidenceGroups(links) {
  const list = Array.isArray(links) ? links : [];
  return STANCES.map((s) => ({ ...s, items: list.filter((l) => l.stance === s.value) }));
}

/** "Recorded on" for states, so history reads as history and not as current truth. */
export function stateHeading(state, index, total) {
  const when = formatDateOnly(state.createdAt);
  const kind = state.basis === "INITIAL" ? "Starting state recorded" : "Updated state recorded";
  return `${kind} on ${when}${index === total - 1 ? " — latest" : " — earlier"}`;
}

export function metricReadingLine(m) {
  if (m.latest === null || m.latest === undefined) return "No readings recorded yet.";
  return `Latest recorded reading: ${m.latest} ${m.unit}${m.lastObservedAt ? ` on ${formatDateOnly(m.lastObservedAt)}` : ""}.`;
}

/** Body for ASPIRATION_STATE_RECORD. Empty optional fields are left out; the evidence items carry ids the server looked up, never labels. */
export function buildStateBody(aspirationId, values, evidence) {
  const { body } = buildBody({ current: values.current, gap: values.gap, desired: values.desired, note: values.note });
  const errors = [];
  if (!body.current) errors.push("Describe the current state in your words.");
  if (!body.desired) errors.push("Describe the desired state.");
  if (!evidence.length) errors.push("Add at least one piece of evidence.");
  return { body: { aspirationId, ...body, evidence: evidence.map(({ sourceKind, sourceId, stance }) => ({ sourceKind, sourceId, stance })) }, errors };
}

// ── Capture: a draft proposal the owner confirms ───────────────────────────
export const CAPTURE_TYPE_LABELS = {
  EXPERIENCE: "Experience", INFERENCE: "Interpretation (not a fact)", DECISION: "Decision", RESULT: "Result", LESSON: "Lesson",
  EXPERIMENT_OBSERVATION: "Experiment observation", FUTURE_SELF_STATE: "Future Self state", NEXT_ACTION: "Next action",
};
export const captureTypeLabel = (t) => CAPTURE_TYPE_LABELS[t] ?? String(t).toLowerCase();
/** Only READY items can be saved; the others say why not, in the server's words. */
export const captureCanSave = (item) => item?.status === "READY";
export function captureStatusLabel(status) {
  return { READY: "Ready to save", NEEDS_CLARIFICATION: "Needs a clarification", UNSUPPORTED: "Can't be saved from a sentence", INVALID: "Can't be saved" }[status] ?? String(status).toLowerCase();
}
export function captureOutcomeLabel(status) {
  return { EXECUTED: "Saved", PENDING_APPROVAL: "Waiting for your approval", DENIED: "Not allowed", FAILED: "Failed — nothing saved", SKIPPED: "Not saved" }[status] ?? String(status).toLowerCase();
}
/** Body for confirm: the item numbers the owner ticked. No text, ids or labels ever travel back — the server holds the exact draft. */
export function buildCaptureConfirmBody(checkedIndexes) {
  return { accept: [...new Set(checkedIndexes)].filter((n) => Number.isInteger(n) && n >= 0 && n < 8).sort((a, b) => a - b) };
}
