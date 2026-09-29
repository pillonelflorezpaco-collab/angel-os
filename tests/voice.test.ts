import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { disconnectDb } from "../db/client/index.js";
import { handleVoiceInput, toSpeakable, MIN_VOICE_CONFIDENCE } from "../interfaces/voice/index.js";
import type { VoiceDeviceAdapter } from "../interfaces/voice/index.js";
import { createIdentity } from "../identity/index.js";
import { getDb } from "../db/client/index.js";
import { listAuditLog } from "../gateway/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { SKILL_KEY as TASKS_SKILL, RESOURCE as TASKS_RESOURCE } from "../skills/system/tasks.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

// Two unrelated "vendors" with different wire formats. Angel OS never sees
// either format — only VoiceInput / VoiceOutput.
const VendorA: VoiceDeviceAdapter<{ sess: string; dev: string; utterance: string; conf: number }, { say: string; done: boolean }> = {
  parseRequest: (raw) => ({
    session: { id: raw.sess, deviceId: raw.dev, startedAt: new Date() },
    transcript: raw.utterance,
    confidence: raw.conf,
  }),
  renderResponse: (out) => ({ say: out.speech, done: out.endSession }),
};
const VendorB: VoiceDeviceAdapter<{ request: { session: { sessionId: string }; device: string; text: string } }, { outputSpeech: { text: string }; shouldEndSession: boolean }> = {
  parseRequest: (raw) => ({
    session: { id: raw.request.session.sessionId, deviceId: raw.request.device, startedAt: new Date() },
    transcript: raw.request.text,
  }),
  renderResponse: (out) => ({ outputSpeech: { text: out.speech }, shouldEndSession: out.endSession }),
};

describe("voice abstraction", () => {
  let principalId: string;
  const voice = (p: string) => createIdentity({ principalId: p, interfaceSource: "VOICE", authMethod: "external_identity", requestId: `v-${Math.random()}` });

  beforeAll(async () => {
    principalId = (await createPrincipal("Voice Principal")).id;
    await grant(principalId, JARVIS_AGENT_KEY, TASKS_SKILL, TASKS_RESOURCE, "READ", "READ");
    await getDb().task.create({ data: { principalId, title: "voice-task-one" } });
  });
  afterAll(async () => {
    await deletePrincipal(principalId);
    await disconnectDb();
  });

  it("converts chat-style text into speakable text", () => {
    expect(toSpeakable("[fact] likes window seats")).toBe("fact: likes window seats");
    expect(toSpeakable("[inference, unconfirmed] probably prefers mornings")).toBe("inference, unconfirmed: probably prefers mornings");
    expect(toSpeakable("Your tasks (2):\n• Buy milk [todo]\n• Call Ana [todo]")).toBe("Your tasks (2): Buy milk, todo. Call Ana, todo");
    expect(toSpeakable("Today — 08:00 Gym")).toBe("Today — 08:00 Gym");
  });

  it("runs a spoken request through the real backend and returns speech + text", async () => {
    const input = VendorA.parseRequest({ sess: "s1", dev: "kitchen-speaker", utterance: "What are my tasks?", conf: 0.95 });
    const out = await handleVoiceInput(voice(principalId), input);
    expect(out.text).toBe("Your tasks (1):\n• voice-task-one [todo]");
    expect(out.speech).toBe("Your tasks (1): voice-task-one, todo");
    expect(out.session.deviceId).toBe("kitchen-speaker");
    expect(out.endSession).toBe(false);
  });

  it("the device is replaceable: two different vendors get identical behaviour from the same backend", async () => {
    const identity = voice(principalId);
    const fromA = VendorA.renderResponse(await handleVoiceInput(identity, VendorA.parseRequest({ sess: "a", dev: "d1", utterance: "What are my tasks?", conf: 0.9 })));
    const fromB = VendorB.renderResponse(await handleVoiceInput(identity, VendorB.parseRequest({ request: { session: { sessionId: "b" }, device: "d2", text: "What are my tasks?" } })));
    expect(fromA.say).toBe(fromB.outputSpeech.text);
    expect(fromA.done).toBe(fromB.shouldEndSession);
  });

  it("never sends a low-confidence transcript to Jarvis — it asks the user to repeat", async () => {
    const dispatch = vi.fn();
    const out = await handleVoiceInput(voice(principalId), VendorA.parseRequest({ sess: "s", dev: "d", utterance: "delete everything", conf: MIN_VOICE_CONFIDENCE - 0.01 }), { dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.speech).toMatch(/say it again/i);
    // right at the threshold it is accepted
    dispatch.mockResolvedValue({ status: "EXECUTED", message: "ok" });
    await handleVoiceInput(voice(principalId), VendorA.parseRequest({ sess: "s", dev: "d", utterance: "hi", conf: MIN_VOICE_CONFIDENCE }), { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("only a VOICE identity can speak as voice: another interface's identity is refused", async () => {
    const guidehub = createIdentity({ principalId, interfaceSource: "GUIDEHUB", authMethod: "api_token", requestId: "x" });
    const dispatch = vi.fn();
    await expect(handleVoiceInput(guidehub, VendorA.parseRequest({ sess: "s", dev: "d", utterance: "hi", conf: 1 }), { dispatch })).rejects.toThrow(/VOICE identity/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("voice requests still go through the Gateway: no permission means denied, spoken as a plain refusal", async () => {
    const other = (await createPrincipal("Voice No Permissions")).id;
    const identity = voice(other);
    const out = await handleVoiceInput(identity, { session: { id: "s", deviceId: "d", startedAt: new Date() }, transcript: "What are my tasks?" });
    expect(out.text).toMatch(/not permitted/i);
    const denied = (await listAuditLog(other, 10)).find((r) => r.eventType === "ACTION_DENIED");
    expect(denied?.interfaceSource).toBe("VOICE");
    await deletePrincipal(other);
  });

  it("the voice module's code has no vendor coupling", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../interfaces/voice/", import.meta.url);
    const code = readdirSync(dir)
      .map((f) => readFileSync(new URL(f, dir), "utf-8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const vendor of ["google", "alexa", "siri", "amazon"]) expect(code.toLowerCase()).not.toContain(vendor);
  });
});
