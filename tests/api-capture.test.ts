import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { PRODUCTION_DEFINITIONS, registerSkillActions } from "../skills/manifest.js";
import { ScriptedModelProvider } from "../capture/provider.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

process.env.NODE_ENV = "test";
registerSkillActions();
const { createApp } = await import("../api/server.js");

const READS: [string, string, string][] = [
  ["system.tasks", "angel:tasks", "READ"], ["system.life", "angel:life", "LIFE_READ"], ["system.future", "angel:future", "FUTURE_READ"], ["system.learning", "angel:learning", "LEARNING_READ"],
  ["system.decisions", "angel:decisions", "DECISION_READ"], ["system.capture", "angel:capture", "CAPTURE_INTERPRET"], ["system.capture", "angel:capture", "CAPTURE_DECIDE"],
];

describe("capture over HTTP: an adapter over the capture service", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  let authVoice: { Authorization: string };
  let authB: { Authorization: string };
  const script = new ScriptedModelProvider(({ text }) => text.includes("forged")
    ? { candidates: [{ type: "NEXT_ACTION", title: "t" }], principalId: "x" }
    : { candidates: [{ type: "EXPERIENCE", content: "Worked on Angel OS." }, { type: "NEXT_ACTION", title: "Run the validation scenarios" }] });
  const app = createApp({ captureProvider: script });
  const bare = createApp();
  const db = () => getDb();

  beforeAll(async () => {
    a = (await createPrincipal("Cap API A")).id;
    b = (await createPrincipal("Cap API B")).id;
    for (const p of [a, b]) {
      for (const [s, r, x] of READS) await grant(p, JARVIS_AGENT_KEY, s, r, x, "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
    const t = getApiTokenService();
    authA = { Authorization: `Bearer ${(await t.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    authVoice = { Authorization: `Bearer ${(await t.create({ principalId: a, interfaceSource: "VOICE", label: "v" })).token}` };
    authB = { Authorization: `Bearer ${(await t.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "b" })).token}` };
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  const UUID = "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e";

  it("every capture route needs an authenticated identity", async () => {
    for (const p of ["/api/capture", `/api/capture/${UUID}/confirm`, `/api/capture/${UUID}/cancel`]) expect((await request(app).post(p).send({})).status, p).toBe(401);
  });

  it("with no interpreter connected it says so (503) and saves nothing", async () => {
    const r = await request(bare).post("/api/capture").set(authA).send({ text: "hello" });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/No interpreter is connected/);
    expect(await db().captureProposal.count({ where: { principalId: a } })).toBe(0);
  });

  it("interpret → a draft with nothing saved; confirm saves via the ordinary actions; the draft is single-use", async () => {
    const before = await db().memory.count({ where: { principalId: a } });
    const p = await request(app).post("/api/capture").set(authA).send({ text: "I worked on Angel OS and should run the validation scenarios." });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.nothingSaved).toBe(true);
    expect(await db().memory.count({ where: { principalId: a } })).toBe(before);
    const id = p.body.data.proposalId;
    const c = await request(app).post(`/api/capture/${id}/confirm`).set(authA).send({ accept: [0, 1] });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.outcomes.map((o: any) => o.status)).toEqual(["EXECUTED", "EXECUTED"]);
    expect(await db().memory.count({ where: { principalId: a, type: "EXPERIENCE", content: "Worked on Angel OS." } })).toBe(1);
    const again = await request(app).post(`/api/capture/${id}/confirm`).set(authA).send({});
    expect(again.status).toBe(404); // "wasn't found or is no longer pending" — same as missing
  });

  it("cancel writes nothing; another principal cannot confirm or cancel your draft (indistinguishable from missing)", async () => {
    const p = (await request(app).post("/api/capture").set(authA).send({ text: "x" })).body.data.proposalId;
    expect((await request(app).post(`/api/capture/${p}/confirm`).set(authB).send({})).status).toBe(404);
    expect((await request(app).post(`/api/capture/${p}/cancel`).set(authB).send({})).status).toBe(404);
    const tasks = await db().task.count({ where: { principalId: a } });
    expect((await request(app).post(`/api/capture/${p}/cancel`).set(authA).send({})).status).toBe(200);
    expect((await request(app).post(`/api/capture/${p}/confirm`).set(authA).send({})).status).toBe(404);
    expect(await db().task.count({ where: { principalId: a } })).toBe(tasks);
  });

  it("no principal, interface, permission or extra field is accepted from the client, and a forged model output is refused", async () => {
    for (const body of [{ text: "x", principalId: b }, { text: "x", interfaceSource: "SYSTEM" }, { text: "x", actions: [] }, { text: 5 }, {}, { text: "x", skillKey: "system.memory" }])
      expect((await request(app).post("/api/capture").set(authA).send(body)).status, JSON.stringify(body)).toBe(400);
    const id = (await request(app).post("/api/capture").set(authA).send({ text: "x" })).body.data.proposalId;
    for (const body of [{ accept: "all" }, { accept: [99] }, { principalId: b }, { text: "override" }, { items: [] }])
      expect((await request(app).post(`/api/capture/${id}/confirm`).set(authA).send(body)).status, JSON.stringify(body)).toBe(400);
    expect((await request(app).post(`/api/capture/${id}/cancel`).set(authA).send({ reason: "x" })).status).toBe(400);
    expect((await request(app).post("/api/capture/not-a-uuid/confirm").set(authA).send({})).status).toBe(400);
    const forged = await request(app).post("/api/capture").set(authA).send({ text: "forged output" });
    expect(forged.body.data.failClosed).toBeTruthy();
    expect(forged.body.data.items).toEqual([]);
    // the header route is refused too
    expect((await request(app).post("/api/capture").set(authA).set("x-principal-id", b).send({ text: "x" })).status).toBe(400);
  });

  it("voice can interpret, but confirming still ends in the approval the action needs (nothing is bypassed)", async () => {
    const p = (await request(app).post("/api/capture").set(authVoice).send({ text: "x" }));
    expect(p.status).toBe(200);
    const c = await request(app).post(`/api/capture/${p.body.data.proposalId}/confirm`).set(authVoice).send({});
    expect(c.body.data.outcomes.map((o: any) => o.status)).toEqual(["PENDING_APPROVAL", "PENDING_APPROVAL"]);
  });
});
