# 0006 — Credential-bound identity; interfaces are thin adapters

**Status**: Accepted (Build #5)

## Context

Every route resolved the caller with `findFirst()` — anyone who could reach
the port acted as the first principal in the database. The next steps
(GuideHub, Telegram, voice) all need to reach one backend, and each would
have inherited that hole.

## Decision

1. **Identity comes from a credential, never from the client.** A verified
   bearer token (hash stored) or a linked external account produces a frozen
   `IdentityContext`. Client-supplied `principalId` is rejected outright.
2. **The interface is fixed by the credential**, not claimed. It is recorded
   on audit and activity rows via a request context, and the gateway refuses
   any action whose principal differs from the authenticated one.
3. **One entry point** (`application/dispatcher.ts`). Adapters translate and
   forward; a test forbids them from importing data, skills, or the gateway.
4. **No dev bypass.** There is no "single-principal local mode". Local
   development uses a token from the CLI, exactly like production, so the
   insecure path cannot be left on by accident.
5. **Activity is separate from audit** and best-effort.
6. **No per-interface trust ceiling yet.** Voice and Telegram will eventually
   need "no immediate EXECUTE" policy, but it has nothing to apply to until an
   EXECUTE skill and approval execution exist. Deferred to that build.

## Consequences

- `tests/api.test.ts` was changed to authenticate (its assertions are
  unchanged); the old behaviour was the vulnerability.
- Bearer tokens are static and non-expiring; production authentication
  (sessions, OIDC, passkeys) is a new `Authenticator`, with no route or
  skill changes.
- CORS is opt-in because the right answer depends on how GuideHub is built.
