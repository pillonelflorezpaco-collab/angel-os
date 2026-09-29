import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import {
  ApiTokenService,
  BearerTokenAuthenticator,
  ExternalIdentityService,
  ExternalIdentityConflictError,
  INTERFACE_SOURCES,
  assertInterfaceSource,
  createIdentity,
  hashToken,
  isInterfaceSource,
} from "../identity/index.js";
import { createPrincipal, deletePrincipal } from "./helpers/fixtures.js";

describe("interface registry", () => {
  it("lists exactly the supported interfaces", () => {
    expect([...INTERFACE_SOURCES]).toEqual(["GUIDEHUB", "TELEGRAM", "VOICE", "MOBILE", "WEB", "API", "SYSTEM"]);
  });

  it("accepts known interfaces and rejects anything else", () => {
    expect(isInterfaceSource("TELEGRAM")).toBe(true);
    expect(isInterfaceSource("telegram")).toBe(false); // canonical form is uppercase
    expect(isInterfaceSource("FAX")).toBe(false);
    expect(isInterfaceSource(undefined)).toBe(false);
    expect(() => assertInterfaceSource("FAX")).toThrow(/Unknown interface/);
  });
});

describe("API tokens", () => {
  const tokens = new ApiTokenService();
  let a: string;
  let b: string;

  beforeAll(async () => {
    a = (await createPrincipal("Identity A")).id;
    b = (await createPrincipal("Identity B")).id;
  });
  afterAll(async () => {
    await deletePrincipal(a);
    await deletePrincipal(b);
  });

  it("returns the plaintext once and stores only its hash", async () => {
    const { id, token } = await tokens.create({ principalId: a, interfaceSource: "GUIDEHUB", label: "hash check" });
    expect(token).toMatch(/^aos_[A-Za-z0-9_-]{43}$/);

    const row = await getDb().apiToken.findUniqueOrThrow({ where: { id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    // nothing on any column of the row is the plaintext
    expect(Object.values(row).map(String)).not.toContain(token);
  });

  it("verifies a valid token and returns the principal AND interface stored with it", async () => {
    const { token, id } = await tokens.create({ principalId: a, interfaceSource: "MOBILE", label: "verify" });
    expect(await tokens.verify(token)).toEqual({ id, principalId: a, interfaceSource: "MOBILE" });
  });

  it("rejects malformed and unknown tokens", async () => {
    expect(await tokens.verify("")).toBeNull();
    expect(await tokens.verify("not-a-token")).toBeNull();
    expect(await tokens.verify(`aos_${"A".repeat(43)}`)).toBeNull(); // well-formed but never issued
  });

  it("rejects an unknown interface at creation", async () => {
    await expect(tokens.create({ principalId: a, interfaceSource: "FAX", label: "bad" })).rejects.toThrow(/Unknown interface/);
  });

  it("a revoked token no longer verifies", async () => {
    const { token, id } = await tokens.create({ principalId: a, interfaceSource: "API", label: "revoke me" });
    expect(await tokens.revoke(a, id)).toBe(true);
    expect(await tokens.verify(token)).toBeNull();
    expect(await tokens.revoke(a, id)).toBe(false); // already revoked
  });

  it("one principal cannot revoke another principal's token", async () => {
    const { token, id } = await tokens.create({ principalId: a, interfaceSource: "API", label: "A's token" });
    expect(await tokens.revoke(b, id)).toBe(false);
    expect(await tokens.verify(token)).not.toBeNull();
  });

  it("listing never exposes a hash or plaintext", async () => {
    const listed = await tokens.list(a);
    expect(listed.length).toBeGreaterThan(0);
    for (const t of listed) expect(Object.keys(t).sort()).toEqual(["createdAt", "id", "interfaceSource", "label", "revokedAt"]);
  });
});

describe("BearerTokenAuthenticator", () => {
  const tokens = new ApiTokenService();
  const auth = new BearerTokenAuthenticator(tokens);
  let principalId: string;
  let token: string;

  beforeAll(async () => {
    principalId = (await createPrincipal("Authenticator Principal")).id;
    token = (await tokens.create({ principalId, interfaceSource: "GUIDEHUB", label: "auth" })).token;
  });
  afterAll(async () => {
    await deletePrincipal(principalId);
  });

  it("resolves a valid bearer token to an IdentityContext", async () => {
    const identity = await auth.authenticate({ headers: { authorization: `Bearer ${token}` } });
    expect(identity).toMatchObject({ principalId, interfaceSource: "GUIDEHUB", authMethod: "api_token" });
    expect(identity?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives every request its own requestId", async () => {
    const one = await auth.authenticate({ headers: { authorization: `Bearer ${token}` } });
    const two = await auth.authenticate({ headers: { authorization: `Bearer ${token}` } });
    expect(one?.requestId).not.toBe(two?.requestId);
  });

  it.each([
    ["no header", {}],
    ["wrong scheme", { authorization: "Basic abc" }],
    ["empty bearer", { authorization: "Bearer " }],
    ["token in a different header", { "x-api-key": "anything" }],
  ])("returns null for %s", async (_name, headers) => {
    expect(await auth.authenticate({ headers })).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    const t = await tokens.create({ principalId, interfaceSource: "API", label: "soon revoked" });
    await tokens.revoke(principalId, t.id);
    expect(await auth.authenticate({ headers: { authorization: `Bearer ${t.token}` } })).toBeNull();
  });

  it("the interface comes from the token, not from anything the client sends", async () => {
    const identity = await auth.authenticate({
      headers: { authorization: `Bearer ${token}`, "x-interface": "TELEGRAM", "x-interface-source": "VOICE" },
    });
    expect(identity?.interfaceSource).toBe("GUIDEHUB");
  });
});

describe("IdentityContext", () => {
  it("is immutable: downstream code cannot rewrite the principal", () => {
    const identity = createIdentity({ principalId: "p1", interfaceSource: "API", authMethod: "api_token", requestId: "r1", metadata: { k: "v" } });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(() => {
      (identity as { principalId: string }).principalId = "someone-else";
    }).toThrow();
    expect(() => {
      (identity.metadata as Record<string, string>).k = "changed";
    }).toThrow();
    expect(identity.principalId).toBe("p1");
  });
});

describe("external identities (e.g. a Telegram user)", () => {
  const external = new ExternalIdentityService();
  let a: string;
  let b: string;
  const uid = () => `tg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    a = (await createPrincipal("External A")).id;
    b = (await createPrincipal("External B")).id;
  });
  afterAll(async () => {
    await deletePrincipal(a);
    await deletePrincipal(b);
  });

  it("resolves a linked account to its principal", async () => {
    const externalId = uid();
    const { id } = await external.link({ principalId: a, interfaceSource: "TELEGRAM", externalId });
    expect(await external.resolve("TELEGRAM", externalId)).toEqual({ id, principalId: a, interfaceSource: "TELEGRAM" });
  });

  it("does not resolve an account linked on a different interface", async () => {
    const externalId = uid();
    await external.link({ principalId: a, interfaceSource: "TELEGRAM", externalId });
    expect(await external.resolve("VOICE", externalId)).toBeNull();
  });

  it("does not resolve an unlinked account", async () => {
    expect(await external.resolve("TELEGRAM", uid())).toBeNull();
  });

  it("an account already linked cannot be silently linked to another principal", async () => {
    const externalId = uid();
    await external.link({ principalId: a, interfaceSource: "TELEGRAM", externalId });
    await expect(external.link({ principalId: b, interfaceSource: "TELEGRAM", externalId })).rejects.toThrow(ExternalIdentityConflictError);
    expect((await external.resolve("TELEGRAM", externalId))?.principalId).toBe(a);
  });

  it("unlinking stops resolution, and one principal cannot unlink another's account", async () => {
    const externalId = uid();
    const { id } = await external.link({ principalId: a, interfaceSource: "TELEGRAM", externalId });
    expect(await external.unlink(b, id)).toBe(false);
    expect(await external.resolve("TELEGRAM", externalId)).not.toBeNull();
    expect(await external.unlink(a, id)).toBe(true);
    expect(await external.resolve("TELEGRAM", externalId)).toBeNull();
  });

  it("rejects an unknown interface", async () => {
    await expect(external.link({ principalId: a, interfaceSource: "FAX", externalId: uid() })).rejects.toThrow(/Unknown interface/);
  });
});

afterAll(async () => {
  await disconnectDb();
});
