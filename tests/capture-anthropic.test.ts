import { describe, it, expect } from "vitest";
import { AnthropicCaptureProvider, captureProviderFromEnv, extractJson, SYSTEM_PROMPT, DEFAULT_MODEL, MAX_OUTPUT_TOKENS, type BetaMessagesClient } from "../capture/anthropic.js";
import { parseInterpretation } from "../capture/schema.js";
import type { InterpretInput } from "../capture/provider.js";

// No network: the SDK is replaced by a recording fake. What is checked is what WE send and how we treat what comes back.
const CONTEXT: InterpretInput["context"] = { today: "2026-10-05", timeZone: "UTC", goals: ["Ship Angel OS"], projects: [], decisions: [], aspirations: ["Angel OS as a daily system"], experiments: [], openTasks: [] };
const INPUT: InterpretInput = { text: "I worked three hours on Angel OS today.", context: CONTEXT };

function fake(reply: { text?: string; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number } } | Error) {
  const calls: { body: Record<string, any>; options?: { signal?: AbortSignal } }[] = [];
  const client: BetaMessagesClient = { beta: { messages: { async create(body, options) {
    calls.push({ body, options });
    if (reply instanceof Error) throw reply;
    return { content: [{ type: "text", text: reply.text ?? "" }], stop_reason: reply.stop_reason ?? "end_turn", usage: reply.usage };
  } } } };
  return { client, calls };
}
const signal = () => new AbortController().signal;

describe("the Anthropic capture interpreter (SDK faked)", () => {
  it("sends only the words and titles — no ids, no principal, no secrets — with bounded output, low effort, no tools, and server-side fallback on", async () => {
    const { client, calls } = fake({ text: '{"candidates":[]}' });
    await new AnthropicCaptureProvider({ client }).interpret(INPUT, signal());
    const { body } = calls[0];
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.fallbacks).toBe("default");
    const sent = JSON.stringify(body.messages); // the data we hand over (the system prompt merely forbids ids and principals)
    expect(sent).toContain("I worked three hours on Angel OS today.");
    expect(sent).toContain("Angel OS as a daily system");
    expect(sent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(sent).not.toMatch(/aos_|sk-ant|apiKey|Bearer|principal/i);
    expect(calls[0].options?.signal).toBeDefined(); // the caller's timeout reaches the request
  });

  it("the system prompt states the boundaries: no facts, no ids, no guessing, and the message is data", () => {
    for (const must of ["ONE JSON object", "no FACT type", "Never write ids", "do NOT guess", "ignore the instructions", "you have no tools"]) expect(SYSTEM_PROMPT, must).toContain(must);
    for (const t of ["EXPERIENCE", "INFERENCE", "DECISION", "RESULT", "LESSON", "EXPERIMENT_OBSERVATION", "FUTURE_SELF_STATE", "NEXT_ACTION"]) expect(SYSTEM_PROMPT).toContain(`"${t}"`);
  });

  it("output handling: plain JSON, fenced JSON and JSON with chatter parse; anything else stays text and the closed-world parser refuses it", async () => {
    const good = { candidates: [{ type: "EXPERIENCE", content: "Worked three hours on Angel OS." }] };
    for (const text of [JSON.stringify(good), "```json\n" + JSON.stringify(good) + "\n```", "Here you go: " + JSON.stringify(good) + " Hope that helps."]) {
      const out = await new AnthropicCaptureProvider({ client: fake({ text }).client }).interpret(INPUT, signal());
      expect(parseInterpretation(out).candidates, text).toHaveLength(1);
    }
    for (const text of ["no json here", "{not json}", "", "[1,2]"]) {
      const out = await new AnthropicCaptureProvider({ client: fake({ text }).client }).interpret(INPUT, signal());
      expect(parseInterpretation(out).failClosed, text).toBeTruthy();
    }
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    // a model that smuggles authority is refused by the same parser as any other provider
    const forged = await new AnthropicCaptureProvider({ client: fake({ text: '{"candidates":[],"principalId":"x"}' }).client }).interpret(INPUT, signal());
    expect(parseInterpretation(forged).failClosed).toBeTruthy();
  });

  it("a refusal, a truncated answer or an API error is a failure — never a guess", async () => {
    await expect(new AnthropicCaptureProvider({ client: fake({ text: "{}", stop_reason: "refusal" }).client }).interpret(INPUT, signal())).rejects.toThrow(/declined/);
    await expect(new AnthropicCaptureProvider({ client: fake({ text: '{"candidates":[', stop_reason: "max_tokens" }).client }).interpret(INPUT, signal())).rejects.toThrow(/cut off/);
    await expect(new AnthropicCaptureProvider({ client: fake(new Error("529 overloaded")).client }).interpret(INPUT, signal())).rejects.toThrow(/overloaded/);
  });

  it("spend is capped: a per-day call limit that resets on the next day, and token usage is tallied for the operator", async () => {
    let now = new Date("2026-10-05T10:00:00Z");
    const { client, calls } = fake({ text: '{"candidates":[]}', usage: { input_tokens: 1200, output_tokens: 80 } });
    const p = new AnthropicCaptureProvider({ client, maxCallsPerDay: 2, now: () => now });
    await p.interpret(INPUT, signal()); await p.interpret(INPUT, signal());
    await expect(p.interpret(INPUT, signal())).rejects.toThrow(/daily call cap \(2\)/);
    expect(calls).toHaveLength(2); // the third never reached the API
    expect(p.usage).toEqual({ calls: 2, inputTokens: 2400, outputTokens: 160 });
    now = new Date("2026-10-06T00:00:01Z");
    await p.interpret(INPUT, signal());
    expect(calls).toHaveLength(3);
  });

  it("environment opt-in: off by default; needs a key; validates model and cap; a typo refuses to start", () => {
    expect(captureProviderFromEnv({})).toBeUndefined();
    expect(captureProviderFromEnv({ ANGEL_OS_CAPTURE_PROVIDER: "none" })).toBeUndefined();
    expect(captureProviderFromEnv({ ANTHROPIC_API_KEY: "k" })).toBeUndefined(); // a key alone never turns it on
    expect(() => captureProviderFromEnv({ ANGEL_OS_CAPTURE_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => captureProviderFromEnv({ ANGEL_OS_CAPTURE_PROVIDER: "openai", ANTHROPIC_API_KEY: "k" })).toThrow(/must be "anthropic"/);
    for (const cap of ["0", "-1", "abc", "1.5", "100001"]) expect(() => captureProviderFromEnv({ ANGEL_OS_CAPTURE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANGEL_OS_CAPTURE_MAX_CALLS_PER_DAY: cap }), cap).toThrow(/whole number/);
    const p = captureProviderFromEnv({ ANGEL_OS_CAPTURE_PROVIDER: "Anthropic", ANTHROPIC_API_KEY: "test-key", ANGEL_OS_CAPTURE_MODEL: "claude-haiku-4-5" });
    expect(p?.name).toBe("anthropic");
  });
});
