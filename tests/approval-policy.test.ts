import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { proposeAction, decideApproval, listAuditLog } from "../gateway/index.js";
import { routeFor, canApproveFrom } from "../gateway/policy.js";
import { setClock } from "../gateway/clock.js";
import { INTERFACE_SOURCES, type InterfaceSource } from "../identity/index.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";
import { ACTIONS, FAKE_SKILL, calls, resetCalls, registerFakeActions, ensureExecRegistry, grantAllFake, grantFake, identityFor, goodParams } from "./helpers/fakeActions.js";

describe("interface approval policy", () => {
  let p: string;
  beforeAll(async () => {
    registerFakeActions();
    await ensureExecRegistry();
    p = (await createPrincipal("Policy P")).id;
  });
  afterAll(async () => { await deletePrincipal(p); await disconnectDb(); });
  beforeEach(() => { resetCalls(); setClock(null); });
  afterEach(() => setClock(null));

  describe("policy table", () => {
    it("read-only is direct everywhere", () => {
      for (const s of INTERFACE_SOURCES) for (const risk of ["LOW", "SENSITIVE"] as const) expect(routeFor(s, "READ", risk)).toBe("DIRECT");
    });
    it("low-risk writes are direct on GuideHub/Telegram/API but need approval by voice", () => {
      for (const s of ["GUIDEHUB", "TELEGRAM", "API", "WEB", "MOBILE"] as InterfaceSource[]) expect(routeFor(s, "WRITE", "LOW")).toBe("DIRECT");
      expect(routeFor("VOICE", "WRITE", "LOW")).toBe("APPROVAL");
    });
    it("sensitive actions need approval everywhere; dangerous ones are refused outright by voice", () => {
      for (const s of INTERFACE_SOURCES) expect(routeFor(s, "EXECUTE", "SENSITIVE")).toBe("APPROVAL");
      for (const s of INTERFACE_SOURCES.filter((x) => x !== "VOICE" && x !== "SYSTEM")) expect(routeFor(s, "EXECUTE", "DANGEROUS")).toBe("APPROVAL");
      expect(routeFor("VOICE", "EXECUTE", "DANGEROUS")).toBe("REFUSE");
      expect(routeFor("SYSTEM", "EXECUTE", "DANGEROUS")).toBe("REFUSE");
    });
    it("an EXECUTE action is never treated as low risk, whatever it declares", () => {
      for (const s of INTERFACE_SOURCES) expect(routeFor(s, "EXECUTE", "LOW")).not.toBe("DIRECT");
    });
    it("voice cannot approve sensitive or dangerous actions; every other interface can", () => {
      expect(canApproveFrom("VOICE", "LOW")).toBe(true);
      expect(canApproveFrom("VOICE", "SENSITIVE")).toBe(false);
      expect(canApproveFrom("VOICE", "DANGEROUS")).toBe(false);
      for (const s of INTERFACE_SOURCES.filter((x) => x !== "VOICE" && x !== "SYSTEM")) expect(canApproveFrom(s, "DANGEROUS")).toBe(true);
      for (const risk of ["LOW", "SENSITIVE", "DANGEROUS"] as const) expect(canApproveFrom("SYSTEM", risk)).toBe(false); // background work never approves
    });
  });

  describe("enforced through the gateway", () => {
    beforeAll(async () => { await grantAllFake(p, "ALLOWED"); });

    it("GuideHub: a read and a low-risk write run directly (no approval), audited as executions", async () => {
      const read = await proposeAction(identityFor(p, "GUIDEHUB"), { skillKey: FAKE_SKILL, action: ACTIONS.READ, parameters: {} });
      const low = await proposeAction(identityFor(p, "GUIDEHUB"), { skillKey: FAKE_SKILL, action: ACTIONS.LOW, parameters: goodParams });
      expect([read.status, low.status]).toEqual(["EXECUTED", "EXECUTED"]);
      expect(calls).toHaveLength(2);
      expect((await listAuditLog(p, 100)).some((e) => e.eventType === "ACTION_EXECUTION_SUCCEEDED")).toBe(true);
    });

    it("a sensitive action needs approval even though its permission row says ALLOWED (policy only tightens)", async () => {
      for (const s of ["GUIDEHUB", "TELEGRAM", "API"] as InterfaceSource[]) {
        const r = await proposeAction(identityFor(p, s), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { ...goodParams, body: `policy-${s}` } });
        expect(r.status, s).toBe("PENDING_APPROVAL");
      }
      expect(calls).toHaveLength(0);
    });

    it("voice: a low-risk write becomes an approval request; a dangerous action is refused with nothing stored", async () => {
      const low = await proposeAction(identityFor(p, "VOICE"), { skillKey: FAKE_SKILL, action: ACTIONS.LOW, parameters: { ...goodParams, body: "voice-low" } });
      expect(low.status).toBe("PENDING_APPROVAL");
      const before = await getDb().approvalRequest.count({ where: { principalId: p } });
      const danger = await proposeAction(identityFor(p, "VOICE"), { skillKey: FAKE_SKILL, action: ACTIONS.DANGER, parameters: goodParams });
      expect(danger.status).toBe("DENIED");
      expect(await getDb().approvalRequest.count({ where: { principalId: p } })).toBe(before);
      expect(calls).toHaveLength(0);
    });

    it("voice cannot approve a sensitive action it proposed; approving from Telegram then works", async () => {
      const r = await proposeAction(identityFor(p, "VOICE"), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { ...goodParams, body: "voice-send" } });
      expect(r.status).toBe("PENDING_APPROVAL");
      const viaVoice = await decideApproval(identityFor(p, "VOICE"), r.approvalId!, "APPROVED");
      expect(viaVoice).toMatchObject({ ok: false, code: "FORBIDDEN", message: "You are not authorized to approve this action." });
      expect(calls).toHaveLength(0);
      const viaTelegram = await decideApproval(identityFor(p, "TELEGRAM"), r.approvalId!, "APPROVED");
      expect(viaTelegram.executed).toBe(true);
      const row = await getDb().approvalRequest.findUniqueOrThrow({ where: { id: r.approvalId! } });
      expect(row.interfaceSource).toBe("VOICE"); // proposed by voice
      expect(row.decidedVia).toBe("TELEGRAM"); // approved on Telegram
    });

    it("a DENIED permission stays denied on every interface; APPROVAL_REQUIRED cannot be relaxed to direct", async () => {
      await grantFake(p, ACTIONS.LOW, "DENIED");
      expect((await proposeAction(identityFor(p, "GUIDEHUB"), { skillKey: FAKE_SKILL, action: ACTIONS.LOW, parameters: goodParams })).status).toBe("DENIED");
      await grantFake(p, ACTIONS.LOW, "APPROVAL_REQUIRED");
      const r = await proposeAction(identityFor(p, "GUIDEHUB"), { skillKey: FAKE_SKILL, action: ACTIONS.LOW, parameters: { ...goodParams, body: "ar" } });
      expect(r.status).toBe("PENDING_APPROVAL");
      await grantFake(p, ACTIONS.LOW, "ALLOWED");
    });

    it("an unregistered action or one with no permission row is refused", async () => {
      expect((await proposeAction(identityFor(p), { skillKey: FAKE_SKILL, action: "NOT_REGISTERED", parameters: {} })).status).toBe("FAILED");
      const other = (await createPrincipal("Policy no-perms")).id;
      try {
        expect((await proposeAction(identityFor(other), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: goodParams })).status).toBe("DENIED");
      } finally { await deletePrincipal(other); }
    });
  });
});
