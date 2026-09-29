import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { statusFor } from "../api/lifeRoutes.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

const DOMAINS = ["system.life", "system.decisions", "system.future", "system.learning", "system.tasks"];
const READS: [string, string, string][] = [
  ["system.life", "angel:life", "LIFE_READ"], ["system.decisions", "angel:decisions", "DECISION_READ"],
  ["system.future", "angel:future", "FUTURE_READ"], ["system.learning", "angel:learning", "LEARNING_READ"],
];
async function grantAll(p: string) {
  for (const [sk, res, act] of READS) await grant(p, JARVIS_AGENT_KEY, sk, res, act, "READ");
  for (const d of PRODUCTION_DEFINITIONS.filter((x) => DOMAINS.includes(x.skillKey) && x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE", d.risk === "SENSITIVE" ? "APPROVAL_REQUIRED" : "ALLOWED");
}

describe("GuideHub-ready API for the Life OS domains", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  let authVoiceA: { Authorization: string };
  let authB: { Authorization: string };
  const act = (auth: { Authorization: string }, skill: string, action: string, body: unknown = {}) => request(app).post(`/api/actions/${skill}/${action}`).set(auth).send(body as object);
  const get = (auth: { Authorization: string }, path: string) => request(app).get(`/api${path}`).set(auth);
  const okAct = async (skill: string, action: string, body: unknown, auth = authA) => {
    const r = await act(auth, skill, action, body);
    expect(r.status, `${action}: ${JSON.stringify(r.body)}`).toBe(200);
    return r.body.data;
  };

  beforeAll(async () => {
    a = (await createPrincipal("API Life A")).id;
    b = (await createPrincipal("API Life B")).id;
    await grantAll(a);
    await grantAll(b);
    const t = getApiTokenService();
    authA = { Authorization: `Bearer ${(await t.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    authVoiceA = { Authorization: `Bearer ${(await t.create({ principalId: a, interfaceSource: "VOICE", label: "v" })).token}` };
    authB = { Authorization: `Bearer ${(await t.create({ principalId: b, interfaceSource: "GUIDEHUB", label: "b" })).token}` };
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("statusFor maps every Result status deterministically", () => {
    expect(statusFor({ status: "EXECUTED", message: "" })).toBe(200);
    expect(statusFor({ status: "PENDING_APPROVAL", message: "" })).toBe(202);
    expect(statusFor({ status: "DENIED", message: "" })).toBe(403);
    expect(statusFor({ status: "FAILED", message: "That goal wasn't found." })).toBe(404);
    expect(statusFor({ status: "FAILED", message: "Something else." })).toBe(422);
  });

  describe("authentication and catalog", () => {
    it("every new route needs an authenticated identity", async () => {
      for (const [method, path] of [["get", "/api/actions"], ["post", "/api/actions/system.life/GOAL_CREATE"], ["get", "/api/life/overview"], ["get", "/api/life/history"], ["get", "/api/decisions"], ["get", "/api/future/aspirations"], ["get", "/api/learning/topics"], ["get", "/api/reviews"]] as const) {
        expect((await (request(app) as any)[method](path)).status, path).toBe(401);
      }
    });

    it("GET /api/actions lists what exists (names, category, risk, fields) and never a principal or identity field", async () => {
      const r = await get(authA, "/actions");
      expect(r.status).toBe(200);
      const list = r.body as { skillKey: string; action: string; category: string; risk: string; fields: string[] }[];
      for (const key of ["system.life|GOAL_CREATE", "system.decisions|DECISION_RECORD", "system.future|METRIC_READING_RECORD", "system.learning|CARD_REVIEW", "system.tasks|TASK_COMPLETE"]) expect(list.map((x) => `${x.skillKey}|${x.action}`)).toContain(key);
      expect(list.find((x) => x.action === "PERSON_DELETE")!.risk).toBe("SENSITIVE");
      expect(JSON.stringify(list)).not.toMatch(/principal|identity/i);
    });
  });

  describe("acting by name", () => {
    it("proposes the registered ActionDefinition as the token's principal; the audit trail records the interface", async () => {
      const goal = await okAct("system.life", "GOAL_CREATE", { title: "Via HTTP" });
      expect(goal).toMatchObject({ principalId: a, title: "Via HTTP" });
      const audit = await getDb().auditLog.findFirst({ where: { principalId: a, action: "GOAL_CREATE", eventType: "ACTION_EXECUTION_SUCCEEDED" }, orderBy: { createdAt: "desc" } });
      expect(audit).toMatchObject({ interfaceSource: "GUIDEHUB" });
    });

    it("unknown skill/action → 404; non-object bodies → 400; invalid or extra parameters → 422 and nothing is created", async () => {
      expect((await act(authA, "system.life", "NOPE")).status).toBe(404);
      expect((await act(authA, "nope.skill", "GOAL_CREATE")).status).toBe(404);
      expect((await request(app).post("/api/actions/system.life/GOAL_CREATE").set(authA).send([1, 2] as never)).status).toBe(400);
      const before = await getDb().goal.count({ where: { principalId: a } });
      for (const body of [{}, { title: "" }, { title: "x", status: "ACHIEVED" }, { title: "x", horizon: "FOREVER" }]) expect((await act(authA, "system.life", "GOAL_CREATE", body)).status, JSON.stringify(body)).toBe(422);
      expect(await getDb().goal.count({ where: { principalId: a } })).toBe(before);
    });

    it("a client-supplied principal is refused outright (body, nested, or query) — the token is the only identity", async () => {
      const before = await getDb().goal.count({ where: { principalId: b } });
      expect((await act(authA, "system.life", "GOAL_CREATE", { title: "x", principalId: b })).status).toBe(400);
      expect((await act(authA, "system.life", "GOAL_CREATE", { title: "x", nested: { principalId: b } })).status).toBe(400);
      expect((await request(app).post("/api/actions/system.life/GOAL_CREATE?principalId=" + b).set(authA).send({ title: "x" })).status).toBe(400);
      expect((await request(app).post("/api/actions/system.life/GOAL_CREATE").set(authA).set("X-Principal-Id", b).send({ title: "x" })).status).toBe(400);
      expect(await getDb().goal.count({ where: { principalId: b } })).toBe(before);
    });

    it("permission still applies: no grant → 403 and nothing is created", async () => {
      const c = (await createPrincipal("API Life none")).id;
      try {
        const token = (await getApiTokenService().create({ principalId: c, interfaceSource: "GUIDEHUB", label: "c" })).token;
        const auth = { Authorization: `Bearer ${token}` };
        expect((await act(auth, "system.life", "GOAL_CREATE", { title: "x" })).status).toBe(403);
        expect((await get(auth, "/life/overview")).status).toBe(403);
        expect(await getDb().goal.count({ where: { principalId: c } })).toBe(0);
      } finally { await deletePrincipal(c); }
    });

    it("interface policy still applies: a VOICE token's LOW write is 202 with an approval, executed only when approved; voice can never approve a SENSITIVE one", async () => {
      const title = `voice-${Math.random()}`;
      const r = await act(authVoiceA, "system.life", "GOAL_CREATE", { title });
      expect(r.status).toBe(202);
      expect(r.body.approvalId).toBeTruthy();
      expect(await getDb().goal.count({ where: { principalId: a, title } })).toBe(0);
      const approve = await request(app).post(`/api/approvals/${r.body.approvalId}/approve`).set(authA).send({});
      expect(approve.status, JSON.stringify(approve.body)).toBe(200);
      expect(approve.body.executed).toBe(true);
      expect(await getDb().goal.count({ where: { principalId: a, title } })).toBe(1);
      expect((await request(app).post(`/api/approvals/${r.body.approvalId}/approve`).set(authA).send({})).status).toBe(409);
    });

    it("SENSITIVE actions return 202 on every interface; another principal cannot decide the approval; approval executes exactly the stored parameters", async () => {
      const person = await okAct("system.life", "PERSON_CREATE", { name: "To delete" });
      const r = await act(authA, "system.life", "PERSON_DELETE", { personId: person.id });
      expect(r.status).toBe(202);
      expect(await getDb().person.count({ where: { id: person.id } })).toBe(1);
      expect((await request(app).post(`/api/approvals/${r.body.approvalId}/approve`).set(authVoiceA).send({})).status).toBe(403); // voice approves LOW only
      expect(await getDb().person.count({ where: { id: person.id } })).toBe(1);
      expect((await request(app).post(`/api/approvals/${r.body.approvalId}/approve`).set(authB).send({})).status).toBe(404);
      expect((await request(app).post(`/api/approvals/${r.body.approvalId}/approve`).set(authA).send({ personId: "other" })).status).toBe(400);
      expect((await request(app).post(`/api/approvals/${r.body.approvalId}/approve`).set(authA).send({})).status).toBe(200);
      expect(await getDb().person.count({ where: { id: person.id } })).toBe(0);
    });
  });

  describe("isolation: another principal sees and touches nothing (missing and foreign are the same 404)", () => {
    it("reads and writes against A's objects by B", async () => {
      const project = await okAct("system.life", "PROJECT_CREATE", { name: "A only project" });
      const decision = await okAct("system.decisions", "DECISION_RECORD", { title: "A decision", decision: "Do it" });
      const asp = await okAct("system.future", "ASPIRATION_CREATE", { title: "A asp", current: "c", desired: "d" });
      const topic = await okAct("system.learning", "TOPIC_CREATE", { title: "A topic" });
      const card = await okAct("system.learning", "CARD_CREATE", { topicId: topic.id, prompt: "p", answer: "a" });
      const missing = "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e";
      for (const path of [`/life/projects/${project.id}`, `/decisions/${decision.id}`, `/future/aspirations/${asp.id}`, `/learning/cards/${card.id}`]) {
        const foreign = await get(authB, path);
        const absent = await get(authB, path.replace(/[0-9a-f-]{36}$/, missing));
        expect(foreign.status, path).toBe(404);
        expect(foreign.body, path).toEqual(absent.body);
        expect((await get(authA, path)).status, path).toBe(200);
      }
      for (const [skill, action, body] of [
        ["system.life", "PROJECT_UPDATE", { projectId: project.id, name: "stolen" }],
        ["system.decisions", "DECISION_REVIEW", { decisionId: decision.id, outcome: "hijack" }],
        ["system.future", "ASPIRATION_ACHIEVE", { aspirationId: asp.id }],
        ["system.learning", "CARD_REVIEW", { cardId: card.id, grade: 2 }],
      ] as const) expect((await act(authB, skill, action, body)).status, action).toBe(404);
      for (const path of ["/life/overview", "/life/history", "/decisions", "/future/aspirations", "/learning/topics", "/learning/due", "/results", "/reviews", "/life/people"]) {
        const body = JSON.stringify((await get(authB, path)).body);
        for (const id of [project.id, decision.id, asp.id, topic.id, card.id]) expect(body, path).not.toContain(id);
      }
    });

    it("path ids must be UUIDs; query strings are strict", async () => {
      for (const path of ["/life/projects/not-a-uuid", "/decisions/1", "/future/aspirations/x"]) expect((await get(authA, path)).status, path).toBe(400);
      for (const path of ["/decisions?foo=1", "/learning/due?limit=0", "/learning/due?limit=1000", "/learning/due?topicId=zzz", "/results?subjectKind=GOAL", "/results?subjectKind=NOPE&subjectId=0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e"]) expect((await get(authA, path)).status, path).toBe(400);
    });
  });

  it("a whole cross-domain flow works over HTTP alone", async () => {
    const goal = await okAct("system.life", "GOAL_CREATE", { title: "Flow goal" });
    const project = await okAct("system.life", "PROJECT_CREATE", { name: "Flow project", goalId: goal.id });
    const task = await okAct("system.tasks", "CREATE_TASK", { title: "Flow task", projectId: project.id });
    await okAct("system.tasks", "TASK_COMPLETE", { taskId: task.id });
    const overview = (await get(authA, "/life/overview")).body.data;
    expect(overview.projects.find((p: any) => p.id === project.id).tasks).toEqual({ open: 0, done: 1, cancelled: 0 });

    const decision = await okAct("system.decisions", "DECISION_RECORD", { title: "Flow decision", decision: "Go", expected: "it works", evidence: [{ kind: "TASK", refId: task.id }] });
    await okAct("system.decisions", "DECISION_REVIEW", { decisionId: decision.id, outcome: "It worked", lesson: "keep going" });
    const readBack = (await get(authA, `/decisions/${decision.id}`)).body.data;
    expect(readBack).toMatchObject({ expected: "it works", outcome: "It worked" });
    expect(readBack.evidence[0].label).toBe("[task] Flow task");
    await okAct("system.life", "RESULT_RECORD", { subjectKind: "GOAL", subjectId: goal.id, statement: "shipped" });
    expect((await get(authA, `/results?subjectKind=GOAL&subjectId=${goal.id}`)).body.data).toHaveLength(1);
    const day = 24 * 3600 * 1000;
    await okAct("system.life", "REVIEW_CREATE", { periodStart: new Date(Date.now() - 7 * day).toISOString(), periodEnd: new Date(Date.now() + day).toISOString(), summary: "week" });
    expect((await get(authA, "/reviews")).body.data.length).toBeGreaterThanOrEqual(1);

    const asp = await okAct("system.future", "ASPIRATION_CREATE", { title: "Flow asp", current: "c", desired: "d" });
    const metric = await okAct("system.future", "METRIC_CREATE", { aspirationId: asp.id, name: "m", unit: "u", definition: "how it is measured", baseline: 0, target: 10 });
    expect((await get(authA, `/future/aspirations/${asp.id}`)).body.data.progress).toBeNull();
    await okAct("system.future", "METRIC_READING_RECORD", { metricId: metric.id, value: 5 });
    expect((await get(authA, `/future/aspirations/${asp.id}`)).body.data.progress).toBeCloseTo(0.5);

    const topic = await okAct("system.learning", "TOPIC_CREATE", { title: "Flow topic" });
    const card = await okAct("system.learning", "CARD_CREATE", { topicId: topic.id, prompt: "p", answer: "a" });
    expect((await get(authA, `/learning/due?topicId=${topic.id}`)).body.data.map((c: any) => c.id)).toEqual([card.id]);
    await okAct("system.learning", "CARD_REVIEW", { cardId: card.id, grade: 2 });
    expect((await get(authA, `/learning/due?topicId=${topic.id}`)).body.data).toEqual([]);
    expect((await get(authA, "/learning/topics")).body.data.find((t: any) => t.id === topic.id)).toMatchObject({ cards: 1, due: 0 });
  });
});
