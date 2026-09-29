# Angel OS (product name: Personal Jarvis)

Angel OS is Angel's personal operating system: a second brain / chief-of-staff
assistant. **It is a separate system from BlackOS / Black Circle** (the
business/agency system) and has no database or runtime dependency on it, or
on the older `jarvis-1.0` repository. "Angel OS" is this codebase's name;
"Personal Jarvis" is the same project's product name — see
`docs/decisions/0000-naming.md`.

See `docs/ARCHITECTURE.md` for the full design (including the two-Jarvis
ecosystem diagram), `docs/SECURITY.md` for the permission model,
`docs/MEMORY.md` for the memory architecture, `docs/research/README.md`
for the ecosystem survey behind these choices, `docs/decisions/` for the
individual architecture decisions and why, and `docs/ROADMAP.md` for
what's deferred.

## What this is

A working foundation: Postgres schema, a Permission & Action Gateway, an
approval workflow, an audit log, a memory abstraction, a Markdown knowledge
layer, a deterministic context engine, a minimal Jarvis Core, a typed HTTP
API, an Integration/Connector Layer, and one real external integration —
**Google Calendar, read-only** — all with passing tests. Ask Jarvis
"What do I have today?" once connected.

## What this is NOT (yet)

No Gmail, Telegram, travel, or finance integration. No frontend. No
LLM-based intent parsing (the parser is deterministic/regex-based by
design, so the pipeline stays understandable end to end). No bridge to
BlackOS (the `gateway/bridge/` module is an interface placeholder only).
No write access to Google Calendar (`calendar.write` is deliberately not
implemented). No production secrets manager (see `docs/SECURITY.md`
"Credential handling").

## Requirements

- Node.js 20+
- PostgreSQL 14+ (a local Docker container works fine)

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to a real Postgres instance, e.g.:
#   docker run -d --name angel-os-db -e POSTGRES_USER=angel -e POSTGRES_PASSWORD=angel \
#     -e POSTGRES_DB=angel_os -p 5432:5432 postgres:16

npm run db:migrate      # applies db/schema.prisma migrations
npm run db:seed         # creates the Principal, jarvis-core agent, skills, permissions

# Required for the credential store (default: encrypted). Generate once:
#   openssl rand -hex 32
# and set ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY in .env to the result.
```

### Access: tokens and interfaces

Every `/api/*` request needs a bearer token; there is no unauthenticated
mode. Issue one for the seeded principal (printed once, never stored in
plaintext):

```bash
npm run identity -- create-token 00000000-0000-0000-0000-000000000001 GUIDEHUB "my laptop"
curl -H "Authorization: Bearer aos_..." http://localhost:3000/api/me
```

Telegram (long polling, private chats from linked accounts only):

```bash
npm run identity -- link 00000000-0000-0000-0000-000000000001 TELEGRAM <your-telegram-user-id>
TELEGRAM_BOT_TOKEN=... npm run telegram
```

API contract for clients: `docs/api/README.md`. Design:
`docs/architecture/interfaces-and-identity.md`.

### Reminder worker

Reminders are delivered by a separate process (never inside the API):

```bash
ANGEL_OS_SYSTEM_PRINCIPAL_ID=<your principal id> TELEGRAM_BOT_TOKEN=... npm run worker
```
It acts as a SYSTEM identity for that one principal and delivers to that principal's linked
Telegram account only. See `docs/architecture/reminders-and-delivery.md`.

### Connecting Google Calendar (optional)

1. Create OAuth credentials at
   https://console.cloud.google.com/apis/credentials (type "Web
   application"), with `GOOGLE_OAUTH_REDIRECT_URI` (from `.env`) as an
   authorized redirect URI.
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
   `GOOGLE_OAUTH_REDIRECT_URI` in `.env`.
3. `GET /api/integrations/google/calendar/connect` (with your bearer token) returns
   `{ "authorizeUrl": "..." }` — open it in a browser, approve, and
   Google redirects to the callback route, which confirms
   `{ "status": "connected", ... }`.
4. Ask Jarvis: `POST /api/jarvis {"input": "What do I have today?"}` (bearer token required).

Without step 1–2 configured, `/connect` fails with a clear config error
rather than a crash — this is expected in an environment with no Google
credentials.

## Run

```bash
npm run dev              # API on http://localhost:3000 (tsx, auto-reload)
# or
npm run build && npm start
```

Try it:

```bash
curl http://localhost:3000/health   # public; everything under /api needs a token (see below)
```

## Test

```bash
npm run test
```

Tests run against a real Postgres database (`DATABASE_URL` from `.env`) — no
mocked database. External providers (Google) are always mocked — no test
requires or makes a real network call. They cover: DB connectivity,
task/reminder creation, permission ALLOWED/DENIED/APPROVAL_REQUIRED, the
approval flow, audit log writes, the memory provider, Jarvis Core's
end-to-end request flow, the connector registry/credential store/connection
service, OAuth state security, and the Google Calendar connector/skill
(normalization, permission enforcement, missing/expired/revoked credential
handling, secret redaction, two-principal isolation).

## Migrations

Prisma manages the schema (`db/schema.prisma`). To add a migration:

```bash
npm run db:migrate     # dev: creates + applies a new migration from schema changes
npm run db:migrate:deploy  # prod-style: applies existing migrations, no schema diffing
```

## Project layout

```
core/       Jarvis Core: router (intent parsing), planner, shared types
memory/     MemoryProvider interface + local (Postgres) and Mem0 (stub) implementations
knowledge/  Markdown knowledge layer (list/read/search)
context/    Context Engine: assembles a small relevant package, never "everything"
skills/     Skills, each executing only through the gateway (system/ built-ins, integrations/ external providers)
gateway/    Permission checks, approvals, audit log, and the BlackOS bridge placeholder
identity/   Authentication: IdentityContext, API tokens, linked external accounts, interface registry
interfaces/ Thin adapters (Telegram, voice)
application/ The one dispatcher + approval facade every interface uses; gateway/execution + approvals run sensitive actions
activity/   User-facing life-history stream (separate from the audit log)
reminders/  Reminder engine: atomic claim/lease, delivery via the application DeliveryPort (run by scripts/worker.ts)
connectors/ Integration/Connector Layer — provider registry, credential abstraction (encrypted store), connection records, OAuth state, and the Google Calendar connector
db/         Prisma schema, migrations, seed script, shared client
api/        Express HTTP API
tests/      Vitest test suite (runs against a real Postgres database)
```

## Design principles this repo follows

1. **Personal only** — one principal (Angel). No employee/agency/business concepts.
2. **READ / WRITE / EXECUTE are distinct**, and every action needs an explicit permission row (fail closed).
3. **Memory ≠ Knowledge ≠ Structured state** — three separate layers, never one giant table.
4. **Current state ≠ history** — e.g. Decisions are never overwritten, only superseded.
5. **Explicit vs inferred** — an INFERENCE memory starts UNCONFIRMED, never silently becomes a standing FACT.
6. **Single source of truth** — PostgreSQL, always; no duplicated state across systems.
7. **Modularity** — a new skill never requires touching core, memory, or the gateway's internals.
8. **No overengineering** — no Neo4j/Graphiti/Letta/Kubernetes/message brokers in v0.1.

**Critical security rule**: the LLM never gets direct authority to execute a
sensitive action. Every action goes Jarvis → Skill → Permission Gateway →
Approval (if required) → Action → Audit Log. See `docs/SECURITY.md`.
