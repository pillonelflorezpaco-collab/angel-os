import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { searchKnowledgeItems, listKnowledgeSources, getKnowledgeItem, SKILL_KEY as K_SKILL, RESOURCE as K_RES } from "../skills/system/knowledge.js";
import { getKnowledgeStore } from "../knowledge/store/index.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { listAuditLog } from "../gateway/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { createPrincipal, deletePrincipal, ensureAgent, ensureSkill, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";

// Knowledge is read only through the knowledge skill (gateway READ lane). The store is NOT an authorization
// boundary — it does ownership scoping only — so these tests prove it is never reached without permission.
describe("Knowledge is read only through the knowledge skill (Gateway READ)", () => {
  let a: string;
  let b: string;
  const store = getKnowledgeStore();
  const spies = () => [vi.spyOn(store, "search"), vi.spyOn(store, "listSources"), vi.spyOn(store, "getItem")];
  const reached = () => spies().reduce((n, s) => n + s.mock.calls.length, 0);

  beforeAll(async () => {
    await ensureAgent(JARVIS_AGENT_KEY);
    await ensureSkill(K_SKILL);
    a = (await createPrincipal("Knowledge A")).id;
    b = (await createPrincipal("Knowledge B")).id;
    await grant(a, JARVIS_AGENT_KEY, K_SKILL, K_RES, "KNOWLEDGE_READ", "READ");
    await store.ingest(a, { title: "A notes", sourceKind: "note", format: "markdown", content: "# Boundary topic\nFact: zzkbq is the marker word" });
  });
  afterAll(async () => { vi.restoreAllMocks(); await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("a granted READ reaches the store and is audited as a gateway READ (the request is fingerprinted, never stored raw)", async () => {
    const r = await searchKnowledgeItems(identityFor(a), { agentKey: JARVIS_AGENT_KEY, query: "zzkbq" });
    expect(r.status).toBe("EXECUTED");
    expect(JSON.stringify(r.data)).toContain("zzkbq");
    const row = (await listAuditLog(a, 20)).find((e) => e.resource === K_RES && e.eventType === "ACTION_EXECUTED");
    expect(row).toBeDefined();
    expect(row!.metadata).toHaveProperty("payloadHash");
    expect(JSON.stringify(row)).not.toContain("zzkbq");
  });

  it("without the permission the store is NEVER reached", async () => {
    const [search, list, get] = spies();
    for (const r of [
      await searchKnowledgeItems(identityFor(b), { agentKey: JARVIS_AGENT_KEY, query: "secret" }),
      await listKnowledgeSources(identityFor(b), { agentKey: JARVIS_AGENT_KEY }),
      await getKnowledgeItem(identityFor(b), { agentKey: JARVIS_AGENT_KEY, itemId: "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e" }),
    ]) expect(r.status).toBe("DENIED");
    expect([search, list, get].map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
    expect((await listAuditLog(b, 20)).filter((e) => e.eventType === "ACTION_DENIED" && e.resource === K_RES)).toHaveLength(3);
  });

  it("permissions are per agent: another agent's grant does not authorize this one", async () => {
    await grant(b, "some-other-knowledge-agent", K_SKILL, K_RES, "KNOWLEDGE_READ", "READ");
    expect((await searchKnowledgeItems(identityFor(b), { agentKey: JARVIS_AGENT_KEY, query: "x" })).status).toBe("DENIED");
    expect((await searchKnowledgeItems(identityFor(b), { agentKey: "some-other-knowledge-agent", query: "x" })).status).toBe("EXECUTED");
    await getDb().agent.delete({ where: { key: "some-other-knowledge-agent" } }).catch(() => undefined);
  });

  it("an explicit identity is required: nothing is read without one", async () => {
    spies();
    for (const identity of [undefined, null, {}, { principalId: a }]) {
      const r = await searchKnowledgeItems(identity as never, { agentKey: JARVIS_AGENT_KEY, query: "x" });
      expect(r.status).toBe("FAILED");
    }
    expect(reached()).toBe(0);
  });

  it("a DENIED permission row beats a grant elsewhere", async () => {
    await grant(b, JARVIS_AGENT_KEY, K_SKILL, K_RES, "KNOWLEDGE_READ", "READ", "DENIED");
    const [search] = spies();
    expect((await searchKnowledgeItems(identityFor(b), { agentKey: JARVIS_AGENT_KEY, query: "x" })).status).toBe("DENIED");
    expect(search).not.toHaveBeenCalled();
  });

  it("there is no global knowledge: one principal's items are never visible to another, even with the grant", async () => {
    await grant(b, JARVIS_AGENT_KEY, K_SKILL, K_RES, "KNOWLEDGE_READ", "READ", "ALLOWED");
    const r = await searchKnowledgeItems(identityFor(b), { agentKey: JARVIS_AGENT_KEY, query: "zzkbq" });
    expect(r.status).toBe("EXECUTED");
    expect(JSON.stringify(r.data)).not.toContain("zzkbq");
  });

  describe("context goes through the skill", () => {
    it("with the grant, context includes the principal's knowledge — and the gateway READ is audited", async () => {
      const ctx = await new DeterministicContextEngine().buildContext({ identity: identityFor(a), agentKey: JARVIS_AGENT_KEY, query: "zzkbq" });
      expect(ctx.relevantKnowledge.map((k) => k.slug)).toEqual(expect.arrayContaining([expect.stringMatching(/^item:/)]));
      expect(JSON.stringify(ctx.relevantKnowledge)).toContain("zzkbq");
      expect((await listAuditLog(a, 50)).some((e) => e.resource === K_RES)).toBe(true);
    });

    it("without the grant, knowledge is withheld and the store is not touched", async () => {
      const c = (await createPrincipal("Knowledge C")).id;
      try {
        const [search] = spies();
        const ctx = await new DeterministicContextEngine().buildContext({ identity: identityFor(c), agentKey: JARVIS_AGENT_KEY, query: "anything" });
        expect(ctx.relevantKnowledge).toEqual([]);
        expect(ctx.withheld).toContain("knowledge");
        expect(search).not.toHaveBeenCalled();
      } finally { await deletePrincipal(c); }
    });
  });
});
