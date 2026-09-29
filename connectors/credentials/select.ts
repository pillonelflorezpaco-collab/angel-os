import { EnvCredentialStore, type CredentialStore } from "./index.js";
import { EncryptedCredentialStore } from "./encrypted.js";

/**
 * Selects the CredentialStore implementation from CREDENTIAL_STORE.
 * Defaults to `encrypted` (EncryptedCredentialStore) because the Google
 * OAuth flow needs to WRITE a refresh token at runtime, and
 * EnvCredentialStore is read-only by design (env vars are set outside the
 * process). Set CREDENTIAL_STORE=env explicitly for the simpler read-only
 * store when no runtime credential writes are needed.
 */
export function getCredentialStore(): CredentialStore {
  const selected = process.env.CREDENTIAL_STORE ?? "encrypted";
  return selected === "env" ? getEnvStore() : getEncryptedStore();
}

let envStore: EnvCredentialStore | undefined;
function getEnvStore(): EnvCredentialStore {
  if (!envStore) envStore = new EnvCredentialStore();
  return envStore;
}

let encryptedStore: EncryptedCredentialStore | undefined;
function getEncryptedStore(): EncryptedCredentialStore {
  if (!encryptedStore) encryptedStore = new EncryptedCredentialStore();
  return encryptedStore;
}
