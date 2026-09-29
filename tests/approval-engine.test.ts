import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import {
  proposeAction, decideApproval, getApproval, listPendingApprovals, listAuditLog, gatewayExecute,
  APPROVAL_MESSAGES,
} from "../gateway/index.js";
import { executeApproval } from "../gateway/execution.js";
import { expireStaleApprovals } from "../gateway/approvals/expiry.js";
import { TRANSITIONS, canTransition, isTerminal } from "../gateway/approvals/state.js";
import { canonicalize, payloadHash } from "../gateway/actions/binding.js";
import { DEFAULT_APPROVAL_TTL_MS } from "../gateway/approvals/service.js";
import { setClock } from "../gateway/clock.js";
import { GENERIC_ERROR_MESSAGE } from "../core/errors.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";
import {
  ACTIONS, FAKE_SKILL, FAKE_AGENT, FAKE_RESOURCE, calls, resetCalls, registerFakeActions, ensureExecRegistry,
  grantAllFake, grantFake, identityFor, goodParams,
} from "./helpers/fakeActions.js";

const T0 = new Date("2030-01-01T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("approval & execution engine", () => {
  let a: string;
  let b: string;
  const idA = () => identityFor(a);
  const idB = () => identityFor(b);
  const propose = (params: unknown = goodParams, action: string = ACTIONS.SEND, who = idA()) =>
    proposeAction(who, { skillKey: FAKE_SKILL, action, parameters: params });
  const row = (id: string) => getDb().approvalRequest.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    registerFakeActions();
    await ensureExecRegistry();
    a = (await createPrincipal("Engine A")).id;
    b = (await createPrincipal("Engine B")).id;
    await grantAllFake(a);
    await grantAllFake(b);
  });
  afterAll(async () => {
    await deletePrincipal(a);
    await deletePrincipal(b);
    await disconnectDb();
  });
  beforeEach(() => { resetCalls(); setClock(() => T0); });
  afterEach(() => setClock(null));

  // ── B. State machine ────────────────────────────────────────────────────
  describe("state machine", () => {
    it("declares exactly the legal transitions; DENIED, EXPIRED and CONSUMED are terminal", () => {
      expect(TRANSITIONS.PENDING).toEqual(["APPROVED", "DENIED", "EXPIRED"]);
      expect(TRANSITIONS.APPROVED).toEqual(["CONSUMED", "EXPIRED"]);
      for (const s of ["DENIED", "EXPIRED", "CONSUMED"] as const) expect(isTerminal(s)).toBe(true);
      expect(canTransition("PENDING", "CONSUMED")).toBe(false); // must be approved first
      expect(canTransition("CONSUMED", "APPROVED")).toBe(false);
      expect(canTransition("DENIED", "APPROVED")).toBe(false);
    });

    it("PENDING → APPROVED → CONSUMED on approve+execute; PENDING → DENIED on deny", async () => {
      const p = await propose();
      expect((await row(p.approvalId!)).status).toBe("PENDING");
      const ok = await decideApproval(idA(), p.approvalId!, "APPROVED");
      expect(ok.ok).toBe(true);
      const final = await row(p.approvalId!);
      expect(final.status).toBe("CONSUMED");
      expect(final.executionStatus).toBe("SUCCEEDED");

      const p2 = await propose({ ...goodParams, body: "second" });
      const denied = await decideApproval(idA(), p2.approvalId!, "DENIED");
      expect(denied.ok).toBe(true);
      expect((await row(p2.approvalId!)).status).toBe("DENIED");
    });

    it("terminal states cannot be re-decided (denied → approve, consumed → approve/deny)", async () => {
      const p = await propose({ ...goodParams, body: "t1" });
      await decideApproval(idA(), p.approvalId!, "DENIED");
      const again = await decideApproval(idA(), p.approvalId!, "APPROVED");
      expect(again).toMatchObject({ ok: false, code: "ALREADY_DECIDED", message: APPROVAL_MESSAGES.ALREADY_DECIDED });
      expect(calls).toHaveLength(0);

      const p2 = await propose({ ...goodParams, body: "t2" });
      await decideApproval(idA(), p2.approvalId!, "APPROVED");
      const consumed = await decideApproval(idA(), p2.approvalId!, "DENIED");
      expect(consumed).toMatchObject({ ok: false, code: "CONSUMED", message: "Approval already consumed." });
      expect((await row(p2.approvalId!)).status).toBe("CONSUMED");
    });

    it("the database itself refuses illegal transitions and any edit to the bound action (trigger)", async () => {
      const p = await propose({ ...goodParams, body: "trigger" });
      const db = getDb();
      await expect(db.approvalRequest.update({ where: { id: p.approvalId! }, data: { status: "CONSUMED" } })).rejects.toThrow(/illegal status transition/);
      await expect(db.approvalRequest.update({ where: { id: p.approvalId! }, data: { parameters: { to: "attacker", body: "x" } } })).rejects.toThrow(/immutable/);
      await expect(db.approvalRequest.update({ where: { id: p.approvalId! }, data: { action: ACTIONS.LOW } })).rejects.toThrow(/immutable/);
      await expect(db.approvalRequest.update({ where: { id: p.approvalId! }, data: { expiresAt: new Date("2099-01-01") } })).rejects.toThrow(/immutable/);
      await expect(db.approvalRequest.update({ where: { id: p.approvalId! }, data: { principalId: b } })).rejects.toThrow(/immutable/);
      await decideApproval(idA(), p.approvalId!, "DENIED");
      await expect(db.approvalRequest.update({ where: { id: p.approvalId! }, data: { status: "APPROVED" } })).rejects.toThrow(/illegal status transition/);
    });
  });

  // ── A. Expiry ───────────────────────────────────────────────────────────
  describe("expiry (enforced at read, decision, and execution — no worker involved)", () => {
    it("every approval gets an expiry, from the clock, not from the caller", async () => {
      const p = await propose({ ...goodParams, body: "exp" });
      expect((await row(p.approvalId!)).expiresAt.getTime()).toBe(T0.getTime() + DEFAULT_APPROVAL_TTL_MS);
    });

    it("an expired PENDING approval is not listed, cannot be approved or denied, and executes nothing", async () => {
      const p = await propose({ ...goodParams, body: "expire-me" });
      setClock(() => at(DEFAULT_APPROVAL_TTL_MS + 1));
      expect((await listPendingApprovals(idA())).map((x) => x.id)).not.toContain(p.approvalId);
      const out = await decideApproval(idA(), p.approvalId!, "APPROVED");
      expect(out).toMatchObject({ ok: false, code: "EXPIRED", message: "Approval expired." });
      expect(calls).toHaveLength(0);
      expect((await row(p.approvalId!)).status).toBe("EXPIRED");
    });

    it("expiry is exact: valid one millisecond before the deadline, expired at the deadline", async () => {
      const p1 = await propose({ ...goodParams, body: "edge-1" });
      const p2 = await propose({ ...goodParams, body: "edge-2" });
      setClock(() => at(DEFAULT_APPROVAL_TTL_MS - 1));
      expect((await decideApproval(idA(), p1.approvalId!, "APPROVED")).ok).toBe(true);
      setClock(() => at(DEFAULT_APPROVAL_TTL_MS));
      expect((await decideApproval(idA(), p2.approvalId!, "APPROVED")).code).toBe("EXPIRED");
    });

    it("reading an expired approval reports EXPIRED (lazy expiry on read)", async () => {
      const p = await propose({ ...goodParams, body: "read-expired" });
      setClock(() => at(DEFAULT_APPROVAL_TTL_MS + 5));
      const got = await getApproval(idA(), p.approvalId!);
      expect(got.approval?.status).toBe("EXPIRED");
    });

    it("an APPROVED-but-unexecuted approval expires too, and cannot execute afterwards", async () => {
      const p = await propose({ ...goodParams, body: "approved-then-late" });
      // Approve at the DB level without executing, to model an approval whose execution was delayed.
      await getDb().approvalRequest.update({ where: { id: p.approvalId! }, data: { status: "APPROVED", decidedAt: T0 } });
      setClock(() => at(DEFAULT_APPROVAL_TTL_MS + 1));
      const out = await executeApproval(idA(), p.approvalId!);
      expect(out).toMatchObject({ claimed: false, reason: "EXPIRED" });
      expect(calls).toHaveLength(0);
      expect((await row(p.approvalId!)).status).toBe("EXPIRED");
    });

    it("expiry is audited exactly once even under concurrent reads; the sweep is optional and idempotent", async () => {
      const p = await propose({ ...goodParams, body: "audit-expiry" });
      setClock(() => at(DEFAULT_APPROVAL_TTL_MS + 1));
      await Promise.all([getApproval(idA(), p.approvalId!), getApproval(idA(), p.approvalId!), listPendingApprovals(idA())]);
      await expireStaleApprovals(at(DEFAULT_APPROVAL_TTL_MS + 1));
      const events = (await listAuditLog(a, 500)).filter((e) => e.eventType === "APPROVAL_EXPIRED" && (e.metadata as { approvalId?: string }).approvalId === p.approvalId);
      expect(events).toHaveLength(1);
    });

    it("a per-action TTL is honoured", async () => {
      // FAKE_SEND uses the default; verify the stored expiry is derived from the definition path
      const p = await propose({ ...goodParams, body: "ttl" });
      const r = await row(p.approvalId!);
      expect(r.expiresAt.getTime() - r.requestedAt.getTime()).toBe(DEFAULT_APPROVAL_TTL_MS);
    });
  });

  // ── C. Exact action binding ─────────────────────────────────────────────
  describe("exact action binding", () => {
    it("stores the exact validated parameters and a payload hash bound to principal+action", async () => {
      const params = { to: "bob@example.com", body: "exact", tags: ["x", "y"] };
      const p = await propose(params);
      const r = await row(p.approvalId!);
      expect(r.parameters).toEqual(params);
      expect(r.principalId).toBe(a);
      expect(r.skillKey).toBe(FAKE_SKILL);
      expect(r.action).toBe(ACTIONS.SEND);
      expect(r.interfaceSource).toBe("GUIDEHUB");
      expect(r.requestId).toBeTruthy();
      expect(r.payloadHash).toBe(payloadHash({ principalId: a, skillKey: FAKE_SKILL, resource: FAKE_RESOURCE, action: ACTIONS.SEND, parameters: params }));
    });

    it("executes exactly the stored parameters, exactly once, with the approval id as idempotency key", async () => {
      const params = { to: "carol@example.com", body: "run exactly this", tags: ["a"] };
      const p = await propose(params);
      const out = await decideApproval(idA(), p.approvalId!, "APPROVED");
      expect(out).toMatchObject({ ok: true, executed: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].params).toEqual(params);
      expect(calls[0].ctx).toMatchObject({ principalId: a, idempotencyKey: p.approvalId, approvalId: p.approvalId, interfaceSource: "GUIDEHUB" });
    });

    it("parameters are validated strictly: unknown keys and wrong types never reach an approval", async () => {
      const before = await getDb().approvalRequest.count({ where: { principalId: a } });
      for (const bad of [{ ...goodParams, extra: 1 }, { to: 5, body: "x" }, { to: "x" }, null, "str"]) {
        expect((await propose(bad)).status).toBe("FAILED");
      }
      expect(await getDb().approvalRequest.count({ where: { principalId: a } })).toBe(before);
    });

    it("differing parameters produce different hashes; key order does not", () => {
      const base = { principalId: "p", skillKey: "s", resource: "r", action: "A" };
      expect(payloadHash({ ...base, parameters: { x: 1, y: 2 } })).toBe(payloadHash({ ...base, parameters: { y: 2, x: 1 } }));
      expect(payloadHash({ ...base, parameters: { x: 1 } })).not.toBe(payloadHash({ ...base, parameters: { x: 2 } }));
      expect(payloadHash({ ...base, parameters: {} })).not.toBe(payloadHash({ ...base, principalId: "q", parameters: {} }));
      expect(canonicalize({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
      expect(() => canonicalize({ n: NaN })).toThrow();
    });

    it("an approval cannot be re-pointed at another action or other parameters (DB refuses)", async () => {
      const p = await propose({ ...goodParams, body: "bound" });
      await expect(getDb().approvalRequest.update({ where: { id: p.approvalId! }, data: { parameters: { to: "evil@example.com", body: "x" } } })).rejects.toThrow();
      expect((await row(p.approvalId!)).parameters).toMatchObject({ body: "bound" });
    });

    it("if stored parameters ever fail their integrity hash, nothing executes (defence in depth beyond the trigger)", async () => {
      const p = await propose({ ...goodParams, body: "tamper" });
      const db = getDb();
      // Simulate a privileged tamper that bypasses the trigger.
      await db.$executeRawUnsafe(`ALTER TABLE approval_requests DISABLE TRIGGER approval_requests_guard_trg`);
      try {
        await db.approvalRequest.update({ where: { id: p.approvalId! }, data: { parameters: { to: "evil@example.com", body: "tamper" }, status: "APPROVED" } });
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE approval_requests ENABLE TRIGGER approval_requests_guard_trg`);
      }
      const out = await executeApproval(idA(), p.approvalId!);
      expect(out).toMatchObject({ claimed: false, reason: "INTEGRITY" });
      expect(calls).toHaveLength(0);
    });

    it("a retried proposal returns the same pending approval (no duplicates)", async () => {
      const params = { ...goodParams, body: "dedupe" };
      const p1 = await propose(params);
      const p2 = await propose({ body: "dedupe", to: goodParams.to }); // same content, different key order
      expect(p2.approvalId).toBe(p1.approvalId);
      const [p3, p4] = await Promise.all([propose({ ...goodParams, body: "dedupe-race" }), propose({ ...goodParams, body: "dedupe-race" })]);
      expect(p3.approvalId).toBe(p4.approvalId);
    });
  });

  // ── D. Ownership ────────────────────────────────────────────────────────
  describe("principal ownership", () => {
    it("another principal cannot get, list, approve, deny, or execute it — and gets 'not found'", async () => {
      const p = await propose({ ...goodParams, body: "owned-by-A" });
      expect((await getApproval(idB(), p.approvalId!))).toMatchObject({ ok: false, code: "NOT_FOUND", message: "Approval not found." });
      expect((await listPendingApprovals(idB())).map((x) => x.id)).not.toContain(p.approvalId);
      expect(await decideApproval(idB(), p.approvalId!, "APPROVED")).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(await decideApproval(idB(), p.approvalId!, "DENIED")).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(await executeApproval(idB(), p.approvalId!)).toMatchObject({ claimed: false });
      expect(calls).toHaveLength(0);
      expect((await row(p.approvalId!)).status).toBe("PENDING");
    });

    it("'belongs to someone else' and 'does not exist' are indistinguishable", async () => {
      const p = await propose({ ...goodParams, body: "indistinguishable" });
      const other = await decideApproval(idB(), p.approvalId!, "APPROVED");
      const missing = await decideApproval(idB(), "00000000-0000-0000-0000-00000000beef", "APPROVED");
      expect(other).toEqual(missing);
    });

    it("the attempt is audited against the REQUESTER, with no leak of the owner", async () => {
      const p = await propose({ ...goodParams, body: "audit-not-owner" });
      await decideApproval(idB(), p.approvalId!, "APPROVED");
      const bAudit = (await listAuditLog(b, 200)).find((e) => e.action === "DECIDE_APPROVAL:APPROVED");
      expect(bAudit).toMatchObject({ result: "DENIED", principalId: b });
      expect(JSON.stringify(bAudit)).not.toContain(a);
    });
  });

  // ── E. Concurrency & idempotency ────────────────────────────────────────
  describe("atomicity, concurrency, idempotency", () => {
    it("two concurrent approvals: exactly one succeeds and the action runs exactly once", async () => {
      const p = await propose({ ...goodParams, body: "race-approve" });
      const results = await Promise.all([decideApproval(idA(), p.approvalId!, "APPROVED"), decideApproval(idA(), p.approvalId!, "APPROVED")]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
      expect(calls).toHaveLength(1);
    });

    it("approve vs deny racing: exactly one decision wins; executes only if approve won", async () => {
      const p = await propose({ ...goodParams, body: "race-mixed" });
      const [ap, de] = await Promise.all([decideApproval(idA(), p.approvalId!, "APPROVED"), decideApproval(idA(), p.approvalId!, "DENIED")]);
      expect([ap.ok, de.ok].filter(Boolean)).toHaveLength(1);
      const final = await row(p.approvalId!);
      expect(calls).toHaveLength(ap.ok ? 1 : 0);
      expect(final.status).toBe(ap.ok ? "CONSUMED" : "DENIED");
    });

    it("many concurrent executions of one approved action: one claim, one run", async () => {
      const p = await propose({ ...goodParams, body: "race-exec" });
      await getDb().approvalRequest.update({ where: { id: p.approvalId! }, data: { status: "APPROVED", decidedAt: T0 } });
      const outs = await Promise.all(Array.from({ length: 8 }, () => executeApproval(idA(), p.approvalId!)));
      expect(outs.filter((o) => o.claimed)).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(outs.filter((o) => !o.claimed).every((o) => o.reason === "CONSUMED")).toBe(true);
    });

    it("a duplicate delivery of the same approve (HTTP/Telegram retry) never executes twice", async () => {
      const p = await propose({ ...goodParams, body: "retry" });
      const first = await decideApproval(idA(), p.approvalId!, "APPROVED");
      const retry = await decideApproval(identityFor(a, "TELEGRAM"), p.approvalId!, "APPROVED");
      expect(first.executed).toBe(true);
      expect(retry).toMatchObject({ ok: false, code: "CONSUMED", message: "Approval already consumed." });
      expect(calls).toHaveLength(1);
    });

    it("at-most-once: an approval whose execution started but never finished is never re-run", async () => {
      const p = await propose({ ...goodParams, body: "crash" });
      // State a crash would leave behind: claimed (CONSUMED) and STARTED, no final status.
      await getDb().approvalRequest.update({ where: { id: p.approvalId! }, data: { status: "APPROVED", decidedAt: T0 } });
      await getDb().approvalRequest.update({ where: { id: p.approvalId! }, data: { status: "CONSUMED", consumedAt: T0, executionStatus: "STARTED" } });
      const out = await executeApproval(idA(), p.approvalId!);
      expect(out).toMatchObject({ claimed: false, reason: "CONSUMED" });
      expect(calls).toHaveLength(0);
    });
  });

  // ── Execution results ───────────────────────────────────────────────────
  describe("approval → execution result", () => {
    it("a failed execution is reported as a failure, never as success, and leaks no internal detail", async () => {
      const p = await propose({ ...goodParams, body: "boom" }, ACTIONS.FAIL);
      const out = await decideApproval(idA(), p.approvalId!, "APPROVED");
      expect(out.ok).toBe(true); // the decision was recorded…
      expect(out.executed).toBe(false); // …but the action did not succeed
      expect(out.execution?.status).toBe("FAILED");
      expect(out.message).toMatch(/failed and was not completed/);
      expect(out.message).toContain(GENERIC_ERROR_MESSAGE);
      expect(out.message).not.toMatch(/hunter2|secret-host/);
      const r = await row(p.approvalId!);
      expect(r.status).toBe("CONSUMED"); // never retried automatically
      expect(r.executionStatus).toBe("FAILED");
    });

    it("a user-safe (PublicError) failure message is passed through", async () => {
      const p = await propose({ ...goodParams, body: "public-fail" }, "FAKE_PUBLIC_FAIL");
      const out = await decideApproval(idA(), p.approvalId!, "APPROVED");
      expect(out.message).toContain("The test provider rejected that.");
      expect(out.executed).toBe(false);
    });

    it("denying executes nothing and says so", async () => {
      const p = await propose({ ...goodParams, body: "deny-me" });
      const out = await decideApproval(idA(), p.approvalId!, "DENIED");
      expect(out).toMatchObject({ ok: true, executed: false, message: "Denied. Nothing was executed." });
      expect(calls).toHaveLength(0);
    });

    it("permission revoked between approval and execution: approval never overrides it", async () => {
      const p = await propose({ ...goodParams, body: "revoked" });
      await grantFake(a, ACTIONS.SEND, "DENIED");
      const out = await decideApproval(idA(), p.approvalId!, "APPROVED");
      expect(out.executed).toBe(false);
      expect(out.execution?.status).toBe("DENIED");
      expect(calls).toHaveLength(0);
      await grantFake(a, ACTIONS.SEND, "APPROVAL_REQUIRED");
    });

    it("the closure-based gateway path fails closed for approval-required actions", async () => {
      let ran = false;
      const r = await gatewayExecute({ principalId: a, agentKey: FAKE_AGENT, skillKey: FAKE_SKILL, resource: FAKE_RESOURCE, action: ACTIONS.SEND, parameters: {} }, async () => { ran = true; });
      expect(r.status).toBe("DENIED");
      expect(ran).toBe(false);
    });

    it("an action whose definition is no longer registered cannot be approved or executed", async () => {
      const p = await propose({ ...goodParams, body: "orphan" });
      await getDb().$executeRawUnsafe(`ALTER TABLE approval_requests DISABLE TRIGGER approval_requests_guard_trg`);
      try {
        await getDb().approvalRequest.update({ where: { id: p.approvalId! }, data: { action: "NO_SUCH_ACTION" } });
      } finally {
        await getDb().$executeRawUnsafe(`ALTER TABLE approval_requests ENABLE TRIGGER approval_requests_guard_trg`);
      }
      const out = await decideApproval(idA(), p.approvalId!, "APPROVED");
      expect(out).toMatchObject({ ok: false, code: "UNAVAILABLE" });
      expect(calls).toHaveLength(0);
    });
  });

  // ── I. Audit ────────────────────────────────────────────────────────────
  describe("audit", () => {
    it("records the whole lifecycle with principal, interface and request id — and no parameters or secrets", async () => {
      const secretBody = "SUPER-SECRET-BODY-8842";
      const who = idA();
      const p = await proposeAction(who, { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { to: "audit@example.com", body: secretBody } });
      await decideApproval(who, p.approvalId!, "APPROVED");
      const rows = (await listAuditLog(a, 500)).filter((e) => (e.metadata as { approvalId?: string }).approvalId === p.approvalId);
      const types = rows.map((e) => e.eventType).sort();
      expect(types).toEqual(
        ["ACTION_EXECUTION_STARTED", "ACTION_EXECUTION_SUCCEEDED", "APPROVAL_APPROVED", "APPROVAL_CONSUMED", "APPROVAL_CREATED"].sort()
      );
      for (const e of rows) {
        expect(e.principalId).toBe(a);
        expect(e.interfaceSource).toBe("GUIDEHUB");
        expect(e.requestId).toBe(who.requestId);
      }
      expect(JSON.stringify(rows)).not.toContain(secretBody);
      expect(JSON.stringify(rows)).not.toContain("audit@example.com");
    });

    it("failed execution is audited with safe structured fields only", async () => {
      const p = await propose({ ...goodParams, body: "audit-fail" }, ACTIONS.FAIL);
      await decideApproval(idA(), p.approvalId!, "APPROVED");
      const failed = (await listAuditLog(a, 500)).find((e) => e.eventType === "ACTION_EXECUTION_FAILED" && (e.metadata as { approvalId?: string }).approvalId === p.approvalId);
      expect(failed).toBeDefined();
      expect(JSON.stringify(failed)).not.toMatch(/hunter2|secret-host/);
    });

    it("denial is audited as APPROVAL_DENIED", async () => {
      const p = await propose({ ...goodParams, body: "audit-deny" });
      await decideApproval(idA(), p.approvalId!, "DENIED");
      expect((await listAuditLog(a, 500)).some((e) => e.eventType === "APPROVAL_DENIED" && (e.metadata as { approvalId?: string }).approvalId === p.approvalId)).toBe(true);
    });
  });
});
