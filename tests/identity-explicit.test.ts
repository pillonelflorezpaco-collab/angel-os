import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService, runWithIdentity, currentIdentity, IdentityRequiredError, createIdentity } from "../identity/index.js";
import { proposeAction, decideApproval, listAuditLog, IDENTITY_REQUIRED_MESSAGE } from "../gateway/index.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { createTask, createReminder } from "../skills/system/tasks.js";
import { remember, updateMemory, confirmMemory, deleteMemory } from "../skills/system/memory.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

describe("mutations require an EXPLICIT IdentityContext (ALS is never the authority)", () => {
  let a: string;
  let b: string;
  const UUID = "00000000-0000-0000-0000-000000000abc";

  beforeAll(async () => {
    a = (await createPrincipal("Explicit A")).id;
    b = (await createPrincipal("Explicit B")).id;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "WRITE");
      await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_REMINDER", "WRITE");
      await grant(p, JARVIS_AGENT_KEY, "system.memory", "angel:memory", "MEMORY_CREATE", "WRITE");
    }
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  const counts = async () => ({
    tasks: await getDb().task.count(),
    reminders: await getDb().reminder.count(),
    memories: await getDb().memory.count(),
    approvals: await getDb().approvalRequest.count(),
  });

  it("every mutation skill fails closed with no / malformed identity: no state change, no approval, no side effect", async () => {
    const before = await counts();
    const bad: unknown[] = [undefined, null, {}, { principalId: a }, { principalId: "", interfaceSource: "API", requestId: "r" }, "a", 42];
    for (const identity of bad) {
      const id = identity as never;
      const results = await Promise.all([
        createTask(id, { title: "x" }),
        createReminder(id, { message: "x", remindAt: new Date(Date.now() + 1000) }),
        remember(id, { type: "FACT", content: "x", source: "t" }),
        updateMemory(id, { memoryId: UUID, content: "x" }),
        confirmMemory(id, { memoryId: UUID }),
        deleteMemory(id, { memoryId: UUID }),
      ]);
      for (const r of results) expect(r).toEqual({ status: "FAILED", message: IDENTITY_REQUIRED_MESSAGE });
    }
    expect(await counts()).toEqual(before);
  });

  it("ALS absent: an explicit identity is sufficient and is what is used", async () => {
    expect(currentIdentity()).toBeUndefined();
    const r = await createTask(identityFor(a), { title: "explicit only" });
    expect(r.status).toBe("EXECUTED");
    expect(await getDb().task.count({ where: { principalId: a, title: "explicit only" } })).toBe(1);
  });

  it("ALS present and MATCHING: fine", async () => {
    const id = identityFor(a);
    const r = await runWithIdentity(id, () => createTask(id, { title: "matching als" }));
    expect(r.status).toBe("EXECUTED");
  });

  it("ALS present but CONFLICTING (another principal): refused, nothing created for anyone, conflict audited against the ambient principal", async () => {
    const before = await counts();
    const r = await runWithIdentity(identityFor(b), () => createTask(identityFor(a), { title: "crossed identities" }));
    expect(r).toEqual({ status: "FAILED", message: IDENTITY_REQUIRED_MESSAGE });
    expect(await counts()).toEqual(before);
    const audit = (await listAuditLog(b, 20)).find((e) => (e.metadata as { reason?: string }).reason === "identity_conflict");
    expect(audit).toMatchObject({ principalId: b, result: "DENIED" });
    expect(JSON.stringify(audit)).not.toContain(a);
  });

  it("an ambient identity alone never authorizes a mutation: passing another principal's explicit identity acts as THAT identity only if ALS agrees", async () => {
    // (no ALS, explicit B) acts as B — the explicit identity is the authority, never the reverse
    await createTask(identityFor(b), { title: "b explicit" });
    expect(await getDb().task.count({ where: { principalId: b, title: "b explicit" } })).toBe(1);
    expect(await getDb().task.count({ where: { principalId: a, title: "b explicit" } })).toBe(0);
  });

  it("approval decisions need an explicit identity too, and conflicting ambient identities are refused", async () => {
    await grant(a, JARVIS_AGENT_KEY, "system.memory", "angel:memory", "MEMORY_DELETE", "WRITE", "APPROVAL_REQUIRED");
    const mem = await getDb().memory.create({ data: { principalId: a, type: "FACT", content: "decide me", source: "t" } });
    await deleteMemory(identityFor(a), { memoryId: mem.id });
    const row = await getDb().approvalRequest.findFirstOrThrow({ where: { principalId: a, action: "MEMORY_DELETE", status: "PENDING" } });
    expect(await decideApproval(undefined as never, row.id, "APPROVED")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await runWithIdentity(identityFor(b), () => decideApproval(identityFor(a), row.id, "APPROVED"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await getDb().memory.findUnique({ where: { id: mem.id } })).not.toBeNull();
    expect((await getDb().approvalRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING");
  });

  it("a hand-built IdentityContext for one principal cannot smuggle another principal in parameters", async () => {
    const r = await proposeAction(identityFor(a), { skillKey: "system.tasks", action: "CREATE_TASK", parameters: { title: "smuggle", principalId: b } });
    expect(r.status).toBe("FAILED"); // strict schema: no principalId field exists
    expect(await getDb().task.count({ where: { title: "smuggle" } })).toBe(0);
  });

  it("client-supplied principalId is rejected over HTTP for the mutating routes (400) and creates nothing", async () => {
    const token = (await getApiTokenService().create({ principalId: a, interfaceSource: "GUIDEHUB", label: "x" })).token;
    const auth = { Authorization: `Bearer ${token}` };
    const before = await counts();
    const body = await request(app).post("/api/tasks").set(auth).send({ title: "override", principalId: b });
    const nested = await request(app).post("/api/reminders").set(auth).send({ message: "m", remindAt: new Date(Date.now() + 5000).toISOString(), meta: { principal_id: b } });
    const header = await request(app).post("/api/tasks").set(auth).set("X-Principal-Id", b).send({ title: "override" });
    expect([body.status, nested.status, header.status]).toEqual([400, 400, 400]);
    expect(await counts()).toEqual(before);
  });

  it("context requires an explicit identity: no identity, no context", async () => {
    const engine = new DeterministicContextEngine();
    for (const identity of [undefined, null, {}, { principalId: a }]) {
      await expect(engine.buildContext({ identity: identity as never, agentKey: JARVIS_AGENT_KEY, query: "x" })).rejects.toBeInstanceOf(IdentityRequiredError);
    }
  });

  it("IdentityContext is frozen: a caller cannot rewrite the principal after the fact", () => {
    const id = createIdentity({ principalId: a, interfaceSource: "API", authMethod: "api_token", requestId: "r" });
    expect(() => { (id as { principalId: string }).principalId = b; }).toThrow();
  });
});
