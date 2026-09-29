import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { getApiTokenService, getExternalIdentityService } from "../identity/index.js";
import { listAuditLog } from "../gateway/index.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";

describe("identity administration is audited (without secrets)", () => {
  let p: string;
  let q: string;
  beforeAll(async () => { p = (await createPrincipal("Admin Audit P")).id; q = (await createPrincipal("Admin Audit Q")).id; });
  afterAll(async () => { await deletePrincipal(p); await deletePrincipal(q); await disconnectDb(); });

  const events = async (principalId: string, type: string) => (await listAuditLog(principalId, 100)).filter((e) => e.eventType === type);

  it("token creation is audited with actor, principal, target interface and token id — never the token or its hash", async () => {
    const { id, token } = await getApiTokenService().create({ principalId: p, interfaceSource: "GUIDEHUB", label: "audit me", actor: "cli:test" });
    const row = (await events(p, "TOKEN_CREATED")).find((e) => (e.metadata as { tokenId?: string }).tokenId === id)!;
    expect(row).toMatchObject({ principalId: p, result: "SUCCESS", source: "identity.admin" });
    expect(row.metadata).toMatchObject({ actor: "cli:test", targetInterface: "GUIDEHUB", tokenId: id });
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(4, 20));
    const stored = await getDb().apiToken.findUniqueOrThrow({ where: { id } });
    expect(dump).not.toContain(stored.tokenHash);
  });

  it("revocation is audited with the outcome; revoking someone else's or a missing token is recorded as DENIED", async () => {
    const { id } = await getApiTokenService().create({ principalId: p, interfaceSource: "API", label: "revoke me" });
    expect(await getApiTokenService().revoke(p, id, "cli:test")).toBe(true);
    expect((await events(p, "TOKEN_REVOKED")).find((e) => (e.metadata as { tokenId?: string }).tokenId === id)).toMatchObject({ result: "SUCCESS", metadata: { outcome: "revoked", actor: "cli:test" } });

    expect(await getApiTokenService().revoke(q, id)).toBe(false); // not q's token
    const denied = (await events(q, "TOKEN_REVOKED"))[0];
    expect(denied).toMatchObject({ result: "DENIED", metadata: { outcome: "no_active_token" } });
    expect((await getDb().apiToken.findUniqueOrThrow({ where: { id } })).revokedAt).not.toBeNull(); // p's own revocation unaffected
  });

  it("link and unlink are audited by link id; the external account id is not recorded", async () => {
    const externalId = `${700_000_000 + Math.floor(Math.random() * 1e8)}`;
    const { id } = await getExternalIdentityService().link({ principalId: p, interfaceSource: "TELEGRAM", externalId, actor: "cli:test" });
    const linked = (await events(p, "IDENTITY_LINKED")).find((e) => (e.metadata as { linkId?: string }).linkId === id)!;
    expect(linked).toMatchObject({ result: "SUCCESS", metadata: { actor: "cli:test", targetInterface: "TELEGRAM", outcome: "linked" } });
    expect(JSON.stringify(linked)).not.toContain(externalId);

    await expect(getExternalIdentityService().link({ principalId: q, interfaceSource: "TELEGRAM", externalId })).rejects.toThrow();
    expect((await events(q, "IDENTITY_LINKED"))[0]).toMatchObject({ result: "DENIED", metadata: { outcome: "already_linked" } });

    expect(await getExternalIdentityService().unlink(p, id, "cli:test")).toBe(true);
    expect((await events(p, "IDENTITY_UNLINKED")).find((e) => (e.metadata as { linkId?: string }).linkId === id)).toMatchObject({ result: "SUCCESS" });
    expect(await getExternalIdentityService().unlink(q, id)).toBe(false);
    expect((await events(q, "IDENTITY_UNLINKED"))[0]).toMatchObject({ result: "DENIED" });
  });

  it("if the audit store is down, the admin action still reports its true outcome", async () => {
    const { withAuditFailures } = await import("./helpers/fakeActions.js");
    const out = await withAuditFailures(() => true, () => getApiTokenService().create({ principalId: p, interfaceSource: "WEB", label: "audit down" }));
    expect(out.token).toMatch(/^aos_/);
  });
});
