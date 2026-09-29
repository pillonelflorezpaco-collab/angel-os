import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { gatewayExecute, listAuditLog } from "../gateway/index.js";
import { createIdentity, runWithIdentity, currentIdentity } from "../identity/index.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

describe("gateway + identity context", () => {
  const agentKey = "test-gw-identity-agent";
  const skillKey = "test.gw.identity";
  const resource = "test:gw-identity";
  let a: string;
  let b: string;

  const req = (principalId: string) => ({ principalId, agentKey, skillKey, resource, action: "READ", parameters: {} });
  const idFor = (principalId: string, interfaceSource: "TELEGRAM" | "GUIDEHUB" = "GUIDEHUB") =>
    createIdentity({ principalId, interfaceSource, authMethod: "api_token", requestId: `req-${Math.random().toString(36).slice(2)}` });

  beforeAll(async () => {
    a = (await createPrincipal("GW Identity A")).id;
    b = (await createPrincipal("GW Identity B")).id;
    await grant(a, agentKey, skillKey, resource, "READ", "READ");
    await grant(b, agentKey, skillKey, resource, "READ", "READ");
  });
  afterAll(async () => {
    await deletePrincipal(a);
    await deletePrincipal(b);
    await getDb().agent.delete({ where: { key: agentKey } }).catch(() => undefined);
    await disconnectDb();
  });

  it("identity is only in scope inside runWithIdentity", async () => {
    expect(currentIdentity()).toBeUndefined();
    const identity = idFor(a);
    await runWithIdentity(identity, async () => {
      expect(currentIdentity()).toBe(identity);
      await Promise.resolve();
      expect(currentIdentity()).toBe(identity); // survives awaits
    });
    expect(currentIdentity()).toBeUndefined();
  });

  it("concurrent requests never see each other's identity", async () => {
    const seen = await Promise.all(
      ["one", "two", "three", "four"].map((n) =>
        runWithIdentity(createIdentity({ principalId: a, interfaceSource: "API", authMethod: "api_token", requestId: n }), async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 15));
          return currentIdentity()?.requestId;
        })
      )
    );
    expect(seen).toEqual(["one", "two", "three", "four"]);
  });

  it("an action for the authenticated principal proceeds and is stamped with interface + request id", async () => {
    const identity = idFor(a, "TELEGRAM");
    const result = await runWithIdentity(identity, () => gatewayExecute(req(a), async () => "ok"));
    expect(result.status).toBe("EXECUTED");
    const row = (await listAuditLog(a, 20)).find((r) => r.requestId === identity.requestId && r.eventType === "ACTION_EXECUTED");
    expect(row?.interfaceSource).toBe("TELEGRAM");
  });

  it("an action targeting ANOTHER principal is refused, the executor never runs, and B is untouched", async () => {
    const identity = idFor(a);
    let ran = false;
    const result = await runWithIdentity(identity, () =>
      gatewayExecute(req(b), async () => {
        ran = true;
        return "leaked";
      })
    );
    expect(result.status).toBe("DENIED");
    expect(ran).toBe(false);
    expect(JSON.stringify(result)).not.toContain("leaked");

    // recorded against the REQUESTER, with a reason — nothing is written into B's log
    const denied = (await listAuditLog(a, 20)).find((r) => r.requestId === identity.requestId);
    expect(denied).toMatchObject({ eventType: "ACTION_DENIED", result: "DENIED", metadata: { reason: "principal_mismatch" } });
    expect((await listAuditLog(b, 50)).some((r) => r.requestId === identity.requestId)).toBe(false);
  });

  it("the mismatch check needs no permission row for the target: B's own grant does not help A", async () => {
    // b HAS a READ permission for this exact tuple; a's request for b must still be refused
    const result = await runWithIdentity(idFor(a), () => gatewayExecute(req(b), async () => "x"));
    expect(result.status).toBe("DENIED");
  });

  it("outside an interface request (seed scripts, system work) behaviour is unchanged and rows carry no interface", async () => {
    const result = await gatewayExecute(req(b), async () => "ok");
    expect(result.status).toBe("EXECUTED");
    const row = (await listAuditLog(b, 5)).find((r) => r.eventType === "ACTION_EXECUTED");
    expect(row?.interfaceSource).toBeNull();
    expect(row?.requestId).toBeNull();
  });
});
