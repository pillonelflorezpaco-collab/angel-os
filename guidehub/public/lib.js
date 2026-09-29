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
  if (progress === null || progress === undefined) return "No evidence yet";
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

/** Hash routes: #/today, #/life, #/life/projects/<uuid>. Anything else falls back to Today. */
export function parseRoute(hash) {
  const h = String(hash ?? "").replace(/^#\/?/, "");
  if (h === "" || h === "today") return { view: "today" };
  if (h === "life") return { view: "life" };
  const m = /^life\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(h);
  if (m) return { view: "project", id: m[1] };
  return { view: "today" };
}
