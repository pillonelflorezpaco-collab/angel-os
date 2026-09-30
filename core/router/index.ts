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

  // "What matters?" — open loops that already exist; English and French phrasings.
  if (/^(what matters|what should i (do|focus on)|what.?s (open|waiting|next)|what remains open|qu.est-ce qui compte|qu.est-ce que je dois faire|quoi faire)\b/i.test(lower)) return { name: "today.loops", raw: text, slots: {} };

  // Only these exact words act on a pending capture draft; anything else that merely contains them is not a confirmation.
  if (/^confirm( (that|it|all|the (draft|proposal|capture)))?[.!]*$/i.test(lower)) return { name: "capture.confirm", raw: text, slots: {} };
  if (/^cancel( (that|it|the (draft|proposal|capture)))?[.!]*$/i.test(lower)) return { name: "capture.cancel", raw: text, slots: {} };

  if (/^(remember|note) (that )?/i.test(lower)) {
    const content = text.replace(/^(remember|note) (that )?/i, "").trim();
    return { name: "memory.remember", raw: text, slots: { content } };
  }

  if (/^(what do i know about|what did i learn about|search (my )?memory)/i.test(lower)) {
    const query = text.replace(/^(what do i know about|what did i learn about|search (my )?memory( for)?)/i, "").replace(/[?.!]+$/, "").trim();
    return { name: "memory.search", raw: text, slots: { query } };
  }

  // "What do YOU know about X?" / "brief me on X" / "tell me about X": the full context, not just memory.
  const briefMatch = text.match(/^(?:what do you know about|brief me on|tell me about|what can you tell me about)\s+(.+?)[?.!]*$/i);
  if (briefMatch) return { name: "context.brief", raw: text, slots: { topic: briefMatch[1].trim() } };

  if (/^what did i decide about /i.test(lower)) {
    const topic = text.replace(/^what did i decide about /i, "").trim();
    return { name: "decision.query", raw: text, slots: { topic } };
  }

  if (/^(what happened today|what did i do today|what have i done today)/i.test(lower)) {
    return { name: "activity.today", raw: text, slots: {} };
  }

  if (/^(what have i done this week|what did i do this week|what happened this week)/i.test(lower)) {
    return { name: "activity.week", raw: text, slots: {} };
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
