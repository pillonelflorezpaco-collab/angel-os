import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getDb } from "../../db/client/index.js";
import { CredentialNotFoundError, type CredentialStore } from "./index.js";

// A "production-oriented" (see docs/SECURITY.md) local secret store — real
// AES-256-GCM encryption at rest, but explicitly NOT a substitute for a
// real secrets manager. Documented here rather than assumed:
//
// ENCRYPTION KEY SOURCE: the `ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY` env var,
//   a 32-byte key given as 64 hex characters. There is no fallback and no
//   generated default — an unset or malformed key is a hard startup error
//   for this store, never a silent weak key.
// ENCRYPTION BOUNDARY: encryption/decryption happen only inside this
//   module, only in application memory, only for the instant a secret is
//   written or read. The key never touches Postgres — `credential_secrets`
//   holds ciphertext, IV, and auth tag only (see db/schema.prisma
//   `CredentialSecret`). Anyone with only DB access sees ciphertext.
//   Anyone with only the env var (no DB access) sees nothing plaintext
//   either. Compromise requires both.
// ROTATION LIMITATIONS: single key version, no built-in re-encryption on
//   rotation. Rotating `ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY` makes every
//   existing ciphertext unreadable until a migration script decrypts with
//   the old key and re-encrypts with the new one — no such script exists
//   yet. This is a real gap versus a managed KMS (which handles envelope
//   encryption and rotation natively) — see docs/ROADMAP.md.
//
// This is why the interface (CredentialStore) exists: swapping this for a
// real Vault/cloud-secrets-manager-backed implementation later is a config
// change (CREDENTIAL_STORE=vault, say), not a rewrite of anything that
// calls getSecret/setSecret/deleteSecret.

const ALGORITHM = "aes-256-gcm";
const KEY_ENV_VAR = "ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY";

export class CredentialStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreConfigError";
  }
}

function loadKey(): Buffer {
  const hex = process.env[KEY_ENV_VAR];
  if (!hex) {
    throw new CredentialStoreConfigError(
      `${KEY_ENV_VAR} is not set. EncryptedCredentialStore requires a 32-byte key ` +
        `as 64 hex characters (generate one with: openssl rand -hex 32).`
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new CredentialStoreConfigError(
      `${KEY_ENV_VAR} must decode to exactly 32 bytes (64 hex characters); got ${key.length} bytes.`
    );
  }
  return key;
}

export class EncryptedCredentialStore implements CredentialStore {
  async getSecret(ref: string): Promise<string> {
    const db = getDb();
    const row = await db.credentialSecret.findUnique({ where: { ref } });
    if (!row) throw new CredentialNotFoundError(ref);

    const key = loadKey();
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]);
    return decrypted.toString("utf-8");
  }

  async setSecret(ref: string, value: string): Promise<void> {
    const key = loadKey();
    const iv = randomBytes(12); // 96-bit IV, standard for GCM
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const db = getDb();
    await db.credentialSecret.upsert({
      where: { ref },
      create: {
        ref,
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
      },
      update: {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
      },
    });
  }

  async deleteSecret(ref: string): Promise<void> {
    const db = getDb();
    await db.credentialSecret.deleteMany({ where: { ref } });
  }
}
