import { describe, it, expect, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { EncryptedCredentialStore, CredentialStoreConfigError } from "../connectors/credentials/encrypted.js";
import { CredentialNotFoundError } from "../connectors/credentials/index.js";

describe("EncryptedCredentialStore", () => {
  const store = new EncryptedCredentialStore();
  const testRefs: string[] = [];

  afterAll(async () => {
    const db = getDb();
    await db.credentialSecret.deleteMany({ where: { ref: { in: testRefs } } });
    await disconnectDb();
  });

  it("round-trips a secret through encryption/decryption", async () => {
    const ref = "test:refresh-token:roundtrip";
    testRefs.push(ref);
    await store.setSecret(ref, "super-secret-refresh-token-value");
    const value = await store.getSecret(ref);
    expect(value).toBe("super-secret-refresh-token-value");
  });

  it("stores only ciphertext in the database, never the plaintext value", async () => {
    const ref = "test:refresh-token:ciphertext-check";
    testRefs.push(ref);
    const plaintext = "another-secret-value-never-stored-plain";
    await store.setSecret(ref, plaintext);

    const db = getDb();
    const row = await db.credentialSecret.findUniqueOrThrow({ where: { ref } });
    expect(row.ciphertext).not.toContain(plaintext);
    // Base64 ciphertext shouldn't even happen to contain the raw string.
    expect(Buffer.from(row.ciphertext, "base64").toString("utf-8")).not.toBe(plaintext);
  });

  it("throws CredentialNotFoundError for an unknown reference", async () => {
    await expect(store.getSecret("test:does-not-exist:xyz")).rejects.toThrow(CredentialNotFoundError);
  });

  it("overwrites an existing secret on a second setSecret for the same ref", async () => {
    const ref = "test:refresh-token:overwrite";
    testRefs.push(ref);
    await store.setSecret(ref, "first-value");
    await store.setSecret(ref, "second-value");
    const value = await store.getSecret(ref);
    expect(value).toBe("second-value");
  });

  it("deleteSecret removes the stored value", async () => {
    const ref = "test:refresh-token:delete";
    testRefs.push(ref);
    await store.setSecret(ref, "to-be-deleted");
    await store.deleteSecret(ref);
    await expect(store.getSecret(ref)).rejects.toThrow(CredentialNotFoundError);
  });

  it("throws CredentialStoreConfigError when the encryption key env var is unset", async () => {
    const original = process.env.ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY;
    try {
      const unconfiguredStore = new EncryptedCredentialStore();
      await expect(unconfiguredStore.setSecret("test:no-key", "value")).rejects.toThrow(CredentialStoreConfigError);
    } finally {
      if (original !== undefined) process.env.ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });

  it("throws CredentialStoreConfigError for a malformed (wrong length) key", async () => {
    const original = process.env.ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY;
    process.env.ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY = "not-a-valid-hex-key";
    try {
      const badStore = new EncryptedCredentialStore();
      await expect(badStore.setSecret("test:bad-key", "value")).rejects.toThrow(CredentialStoreConfigError);
    } finally {
      if (original !== undefined) process.env.ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });
});
