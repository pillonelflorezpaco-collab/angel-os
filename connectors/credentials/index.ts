// Credential abstraction. Critical rule (see docs/SECURITY.md "Credential
// handling"): a plaintext OAuth access/refresh token must never be stored
// in an ordinary Prisma model or Json metadata column. `Connection.
// credentialRef` (db/schema.prisma) stores only a REFERENCE — a name this
// store resolves to an actual secret. Nothing outside this module ever
// sees, logs, or persists the resolved secret value directly.

export class CredentialNotFoundError extends Error {
  constructor(ref: string) {
    // Deliberately does not echo `ref` if it might itself be sensitive-
    // shaped; refs in this codebase are plain identifiers (e.g. env var
    // names), so this is safe, but callers should still never log a
    // resolved secret.
    super(`No credential found for reference "${ref}".`);
    this.name = "CredentialNotFoundError";
  }
}

/**
 * The rest of Angel OS depends on this interface, never on a specific
 * backing mechanism — same pattern as MemoryProvider. Swapping the
 * production implementation (a real secrets manager / KMS) for the local
 * dev one below is a config change, not a rewrite.
 */
export interface CredentialStore {
  /** Resolves a reference to its secret value. Throws CredentialNotFoundError if unresolvable. */
  getSecret(ref: string): Promise<string>;
  /** Stores a secret and returns the reference to retrieve it by. */
  setSecret(ref: string, value: string): Promise<void>;
  /** Removes a stored secret. No-op if it doesn't exist. */
  deleteSecret(ref: string): Promise<void>;
}

/**
 * Local development implementation ONLY — backed by process environment
 * variables. `ref` is the env var name (e.g. "GOOGLE_OAUTH_TOKEN_ANGEL").
 *
 * NOT SAFE FOR PRODUCTION: env vars are visible to the whole process, can
 * end up in crash dumps/process listings, and aren't rotated or access-
 * controlled. Production secret storage (a real secrets manager or KMS-
 * backed store) is explicitly deferred — see docs/ROADMAP.md.
 */
export class EnvCredentialStore implements CredentialStore {
  async getSecret(ref: string): Promise<string> {
    const value = process.env[ref];
    if (value === undefined) throw new CredentialNotFoundError(ref);
    return value;
  }

  async setSecret(): Promise<void> {
    throw new Error(
      "EnvCredentialStore is read-only (env vars are set outside the process). " +
        "Use a real CredentialStore implementation to support writing secrets at runtime."
    );
  }

  async deleteSecret(): Promise<void> {
    throw new Error("EnvCredentialStore is read-only. See setSecret's note.");
  }
}

// Store selection lives in ./select.js, not here, to avoid a circular
// import between this file and ./encrypted.js (which needs
// CredentialNotFoundError and the CredentialStore type from this file).
