import type { Intent, IntentName } from "../types/index.js";

/**
 * v0.1 deterministic intent parser. Regex-based on purpose — see
 * docs/ROADMAP.md for the planned upgrade to an LLM-assisted parser once
 * the deterministic core is proven. This intentionally does NOT call an
 * LLM: v0.1's whole point is a pipeline that is understandable end to end.
 */
export function parseIntent(raw: string): Intent {
  const text = raw.trim();
  const lower = text.toLowerCase();

  const remindMatch = text.match(
    /remind me (?:tomorrow at (\d{1,2})(?::(\d{2}))?|on (\S+))\s*(?:to\s+)?(.*)/i
  );
  if (remindMatch) {
    const [, hour, minute, dateWord, message] = remindMatch;
    return {
      name: "reminder.create",
      raw: text,
      slots: {
        hour,
        minute: minute ?? "00",
        dateWord,
        message: message?.trim() || text,
      },
    };
  }

  if (/^(what are my (current )?reminders|what reminders do i have|show( me)? my reminders|list( my)? reminders)\b/i.test(lower)) {
    return { name: "reminder.list", raw: text, slots: {} };
  }

  if (/^(what are my (current )?tasks|list (my )?tasks)/i.test(lower)) {
    return { name: "task.list", raw: text, slots: {} };
  }

  if (/^(remember|note) (that )?/i.test(lower)) {
    const content = text.replace(/^(remember|note) (that )?/i, "").trim();
    return { name: "memory.remember", raw: text, slots: { content } };
  }

  if (/^(what do i know about|search (my )?memory)/i.test(lower)) {
    const query = text.replace(/^(what do i know about|search (my )?memory( for)?)/i, "").trim();
    return { name: "memory.search", raw: text, slots: { query } };
  }

  if (/^what did i decide about /i.test(lower)) {
    const topic = text.replace(/^what did i decide about /i, "").trim();
    return { name: "decision.query", raw: text, slots: { topic } };
  }

  if (/^(what do i have today|what.?s on my calendar( today)?|what are my calendar events( today)?)/i.test(lower)) {
    return { name: "calendar.today", raw: text, slots: {} };
  }

  if (/^(add|create) task/i.test(lower)) {
    const title = text.replace(/^(add|create) task[: ]?/i, "").trim();
    return { name: "task.create", raw: text, slots: { title } };
  }

  return { name: "unknown" as IntentName, raw: text, slots: {} };
}
