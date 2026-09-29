# Architecture

## What Angel OS is

A personal AI operating system for one principal, Angel: a second brain and
chief-of-staff assistant. Long-term memory, personal knowledge, structured
state (tasks, projects, goals, decisions), and a permission-gated action
layer, orchestrated by a minimal core. Product name: **Personal Jarvis** —
same project, see `docs/decisions/0000-naming.md`.

### The two-Jarvis ecosystem

```
                    JARVIS ECOSYSTEM
                           |
              +------------+------------+
              |                         |
       PERSONAL JARVIS             BUSINESS JARVIS
       (this repository)              (BlackOS)
              |                         |
       Personal world              Black Circle
              |                         |
              +------------+------------+
                           |
                 FUTURE SECURE BRIDGE
              (Business Jarvis Gateway —
               see docs/integrations/business-jarvis-gateway.md)
```

Personal Jarvis (this repository) must work fully standalone — it never
requires BlackOS, BlackOS's database, BlackOS's VPS, or BlackOS credentials
to run. Nothing below assumes BlackOS is reachable.

## What Angel OS is NOT

- **Not BlackOS / Black Circle.** That is a separate, business/agency system
  (multi-employee, multi-client, sector-based permissions). Angel OS has no
  database connection, shared schema, or runtime dependency on it.
- **Not `jarvis-1.0`.** That repository's *patterns* (audit logging,
  grant/revoke state, credential indirection, Telegram command parsing,
  single source of truth, explicit permissions before actions) informed this
  design, but no code or table from it is imported here. See "What was
  reused from jarvis-1.0" below.
- **Not a multi-user system.** Every table is scoped to `principalId`, and
  the shape stays ready for more than one principal later, but v0.1
  implements exactly one.

## Pipeline

```
Angel
  ↓
Jarvis Core        (core/)         — intent → context → plan → action → result
  ↓
Context/Memory/Knowledge (context/, memory/, knowledge/) — retrieval, not storage of truth
  ↓
Planner/Reasoner    (core/planner/) — turns an Intent into a Plan naming a skill+action+resource
  ↓
Skills/Tools        (skills/)      — one real skill in v0.1: system.tasks
  ↓
Permission & Action Gateway (gateway/) — the only path to execution
  ↓
Angel
```

Jarvis Core never touches the database for anything sensitive directly — it
delegates to a skill, and the skill executes exclusively through
`gateway/index.ts`'s `gatewayExecute`. This is what enforces: **the LLM
never gets direct authority to execute a sensitive action.**

## Layer separation

### Structured state (Postgres, source of truth)
`tasks`, `reminders`, `projects`, `goals`, `decisions`, `people` (people
Angel knows, not employees). CRUD-shaped, queried directly.

### Memory (`memory/`)
Long-term facts, preferences, principles, habits, experiences, and
*inferences* — distinguished by `MemoryType` and `MemoryStatus`. An
`INFERENCE` starts `UNCONFIRMED`; it is never silently promoted to a
standing fact — see `docs/MEMORY.md`. The rest of the system depends on the
`MemoryProvider` interface (`memory/types/index.ts`), not on a specific
backend — see "Memory provider abstraction" below.

### Knowledge (`knowledge/`)
Markdown documents Angel curates by hand: principles, preferences, current
priorities. Read through the `KnowledgeProvider` interface
(`knowledge/types/index.ts`); the default implementation
(`knowledge/markdown/`) reads flat files from disk. Not a document
management system — list/read/search only.

### Current state vs. history
Some structured objects represent *now* and are edited in place
(`knowledge/markdown/current-priorities.md`, a `Goal`'s `status`). Others
are an append-only history: `Decision` rows are never overwritten — a new
decision on the same topic sets `supersedesId` on the prior one, so "what
did I decide about X" stays answerable and the timeline stays intact.

## Context Engine (`context/`)

Purpose: assemble a *small, relevant* context package for a future
LLM-assisted planner — never load the entire database into an LLM call.
`DeterministicContextEngine` pulls open tasks, a handful of memory search
hits, and a handful of knowledge hits, scoped to the query and principal.

**Protected data is read only through skills**, so every read is a normal
`gatewayExecute` call for the requesting `agentKey`: permission-checked
(missing permission = DENIED), and audited as `ACTION_EXECUTED` /
`ACTION_DENIED` (resource and action only, never memory content). Being
internal grants no extra access. A denied section is empty and listed in
`withheld`; its data is never fetched. Memories keep `type`, `status`, and
a derived `confirmed` flag, so an inference is never presented as a fact.

Jarvis Core does **not** call the context engine today: the deterministic
planner has no use for it, and calling it only produced permission checks
and audit entries for data nobody read. It is ready for the first
consumer (see `docs/architecture/next-stage-architecture.md`).

## Jarvis Core (`core/`)

v0.1 is deterministic on purpose: `core/router` parses intent with regex
(not an LLM), `core/planner` turns an `Intent` into a `Plan`
(skill+action+resource), and `core/index.ts` (`JarvisCore`) executes that
plan through a skill. This keeps the first version fully understandable end
to end — every request's path from input to result can be traced without
guessing what an LLM decided. LLM-assisted planning is a deferred upgrade
(`docs/ROADMAP.md`), and even then, an LLM only ever *proposes* a plan; the
gateway still enforces permissions on whatever it proposes.

**Jarvis Core orchestrates only — it never performs a personal data
operation itself.** Every intent branch in `JarvisCore.handle` calls a
skill function; `core/index.ts` imports no Prisma client and no
`MemoryProvider`. This was not true in the first version of this file: an
earlier revision called `MemoryProvider.addMemory`/`.searchMemory` and
Prisma's `decision.findMany` directly from `core/index.ts`, skipping the
skill and gateway layers (and therefore skipping permission checks and
audit logging) for those three intents. That bypass is fixed — see
`skills/system/memory.ts` and `skills/system/decisions.ts` below.

## Permission & Action Gateway (`gateway/`)

See `docs/SECURITY.md` for the full permission and approval model. In one
line: every action names `(principal, agent, skill, resource, action)`, is
categorized `READ | WRITE | EXECUTE`, and has a state
`ALLOWED | DENIED | APPROVAL_REQUIRED`. No permission row = `DENIED` (fail
closed). `APPROVAL_REQUIRED` creates a `PENDING` `ApprovalRequest` instead of
executing. Every meaningful event is written to `audit_logs`.

## Memory provider abstraction

`memory/types/index.ts` defines `MemoryProvider`
(`addMemory`/`searchMemory`/`updateMemory`/`deleteMemory`/`confirmMemory`).
`memory/local/` is the default, Postgres-backed implementation — no external
service required to run Angel OS. `memory/mem0/` documents the integration
point for Mem0 and is intentionally left unimplemented (a stub that throws)
rather than a fake/partial implementation; see `docs/MEMORY.md` for why and
how to complete it. The rest of the application imports `getMemoryProvider()`
from `memory/index.ts`, never a concrete provider class directly.

## Skills (`skills/`)

Each skill is a plain module exposing functions that build an
`ActionRequest` and call `gatewayExecute`. A skill never queries the
database (or calls `MemoryProvider`) before the gateway has cleared the
action. Adding a new skill means adding a new module here plus permission
rows in the seed/registry — it never requires changes to `core/`,
`memory/`, or `gateway/`'s internals (modularity requirement).

Three skills exist in v0.1, all following the same shape:

- `skills/system/tasks.ts` — `angel:tasks` resource; `READ`, `CREATE_TASK`, `CREATE_REMINDER`.
- `skills/system/memory.ts` — `angel:memory` resource; `MEMORY_READ`, `MEMORY_WRITE`. Wraps `MemoryProvider` so Jarvis Core (and the `/api/memory/search` route) never call it directly.
- `skills/system/decisions.ts` — `angel:decisions` resource; `DECISION_READ`. Owns the only `db.decision` query path.

## Connector Layer (`connectors/`)

Build #2 adds the reusable infrastructure future external integrations
(Google Calendar, Gmail, Telegram, ...) will use — with **no integration
implemented yet**. The full path, once a real connector exists, is:

```
Jarvis → Skill → Gateway → Connector → External Provider API
```

Four pieces, each with one job:

- **`ConnectorProvider`** (`connectors/types/index.ts`) — the provider-
  neutral interface a future `GoogleConnector`, `TelegramConnector`, etc.
  implements: identity (`providerKey`, `displayName`), capability
  discovery (`listCapabilities()`), authorization requirement
  (`requiresAuthorization()`), and health (`checkHealth()`). No method on
  this interface calls an external API to *do* anything — there is no
  `execute`/`send`/`invoke` method here on purpose (see "Connector vs
  Skill" below).
- **`ConnectorRegistry`** (`connectors/registry/index.ts`) — discovery
  only: register/get/list connectors, list a connector's capabilities,
  check availability. It never executes anything, and its method surface
  has no verb that could (enforced structurally, see
  `tests/connectors.test.ts` "Gateway remains the authorization
  boundary").
- **`CredentialStore`** (`connectors/credentials/index.ts`) — secret
  indirection. `Connection.credentialRef` (schema) stores only a
  *reference*; `CredentialStore.getSecret(ref)` resolves it. The default
  `EnvCredentialStore` is explicitly local-dev-only (env-var backed);
  production secret storage (a real secrets manager/KMS) is deferred — see
  docs/ROADMAP.md.
- **`ConnectionService`** (`connectors/service/index.ts`) — principal-
  scoped CRUD over `Connection` records (an authenticated external
  account, e.g. "Angel's Google account"), following the exact same
  ownership pattern as Memory and Approvals: every write scoped by
  `{id, principalId}` in one query, never fetched by id alone.

### Connector vs Skill

A **Connector** knows how to talk to a provider (or, in v0.1, merely
*declares* that it could). A **Skill** is what Jarvis Core calls, and is
what owns the decision "should this action happen" via `gatewayExecute`.
The connector layer never receives a request directly from Jarvis Core or
the API — a future skill (e.g. `skills/integrations/gmail.ts`) will call
into a connector only from *inside* its `gatewayExecute` callback, after
permission has already cleared. This keeps the rule from Build #1 intact:
**the LLM never gets direct authority to execute a sensitive action** — a
connector existing and being "available" is not authority to use it; the
permission row is.

### Connection vs Credential

A `Connection` (Prisma model) is a record: which provider, which external
account, what status, owned by which principal. It is safe to log, safe to
return over an API (`ConnectionSummary` deliberately excludes
`credentialRef` and `metadata`). A **Credential** is the actual secret
(OAuth token, API key) that record's `credentialRef` points at, resolved
only through `CredentialStore`, never persisted alongside the connection
record itself.

### Capability vs Permission

A connector's `listCapabilities()` answers "what could this provider do"
(`calendar.read`, `email.send`, ...) — a static, provider-described list.
Whether Angel OS is currently *allowed* to use one is a separate question,
answered by the existing `Permission` model (`gateway/permissions`),
exactly as it already governs `system.tasks`/`system.memory`. A capability
existing creates zero rows in `permissions` by itself — see
`tests/connectors.test.ts` section C. A future Gmail skill would declare
its own permission rows (`SEND_EMAIL` → `APPROVAL_REQUIRED`, as already
seeded illustratively for `communication.gmail` in `db/seed/seed.ts`)
independently of whatever capabilities the Gmail connector reports.

### Why Core cannot directly access connectors

Same reasoning as the Build #1 fix for the Jarvis Core → Memory bypass:
if `core/index.ts` could reach `ConnectorRegistry` or `ConnectionService`
directly, a new intent branch could call an external-facing capability
with no permission check and no audit trail, by construction. `core/`
has exactly one import from `connectors/`: `import type { CalendarEvent }`
in `core/index.ts`, used only to type the data the calendar skill already
returned so Jarvis can format a message from it. `import type` is erased
at compile time — it is not a runtime dependency, cannot be used to call
anything, and does not let Jarvis Core reach a connector, registry, or
credential store. Every actual calendar operation still goes through
`skills/integrations/calendar.ts`.

## Google Calendar connector (Build #3)

The first real connector, proving the layer end to end:

```
Jarvis (calendar.today intent)
  → skills/integrations/calendar.ts (SKILL_KEY = "integrations.calendar")
    → gatewayExecute (resource "angel:calendar", action "READ")
      → connectors/google/calendarConnector.ts (GoogleCalendarConnector)
        → Google Calendar API (read-only)
```

**Read-only, deliberately.** `GoogleCalendarConnector.listCapabilities()`
reports only `calendar.read`; no `calendar.write` capability is declared,
and the seed script (`db/seed/seed.ts`) creates only one permission row
for this skill — `angel:calendar` / `READ` / `ALLOWED`. No `WRITE` or
`EXECUTE` row exists, so both remain `DENIED` by the gateway's fail-closed
default, without any code needing to check for them explicitly.

**OAuth flow**: `GET /api/integrations/google/calendar/connect` issues a
principal-bound, single-use `OAuthState` (see "OAuth state security" in
docs/SECURITY.md) and returns Google's authorize URL. `GET /api/integrations/google/calendar/callback`
consumes that state (binding the callback back to the principal that
started the flow), exchanges the authorization code, fetches the Google
account's email, upserts a `Connection` row, and stores the resulting
tokens through `CredentialStore` — never in the `Connection` row itself,
never in the API response.

**Credential resolution and refresh**: `skills/integrations/calendar.ts`'s
`resolveCredential()` loads the principal's `Connection`, resolves its
`credentialRef` through `CredentialStore`, and refreshes the access token
(via `GoogleOAuthClient.refreshAccessToken`) if it's expired or about to
be — persisting the refreshed token back through the same store. If the
refresh token itself is missing or rejected (revoked), the `Connection` is
marked `ERROR`, a `CONNECTION_FAILED` audit event is written, and the
skill fails safely rather than retrying indefinitely.

**Internal calendar types** (`connectors/types/calendar.ts`): `Calendar`
and `CalendarEvent` are Angel OS's own shapes, not Google's. Google's
response types (`GoogleEvent`, `GoogleCalendarListEntry`, etc.) are
declared `interface`s private to `connectors/google/calendarConnector.ts`
and never exported — `normalizeEvent()` is the one place a Google shape
crosses into an Angel OS shape.

**Why calendar events are live state, not Memory**: a calendar event is
external, provider-owned, and changes independently of Angel OS (Angel
could edit it in Google Calendar directly). Writing every fetched event
into `memories` would create stale, duplicated copies of state Angel OS
doesn't own and can't trust to stay accurate — the exact anti-pattern
`docs/MEMORY.md` warns against ("Memory ≠ Knowledge ≠ Structured state").
`skills/integrations/calendar.ts`'s `today()` fetches fresh on every call
and formats it (`formatEventsAsContext`) for Jarvis to present in the
moment; nothing about "today's calendar" is ever persisted.

## Future: Proactive Engine (design only, not implemented)

Angel OS is reactive today — every `Result` is a direct response to a
`JarvisCore.handle()` call. Proactivity ("You have a meeting in 30
minutes," "You haven't completed the task you planned for today") is a
deliberately separate future subsystem, not a side effect bolted onto
existing skills, because it needs its own controls the reactive path
doesn't: rate limiting, quiet hours, explainability, and a kill switch.

Target shape, none of it built:

```
ProactiveTrigger (a rule: "task overdue", "event starts in N minutes", ...)
  ↓ (condition met, cooldown elapsed, not in quiet hours)
ProactiveEngine
  ↓ (still goes through the same Permission Gateway — a proactive
  ↓  notification is an EXECUTE action like any other, e.g. "send a
  ↓  Telegram message," and can be APPROVAL_REQUIRED or DENIED exactly
  ↓  like a user-initiated one)
Notification (via whatever interface is active — Telegram, etc.)
```

Required properties, all from the work order, none negotiable when this
gets built: **configurable** (per-trigger, not global on/off only),
**explainable** (a notification should be traceable to the exact trigger
and condition that fired it — audited via the existing `AuditLog`, not a
new logging system), **rate-limited** (a cooldown per trigger, not just a
global rate limit), **disableable** (per-trigger and globally), and
**permission-aware** (a proactive action is not exempt from
`gatewayExecute` just because a human didn't ask for it in the moment —
if anything, an unprompted action deserves *more* scrutiny, not less, so
the default for any new proactive trigger should be `APPROVAL_REQUIRED`
until proven safe to relax).

A `ProactiveTrigger` entity (rule definition: condition, priority,
cooldown, notification policy) is a reasonable future Postgres table —
not built now because no trigger evaluator exists yet to consume it.
Building the table first would be exactly the "create tables because
they're listed" anti-pattern this project avoids elsewhere.

## Bridge to Business Jarvis / BlackOS

`gateway/bridge/index.ts` exists only as an interface placeholder
(`BridgeConnector`), currently disabled. See
`docs/integrations/business-jarvis-gateway.md` for the full target design.
When built, it must still go
through the same Permission & Action Gateway, use an explicit allowlist of
resources/actions, and never let the two systems read or write each other's
Postgres schema directly. Not built in v0.1.

## What was reused from `jarvis-1.0`

Patterns only, no code or business tables:

1. Audit logging shape (actor/action/target/source/metadata/timestamp) → `audit_logs`
2. Grant/revoke-style permission state → `Permission.state`, adapted to `ALLOWED|DENIED|APPROVAL_REQUIRED` and agent/skill/resource/action scoped instead of person-to-person
3. Credential reference indirection (never store secrets in the data layer) → no secret fields anywhere in this schema
4. Telegram command → structured action pattern → the shape `core/router`'s intent parser follows (not implemented as a live Telegram integration yet)
5. Single source of truth → Postgres, no duplicated state
6. Explicit permissions before actions → the gateway's fail-closed default

Explicitly NOT reused: `sectors`, `owner_entity_type` (model/client/agency),
`tool_accounts.model_id`, the multi-employee delegation concept — all
business-specific to BlackOS.
