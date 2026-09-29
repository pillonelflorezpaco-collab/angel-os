import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { LocalMemoryProvider } from "../memory/local/index.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import { describeMemory, SKILL_KEY as MEMORY_SKILL, RESOURCE as MEMORY_RESOURCE } from "../skills/system/memory.js";
import { SKILL_KEY as TASKS_SKILL, RESOURCE as TASKS_RESOURCE } from "../skills/system/tasks.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

const provider = new LocalMemoryProvider();

/** Regression for audit finding F5 (part 1): expired memories were still returned. */
describe("memory expiration", () => {
  let principalId: string;

  beforeAll(async () => {
    principalId = (await createPrincipal("Memory Expiry Principal")).id;
  });
  afterAll(async () => {
    await deletePrincipal(principalId);
  });

  it("returns memories with no expiration and a future expiration, but not an expired one", async () => {
    const none = await provider.addMemory({ principalId, type: "FACT", content: "expirytest no-expiry", source: "test" });
    const future = await provider.addMemory({
      principalId,
      type: "FACT",
      content: "expirytest future-expiry",
      source: "test",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const expired = await provider.addMemory({
      principalId,
      type: "FACT",
      content: "expirytest already-expired",
      source: "test",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    const ids = (await provider.searchMemory({ principalId, query: "expirytest" })).map((m) => m.id);
    expect(ids).toContain(none.id);
    expect(ids).toContain(future.id);
    expect(ids).not.toContain(expired.id);
  });

  it("does not delete the expired memory — history is preserved", async () => {
    const stillThere = await getDb().memory.findFirst({ where: { principalId, content: "expirytest already-expired" } });
    expect(stillThere).not.toBeNull();
  });

  it("an expiration one second in the past is expired (boundary)", async () => {
    const m = await provider.addMemory({
      principalId,
      type: "FACT",
      content: "expirytest boundary",
      source: "test",
      expiresAt: new Date(Date.now() - 1000),
    });
    const ids = (await provider.searchMemory({ principalId, query: "expirytest boundary" })).map((r) => r.id);
    expect(ids).not.toContain(m.id);
  });
});

/** Regression for audit finding F5 (part 2): unconfirmed inferences were presented alongside facts without distinction. */
describe("fact vs inference", () => {
  let principalId: string;
  let factId: string;
  let inferenceId: string;

  beforeAll(async () => {
    principalId = (await createPrincipal("Fact Inference Principal")).id;
    factId = (await provider.addMemory({ principalId, type: "FACT", content: "fitest likes window seats", source: "test" })).id;
    inferenceId = (
      await provider.addMemory({ principalId, type: "INFERENCE", content: "fitest probably prefers mornings", source: "inference:test" })
    ).id;
    await grant(principalId, JARVIS_AGENT_KEY, MEMORY_SKILL, MEMORY_RESOURCE, "MEMORY_READ", "READ");
    await grant(principalId, JARVIS_AGENT_KEY, TASKS_SKILL, TASKS_RESOURCE, "READ", "READ");
  });

  afterAll(async () => {
    await deletePrincipal(principalId);
    await disconnectDb();
  });

  it("FACT is retrieved as FACT and INFERENCE as INFERENCE (UNCONFIRMED)", async () => {
    const results = await provider.searchMemory({ principalId, query: "fitest" });
    const fact = results.find((m) => m.id === factId)!;
    const inference = results.find((m) => m.id === inferenceId)!;
    expect(fact.type).toBe("FACT");
    expect(fact.status).toBe("ACTIVE");
    expect(inference.type).toBe("INFERENCE");
    expect(inference.status).toBe("UNCONFIRMED");
  });

  it("context generation preserves type, status, and confirmed flag", async () => {
    const ctx = await new DeterministicContextEngine().buildContext({ principalId, agentKey: JARVIS_AGENT_KEY, query: "fitest" });
    const fact = ctx.relevantMemories.find((m) => m.id === factId)!;
    const inference = ctx.relevantMemories.find((m) => m.id === inferenceId)!;
    expect(fact).toMatchObject({ type: "FACT", status: "ACTIVE", confirmed: true });
    expect(inference).toMatchObject({ type: "INFERENCE", status: "UNCONFIRMED", confirmed: false });
  });

  it("serialization for the user labels each memory with its type", () => {
    expect(describeMemory({ type: "FACT", status: "ACTIVE", content: "x" })).toBe("[fact] x");
    expect(describeMemory({ type: "INFERENCE", status: "UNCONFIRMED", content: "y" })).toBe("[inference, unconfirmed] y");
    expect(describeMemory({ type: "INFERENCE", status: "ACTIVE", content: "z" })).toBe("[inference, confirmed] z");
  });

  it("Jarvis's memory answer never presents the inference as a fact", async () => {
    const result = await new JarvisCore().handle({ principalId, input: "what do i know about fitest" });
    expect(result.status).toBe("EXECUTED");
    expect(result.message).toContain("[fact] fitest likes window seats");
    expect(result.message).toContain("[inference, unconfirmed] fitest probably prefers mornings");
    expect(result.message).not.toContain("[fact] fitest probably prefers mornings");
  });

  it("no automatic promotion: reads and context builds leave the inference UNCONFIRMED", async () => {
    const row = await getDb().memory.findUniqueOrThrow({ where: { id: inferenceId } });
    expect(row.type).toBe("INFERENCE");
    expect(row.status).toBe("UNCONFIRMED");
    expect(row.confidence).toBeLessThan(1);
  });

  it("even explicit confirmation never changes the type from INFERENCE to FACT", async () => {
    const confirmed = await provider.confirmMemory(principalId, inferenceId);
    expect(confirmed.type).toBe("INFERENCE");
    expect(confirmed.status).toBe("ACTIVE");
  });
});
