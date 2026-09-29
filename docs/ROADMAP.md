# Roadmap

## v0.1 (Build #1) — foundation

Done: Postgres schema, Permission & Action Gateway (with fail-closed
default), approval workflow, audit log, `MemoryProvider` abstraction +
local implementation, Markdown knowledge layer, deterministic Context
Engine, deterministic Jarvis Core, one real skill (`system.tasks`), typed
HTTP API, passing tests against a real database.

## Security hardening pass (after Build #1's audit)

Closed the Jarvis Core → Memory/Decisions bypass (now `skills/system/
memory.ts` and `skills/system/decisions.ts`, gateway-mediated), the memory
IDOR (`MemoryProvider` methods now require `principalId`), the approval
ownership IDOR and TOCTOU race (`decideApproval` now principal-scoped and
atomic), unaudited permission changes (`setPermission` now transactional),
the `/api/memory/search` gateway bypass, and the knowledge path-traversal
gap (`resolveSafeDocPath`). 53/53 tests passing at the end of this pass.

## Build #2 — Integration / Connector Layer (infrastructure only)

Done: `connectors/` — `ConnectorProvider` interface, `ConnectorRegistry`
(discovery), `CredentialStore` abstraction + `EnvCredentialStore`
(local-dev-only), `ConnectionService` (principal-scoped CRUD over the new
`Connection` model), read-only `GET /api/connectors` /
`GET /api/connections` endpoints. No provider implemented — no Google,
Gmail, Telegram, WhatsApp, finance, or travel code exists yet. 73/73 tests
passing at the end of this build. See `docs/ARCHITECTURE.md` "Connector
Layer" for the design.

## Intentionally deferred (explicit instruction: build the foundation first)

- **Integrations**: Gmail, Google Calendar, Telegram, flights/hotels/travel
  search, personal finance, photos/personal media, personal documents. Each
  should become its own module under `skills/`, following the same
  gateway-mediated pattern as `skills/system/tasks.ts`, with its own
  permission rows seeded before it can do anything.
- **BlackOS bridge**: `gateway/bridge/` stays a disabled placeholder until a
  real, explicitly-scoped connector is designed (see
  `docs/ARCHITECTURE.md` "Bridge to Business Jarvis / BlackOS").
- **Frontend**: none yet. The API is the interface; a future Next.js UI can
  sit on top without changing `core/`, `memory/`, or `gateway/`.
- **Authentication**: the API currently assumes a single trusted local
  caller. Needs a real auth layer before being exposed beyond localhost.
- **LLM-assisted intent parsing**: `core/router` is regex-based by design
  for v0.1's legibility. An LLM-assisted parser can replace/augment it
  later, but must still only *produce* a `Plan` — the gateway keeps
  enforcing permissions regardless of what proposed the plan.
- **Approval → execution wiring**: approving a request currently records the
  decision (audit-logged) but does not automatically re-invoke the original
  action, because no implemented skill yet produces `APPROVAL_REQUIRED` in
  practice (only the seeded example `communication.gmail` rows do, and that
  skill isn't implemented). Build this once a real EXECUTE-category skill
  exists.
- **Memory search quality**: substring match today; embeddings/pgvector or
  a completed Mem0 adapter later (see `docs/MEMORY.md`).
- **Memory expiry sweep**: `expiresAt` is stored but nothing currently acts
  on it.
- **Proactive daily planning**: "prepare my day" as a scheduled job that
  assembles context and pushes a summary — needs a scheduler/worker, not
  built in v0.1.
- **Multi-user**: the schema is `principalId`-scoped everywhere so this
  wouldn't require a schema rewrite, but no multi-user logic (auth per
  principal, isolation guarantees beyond the FK) is implemented.

## Build #3 — Google Calendar (read-only), the first real connector

Done: `GoogleCalendarConnector` (`connectors/google/calendarConnector.ts`,
declares only `calendar.read`), `GoogleOAuthClient` (plain-fetch OAuth
2.0, no `googleapis` SDK dependency), the OAuth flow
(`GET /api/integrations/google/calendar/connect` +
`GET /api/integrations/google/calendar/callback`), principal-bound
single-use `OAuthState`, `EncryptedCredentialStore` (AES-256-GCM,
self-hosted — see docs/SECURITY.md for its exact limitations),
`skills/integrations/calendar.ts` (list calendars/events, get event,
"today" — one `angel:calendar`/`READ` permission, gateway-mediated, token
refresh with a revoked-token failure path), and Jarvis Core's
`calendar.today` intent ("What do I have today?"). 111/111 tests passing.
Real Google OAuth was **not** exercised in this build — no live Google
credentials were available in this environment; verified structurally
with mocked `fetch` instead (see docs/SECURITY.md "Known limitations").

## Research & decisions pass (this work order)

Not a code build — a research and documentation pass validating the
existing architecture against a detailed "Personal Jarvis" vision
document, per that document's own instruction to research before building
further. Added `docs/research/README.md` (ecosystem survey: Letta/MemGPT,
LangGraph, AutoGPT-style autonomy, Mem0, Graphiti, Telegram SDKs — what
was reused as inspiration vs. rejected vs. adopted as an optional
adapter) and `docs/decisions/0000`–`0005` (naming, build-vs-framework,
memory architecture, graph memory, directory layout, interface boundary).
Confirmed: no rebuild needed, this repository already implements the
vision's core shape. Concrete gaps this pass surfaced, not yet built:

- **Telegram interface**: named as the first intended interface, not yet
  built. See `docs/decisions/0005-interface-boundary.md` for the exact
  shape a future `interfaces/telegram/` module must follow (thin adapter,
  no logic of its own) and `docs/research/README.md` for the recommended
  library (grammY).
- **Per-memory privacy classification**: no field yet marks a `Memory` row
  as bridgeable-to-BlackOS vs. personal-only. Must exist before any
  Business Jarvis Gateway work begins — see
  `docs/decisions/0002-memory-architecture.md` "Gaps" and
  `docs/integrations/business-jarvis-gateway.md`.
- **Delete/high-risk memory actions**: `MemoryProvider.deleteMemory`
  exists at the provider level but isn't exposed through any Skill/
  permission-checked action yet. See `docs/permissions/README.md` "Gaps."
- **Proactive Engine**: design-only, documented in
  `docs/ARCHITECTURE.md` "Future: Proactive Engine" — no
  `ProactiveTrigger` table, no evaluator, nothing scheduled. Build only
  once a real trigger source (e.g. calendar events, since Build #3 now
  provides that data) makes it worth building, not speculatively.
- **Permission inspection endpoint**: no `GET /api/permissions` — current
  permission state is only visible via direct DB query.
- **Working/conversational memory persistence**: intentionally still not
  persisted — see `docs/decisions/0002-memory-architecture.md`.

## Principal-architect audit (supersedes the Build #4 recommendation below)

A verified audit (`docs/architecture/current-state.md`) found gaps the
earlier recommendation didn't account for: approved actions cannot be
executed from stored parameters at all (closure-based executor), approval
expiry is not enforced, reminders never fire, and the context engine is an
ungated read path. The dependency-aware order is now: **Build 4 Telegram
inbound adapter (+ prerequisite patch) → Build 5 reminder delivery →
Build 6 deferred action execution → Build 7 Gmail → Build 8 privacy
classification.** Full reasoning in
`docs/architecture/next-stage-architecture.md`.

## Recommended BUILD #4 (superseded — kept for history)

Now that one connector proves the full path end to end, either:
(a) build Gmail (draft-only, `SEND` behind `APPROVAL_REQUIRED`) — the
first skill that actually needs the approval→execution wiring deferred
since Build #1, since a draft can sit `PENDING_APPROVAL` indefinitely and
approving it must trigger a real send using exactly the approved
parameters (see docs/SECURITY.md "Approval execution contract"); or
(b) do a real end-to-end validation of the Google Calendar integration
against a live Google account, closing the one gap Build #3 couldn't
close in this environment. (a) is architecturally more valuable — it
forces solving approval execution, which everything after it depends on.

## Recommended BUILD #3 (superseded — kept for history)

Now that the connector layer exists as infrastructure, implement **one**
real connector + skill pair end to end, rather than adding several
providers shallowly. Recommended, unchanged from Build #1's
recommendation: **Google Calendar, read-only first**:
1. A `GoogleCalendarConnector implements ConnectorProvider` reporting
   `calendar.read` (and `calendar.write` as a capability it *could* do,
   even if the skill doesn't use it yet).
2. A real OAuth flow (see docs/SECURITY.md "No OAuth flow implemented") to
   populate a `Connection` and a real `CredentialStore` (not
   `EnvCredentialStore`) to hold the resulting token.
3. A `skills/integrations/calendar.ts` skill with a `READ`-only permission
   row, calling the connector only from inside its `gatewayExecute`
   callback.

This proves the full `Jarvis → Skill → Gateway → Connector → Provider API`
path on the lowest-risk possible surface (`READ`, no `EXECUTE`), and
directly answers "what do I have today?" / "prepare my day" from the
original mission. Gmail (draft-only, `SEND` gated behind
`APPROVAL_REQUIRED`) is the natural follow-up once Calendar proves the
shape, since it's the first place `APPROVAL_REQUIRED` — and the approval
execution contract documented in `docs/SECURITY.md` — actually has to be
implemented for real.
