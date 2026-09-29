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

When a permission's state is `APPROVAL_REQUIRED`, `gatewayExecute` does not
run the action. It creates an `ApprovalRequest` row (`status: PENDING`) with
the requested resource, action, and parameters, and returns
`{ status: "PENDING_APPROVAL", approvalId }` to the caller instead of a
result. The action only runs once a human decision moves the approval to
`APPROVED` — v0.1 has no code path that executes a pending action
automatically, on a timer, or on re-request.

`decideApproval(principalId, approvalId, "APPROVED" | "REJECTED")`:
- Requires the deciding `principalId` and only matches an approval that
  belongs to it — the WHERE clause on the update itself is
  `{ id, principalId, status: "PENDING" }`, so an approval belonging to a
  different principal is never fetched, never mutated, and produces the
  same `ApprovalOwnershipError` as a nonexistent id (no oracle for
  enumerating other principals' approval ids).
- Refuses to decide an approval that isn't `PENDING` (no double-deciding),
  and does so atomically: the PENDING→APPROVED/REJECTED transition is one
  `updateMany` conditioned on `status: "PENDING"`, not a separate read then
  write — see "Approval decisions are atomic" below.
- Writes `ACTION_APPROVED` or `ACTION_REJECTED` to the audit log on success,
  and `ACTION_DENIED` (never a misleading `ACTION_APPROVED`/`ACTION_REJECTED`)
  when ownership fails.
- v0.1 does **not** automatically execute the underlying action on
  approval — approving records the decision; wiring approval → actual
  execution is deferred (see `docs/ROADMAP.md` and "Approval execution
  contract" below), since no sensitive skill (Gmail send, calendar delete,
  money transfer) is implemented yet to execute.

### Approval decisions are atomic (no TOCTOU)

`gateway/approvals/index.ts`'s `decideApproval` does not read the approval's
status and then separately write a new status — that read-then-write gap is
exactly where a race would live (two concurrent requests could both observe
`PENDING` before either writes). Instead the check and the write are the
same SQL statement:
`UPDATE approval_requests SET status = ... WHERE id = ... AND principalId = ... AND status = 'PENDING'`.
Postgres serializes concurrent updates to the same row; of two simultaneous
decisions, only the one that reaches the row first can still match
`status = 'PENDING'` — the loser's `WHERE` no longer matches (the row
already changed) and its `count` comes back `0`, which surfaces as
`ApprovalNotPendingError`. One approval can never be successfully decided
twice, under concurrency or otherwise.

### Approval execution contract (binding, not yet implemented)

This is the contract that governs the still-unbuilt approval → execution
wiring (see `docs/ROADMAP.md`), written down now so nothing implements it
incorrectly later:

An `ApprovalRequest` authorizes **one exact action**, not a category of
action. It binds `principalId`, `agentId`, `skillKey`, `resource`, `action`,
and `parameters` together at creation time (`createApprovalRequest`,
`gateway/approvals/index.ts`).

When execution-on-approval is eventually built, it **must**:
1. Load the stored `ApprovalRequest` by id.
2. Verify `approval.principalId` matches the caller (already enforced by
   `decideApproval`).
3. Verify `approval.status === "PENDING"`.
4. Atomically consume the approval (flip it to a terminal, one-time-use
   state) as part of the same operation that triggers execution — reusing
   the same conditional-`updateMany` pattern `decideApproval` already uses,
   so approving and executing can't be split into two separately-racy
   steps.
5. Execute using **only** `approval.resource`, `approval.action`, and
   `approval.parameters` as stored — **never** parameters supplied fresh by
   whatever caller is triggering execution.

Concretely, this is **wrong**:
```
approve(approvalId) → execute(callerProvidedParameters)
```
and this is the required shape:
```
approve(approvalId) → load stored approval → verify ownership → verify PENDING
                     → atomically consume → execute(approval.resource, approval.action, approval.parameters)
```
An approval must never be reusable to authorize a different resource,
action, or parameter set than the one that was actually shown to and
approved by the principal (e.g., "approved sending an email to John" must
never be reusable to send to someone else). No execution code exists yet —
this section exists so the first implementation is correct.

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

`knowledge/markdown/index.ts`'s `resolveSafeDocPath` rejects any slug that
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

Known gap: Express 4 does not catch rejected promises in async route
handlers. An error thrown directly in a route (outside `JarvisCore` or a
skill — e.g. the database being unreachable in `getOrCreatePrincipal`)
does not leak text, but becomes an unhandled rejection, which under
Node's default behaviour terminates the API process. See
`docs/architecture/current-state.md`.

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

- No authentication layer yet — the API has no auth middleware; it assumes
  a single trusted caller (Angel, locally). `getOrCreatePrincipal()`
  (`api/server.ts`) resolves whichever principal Postgres returns first —
  correct only because exactly one principal is ever seeded today. Do not
  expose this API on the open internet, and do not seed a second principal
  without adding real authentication first. This also applies to
  `/api/integrations/google/calendar/connect` — it starts the OAuth flow
  for whichever principal `getOrCreatePrincipal()` resolves, for the same
  reason. `OAuthStateService`'s principal-binding (see "OAuth state
  security" above) protects the *callback* from being redirected to the
  wrong principal; it does not by itself add authentication to who can hit
  `/connect` in the first place.
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
