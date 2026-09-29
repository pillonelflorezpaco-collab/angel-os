import { describe, it, expect, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { recordAuditEvent } from "../gateway/index.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";

process.env.NODE_ENV = "test";

describe("audit history outlives the principal it describes", () => {
  const created: string[] = [];
  afterAll(async () => {
    await getDb().auditLog.deleteMany({ where: { principalId: { in: created } } });
    await disconnectDb();
  });

  it("deleting a principal removes its data but NEVER its audit rows", async () => {
    const p = (await createPrincipal("Audit retention")).id;
    created.push(p);
    const db = getDb();
    await db.task.create({ data: { principalId: p, title: "will be deleted" } });
    await recordAuditEvent({ principalId: p, eventType: "ACTION_EXECUTION_SUCCEEDED", action: "RETAIN_ME", result: "SUCCESS", source: "test" });
    await recordAuditEvent({ principalId: p, eventType: "ACTION_DENIED", action: "RETAIN_ME_TOO", result: "DENIED", source: "test" });

    await db.principal.delete({ where: { id: p } }); // cascades personal data
    expect(await db.task.count({ where: { principalId: p } })).toBe(0);
    const rows = await db.auditLog.findMany({ where: { principalId: p }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["RETAIN_ME", "RETAIN_ME_TOO"]);
    expect(rows.every((r) => r.principalId === p)).toBe(true); // still says WHO, even though that principal is gone
  });

  it("audit rows are append-only: an UPDATE is refused by the database, so history cannot be rewritten", async () => {
    const p = (await createPrincipal("Audit append-only")).id;
    created.push(p);
    const row = await recordAuditEvent({ principalId: p, eventType: "ACTION_DENIED", action: "ORIGINAL", result: "DENIED", source: "test" });
    await expect(getDb().auditLog.update({ where: { id: row.id }, data: { action: "REWRITTEN", result: "SUCCESS" } })).rejects.toThrow(/append-only/);
    await expect(getDb().auditLog.updateMany({ where: { principalId: p }, data: { metadata: { tampered: true } } })).rejects.toThrow(/append-only/);
    expect((await getDb().auditLog.findUniqueOrThrow({ where: { id: row.id } })).action).toBe("ORIGINAL");
    await deletePrincipal(p);
    expect(await getDb().auditLog.count({ where: { principalId: p } })).toBe(0); // the test helper purges its own rows explicitly
  });

  it("deleting an AGENT only detaches it from its audit rows (agentId → NULL); no other column can change", async () => {
    const p = (await createPrincipal("Audit agent detach")).id;
    created.push(p);
    const key = `audit-detach-agent-${Math.random().toString(36).slice(2)}`;
    const agent = await getDb().agent.create({ data: { key, name: "tmp" } });
    const row = await recordAuditEvent({ principalId: p, agentKey: key, eventType: "ACTION_DENIED", action: "DETACH_ME", result: "DENIED", source: "test" });
    expect((await getDb().auditLog.findUniqueOrThrow({ where: { id: row.id } })).agentId).toBe(agent.id);
    // the guard refuses to re-point an audit row at another agent, or to touch anything else along with the detach
    await expect(getDb().auditLog.update({ where: { id: row.id }, data: { agentId: null, action: "CHANGED" } })).rejects.toThrow(/append-only/);
    await expect(getDb().auditLog.update({ where: { id: row.id }, data: { agentId: agent.id, source: "x" } })).rejects.toThrow(/append-only/);
    await getDb().agent.delete({ where: { id: agent.id } }); // FK SET NULL is the one permitted update
    const after = await getDb().auditLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ agentId: null, action: "DETACH_ME", result: "DENIED", source: "test", principalId: p });
    await deletePrincipal(p);
  });

  it("another principal never sees a deleted principal's trail", async () => {
    const gone = (await createPrincipal("Audit gone")).id;
    const other = (await createPrincipal("Audit other")).id;
    created.push(gone, other);
    await recordAuditEvent({ principalId: gone, eventType: "ACTION_DENIED", action: "GONE_ONLY", result: "DENIED", source: "test" });
    await getDb().principal.delete({ where: { id: gone } });
    const { listAuditLog } = await import("../gateway/index.js");
    expect((await listAuditLog(other)).some((r) => r.action === "GONE_ONLY")).toBe(false);
    expect((await listAuditLog(gone)).some((r) => r.action === "GONE_ONLY")).toBe(true); // an operator query by the historical id still works
    await deletePrincipal(other);
  });
});
