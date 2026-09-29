import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService, runAsSystem } from "../identity/index.js";
import { decideApproval, listAuditLog } from "../gateway/index.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { remember, updateMemory, confirmMemory, retractMemory, deleteMemory, search, getMemoryById, memoryHistory } from "../skills/system/memory.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
const { app } = await import("../api/server.js");

const SKILL = "system.memory";
const RES = "angel:memory";
const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.now() + ms);

describe("Memory OS: provenance, temporal validity, lifecycle, history", () => {
  let a: string;
  let b: string;
  const idA = (s: "GUIDEHUB" | "VOICE" | "TELEGRAM" = "GUIDEHUB") => identityFor(a, s);
  const raw = (id: string) => getDb().memory.findUnique({ where: { id } });
  const readA = { principalId: "", agentKey: JARVIS_AGENT_KEY };
  const searchA = async (query: string, extra: Record<string, unknown> = {}) => {
    const r = await search({ principalId: a, agentKey: JARVIS_AGENT_KEY, query: { query, ...extra } });
    return (r.data as { id: string; content: string }[] | undefined) ?? [];
  };
  /** Creates a memory through the real skill path and returns its id. */
  const create = async (params: Parameters<typeof remember>[1], who = idA()) => {
    const r = await remember(who, params);
    expect(r.status, JSON.stringify(r)).toBe("EXECUTED");
    return (r.data as { id: string }).id;
  };
  /** Proposes a sensitive change and approves it from GuideHub. */
  const approve = async (r: { status: string; approvalId?: string }) => {
    expect(r.status).toBe("PENDING_APPROVAL");
    return decideApproval(idA(), r.approvalId!, "APPROVED");
  };

  beforeAll(async () => {
    a = (await createPrincipal("Memory OS A")).id;
    b = (await createPrincipal("Memory OS B")).id;
    readA.principalId = a;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, SKILL, RES, "MEMORY_READ", "READ");
      await grant(p, JARVIS_AGENT_KEY, SKILL, RES, "MEMORY_CREATE", "WRITE");
      for (const action of ["MEMORY_UPDATE", "MEMORY_CONFIRM", "MEMORY_RETRACT", "MEMORY_DELETE"]) await grant(p, JARVIS_AGENT_KEY, SKILL, RES, action, "WRITE", "APPROVAL_REQUIRED");
    }
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });

  describe("vocabulary and default provenance", () => {
    it("supports facts, experiences, preferences, decisions, lessons, relationships, goals and personal context", async () => {
      for (const type of ["FACT", "EXPERIENCE", "PREFERENCE", "DECISION", "LESSON", "RELATIONSHIP", "GOAL", "CONTEXT"] as const) {
        const id = await create({ type, content: `vocab ${type}`, source: "test" });
        expect((await raw(id))!.type).toBe(type);
      }
    });

    it("provenance defaults from the type: STATED, EXPERIENCED for experiences, INFERRED for inferences", async () => {
      expect((await raw(await create({ type: "FACT", content: "prov fact", source: "t" })))!.provenance).toBe("STATED");
      expect((await raw(await create({ type: "EXPERIENCE", content: "prov exp", source: "t", occurredAt: at(-3 * DAY) })))!.provenance).toBe("EXPERIENCED");
      expect((await raw(await create({ type: "INFERENCE", content: "prov inf", source: "t" })))!.provenance).toBe("INFERRED");
    });

    it("structured provenance is preserved exactly: source, sourceRef, subject, occurredAt, validity", async () => {
      const occurredAt = new Date("2031-02-03T04:05:06.000Z");
      const id = await create({ type: "EXPERIENCE", content: "trekked Chingaza", source: "conversation", sourceRef: "msg-42", subject: "Chingaza trip", occurredAt, validFrom: new Date("2031-02-01T00:00:00.000Z") });
      const m = (await raw(id))!;
      expect(m).toMatchObject({ source: "conversation", sourceRef: "msg-42", subject: "Chingaza trip", provenance: "EXPERIENCED", principalId: a });
      expect(m.occurredAt!.toISOString()).toBe(occurredAt.toISOString());
      expect(m.validFrom!.toISOString()).toBe("2031-02-01T00:00:00.000Z");
    });
  });

  describe("inference is never silently a fact", () => {
    it("an inference is created UNCONFIRMED at reduced confidence and its type/provenance can never change", async () => {
      const id = await create({ type: "INFERENCE", content: "sem-inf likes early mornings", source: "inference:pattern" });
      expect(await raw(id)).toMatchObject({ type: "INFERENCE", status: "UNCONFIRMED", confidence: 0.5, provenance: "INFERRED" });
      // no ActionDefinition parameter can carry an identity/lifecycle change — each one is rejected on its own
      for (const forbidden of [{ type: "FACT" }, { provenance: "STATED" }, { status: "ACTIVE" }, { principalId: b }, { derivedFromId: id }, { retractedAt: new Date().toISOString() }]) {
        const r = await updateMemory(idA(), { memoryId: id, content: "sem-inf tampered", ...forbidden } as never);
        expect(r.status, JSON.stringify(forbidden)).toBe("FAILED");
      }
      expect(await raw(id)).toMatchObject({ type: "INFERENCE", provenance: "INFERRED", content: "sem-inf likes early mornings" });
    });

    it("confirming promotes status and confidence, but the memory is STILL an inference", async () => {
      const id = await create({ type: "INFERENCE", content: "sem-inf confirm me", source: "t" });
      expect((await approve(await confirmMemory(idA(), { memoryId: id }))).executed).toBe(true);
      expect(await raw(id)).toMatchObject({ type: "INFERENCE", provenance: "INFERRED", status: "ACTIVE", confidence: 1 });
      expect((await raw(id))!.lastConfirmedAt).not.toBeNull();
    });

    it("relabeling is rejected before any approval exists: FACT+INFERRED, INFERENCE+STATED, EXPERIENCE+STATED, FACT+EXPERIENCED", async () => {
      const before = await getDb().approvalRequest.count({ where: { principalId: a } });
      for (const params of [
        { type: "FACT", content: "x", source: "t", provenance: "INFERRED" },
        { type: "INFERENCE", content: "x", source: "t", provenance: "STATED" },
        { type: "EXPERIENCE", content: "x", source: "t", provenance: "STATED" },
        { type: "FACT", content: "x", source: "t", provenance: "EXPERIENCED" },
        { type: "INFERENCE", content: "x", source: "t", confidence: 1 },
      ] as const) {
        const r = await remember(idA("VOICE"), params as never); // voice would create an approval if it validated
        expect(r.status, JSON.stringify(params)).toBe("FAILED");
      }
      expect(await getDb().approvalRequest.count({ where: { principalId: a } })).toBe(before);
    });

    it("an unconfirmed inference cannot be pushed to full confidence by an update", async () => {
      const id = await create({ type: "INFERENCE", content: "sem-inf conf cap", source: "t" });
      const r = await approve(await updateMemory(idA(), { memoryId: id, confidence: 1 }));
      expect(r.executed).toBe(false);
      expect((await raw(id))!.confidence).toBe(0.5);
    });

    it("a fact can be derived from an inference only explicitly, and keeps the link", async () => {
      const inf = await create({ type: "INFERENCE", content: "sem-inf prefers tea", source: "t" });
      const fact = await create({ type: "FACT", content: "sem-inf Angel confirmed: prefers tea", source: "explicit", derivedFromId: inf });
      expect(await raw(fact)).toMatchObject({ type: "FACT", provenance: "STATED", derivedFromId: inf });
      expect((await raw(inf))!.type).toBe("INFERENCE"); // the inference itself is untouched
    });
  });

  describe("provenance links stay inside the owner", () => {
    it("derivedFromId must be the SAME principal's memory", async () => {
      const bMem = await getDb().memory.create({ data: { principalId: b, type: "EXPERIENCE", provenance: "EXPERIENCED", content: "B's experience", source: "t" } });
      const r = await remember(idA(), { type: "LESSON", content: "steal provenance", source: "t", derivedFromId: bMem.id });
      expect(r.status).toBe("FAILED");
      expect(await getDb().memory.count({ where: { principalId: a, content: "steal provenance" } })).toBe(0);
    });

    it("a lesson references its experience; deleting the experience keeps the lesson and clears the link", async () => {
      const exp = await create({ type: "EXPERIENCE", content: "lesson exp", source: "t", occurredAt: at(-DAY) });
      const lesson = await create({ type: "LESSON", content: "lesson learned", source: "t", derivedFromId: exp, provenance: "EXPERIENCED" });
      expect((await raw(lesson))!.derivedFromId).toBe(exp);
      await approve(await deleteMemory(idA(), { memoryId: exp }));
      expect(await raw(exp)).toBeNull();
      expect((await raw(lesson))!.derivedFromId).toBeNull();
    });
  });

  describe("temporal validity (world time) vs expiry (system time)", () => {
    it("retrieval honours validFrom / validUntil / expiresAt, with an explicit asOf", async () => {
      const future = await create({ type: "CONTEXT", content: "tv-future trip", source: "t", validFrom: at(5 * DAY), validUntil: at(9 * DAY) });
      const current = await create({ type: "CONTEXT", content: "tv-current trip", source: "t", validFrom: at(-DAY), validUntil: at(DAY) });
      const past = await create({ type: "CONTEXT", content: "tv-past trip", source: "t", validFrom: at(-9 * DAY), validUntil: at(-5 * DAY) });
      const open = await create({ type: "CONTEXT", content: "tv-open trip", source: "t" });
      const ids = async (extra = {}) => (await searchA("tv-", extra)).map((m) => m.id);
      const now = await ids();
      expect(now).toContain(current);
      expect(now).toContain(open);
      expect(now).not.toContain(future);
      expect(now).not.toContain(past);
      const later = await ids({ asOf: at(7 * DAY) });
      expect(later).toContain(future);
      expect(later).not.toContain(current);
      const earlier = await ids({ asOf: at(-7 * DAY) });
      expect(earlier).toContain(past);
      expect(await raw(past)).not.toBeNull(); // kept for history
    });

    it("validUntil is exclusive; validFrom is inclusive", async () => {
      const edge = new Date(Date.now() + 10 * DAY);
      const id = await create({ type: "CONTEXT", content: "tv-edge", source: "t", validFrom: new Date(edge.getTime() - DAY), validUntil: edge });
      expect((await searchA("tv-edge", { asOf: new Date(edge.getTime() - 1) })).map((m) => m.id)).toContain(id);
      expect((await searchA("tv-edge", { asOf: edge })).map((m) => m.id)).not.toContain(id);
      expect((await searchA("tv-edge", { asOf: new Date(edge.getTime() - DAY) })).map((m) => m.id)).toContain(id);
    });

    it("an invalid window is rejected up front", async () => {
      expect((await remember(idA(), { type: "CONTEXT", content: "bad window", source: "t", validFrom: at(DAY), validUntil: at(-DAY) })).status).toBe("FAILED");
      const same = at(DAY); // one instant: from == until is an empty window
      expect((await remember(idA(), { type: "CONTEXT", content: "bad window", source: "t", validFrom: same, validUntil: same })).status).toBe("FAILED");
    });

    it("extending a validity window is an approved update and brings the memory back", async () => {
      const id = await create({ type: "CONTEXT", content: "tv-extend", source: "t", validFrom: at(-3 * DAY), validUntil: at(-DAY) });
      expect((await searchA("tv-extend")).map((m) => m.id)).not.toContain(id);
      expect((await approve(await updateMemory(idA(), { memoryId: id, validUntil: at(30 * DAY) }))).executed).toBe(true);
      expect((await searchA("tv-extend")).map((m) => m.id)).toContain(id);
    });

    it("filters: by type(s) and by subject", async () => {
      const rel = await create({ type: "RELATIONSHIP", content: "flt-x calls on Sundays", source: "t", subject: "Ana (sister)" });
      const pref = await create({ type: "PREFERENCE", content: "flt-x likes tea", source: "t", subject: "Ana" });
      const other = await create({ type: "PREFERENCE", content: "flt-x likes coffee", source: "t", subject: "Luis" });
      expect((await searchA("flt-x", { type: "RELATIONSHIP" })).map((m) => m.id)).toEqual([rel]);
      expect((await searchA("flt-x", { types: ["RELATIONSHIP", "PREFERENCE"] })).map((m) => m.id).sort()).toEqual([rel, pref, other].sort());
      expect((await searchA("flt-x", { subject: "ana" })).map((m) => m.id).sort()).toEqual([rel, pref].sort());
    });
  });

  describe("lifecycle: revisions, retraction, history", () => {
    it("an approved update records the previous state, tied to the request, interface and approval", async () => {
      const id = await create({ type: "FACT", content: "rev original", source: "t", confidence: 0.8 });
      const proposal = await updateMemory(idA("TELEGRAM"), { memoryId: id, content: "rev changed", confidence: 0.9 });
      const done = await approve(proposal);
      expect(done.executed).toBe(true);
      expect(await raw(id)).toMatchObject({ content: "rev changed", confidence: 0.9 });
      const revs = await getDb().memoryRevision.findMany({ where: { memoryId: id } });
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({ changeType: "UPDATE", previousContent: "rev original", previousConfidence: 0.8, previousStatus: "ACTIVE", principalId: a, approvalId: proposal.approvalId, interfaceSource: "GUIDEHUB" });
      expect(revs[0].requestId).toBeTruthy();
    });

    it("history is readable by the owner through the READ lane, newest first, and is audited without raw content", async () => {
      const id = await create({ type: "FACT", content: "hist v1", source: "t" });
      await approve(await updateMemory(idA(), { memoryId: id, content: "hist v2" }));
      await approve(await updateMemory(idA(), { memoryId: id, content: "hist v3" }));
      const h = await memoryHistory({ ...readA, memoryId: id });
      expect(h.status).toBe("EXECUTED");
      expect((h.data as { previousContent: string }[]).map((r) => r.previousContent)).toEqual(["hist v2", "hist v1"]);
      const got = await getMemoryById({ ...readA, memoryId: id });
      expect((got.data as { content: string }).content).toBe("hist v3");
      const audit = (await listAuditLog(a, 400)).filter((e) => e.eventType === "ACTION_EXECUTED" && e.resource === RES);
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toMatch(/hist v[123]/);
    });

    it("concurrent updates serialize (row lock): every revision captures the state it actually replaced — no lost updates", async () => {
      const { LocalMemoryProvider } = await import("../memory/local/index.js");
      const provider = new LocalMemoryProvider();
      const id = await create({ type: "FACT", content: "conc start", source: "t" });
      const N = 10;
      await Promise.all(Array.from({ length: N }, (_, i) => provider.updateMemory(a, id, { content: `conc v${i}` })));
      const revs = (await getDb().memoryRevision.findMany({ where: { memoryId: id } })).map((r) => r.previousContent);
      expect(revs).toHaveLength(N);
      expect(new Set(revs).size).toBe(N); // a lost update would show the same previous state twice
      expect(revs).toContain("conc start");
      const final = (await raw(id))!.content;
      expect(revs).not.toContain(final); // the final state was never "replaced": the chain is unbroken
    });

    it("confirm records a CONFIRM revision", async () => {
      const id = await create({ type: "INFERENCE", content: "rev-inf", source: "t" });
      await approve(await confirmMemory(idA(), { memoryId: id }));
      expect(await getDb().memoryRevision.findFirst({ where: { memoryId: id } })).toMatchObject({ changeType: "CONFIRM", previousStatus: "UNCONFIRMED", previousConfidence: 0.5 });
    });

    it("revisions are append-only at the database level", async () => {
      const id = await create({ type: "FACT", content: "append only", source: "t" });
      await approve(await updateMemory(idA(), { memoryId: id, content: "append only 2" }));
      const rev = await getDb().memoryRevision.findFirstOrThrow({ where: { memoryId: id } });
      await expect(getDb().memoryRevision.update({ where: { id: rev.id }, data: { previousContent: "forged" } })).rejects.toThrow(/append-only/);
    });

    describe("retraction", () => {
      it("needs approval on EVERY interface; nothing changes until approved", async () => {
        for (const source of ["GUIDEHUB", "TELEGRAM", "API", "VOICE"] as const) {
          const id = await create({ type: "FACT", content: `retract gate ${source}`, source: "t" });
          const r = await retractMemory(identityFor(a, source), { memoryId: id, reason: "wrong" });
          expect(r.status, source).toBe("PENDING_APPROVAL");
          expect((await raw(id))!.status).toBe("ACTIVE");
        }
      });

      it("voice and SYSTEM can never approve it", async () => {
        const id = await create({ type: "FACT", content: "retract who approves", source: "t" });
        const r = await retractMemory(idA(), { memoryId: id, reason: "wrong" });
        expect(await decideApproval(idA("VOICE"), r.approvalId!, "APPROVED")).toMatchObject({ ok: false, code: "FORBIDDEN" });
        expect(await runAsSystem(a, "j", (s) => decideApproval(s, r.approvalId!, "APPROVED"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
        expect((await raw(id))!.status).toBe("ACTIVE");
      });

      it("approved: kept for history with the reason, no longer retrieved as belief, terminal", async () => {
        const id = await create({ type: "FACT", content: "ret-x the sky is green", source: "t" });
        expect((await approve(await retractMemory(idA(), { memoryId: id, reason: "it was a typo" }))).executed).toBe(true);
        const m = (await raw(id))!;
        expect(m).toMatchObject({ status: "RETRACTED", retractedReason: "it was a typo", content: "ret-x the sky is green" });
        expect(m.retractedAt).not.toBeNull();
        expect((await searchA("ret-x")).map((r) => r.id)).not.toContain(id);
        expect(((await getMemoryById({ ...readA, memoryId: id })).data as { status: string }).status).toBe("RETRACTED"); // owner can still inspect it
        expect(await getDb().memoryRevision.count({ where: { memoryId: id, changeType: "RETRACT" } })).toBe(1);
        // terminal: cannot be updated, confirmed or retracted again
        for (const p of [await updateMemory(idA(), { memoryId: id, content: "revive" }), await confirmMemory(idA(), { memoryId: id }), await retractMemory(idA(), { memoryId: id, reason: "again" })]) {
          expect((await decideApproval(idA(), p.approvalId!, "APPROVED")).executed).toBe(false);
        }
        expect((await raw(id))!.status).toBe("RETRACTED");
        await expect(getDb().memory.update({ where: { id }, data: { status: "ACTIVE", retractedAt: null, retractedReason: null } })).rejects.toThrow(/illegal status transition/);
      });

      it("requires a reason and an exact, hashed binding", async () => {
        const id = await create({ type: "FACT", content: "ret-bind", source: "t" });
        expect((await retractMemory(idA(), { memoryId: id, reason: "  " })).status).toBe("FAILED");
        const r = await retractMemory(idA(), { memoryId: id, reason: "no longer true" });
        const row = await getDb().approvalRequest.findUniqueOrThrow({ where: { id: r.approvalId! } });
        expect(row.parameters).toEqual({ memoryId: id, reason: "no longer true" });
        expect(row.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  });

  describe("cross-principal isolation", () => {
    it("another principal's memory cannot be read, inspected, historied or retracted", async () => {
      const id = await create({ type: "FACT", content: "iso secret content", source: "t" });
      await approve(await updateMemory(idA(), { memoryId: id, content: "iso secret v2" }));
      const asB = { principalId: b, agentKey: JARVIS_AGENT_KEY, memoryId: id };
      expect((await getMemoryById(asB)).status).toBe("FAILED");
      expect((await memoryHistory(asB)).status).toBe("FAILED");
      expect(JSON.stringify(await getMemoryById(asB))).not.toContain("iso secret");
      const r = await retractMemory(identityFor(b), { memoryId: id, reason: "attack" });
      const out = await decideApproval(identityFor(b), r.approvalId!, "APPROVED");
      expect(out.executed).toBe(false);
      expect(out.message).toContain("That memory wasn't found.");
      expect((await raw(id))!.status).toBe("ACTIVE");
      expect(await getDb().memoryRevision.count({ where: { memoryId: id, principalId: b } })).toBe(0);
      expect((await searchA("iso secret")).length).toBeGreaterThan(0);
      const bSearch = await search({ principalId: b, agentKey: JARVIS_AGENT_KEY, query: { query: "iso secret" } });
      expect(bSearch.data).toEqual([]);
    });
  });

  describe("semantic separation and database invariants", () => {
    it("memory never reads or writes knowledge: neither the memory layer nor the memory skill imports it", () => {
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".ts") ? [f] : []; });
      const root = path.resolve(import.meta.dirname, "..");
      const files = [...walk(path.join(root, "memory")), path.join(root, "skills/system/memory.ts")];
      const offenders = files.filter((f) => /from\s+["'][^"']*knowledge/.test(readFileSync(f, "utf-8")));
      expect(offenders).toEqual([]);
    });

    it("the database itself refuses to change what a memory IS: owner, type, provenance", async () => {
      const id = await create({ type: "INFERENCE", content: "db-inv inf", source: "t" });
      const db = getDb();
      await expect(db.memory.update({ where: { id }, data: { type: "FACT" } })).rejects.toThrow(/immutable|check constraint/i);
      await expect(db.memory.update({ where: { id }, data: { provenance: "STATED" } })).rejects.toThrow(/immutable|check constraint/i);
      await expect(db.memory.update({ where: { id }, data: { principalId: b } })).rejects.toThrow(/immutable/);
      expect(await raw(id)).toMatchObject({ type: "INFERENCE", provenance: "INFERRED", principalId: a });
    });

    it("the database refuses semantically invalid rows (inference laundering, over-confidence, bad windows, half-retractions)", async () => {
      const db = getDb();
      const base = { principalId: a, content: "db-inv row", source: "t" };
      const bad: Record<string, unknown>[] = [
        { ...base, type: "INFERENCE", provenance: "STATED", status: "UNCONFIRMED", confidence: 0.5 },
        { ...base, type: "FACT", provenance: "INFERRED" },
        { ...base, type: "EXPERIENCE", provenance: "STATED" },
        { ...base, type: "INFERENCE", provenance: "INFERRED", status: "UNCONFIRMED", confidence: 1 },
        { ...base, type: "FACT", confidence: 1.5 },
        { ...base, type: "FACT", validFrom: at(DAY), validUntil: at(-DAY) },
        { ...base, type: "FACT", status: "RETRACTED" },
        { ...base, type: "FACT", retractedAt: new Date() },
      ];
      for (const data of bad) await expect(db.memory.create({ data: data as never }), JSON.stringify(data)).rejects.toThrow();
      expect(await db.memory.count({ where: { principalId: a, content: "db-inv row" } })).toBe(0);
    });

    it("status only moves forward: UNCONFIRMED -> ACTIVE ok; ACTIVE -> UNCONFIRMED and EXPIRED -> ACTIVE are refused", async () => {
      const db = getDb();
      const inf = await create({ type: "INFERENCE", content: "db-status inf", source: "t" });
      await expect(db.memory.update({ where: { id: inf }, data: { status: "ACTIVE", confidence: 1 } })).resolves.toBeTruthy();
      await expect(db.memory.update({ where: { id: inf }, data: { status: "UNCONFIRMED", confidence: 0.4 } })).rejects.toThrow(/illegal status transition/);
      const fact = await create({ type: "FACT", content: "db-status fact", source: "t" });
      await db.memory.update({ where: { id: fact }, data: { status: "EXPIRED" } });
      await expect(db.memory.update({ where: { id: fact }, data: { status: "ACTIVE" } })).rejects.toThrow(/illegal status transition/);
    });
  });

  describe("interfaces", () => {
    it("voice creation with full provenance is an approval that stores the exact canonical parameters and executes exactly them", async () => {
      const occurredAt = new Date("2032-06-07T08:09:10.000Z");
      const r = await remember(idA("VOICE"), { type: "EXPERIENCE", content: "voice exp exact", source: "voice", subject: "Andes", occurredAt, sourceRef: "utt-1" });
      expect(r.status).toBe("PENDING_APPROVAL");
      expect(await getDb().memory.count({ where: { principalId: a, content: "voice exp exact" } })).toBe(0);
      const row = await getDb().approvalRequest.findUniqueOrThrow({ where: { id: r.approvalId! } });
      expect(row.parameters).toEqual({ type: "EXPERIENCE", content: "voice exp exact", source: "voice", subject: "Andes", occurredAt: occurredAt.toISOString(), sourceRef: "utt-1" });
      expect((await decideApproval(idA("GUIDEHUB"), r.approvalId!, "APPROVED")).executed).toBe(true);
      const m = (await getDb().memory.findFirstOrThrow({ where: { principalId: a, content: "voice exp exact" } }));
      expect(m).toMatchObject({ provenance: "EXPERIENCED", subject: "Andes", sourceRef: "utt-1" });
      expect(m.occurredAt!.toISOString()).toBe(occurredAt.toISOString());
    });

    it("the search API supports type/subject filters and rejects unknown types", async () => {
      const token = (await getApiTokenService().create({ principalId: a, interfaceSource: "GUIDEHUB", label: "m" })).token;
      const auth = { Authorization: `Bearer ${token}` };
      await create({ type: "LESSON", content: "api-flt lesson", source: "t", subject: "Focus" });
      const ok = await request(app).get("/api/memory/search?q=api-flt&type=LESSON&subject=focus").set(auth);
      expect((ok.body.data as { content: string }[]).map((m) => m.content)).toEqual(["api-flt lesson"]);
      expect((await request(app).get("/api/memory/search?q=api-flt&type=NOPE").set(auth)).status).toBe(400);
      expect(((await request(app).get("/api/memory/search?q=api-flt&type=FACT").set(auth)).body.data as unknown[])).toEqual([]);
    });

    it("creating a memory records Activity that references it without copying its content; retraction records none", async () => {
      const id = await create({ type: "FACT", content: "activity-safe secret 7712", source: "t" });
      const act = await getDb().activity.findFirst({ where: { principalId: a, type: "MEMORY_CREATED", refId: id } });
      expect(act).toMatchObject({ refType: "memory" });
      expect(JSON.stringify(act)).not.toContain("7712");
      const before = await getDb().activity.count({ where: { principalId: a } });
      await approve(await retractMemory(idA(), { memoryId: id, reason: "test" }));
      expect(await getDb().activity.count({ where: { principalId: a } })).toBe(before);
    });
  });
});
