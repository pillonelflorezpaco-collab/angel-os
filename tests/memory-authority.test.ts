import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService, runAsSystem } from "../identity/index.js";
import { decideApproval, listAuditLog, proposeAction } from "../gateway/index.js";
import { DEFAULT_APPROVAL_TTL_MS } from "../gateway/approvals/service.js";
import { payloadHash } from "../gateway/actions/binding.js";
import { setClock } from "../gateway/clock.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { remember, updateMemory, confirmMemory, deleteMemory } from "../skills/system/memory.js";
import { handleVoiceInput } from "../interfaces/voice/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

const SKILL = "system.memory";
const RES = "angel:memory";

describe("memory write authority is split: create / update / confirm / delete", () => {
  let a: string;
  let b: string;
  const idA = (s: "GUIDEHUB" | "VOICE" | "TELEGRAM" = "GUIDEHUB") => identityFor(a, s);
  const memory = (id: string) => getDb().memory.findUnique({ where: { id } });
  const mk = async (principalId: string, content: string, type: "FACT" | "INFERENCE" = "FACT") =>
    (await getDb().memory.create({ data: { principalId, type, content, source: "test", status: type === "INFERENCE" ? "UNCONFIRMED" : "ACTIVE" } })).id;
  const pendingFor = (memoryId: string, action: string) =>
    getDb().approvalRequest.findFirstOrThrow({ where: { principalId: a, action, status: "PENDING", parameters: { path: ["memoryId"], equals: memoryId } } });

  beforeAll(async () => {
    a = (await createPrincipal("Memory Authority A")).id;
    b = (await createPrincipal("Memory Authority B")).id;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, SKILL, RES, "MEMORY_CREATE", "WRITE");
      await grant(p, JARVIS_AGENT_KEY, SKILL, RES, "MEMORY_UPDATE", "WRITE", "APPROVAL_REQUIRED");
      await grant(p, JARVIS_AGENT_KEY, SKILL, RES, "MEMORY_CONFIRM", "WRITE", "APPROVAL_REQUIRED");
      await grant(p, JARVIS_AGENT_KEY, SKILL, RES, "MEMORY_DELETE", "WRITE", "APPROVAL_REQUIRED");
    }
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => setClock(null));
  afterEach(() => setClock(null));

  it("MEMORY_CREATE is LOW risk: direct from GuideHub/Telegram, approval from voice", async () => {
    expect((await remember(idA(), { type: "FACT", content: "create direct", source: "test" })).status).toBe("EXECUTED");
    expect((await remember(idA("TELEGRAM"), { type: "FACT", content: "create tg", source: "test" })).status).toBe("EXECUTED");
    const v = await remember(idA("VOICE"), { type: "FACT", content: "create voice", source: "test" });
    expect(v.status).toBe("PENDING_APPROVAL");
    expect(await getDb().memory.count({ where: { principalId: a, content: "create voice" } })).toBe(0);
  });

  describe.each([
    ["MEMORY_UPDATE", (id: string, who = idA()) => updateMemory(who, { memoryId: id, content: "updated content" })],
    ["MEMORY_CONFIRM", (id: string, who = idA()) => confirmMemory(who, { memoryId: id })],
    ["MEMORY_DELETE", (id: string, who = idA()) => deleteMemory(who, { memoryId: id })],
  ])("%s (SENSITIVE)", (action, propose) => {
    const seed = () => (action === "MEMORY_CONFIRM" ? mk(a, `${action} target`, "INFERENCE") : mk(a, `${action} target`));

    it("needs approval on EVERY interface, and nothing changes until approved", async () => {
      for (const source of ["GUIDEHUB", "TELEGRAM", "API", "VOICE"] as const) {
        const id = await seed();
        const r = await propose(id, identityFor(a, source));
        expect(r.status, source).toBe("PENDING_APPROVAL");
        const m = await memory(id);
        expect(m, source).not.toBeNull();
        expect(m!.content).toBe(`${action} target`);
        expect(m!.status).toBe(action === "MEMORY_CONFIRM" ? "UNCONFIRMED" : "ACTIVE");
      }
    });

    it("approval stores the exact parameters + hash and executes exactly them, once", async () => {
      const id = await seed();
      await propose(id);
      const row = await pendingFor(id, action);
      const stored = row.parameters as Record<string, unknown>;
      expect(stored.memoryId).toBe(id);
      expect(row.payloadHash).toBe(payloadHash({ principalId: a, skillKey: SKILL, resource: RES, action, parameters: stored }));
      const out = await decideApproval(idA(), row.id, "APPROVED");
      expect(out).toMatchObject({ ok: true, executed: true });
      const after = await memory(id);
      if (action === "MEMORY_DELETE") expect(after).toBeNull();
      if (action === "MEMORY_UPDATE") expect(after!.content).toBe("updated content");
      if (action === "MEMORY_CONFIRM") expect(after!.status).toBe("ACTIVE");
      expect((await decideApproval(idA(), row.id, "APPROVED")).ok).toBe(false); // consumed
    });

    it("voice can never approve it; SYSTEM can never approve it", async () => {
      const id = await seed();
      await propose(id);
      const row = await pendingFor(id, action);
      expect(await decideApproval(idA("VOICE"), row.id, "APPROVED")).toMatchObject({ ok: false, code: "FORBIDDEN" });
      const bySystem = await runAsSystem(a, "test-job", (sys) => decideApproval(sys, row.id, "APPROVED"));
      expect(bySystem).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await memory(id)).not.toBeNull();
      expect((await memory(id))!.content).toBe(`${action} target`);
    });

    it("a denied approval changes nothing; an expired one changes nothing", async () => {
      const id = await seed();
      await propose(id);
      const row = await pendingFor(id, action);
      expect((await decideApproval(idA(), row.id, "DENIED")).ok).toBe(true);
      expect((await memory(id))!.content).toBe(`${action} target`);

      const id2 = await seed();
      await propose(id2);
      const row2 = await pendingFor(id2, action);
      setClock(() => new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS + 60_000));
      expect(await decideApproval(idA(), row2.id, "APPROVED")).toMatchObject({ ok: false, code: "EXPIRED" });
      expect((await memory(id2))!.content).toBe(`${action} target`);
    });

    it("another principal's memory cannot be touched: not found, and nothing changes", async () => {
      const bId = await mk(b, `B's ${action} memory`, action === "MEMORY_CONFIRM" ? "INFERENCE" : "FACT");
      await propose(bId); // A proposes an action on B's memory id…
      const row = await pendingFor(bId, action);
      const out = await decideApproval(idA(), row.id, "APPROVED"); // …and approves it
      expect(out.executed).toBe(false);
      expect(out.message).toContain("That memory wasn't found.");
      const untouched = await memory(bId);
      expect(untouched).not.toBeNull();
      expect(untouched!.content).toBe(`B's ${action} memory`);
      expect(untouched!.status).toBe(action === "MEMORY_CONFIRM" ? "UNCONFIRMED" : "ACTIVE");
    });

    it("the approval itself cannot be decided by someone else", async () => {
      const id = await seed();
      await propose(id);
      const row = await pendingFor(id, action);
      expect(await decideApproval(identityFor(b), row.id, "APPROVED")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("without its own permission it is DENIED (a MEMORY_CREATE grant does not authorize it)", async () => {
      const c = (await createPrincipal("Memory Authority C")).id;
      try {
        await grant(c, JARVIS_AGENT_KEY, SKILL, RES, "MEMORY_CREATE", "WRITE");
        const id = await mk(c, "c's memory");
        const r = await propose(id, identityFor(c));
        expect(r.status).toBe("DENIED");
      } finally { await deletePrincipal(c); }
    });
  });

  it("strict schemas: ids must be UUIDs, unknown fields and empty updates are rejected before any approval exists", async () => {
    const before = await getDb().approvalRequest.count({ where: { principalId: a } });
    const id = await mk(a, "schema target");
    for (const params of [{ memoryId: "not-a-uuid" }, { memoryId: id, extra: 1 }, { memoryId: id }, { memoryId: id, content: "" }]) {
      expect((await proposeAction(idA(), { skillKey: SKILL, action: "MEMORY_UPDATE", parameters: params })).status).toBe("FAILED");
    }
    expect((await proposeAction(idA(), { skillKey: SKILL, action: "MEMORY_DELETE", parameters: { memoryId: id, force: true } })).status).toBe("FAILED");
    expect(await getDb().approvalRequest.count({ where: { principalId: a } })).toBe(before);
  });

  it("the legacy MEMORY_WRITE grant no longer authorizes anything (deleted from the vocabulary)", async () => {
    const c = (await createPrincipal("Memory Authority Legacy")).id;
    try {
      await grant(c, JARVIS_AGENT_KEY, SKILL, RES, "MEMORY_WRITE", "WRITE");
      const id = await mk(c, "legacy");
      expect((await deleteMemory(identityFor(c), { memoryId: id })).status).toBe("DENIED");
      expect((await remember(identityFor(c), { type: "FACT", content: "legacy create", source: "t" })).status).toBe("DENIED");
    } finally { await deletePrincipal(c); }
  });

  it("no public route exists for update/confirm/delete of memory", async () => {
    const token = (await getApiTokenService().create({ principalId: a, interfaceSource: "GUIDEHUB", label: "m" })).token;
    const id = await mk(a, "route target");
    for (const [method, path] of [["patch", `/api/memory/${id}`], ["delete", `/api/memory/${id}`], ["post", `/api/memory/${id}/confirm`], ["put", `/api/memory/${id}`]] as const) {
      expect((await request(app)[method](path).set({ Authorization: `Bearer ${token}` }).send({})).status, `${method} ${path}`).toBe(404);
    }
    expect(await memory(id)).not.toBeNull();
  });

  it("voice 'remember that…' still needs approval; the audit records the whole lifecycle for a delete", async () => {
    const out = await handleVoiceInput(idA("VOICE"), { transcript: "remember that x is y", session: { id: "s", deviceId: "d", startedAt: new Date() }, confidence: 0.9 });
    expect(out.speech).toMatch(/needs your approval/);
    const id = await mk(a, "audited delete");
    await deleteMemory(idA(), { memoryId: id });
    const row = await pendingFor(id, "MEMORY_DELETE");
    await decideApproval(idA(), row.id, "APPROVED");
    const types = (await listAuditLog(a, 300)).filter((e) => (e.metadata as { approvalId?: string }).approvalId === row.id).map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(["APPROVAL_CREATED", "APPROVAL_APPROVED", "APPROVAL_CONSUMED", "ACTION_EXECUTION_STARTED", "ACTION_EXECUTION_SUCCEEDED"]));
  });
});
