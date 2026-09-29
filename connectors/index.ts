// The Integration / Connector Layer. See docs/ARCHITECTURE.md "Connector
// Layer" for the full design and docs/SECURITY.md for the security
// controls (principal isolation, credential handling).
//
// Nothing in this module calls an external API. It is discovery
// (ConnectorRegistry), identity/health (ConnectorProvider), secret
// indirection (CredentialStore), and principal-scoped connection records
// (ConnectionService) — infrastructure a future Skill will use, never a
// replacement for the Gateway.

export * from "./types/index.js";
export * from "./types/calendar.js";
export { ConnectorRegistry, getConnectorRegistry } from "./registry/index.js";
export { CredentialNotFoundError, EnvCredentialStore } from "./credentials/index.js";
export type { CredentialStore } from "./credentials/index.js";
export { EncryptedCredentialStore, CredentialStoreConfigError } from "./credentials/encrypted.js";
export { getCredentialStore } from "./credentials/select.js";
export { ConnectionService, ConnectionNotFoundError, getConnectionService } from "./service/index.js";
export type { CreateConnectionInput } from "./service/index.js";
export {
  OAuthStateService,
  OAuthStateInvalidError,
  OAuthStateExpiredError,
  getOAuthStateService,
} from "./oauth/state.js";
