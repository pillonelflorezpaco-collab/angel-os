import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService } from "../identity/index.js";
import { recordAuditEvent } from "../gateway/index.js";
import { listOwnAudit, MAX_AUDIT_LIMIT } from "../application/audit.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

describe("audit view: identity-based, bounded, client-safe", () => {
  let a: string;
  let b: string;
  let authA: { Authorization: string };
  const seed = (principalId: string, n: number, tag: string) => Promise.all(Array.from({ length: n }, (_, i) => recordAuditEvent({ principalId, agentKey: "jarvis-core", eventType: "ACTION_EXECUTION_SUCCEEDED", action: `${tag}-${i}`, result: "SUCCESS", source: "test" })));

  beforeAll(async () => {
    a = (await createPrincipal("Audit view A")).id;
    b = (await createPrincipal("Audit view B")).id;
    authA = { Authorization: `Bearer ${(await getApiTokenService().create({ principalId: a, interfaceSource: "GUIDEHUB", label: "a" })).token}` };
    await seed(a, 60, "mine");
    await seed(b, 5, "theirs");
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  it("returns only the identity's rows, newest first, without the internal agent FK", async () => {
    const rows = await listOwnAudit(identityFor(a), 10);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.principalId === a)).toBe(true);
    expect(rows.some((r) => (r.action ?? "").startsWith("theirs"))).toBe(false);
    expect(Object.keys(rows[0])).not.toContain("agentId");
    expect(rows.map((r) => r.createdAt.getTime())).toEqual([...rows.map((r) => r.createdAt.getTime())].sort((x, y) => y - x));
  });

  it("the limit is bounded: default 50, never above the cap, junk falls back safely", async () => {
    expect((await listOwnAudit(identityFor(a))).length).toBe(50);
    expect((await listOwnAudit(identityFor(a), 10_000)).length).toBeLessThanOrEqual(MAX_AUDIT_LIMIT);
    expect((await listOwnAudit(identityFor(a), 0)).length).toBe(50);
    expect((await listOwnAudit(identityFor(a), Number.NaN)).length).toBe(50);
    expect((await listOwnAudit(identityFor(a), -5)).length).toBe(1);
  });

  it("no identity, or a malformed one, throws before anything is read", async () => {
    for (const bad of [undefined, null, {}, { principalId: a }]) await expect(listOwnAudit(bad as never)).rejects.toThrow();
  });

  it("GET /api/audit honours ?limit, rejects bad or extra query parameters, and never leaks the agent FK", async () => {
    const ok = await request(app).get("/api/audit?limit=7").set(authA);
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveLength(7);
    expect(ok.body.every((r: any) => r.principalId === a && !("agentId" in r))).toBe(true);
    for (const q of ["limit=0", "limit=1000", "limit=abc", "foo=1", "limit=5&offset=1"]) expect((await request(app).get(`/api/audit?${q}`).set(authA)).status, q).toBe(400);
    expect((await request(app).get("/api/audit").set(authA)).body).toHaveLength(50);
  });

  it("the row count in the DB is unaffected by reading (audit is append-only and reads are not audited as writes to other principals)", async () => {
    const before = await getDb().auditLog.count({ where: { principalId: b } });
    await request(app).get("/api/audit").set(authA);
    expect(await getDb().auditLog.count({ where: { principalId: b } })).toBe(before);
  });
});
