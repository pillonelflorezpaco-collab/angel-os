import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { JarvisCore, JARVIS_AGENT_KEY, setCaptureProvider } from "../core/index.js";
import { parseIntent } from "../core/router/index.js";
import { PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { ScriptedModelProvider } from "../capture/provider.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";

const READS: [string, string, string][] = [
  ["system.tasks", "angel:tasks", "READ"], ["system.memory", "angel:memory", "MEMORY_READ"], ["system.life", "angel:life", "LIFE_READ"], ["system.future", "angel:future", "FUTURE_READ"],
  ["system.learning", "angel:learning", "LEARNING_READ"], ["system.decisions", "angel:decisions", "DECISION_READ"], ["system.capture", "angel:capture", "CAPTURE_INTERPRET"], ["system.capture", "angel:capture", "CAPTURE_DECIDE"],
];

describe("Jarvis Core ↔ capture: a sentence Core doesn't otherwise understand becomes a draft; 'confirm' / 'cancel' decide it", () => {
  let a: string;
  let b: string;
  const db = () => getDb();
  const jarvis = new JarvisCore();
  const as = (p: string, src: "GUIDEHUB" | "TELEGRAM" | "VOICE" = "GUIDEHUB") => identityFor(p, src);
  const say = (input: string, p = a, src: "GUIDEHUB" | "TELEGRAM" | "VOICE" = "GUIDEHUB") => jarvis.handle({ principalId: p, input, identity: as(p, src) });
  const LOG = "Today I worked three hours on Angel OS and realized I need to stop adding features and start testing it.";
  const scripted = () => new ScriptedModelProvider(({ text }) => text === LOG
    ? { candidates: [{ type: "EXPERIENCE", content: "Worked three hours on Angel OS." }, { type: "INFERENCE", content: "Testing should come before more features.", confidence: 0.9 }, { type: "NEXT_ACTION", title: "Run the validation scenarios" }] }
    : { candidates: [] });
  const count = async () => ({ mem: await db().memory.count({ where: { principalId: a } }), task: await db().task.count({ where: { principalId: a } }) });

  beforeAll(async () => {
    a = (await createPrincipal("Core capture A")).id;
    b = (await createPrincipal("Core capture B")).id;
    for (const p of [a, b]) {
      for (const [s, r, x] of READS) await grant(p, JARVIS_AGENT_KEY, s, r, x, "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
  });
  afterEach(() => setCaptureProvider(null));
  afterAll(async () => { setCaptureProvider(null); await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("only the exact words confirm or cancel; anything that merely contains them is a normal sentence", () => {
    for (const t of ["confirm", "Confirm.", "confirm it", "confirm all", "confirm the draft", "CONFIRM THAT!"]) expect(parseIntent(t).name, t).toBe("capture.confirm");
    for (const t of ["cancel", "Cancel it", "cancel the proposal"]) expect(parseIntent(t).name, t).toBe("capture.cancel");
    for (const t of ["please confirm my dentist appointment", "confirm 3", "confirm and delete everything", "I want to cancel my gym membership", "cancel task", "yes", "ok"]) expect(["capture.confirm", "capture.cancel"], t).not.toContain(parseIntent(t).name);
  });

  it("with no interpreter connected nothing changes: unknown input gets the usual guidance and 'confirm' has nothing to confirm", async () => {
    expect((await say(LOG)).message).toMatch(/I didn't understand/);
    const r = await say("confirm");
    expect(r).toMatchObject({ status: "FAILED", message: "There is nothing waiting to be confirmed." });
  });

  it("free text → a draft in words, nothing saved; 'confirm' saves through the ordinary actions; a second 'confirm' finds nothing", async () => {
    setCaptureProvider(scripted());
    const before = await count();
    const r = await say(LOG);
    expect(r.status).toBe("EXECUTED");
    expect(r.message).toMatch(/^I understood:/);
    expect(r.message).toMatch(/2\. INFERENCE: Jarvis's reading \(not a fact\)/);
    expect(r.message).toMatch(/Nothing has been saved yet\. Say “confirm” to save the 3 ready items, or “cancel”\./);
    expect(await count()).toEqual(before);
    const c = await say("Confirm.");
    expect(c.status).toBe("EXECUTED");
    expect(c.message).toMatch(/1\. EXPERIENCE: Saved/);
    expect(c.message).toMatch(/3\. NEXT_ACTION: Saved/);
    const mems = await db().memory.findMany({ where: { principalId: a, source: "jarvis-capture" } });
    expect(mems.map((m) => [m.type, m.status]).sort()).toEqual([["EXPERIENCE", "ACTIVE"], ["INFERENCE", "UNCONFIRMED"]]);
    expect(await db().task.count({ where: { principalId: a, title: "Run the validation scenarios" } })).toBe(1);
    expect((await say("confirm")).message).toBe("There is nothing waiting to be confirmed.");
  });

  it("'cancel' saves nothing and consumes the draft", async () => {
    setCaptureProvider(scripted());
    const before = await count();
    await say(LOG);
    expect((await say("cancel")).message).toBe("Cancelled. Nothing was saved.");
    expect((await say("confirm")).status).toBe("FAILED");
    expect(await count()).toEqual(before);
  });

  it("deterministic intents still win; capture never intercepts them", async () => {
    setCaptureProvider(new ScriptedModelProvider(() => { throw new Error("must not be asked"); }));
    const r = await say("add task Buy shoes");
    expect(r.status).toBe("EXECUTED");
    expect(r.message).not.toMatch(/I understood/);
    expect((await say("what are my tasks")).status).toBe("EXECUTED");
    expect((await say("remember that I like tea")).status).toBe("EXECUTED");
  });

  it("a sentence that merely contains 'confirm' is interpreted as a new sentence and confirms nothing", async () => {
    setCaptureProvider(scripted());
    const before = await count();
    await say(LOG);
    const r = await say("please confirm my dentist appointment for tomorrow");
    expect(r.message).toMatch(/didn't find anything I can save/);
    expect(await count()).toEqual(before);
    await say("cancel"); // the newest pending draft (the empty one) — the earlier draft is still pending
    expect((await say("cancel")).status).toBe("EXECUTED");
  });

  it("drafts are per principal and per interface: another person's or another interface's 'confirm' never touches them", async () => {
    setCaptureProvider(scripted());
    const before = await count();
    await say(LOG);
    expect((await say("confirm", b)).status).toBe("FAILED");
    expect((await say("confirm", a, "TELEGRAM")).message).toBe("There is nothing waiting to be confirmed.");
    expect(await count()).toEqual(before);
    expect((await say("cancel")).status).toBe("EXECUTED");
  });

  it("each person's 'confirm' finds THEIR newest draft even when someone else's is newer; a clarification is shown as a question and offers no confirm", async () => {
    setCaptureProvider(scripted());
    const bMem = () => db().memory.count({ where: { principalId: b, source: "jarvis-capture" } });
    const beforeB = await bMem();
    await say(LOG, b);
    await say(LOG, a); // A's draft is newer than B's
    const r = await say("confirm", b);
    expect(r.status).toBe("EXECUTED");
    expect(await bMem()).toBe(beforeB + 2);
    await say("cancel", a);
    setCaptureProvider(new ScriptedModelProvider(() => ({ candidates: [], clarifications: [{ question: "Did you test it yourself?", options: ["yes", "no"] }] })));
    const q = await say("I learned how to configure the Docker networking.");
    expect(q.message).toMatch(/^Question: Did you test it yourself\? \(yes \/ no\)/m);
    expect(q.message).toMatch(/Nothing has been saved\.$/);
    expect(q.message).not.toMatch(/Say “confirm”/);
  });

  it("voice still needs approval: 'confirm' by voice ends in Waiting for your approval, and nothing is saved", async () => {
    setCaptureProvider(scripted());
    const before = await count();
    await say(LOG, a, "VOICE");
    const c = await say("confirm", a, "VOICE");
    expect(c.status).toBe("EXECUTED");
    expect(c.message).toMatch(/Waiting for your approval/);
    expect(c.message).not.toMatch(/: Saved/);
    expect(await count()).toEqual(before);
  });

  it("identity is required and single: no identity, or a request principal that disagrees with it, is refused", async () => {
    setCaptureProvider(scripted());
    for (const input of [LOG, "confirm", "cancel"]) {
      expect((await jarvis.handle({ principalId: a, input })).status, input).toBe("FAILED");
      expect((await jarvis.handle({ principalId: b, input, identity: as(a) })).status, input).toBe("FAILED");
    }
  });

  it("a failing or forging interpreter fails safe in words: nothing saved, no internals, no fake success", async () => {
    const before = await count();
    setCaptureProvider(new ScriptedModelProvider(() => { throw new Error("secret stack detail"); }));
    const boom = await say(LOG);
    expect(boom.status).toBe("FAILED");
    expect(boom.message).not.toMatch(/secret stack/);
    setCaptureProvider(new ScriptedModelProvider(() => ({ candidates: [{ type: "NEXT_ACTION", title: "t" }], principalId: b })));
    const forged = await say(LOG);
    expect(forged.message).toMatch(/Nothing was proposed and nothing has been saved/);
    expect((await say("confirm")).message).toMatch(/Nothing to save|nothing to save|There was nothing to save/i);
    expect(await count()).toEqual(before);
  });
});
