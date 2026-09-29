import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { disconnectDb } from "../db/client/index.js";
import { gatewayExecute, listAuditLog } from "../gateway/index.js";
import { JarvisCore } from "../core/index.js";
import { PublicError, GENERIC_ERROR_MESSAGE, toSafeError, redactForLog } from "../core/errors.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

const RAW_SECRET_ERROR =
  "connect ECONNREFUSED postgresql://angel:hunter2@db.internal:5432/angel_os token=abc123secret " +
  "at Object.<anonymous> (/home/user/angel-os/secret/path.ts:12:5)";

/** Regression for audit finding F7: raw internal error text reached users and the audit log. */
describe("error sanitization", () => {
  const agentKey = "test-errors-agent";
  const skillKey = "test.errors";
  const resource = "test:errors";
  let principalId: string;

  beforeAll(async () => {
    principalId = (await createPrincipal("Error Sanitization Principal")).id;
    await grant(principalId, agentKey, skillKey, resource, "READ", "READ");
  });

  afterAll(async () => {
    await deletePrincipal(principalId);
    await disconnectDb();
  });

  const run = (err: unknown) =>
    gatewayExecute({ principalId, agentKey, skillKey, resource, action: "READ", parameters: {} }, async () => {
      throw err;
    });

  it("an internal error gives the user a safe generic message", async () => {
    const result = await run(new Error(RAW_SECRET_ERROR));
    expect(result.status).toBe("FAILED");
    expect(result.message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("the raw error, credentials, connection string, path, and stack never reach the user", async () => {
    const result = await run(new Error(RAW_SECRET_ERROR));
    for (const leak of ["hunter2", "postgresql://", "abc123secret", "/home/user", "ECONNREFUSED", "at Object"]) {
      expect(result.message).not.toContain(leak);
    }
  });

  it("the audit entry holds structured safe fields only, not the raw message", async () => {
    const dbError = Object.assign(new Error("Unique constraint failed on the fields: (`email`) value angel@example.com"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    await run(dbError);
    const failed = (await listAuditLog(principalId, 50)).filter((l) => l.eventType === "ACTION_FAILED");
    const latest = failed[0];
    expect(latest.metadata).toEqual({ errorType: "PrismaClientKnownRequestError", code: "P2002", public: false });

    const all = JSON.stringify(failed);
    for (const leak of ["hunter2", "postgresql://", "abc123secret", "angel@example.com", "Unique constraint"]) {
      expect(all).not.toContain(leak);
    }
  });

  it("a PublicError's message is shown, because it was written for the user", async () => {
    const result = await run(new PublicError("Connect Google Calendar first."));
    expect(result.message).toBe("Connect Google Calendar first.");
  });

  it("Jarvis Core's boundary sanitizes errors thrown outside any skill", async () => {
    const spy = vi.spyOn(JarvisCore.prototype, "dispatch").mockRejectedValueOnce(new Error(RAW_SECRET_ERROR));
    const result = await new JarvisCore().handle({ principalId, input: "anything" });
    expect(result.status).toBe("FAILED");
    expect(result.message).toBe(GENERIC_ERROR_MESSAGE);
    spy.mockRestore();
  });

  it("toSafeError never returns a non-public message", () => {
    expect(toSafeError(new Error(RAW_SECRET_ERROR)).publicMessage).toBe(GENERIC_ERROR_MESSAGE);
    expect(toSafeError("a thrown string").publicMessage).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("developer-log redaction strips credentials and tokens", () => {
    const redacted = redactForLog(`${RAW_SECRET_ERROR} Authorization: Bearer ya29.abcdefghijklmnop`);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("abc123secret");
    expect(redacted).not.toContain("ya29.abcdefghijklmnop");
  });
});
