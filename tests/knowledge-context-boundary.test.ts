import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getDb, disconnectDb } from "../db/client/index.js";
import { searchKnowledge, listKnowledge, readKnowledge, setKnowledgeProvider, SKILL_KEY as K_SKILL, RESOURCE as K_RES } from "../skills/system/knowledge.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { listAuditLog } from "../gateway/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import type { KnowledgeProvider } from "../knowledge/types/index.js";
import { createPrincipal, deletePrincipal, ensureAgent, ensureSkill, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

describe("Knowledge is read only through the knowledge skill (Gateway READ)", () => {
  let a: string;
  let b: string;
  const touched: string[] = [];
  const spy: KnowledgeProvider = {
    listDocuments: async () => { touched.push("list"); return [{ slug: "s", title: "T", tags: [] }]; },
    readDocument: async (slug) => { touched.push(`read:${slug}`); return { slug, title: "T", tags: [], content: "body" }; },
    search: async (q) => { touched.push(`search:${q}`); return [{ slug: "s", title: "T", tags: [], excerpt: "e" }]; },
  };

  beforeAll(async () => {
    await ensureAgent(JARVIS_AGENT_KEY);
    await ensureSkill(K_SKILL);
    a = (await createPrincipal("Knowledge A")).id;
    b = (await createPrincipal("Knowledge B")).id;
    await grant(a, JARVIS_AGENT_KEY, K_SKILL, K_RES, "KNOWLEDGE_READ", "READ");
    setKnowledgeProvider(spy);
  });
  afterAll(async () => { setKnowledgeProvider(null); await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  afterEach(() => { touched.length = 0; });

  it("a granted READ reaches the provider and is audited as a gateway READ", async () => {
    const r = await searchKnowledge(identityFor(a), { agentKey: JARVIS_AGENT_KEY, query: "hello" });
    expect(r.status).toBe("EXECUTED");
    expect(touched).toEqual(["search:hello"]);
    const row = (await listAuditLog(a, 20)).find((e) => e.resource === K_RES && e.eventType === "ACTION_EXECUTED");
    expect(row).toBeDefined();
    expect(row!.metadata).toHaveProperty("payloadHash"); // the request is fingerprinted, never stored raw
    expect(JSON.stringify(row)).not.toContain("hello");
  });

  it("without the permission the provider is NEVER reached (the provider is not an authorization boundary)", async () => {
    for (const r of [
      await searchKnowledge(identityFor(b), { agentKey: JARVIS_AGENT_KEY, query: "secret" }),
      await listKnowledge(identityFor(b), { agentKey: JARVIS_AGENT_KEY }),
      await readKnowledge(identityFor(b), { agentKey: JARVIS_AGENT_KEY, slug: "principles" }),
    ]) expect(r.status).toBe("DENIED");
    expect(touched).toEqual([]);
    expect((await listAuditLog(b, 20)).filter((e) => e.eventType === "ACTION_DENIED" && e.resource === K_RES)).toHaveLength(3);
  });

  it("permissions are per agent: another agent's grant does not authorize this one", async () => {
    await grant(b, "some-other-knowledge-agent", K_SKILL, K_RES, "KNOWLEDGE_READ", "READ");
    expect((await searchKnowledge(identityFor(b), { agentKey: JARVIS_AGENT_KEY, query: "x" })).status).toBe("DENIED");
    expect((await searchKnowledge(identityFor(b), { agentKey: "some-other-knowledge-agent", query: "x" })).status).toBe("EXECUTED");
    await getDb().agent.delete({ where: { key: "some-other-knowledge-agent" } }).catch(() => undefined);
  });

  it("an explicit identity is required: nothing is read without one", async () => {
    for (const identity of [undefined, null, {}, { principalId: a }]) {
      const r = await searchKnowledge(identity as never, { agentKey: JARVIS_AGENT_KEY, query: "x" });
      expect(r.status).toBe("FAILED");
    }
    expect(touched).toEqual([]);
  });

  it("a DENIED permission row beats a grant elsewhere", async () => {
    await grant(b, JARVIS_AGENT_KEY, K_SKILL, K_RES, "KNOWLEDGE_READ", "READ", "DENIED");
    expect((await readKnowledge(identityFor(b), { agentKey: JARVIS_AGENT_KEY, slug: "principles" })).status).toBe("DENIED");
    expect(touched).toEqual([]);
  });

  describe("context goes through the skill", () => {
    it("with the grant, context includes knowledge — and the gateway READ is audited", async () => {
      const ctx = await new DeterministicContextEngine().buildContext({ identity: identityFor(a), agentKey: JARVIS_AGENT_KEY, query: "anything" });
      expect(ctx.relevantKnowledge).toEqual([{ slug: "s", title: "T", excerpt: "e" }]);
      expect(touched).toContain("search:anything");
      expect((await listAuditLog(a, 50)).some((e) => e.resource === K_RES)).toBe(true);
    });

    it("without the grant, knowledge is withheld and the provider is not touched", async () => {
      const ctx = await new DeterministicContextEngine().buildContext({ identity: identityFor(b), agentKey: JARVIS_AGENT_KEY, query: "anything" });
      expect(ctx.relevantKnowledge).toEqual([]);
      expect(ctx.withheld).toContain("knowledge");
      expect(touched).toEqual([]);
    });
  });

  it("structural: the Markdown provider itself contains no authorization (imports no gateway/identity/skills/db)", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../knowledge/markdown/index.ts"), "utf-8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.filter((i) => /gateway|identity|skills|db|prisma/.test(i))).toEqual([]);
  });
});
