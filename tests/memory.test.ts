import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { disconnectDb, getDb } from "../db/client/index.js";
import { LocalMemoryProvider } from "../memory/local/index.js";

describe("MemoryProvider (local implementation)", () => {
  let principalId: string;
  const provider = new LocalMemoryProvider();

  beforeAll(async () => {
    const db = getDb();
    const principal = await db.principal.create({ data: { name: "Test Principal memory" } });
    principalId = principal.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
    await disconnectDb();
  });

  it("adds an ACTIVE memory for an explicit FACT", async () => {
    const memory = await provider.addMemory({
      principalId,
      type: "FACT",
      content: "Prefers window seats when traveling.",
      source: "test",
    });
    expect(memory.status).toBe("ACTIVE");
    expect(memory.confidence).toBe(1.0);
  });

  it("adds an UNCONFIRMED memory with lower confidence for an INFERENCE", async () => {
    const memory = await provider.addMemory({
      principalId,
      type: "INFERENCE",
      content: "Seems to prefer morning meetings based on recent scheduling.",
      source: "inference:calendar-pattern",
    });
    expect(memory.status).toBe("UNCONFIRMED");
    expect(memory.confidence).toBeLessThan(1.0);
  });

  it("searchMemory finds by content substring", async () => {
    const results = await provider.searchMemory({ principalId, query: "window seats" });
    expect(results.some((m) => m.content.includes("window seats"))).toBe(true);
  });

  it("confirmMemory promotes an UNCONFIRMED memory to ACTIVE", async () => {
    const created = await provider.addMemory({
      principalId,
      type: "INFERENCE",
      content: "Might prefer async communication.",
      source: "inference:test",
    });
    const confirmed = await provider.confirmMemory(principalId, created.id);
    expect(confirmed.status).toBe("ACTIVE");
    expect(confirmed.lastConfirmedAt).not.toBeNull();
  });

  it("deleteMemory removes the record", async () => {
    const created = await provider.addMemory({
      principalId,
      type: "FACT",
      content: "Temporary fact to delete.",
      source: "test",
    });
    await provider.deleteMemory(principalId, created.id);
    const results = await provider.searchMemory({ principalId, query: "Temporary fact to delete" });
    expect(results.find((m) => m.id === created.id)).toBeUndefined();
  });
});
