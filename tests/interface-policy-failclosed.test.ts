import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { INTERFACE_SOURCES, assertExplicitIdentity, IdentityRequiredError, createIdentity, isInterfaceSource } from "../identity/index.js";
import { routeFor, canApproveFrom, INTERFACE_POLICY } from "../gateway/policy.js";
import { proposeAction, decideApproval, IDENTITY_REQUIRED_MESSAGE } from "../gateway/index.js";
import { createTask } from "../skills/system/tasks.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { getDb, disconnectDb } from "../db/client/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { ACTIONS, FAKE_SKILL, calls, resetCalls, registerFakeActions, ensureExecRegistry, grantAllFake, identityFor, goodParams } from "./helpers/fakeActions.js";

const CATEGORIES = ["READ", "WRITE", "EXECUTE"] as const;
const RISKS = ["LOW", "SENSITIVE", "DANGEROUS"] as const;
// Not in the canonical registry: none of these may ever receive a permissive policy.
const UNKNOWN = ["BOGUS", "", " ", "guidehub", "Telegram", "SYSTEM ", "VOICE\n", "__proto__", "constructor", "toString", "ADMIN", null, undefined, 42, {}] as const;

describe("unknown interfaces fail closed", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");
  let p: string;
  beforeAll(async () => {
    registerFakeActions();
    await ensureExecRegistry();
    p = (await createPrincipal("Unknown iface")).id;
    await grantAllFake(p, "ALLOWED");
    await grant(p, JARVIS_AGENT_KEY, "system.tasks", "angel:tasks", "CREATE_TASK", "WRITE");
  });
  afterAll(async () => { await deletePrincipal(p); await disconnectDb(); });

  describe("policy table is closed by construction", () => {
    it("declares a policy for EXACTLY the canonical interfaces (adding an interface without a policy fails this and the compiler)", () => {
      expect(Object.keys(INTERFACE_POLICY).sort()).toEqual([...INTERFACE_SOURCES].sort());
    });

    it("membership is decided by the canonical registry, including inherited object keys", () => {
      for (const s of INTERFACE_SOURCES) expect(isInterfaceSource(s)).toBe(true);
      for (const u of UNKNOWN) expect(isInterfaceSource(u), String(u)).toBe(false);
    });
  });

  describe("routeFor / canApproveFrom", () => {
    it("an unknown interface can NEVER run anything directly, never gets approval routing, and can never approve", () => {
      for (const u of UNKNOWN) for (const c of CATEGORIES) for (const r of RISKS) {
        expect(routeFor(u as never, c, r), `${String(u)} ${c}/${r}`).toBe("REFUSE");
      }
      for (const u of UNKNOWN) for (const r of RISKS) expect(canApproveFrom(u as never, r), `${String(u)} ${r}`).toBe(false);
    });

    it("known interfaces keep exactly their behaviour (pinned)", () => {
      const expected: Record<string, Record<string, string>> = {
        // route for: READ/LOW, WRITE/LOW, WRITE/SENSITIVE, EXECUTE/LOW, EXECUTE/DANGEROUS
        GUIDEHUB: { "READ/LOW": "DIRECT", "WRITE/LOW": "DIRECT", "WRITE/SENSITIVE": "APPROVAL", "EXECUTE/LOW": "APPROVAL", "EXECUTE/DANGEROUS": "APPROVAL" },
        API: { "READ/LOW": "DIRECT", "WRITE/LOW": "DIRECT", "WRITE/SENSITIVE": "APPROVAL", "EXECUTE/LOW": "APPROVAL", "EXECUTE/DANGEROUS": "APPROVAL" },
        TELEGRAM: { "READ/LOW": "DIRECT", "WRITE/LOW": "DIRECT", "WRITE/SENSITIVE": "APPROVAL", "EXECUTE/LOW": "APPROVAL", "EXECUTE/DANGEROUS": "APPROVAL" },
        WEB: { "READ/LOW": "DIRECT", "WRITE/LOW": "DIRECT", "WRITE/SENSITIVE": "APPROVAL", "EXECUTE/LOW": "APPROVAL", "EXECUTE/DANGEROUS": "APPROVAL" },
        MOBILE: { "READ/LOW": "DIRECT", "WRITE/LOW": "DIRECT", "WRITE/SENSITIVE": "APPROVAL", "EXECUTE/LOW": "APPROVAL", "EXECUTE/DANGEROUS": "APPROVAL" },
        VOICE: { "READ/LOW": "DIRECT", "WRITE/LOW": "APPROVAL", "WRITE/SENSITIVE": "APPROVAL", "EXECUTE/LOW": "APPROVAL", "EXECUTE/DANGEROUS": "REFUSE" },
        SYSTEM: { "READ/LOW": "DIRECT", "WRITE/LOW": "APPROVAL", "WRITE/SENSITIVE": "APPROVAL", "EXECUTE/LOW": "APPROVAL", "EXECUTE/DANGEROUS": "REFUSE" },
      };
      for (const [source, table] of Object.entries(expected)) {
        for (const [key, route] of Object.entries(table)) {
          const [c, r] = key.split("/");
          expect(routeFor(source as never, c as never, r as never), `${source} ${key}`).toBe(route);
        }
      }
      const approve: Record<string, [boolean, boolean, boolean]> = { // LOW, SENSITIVE, DANGEROUS
        GUIDEHUB: [true, true, true], API: [true, true, true], TELEGRAM: [true, true, true], WEB: [true, true, true], MOBILE: [true, true, true],
        VOICE: [true, false, false], SYSTEM: [false, false, false],
      };
      for (const [source, flags] of Object.entries(approve)) {
        RISKS.forEach((r, i) => expect(canApproveFrom(source as never, r), `${source} approves ${r}`).toBe(flags[i]));
      }
    });
  });

  describe("identity validation", () => {
    it("assertExplicitIdentity rejects every unknown interface and accepts every canonical one", () => {
      for (const u of UNKNOWN) {
        expect(() => assertExplicitIdentity({ principalId: p, requestId: "r", interfaceSource: u }), String(u)).toThrow(IdentityRequiredError);
      }
      for (const s of INTERFACE_SOURCES) {
        expect(assertExplicitIdentity({ principalId: p, requestId: "r", interfaceSource: s }).interfaceSource).toBe(s);
      }
    });

    it("a forged identity with an unknown interface cannot propose, create, or decide anything — no state, no approval, no side effect", async () => {
      resetCalls();
      const forged = createIdentity({ principalId: p, interfaceSource: "BOGUS" as never, authMethod: "api_token", requestId: "forged" });
      const before = { tasks: await getDb().task.count(), approvals: await getDb().approvalRequest.count() };
      for (const proposal of [
        { skillKey: FAKE_SKILL, action: ACTIONS.LOW, parameters: goodParams }, // LOW write: would be DIRECT for a lenient interface
        { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: goodParams },
        { skillKey: FAKE_SKILL, action: ACTIONS.READ, parameters: {} },
      ]) {
        expect(await proposeAction(forged, proposal)).toEqual({ status: "FAILED", message: IDENTITY_REQUIRED_MESSAGE });
      }
      expect(await createTask(forged, { title: "forged" })).toEqual({ status: "FAILED", message: IDENTITY_REQUIRED_MESSAGE });
      const pending = await proposeAction(identityFor(p), { skillKey: FAKE_SKILL, action: ACTIONS.SEND, parameters: { ...goodParams, body: "forged decide" } });
      expect(await decideApproval(forged, pending.approvalId!, "APPROVED")).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await decideApproval(forged, pending.approvalId!, "DENIED")).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(calls).toHaveLength(0);
      expect(await getDb().task.count()).toBe(before.tasks);
      expect(await getDb().approvalRequest.count()).toBe(before.approvals + 1); // only the legitimate proposal above
      expect((await getDb().approvalRequest.findUniqueOrThrow({ where: { id: pending.approvalId! } })).status).toBe("PENDING");
    });
  });

  describe("guard against permissive-by-default logic creeping back", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = path.join(dir, n); return statSync(f).isDirectory() ? walk(f) : f.endsWith(".ts") ? [f] : []; });
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    it("policy.ts decides through INTERFACE_POLICY and never compares an interface to a string literal", () => {
      const src = strip(readFileSync(path.join(ROOT, "gateway/policy.ts"), "utf-8"));
      expect(src).toContain("INTERFACE_POLICY");
      expect(src).not.toMatch(/\b(source|interfaceSource)\s*[!=]==?\s*["']/);
      expect(src).not.toMatch(/["']\s*[!=]==?\s*(source|interfaceSource)\b/);
    });

    it("no gateway/application/skills code branches on an interface literal (an unlisted interface would fall into the else branch)", () => {
      const offenders = ["gateway", "application", "skills", "reminders", "core"].flatMap((d) =>
        walk(path.join(ROOT, d)).filter((f) => /\b(interfaceSource|source)\s*[!=]==?\s*["'](VOICE|SYSTEM|TELEGRAM|GUIDEHUB|API|WEB|MOBILE)["']/.test(strip(readFileSync(f, "utf-8"))))
          .map((f) => path.relative(ROOT, f)));
      expect(offenders).toEqual([]);
    });
  });
});
