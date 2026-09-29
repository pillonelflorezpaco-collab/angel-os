import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { listTasks, listReminders } from "../skills/system/tasks.js";
import { search, getMemoryById, memoryHistory } from "../skills/system/memory.js";
import { listActivity, summarizeActivity } from "../skills/system/activity.js";
import { queryDecisions } from "../skills/system/decisions.js";
import * as calendar from "../skills/integrations/calendar.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";

// Legacy READ skills used to take {principalId, agentKey}. They now derive the principal ONLY from an explicit
// IdentityContext: a smuggled principalId is overridden, and a missing or malformed identity fails closed.
describe("READ skills: the principal comes from the identity, never from a parameter", () => {
  let a: string;
  let b: string;
  const agentKey = JARVIS_AGENT_KEY;

  beforeAll(async () => {
    a = (await createPrincipal("Read identity A")).id;
    b = (await createPrincipal("Read identity B")).id;
    for (const p of [a, b]) {
      for (const [sk, res, act] of [["system.tasks", "angel:tasks", "READ"], ["system.memory", "angel:memory", "MEMORY_READ"], ["system.activity", "angel:activity", "ACTIVITY_READ"], ["system.decisions", "angel:decisions", "DECISION_READ"]] as const) await grant(p, agentKey, sk, res, act, "READ");
    }
    const db = getDb();
    await db.task.create({ data: { principalId: a, title: "A task xqzw" } });
    await db.task.create({ data: { principalId: b, title: "B task xqzw" } });
    await db.reminder.create({ data: { principalId: a, message: "A reminder xqzw", remindAt: new Date(Date.now() + 86400000) } });
    await db.reminder.create({ data: { principalId: b, message: "B reminder xqzw", remindAt: new Date(Date.now() + 86400000) } });
    await db.memory.create({ data: { principalId: a, type: "FACT", content: "A memory xqzw", source: "t" } });
    await db.memory.create({ data: { principalId: b, type: "FACT", content: "B memory xqzw", source: "t" } });
    await db.decision.create({ data: { principalId: a, title: "A decision xqzw", decision: "d" } });
    await db.decision.create({ data: { principalId: b, title: "B decision xqzw", decision: "d" } });
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("a smuggled principalId is overridden by the identity: A's identity never returns B's rows", async () => {
    const bad = (extra: object = {}) => ({ agentKey, principalId: b, ...extra }) as never;
    const asA = identityFor(a);
    expect(JSON.stringify((await listTasks(asA, bad())).data)).toMatch(/A task/);
    expect(JSON.stringify((await listTasks(asA, bad())).data)).not.toMatch(/B task/);
    expect(JSON.stringify((await listReminders(asA, bad())).data)).not.toMatch(/B reminder/);
    expect(JSON.stringify((await search(asA, bad({ query: { query: "xqzw" } }))).data)).not.toMatch(/B memory/);
    expect(JSON.stringify((await search(asA, bad({ query: { query: "xqzw" } }))).data)).toMatch(/A memory/);
    expect(JSON.stringify((await queryDecisions(asA, bad({ topic: "xqzw" }))).data)).not.toMatch(/B decision/);
    expect(JSON.stringify((await queryDecisions(asA, bad({ topic: "xqzw" }))).data)).toMatch(/A decision/);
    const bMem = await getDb().memory.findFirstOrThrow({ where: { principalId: b } });
    expect((await getMemoryById(asA, bad({ memoryId: bMem.id }))).status).toBe("FAILED");
    expect((await memoryHistory(asA, bad({ memoryId: bMem.id }))).status).toBe("FAILED");
    // activity/calendar: the audit rows and results are for A, and the call is authorized as A
    const act = await listActivity(asA, bad({ range: "today" }));
    expect(act.status).toBe("EXECUTED");
    expect((await summarizeActivity(asA, bad({ range: "week" }))).status).toBe("EXECUTED");
    const audit = await getDb().auditLog.findMany({ where: { principalId: b, source: { startsWith: "skill.system" } } });
    expect(audit).toHaveLength(0);
  });

  it("no identity, or a malformed one, fails closed for every read skill and nothing is read", async () => {
    const before = await getDb().auditLog.count();
    const calls: [string, (i: any) => Promise<{ status: string; message: string }>][] = [
      ["listTasks", (i) => listTasks(i, { agentKey })], ["listReminders", (i) => listReminders(i, { agentKey })],
      ["search", (i) => search(i, { agentKey, query: { query: "x" } })], ["getMemoryById", (i) => getMemoryById(i, { agentKey, memoryId: "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e" })],
      ["memoryHistory", (i) => memoryHistory(i, { agentKey, memoryId: "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e" })],
      ["listActivity", (i) => listActivity(i, { agentKey, range: "today" })], ["summarizeActivity", (i) => summarizeActivity(i, { agentKey, range: "week" })],
      ["queryDecisions", (i) => queryDecisions(i, { agentKey, topic: "x" })],
      ["calendar.listCalendars", (i) => calendar.listCalendars(i, { agentKey })], ["calendar.today", (i) => calendar.today(i, { agentKey })],
      ["calendar.listEvents", (i) => calendar.listEvents(i, { agentKey, calendarId: "primary", timeMin: new Date(), timeMax: new Date() })],
      ["calendar.getEvent", (i) => calendar.getEvent(i, { agentKey, calendarId: "primary", eventId: "e" })],
    ];
    for (const [name, call] of calls) {
      for (const bad of [undefined, null, {}, { principalId: a }, { principalId: a, interfaceSource: "GUIDEHUB" }, { principalId: "not-registered", interfaceSource: "NOPE", requestId: "r", authMethod: "x" }]) {
        const r = await call(bad);
        expect(r.status, `${name} ${JSON.stringify(bad)}`).toBe("FAILED");
        expect(r.message, name).toMatch(/without knowing who you are/);
      }
    }
    expect(await getDb().auditLog.count()).toBe(before); // nothing was authorized or executed, so nothing was audited
  });
});
