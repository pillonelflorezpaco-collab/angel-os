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
