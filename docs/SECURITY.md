# Security

## The critical rule

**The LLM never gets direct authority to execute a sensitive action.**

Every action, without exception, takes this path:

```
Jarvis → Skill → Permission Gateway → Approval (if required) → Action → Audit Log
```

A skill function never calls the database (or any external API, once those
exist) before `gatewayExecute` has returned `ALLOWED`. There is no code path
that lets an LLM's output directly trigger a write or an external call.

## Permission model

Every permission row is scoped to five things:

- **principal** — Angel (today, the only one)
- **agent** — the orchestrating entity, e.g. `jarvis-core`
- **skill** — the capability, e.g. `system.tasks`, `communication.gmail`
- **resource** — the specific thing being acted on, e.g. `angel:tasks`, `angel:gmail`
- **action** — a specific verb, e.g. `READ`, `CREATE_TASK`, `SEND_EMAIL`, `DELETE_EVENT`

Each row also has:

- **category**: `READ | WRITE | EXECUTE` — a coarse classification kept
  separate from the specific `action` string, so policy can reason about
  "all EXECUTE actions on this resource" without enumerating every verb.
- **state**: `ALLOWED | DENIED | APPROVAL_REQUIRED`

### Fail closed

If no permission row exists for a given
`(principal, agent, skill, resource, action)` tuple, the gateway treats it
as `DENIED`. Nothing is implicitly allowed. A new skill or a new action on
an existing skill does nothing until a permission row is explicitly created
(seed script or future admin action).

### Example (seeded, illustrative — `communication.gmail` is a registry
placeholder, not an implemented skill)

| skill | action | category | state |
|---|---|---|---|
| system.tasks | READ | READ | ALLOWED |
| system.tasks | CREATE_TASK | WRITE | ALLOWED |
| communication.gmail | READ | READ | ALLOWED |
| communication.gmail | SEND_EMAIL | EXECUTE | APPROVAL_REQUIRED |
| communication.gmail | DELETE_ALL | EXECUTE | DENIED |

## Approval workflow

Implemented in Build #6 — full design in `docs/architecture/approval-and-execution.md`.
Three distinct steps, three distinct actors: **PROPOSE** (Jarvis/Core/a skill
asks), **APPROVE** (the human decides), **EXECUTE** (only the execution layer
acts). An approval authorizes **one exact action**: principal, skill, resource,
action and the exact validated parameters are stored at proposal time, hashed
(SHA-256 over a canonical serialization), and made immutable by a database
trigger. Execution loads those stored values — never anything supplied by
whoever presses "approve".

Guarantees (each covered by tests and by a mutation run, see the Build #6 report):

- **State machine**: `PENDING → APPROVED → CONSUMED`, `PENDING → DENIED`,
  `PENDING|APPROVED → EXPIRED`; `DENIED/EXPIRED/CONSUMED` are terminal. Enforced
  in code (`gateway/approvals/state.ts`) **and** by a Postgres trigger.
- **Expiry** is enforced wherever an approval is read, decided, or executed
  (lazy, deterministic clock in `gateway/clock.ts`), plus in the SQL `WHERE`
  of the approve/consume transitions. No worker is required for correctness.
- **Ownership**: every query carries the authenticated `principalId`; another
  principal's approval and a nonexistent one both answer "Approval not found."
- **Atomic and single-use**: each transition is one conditional `UPDATE`; of any
  number of concurrent approvals/executions exactly one wins, and the action
  runs at most once (claim = `APPROVED → CONSUMED` before anything executes).
- **Approval never overrides permission**: permission is re-checked at execution;
  a revoked permission wins. Interface policy can only tighten (voice cannot
  approve sensitive actions; dangerous actions are refused on voice).
- **Closures fail closed**: `gatewayExecute` no longer creates approvals for
  closures (a closure cannot be "the approved action"); approval-gated actions
  must be registered `ActionDefinition`s run through `proposeAction`.
- **Audit**: `APPROVAL_CREATED/APPROVED/DENIED/EXPIRED/CONSUMED`,
  `ACTION_EXECUTION_STARTED/SUCCEEDED/FAILED` with principal, interface and
  request id; never parameters, tokens or raw errors.

Limitations: at-most-once, not exactly-once — if the process dies after the
claim, the action is not re-run automatically (`executionStatus` stays
`STARTED`); external providers must be given `ctx.idempotencyKey` (the
approval id) to make their own retries safe. See the architecture doc.

## Audit log

Every meaningful event is recorded in `audit_logs`:
`PERMISSION_GRANTED | PERMISSION_REVOKED | ACTION_REQUESTED | ACTION_APPROVED | ACTION_REJECTED | ACTION_EXECUTED | ACTION_FAILED | ACTION_DENIED`,
with `result: SUCCESS | FAILURE | DENIED | PENDING`, the resource/action,
`source` (which subsystem wrote the event), and a `metadata` JSON field.

**Rule: `metadata` must never contain secrets** — no API keys, no OAuth
tokens, no passwords, ever. Nothing in this codebase writes credentials to
`metadata`; if a future skill needs to log request details, it must
explicitly redact anything credential-shaped before writing.

## Memory principal isolation

`MemoryProvider.updateMemory`, `.deleteMemory`, and `.confirmMemory`
(`memory/types/index.ts`) all require `principalId` as a parameter, and
`LocalMemoryProvider` (`memory/local/index.ts`) scopes every one of those
writes by `{ id, principalId }` in the same `updateMany`/`deleteMany` call —
never by `id` alone. A memory belonging to a different principal is not
fetched, not matched, not touched; the call throws `MemoryNotFoundError`,
identical to the id simply not existing. The ownership check lives at this
data-access boundary specifically so no caller (API route, skill, Jarvis
Core) can forget it — see `tests/two-principal.test.ts`.

## Knowledge document path safety

*Historical (the file-backed provider was retired; nothing serves files by slug any more).*
`knowledge/markdown/index.ts`'s `resolveSafeDocPath` rejected any slug that
isn't `^[a-zA-Z0-9_-]+$` (no `.`, no `/`, no `\`, no leading `-` issue since
the whole string must match), and independently verifies the resolved
absolute path still starts with the knowledge directory before any file is
read. Both checks exist because a regex alone is easy to get subtly wrong;
the resolved-path containment check is the actual guarantee. No knowledge
API route is exposed yet — this was fixed pre-emptively, per audit finding,
before one is ever added.

## Connection principal isolation

`ConnectionService` (`connectors/service/index.ts`) follows the exact
pattern established for Memory and Approvals: `get`, `disable`, and
`remove` all scope their query by `{ id, principalId }` in the same
database call — `disable`/`remove` use `updateMany`/`deleteMany` and check
`count === 0` to throw `ConnectionNotFoundError`, never a fetch-then-check.
A connection id alone, without the correct `principalId`, matches nothing.
Verified for both directions (A→B and B→A) in
`tests/connectors.test.ts` "D/K. Connection principal isolation".

## Credential handling (Connector Layer)

**A plaintext OAuth access/refresh token, API key, or password must never
be stored in an ordinary Prisma model or `Json` column.**
`Connection.credentialRef` (`db/schema.prisma`) stores only a *reference*
string — the actual secret lives behind `CredentialStore`
(`connectors/credentials/index.ts`), and the rest of the application never
resolves one except through that interface.

- `EnvCredentialStore` resolves a reference by reading it as an
  environment variable name and is read-only (cannot write a secret at
  runtime — env vars are set outside the process). Explicitly **not safe
  for production**: env vars are visible process-wide, can leak into crash
  dumps/process listings, and have no rotation or access control.
- `EncryptedCredentialStore` (`connectors/credentials/encrypted.ts`) is
  Build #3's addition — the default as of this build, since the Google
  OAuth flow needs to *write* a refresh token at runtime, which
  `EnvCredentialStore` cannot do. AES-256-GCM at rest, backed by the
  `credential_secrets` table (ciphertext/IV/auth-tag only). Documented
  precisely, not assumed safe:
  - **Encryption key source**: `ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY` env
    var, 32 bytes as 64 hex characters, no fallback — an unset or
    malformed key is a hard `CredentialStoreConfigError`, never a silent
    weak default.
  - **Encryption boundary**: the key exists only in application memory,
    only for the instant a secret is encrypted or decrypted. Postgres
    never sees it and never sees plaintext — only ciphertext, IV, and auth
    tag. Compromising only the DB, or only the env var, is insufficient;
    both are required.
  - **Rotation limitations**: single key version, no built-in
    re-encryption on rotation. This is a real gap versus a managed KMS
    (envelope encryption, native rotation) — explicitly not claimed to be
    production-grade, and flagged again in docs/ROADMAP.md.
  - Selected via `CREDENTIAL_STORE=encrypted` (default) or
    `CREDENTIAL_STORE=env` (`connectors/credentials/select.ts`) — a config
    change, not a rewrite, same pattern as `MEMORY_PROVIDER`.
- `ConnectionSummary` (`connectors/types/index.ts`), the only shape
  `ConnectionService` and the API return, has no field for
  `credentialRef` or `metadata` — a resolved secret can never be returned
  through an API response even by accident, because the type constructing
  the response doesn't carry it. Verified by
  `tests/connectors.test.ts` "I. Credential never appears in audit
  output" and `tests/calendar-skill.test.ts` "secret redaction", both of
  which assert a real token value never appears anywhere in the resulting
  audit log entries.
- No code path in `connectors/`, `skills/integrations/calendar.ts`, or
  `gateway/audit` writes a resolved secret to `AuditLog.metadata` —
  connection audit events only ever include identifiers
  (`connectionId`, `provider`, `externalAccountId`, `reason`), never a
  token value.

## OAuth state security

`GET /api/integrations/google/calendar/callback` must never let a caller
supply `?code=...` and attach it to an arbitrary principal. This API has
no real session/authentication layer yet (see "Known limitations" below),
so `connectors/oauth/state.ts`'s `OAuthStateService` is the **explicit,
documented substitute** for "the session that started the flow" — not a
pretense of production authentication.

- **Principal binding**: `/connect` creates an `OAuthState` row scoped to
  the current principal and embeds only an opaque, unguessable token (32
  random bytes, base64url) in the OAuth `state` parameter — never the
  principal id itself. `/callback` calls `OAuthStateService.consume(state,
  provider)`, which takes **no principalId parameter at all**: the state
  token is the only evidence of which principal the flow belongs to, so
  there is no argument a caller could pass to attach someone else's flow
  to their own principal.
- **Single-use**: consuming a state is one atomic conditional update
  (`WHERE state = ... AND consumedAt IS NULL`) — a second consume of the
  same token matches nothing and fails with `OAuthStateInvalidError`,
  identical to an invalid token (no signal distinguishing "reused" from
  "never existed").
- **Short-lived**: a 10-minute expiry (`OAuthState.expiresAt`), checked
  after the atomic consume so an expired-and-somehow-replayed token still
  can't be used twice, but is still rejected as expired.
- **Provider-scoped**: a state issued for `google` is rejected if presented
  against any other provider key.
- Verified in `tests/oauth-state.test.ts`: creation, reuse rejection,
  mismatch rejection, provider-scoping, principal-binding (structural check
  that `consume()` has no principalId parameter to abuse), and expiry.

## Credential handling (general)

No table in this schema stores a credential value. Skills that need
external credentials (once implemented) should hold a reference (an env var
name, a secrets-manager key) — never the secret itself — following the same
"credential reference indirection" principle carried over from `jarvis-1.0`.

## Identity and interfaces

Full design: `docs/architecture/interfaces-and-identity.md`. Security
properties, each covered by tests that were verified to fail when the
control is removed:

- Every `/api/*` request needs a bearer token; there is no fallback
  identity. Only a SHA-256 hash of a token is stored; plaintext is shown once.
- The principal and the interface come from the credential. A client-supplied
  `principalId` (body at any depth, query, `X-Principal-Id`) is rejected `400`.
- Inside a request, `gatewayExecute` refuses any action whose principal
  differs from the authenticated one, and audit rows carry `interfaceSource`
  and `requestId`.
- Adapters (`interfaces/`) cannot import the database, skills, or the gateway
  (`tests/interfaces-boundary.test.ts`); Telegram answers only linked
  private chats and never propagates errors that could contain the bot token.
- Async route errors reach a sanitizing handler instead of stopping the
  process (the Express 4 issue previously listed under "Error handling").

## Error handling

Raw internal error text never reaches the user or the audit log.
`core/errors.ts`:

- `PublicError` marks an error whose message was written for the user
  (e.g. "No active Google Calendar connection…"). Only these messages are
  shown.
- Every other error becomes a generic message. `gatewayExecute`'s audit
  entry stores structured, safe fields only — `{ errorType, code?, public }`
  (e.g. `PrismaClientKnownRequestError`, `P2002`) — never the message,
  which can contain SQL, user content, paths, or connection strings.
- `JarvisCore.handle` wraps dispatch with the same sanitization, for
  failures outside a skill.
- The raw error goes to stderr through `logInternalError`, passed through
  `redactForLog` (connection-string credentials, bearer/Google tokens,
  private keys, `key=value` secrets). This is best-effort defence in depth,
  not permission to put secrets in errors.

Async route handlers are wrapped (`asyncRoute` in `api/middleware.ts`), so an
unexpected error reaches a terminal handler that returns a generic 500 and
logs the redacted detail; it no longer stops the process.

## Time and timezones

Instants are stored and compared in UTC. User-relative concepts ("today",
"tomorrow", "10:00") are interpreted in the principal's IANA timezone
(`Principal.timezone`, falling back to UTC if invalid) by `core/time.ts`,
which uses only the built-in `Intl` API. Only skills read the timezone —
inside their gateway executor, after the permission check.

## What this repo deliberately does not do

- Execute arbitrary shell commands from user input.
- Log request/response bodies verbatim where they might contain secrets.
- Store plaintext passwords (none are stored at all in v0.1 — there is no
  authentication system yet; see `docs/ROADMAP.md`).
- Hardcode credentials or commit `.env`.
- Let any skill bypass `gatewayExecute`.

## Known limitations in v0.1 (tracked in docs/ROADMAP.md)

- **Authentication is a static bearer token** (Build #5). Real, but minimal:
  tokens don't expire (revocation only), there is no rate limiting, and
  issuance is CLI-only. Production authentication (sessions, OIDC,
  passkeys) is a new `Authenticator` — see
  `docs/architecture/interfaces-and-identity.md`. `/connect` now starts the
  flow for the *authenticated* principal; the earlier "whichever principal
  Postgres returns first" limitation no longer exists.
- Approval decisions are not yet wired to automatically trigger the
  originally-requested action; there is no sensitive skill implemented yet
  for this to matter in practice. See "Approval execution contract" above
  for the binding rule the eventual implementation must follow.
- No rate limiting, no request signing.
- `AuditLog` cascades from `Principal` deletion (`onDelete: Cascade` in
  `db/schema.prisma`) — deleting a principal currently deletes its audit
  trail with it. No account-deletion feature exists yet, so this is latent,
  not exploitable. Before one is built, audit retention semantics must be
  explicitly decided (keep audit logs past account deletion? for how long?)
  — do not just leave the cascade as an accident of the schema.
- **Google OAuth flow implemented (Build #3), but never exercised against
  the real Google API.** This sandbox has no real `GOOGLE_CLIENT_ID`/
  `GOOGLE_CLIENT_SECRET`, so `/connect` and `/callback` were verified
  structurally (unit/integration tests with a mocked `fetch`, and a live
  `curl` against `/connect` confirming it fails safely with a clear config
  error rather than crashing) — not against a real Google account. Before
  relying on this in practice: obtain real OAuth credentials from
  https://console.cloud.google.com/apis/credentials, set them plus
  `GOOGLE_OAUTH_REDIRECT_URI`, and run the flow once manually to confirm
  Google's actual token/userinfo response shapes match what
  `connectors/google/oauthClient.ts` expects.
- **`EncryptedCredentialStore` is not a production secrets manager.** Real
  AES-256-GCM encryption at rest (see "Credential handling (Connector
  Layer)" above for the exact key source/boundary/rotation limitations),
  but single-key, no HSM, no managed rotation. A future production
  deployment should implement `CredentialStore` against a real secrets
  manager (Vault, a cloud KMS-backed secret store) — the interface exists
  precisely so that's a config change, not a rewrite.
