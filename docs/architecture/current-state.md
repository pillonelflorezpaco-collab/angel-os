# Angel OS — Current State (verified audit)

Verified directly against the repository, not against earlier summaries.
Where an earlier summary was wrong or incomplete, this document says so.

## Verification baseline

| Check | Result |
|---|---|
| `npm test` (Vitest, real Postgres) | **111 / 111 passed**, 15 files |
| `npm run typecheck` (`tsc --noEmit`) | Clean |
| `npm run build` | Clean |
| `prisma validate` | Valid |
| `prisma migrate status` | 3 migrations, schema up to date |
| Lint | **No lint script exists** (no ESLint/Biome configured) |
| TypeScript source | ~5,400 lines across app + tests |

Runtime: Node 22, TypeScript (ESM, `NodeNext`), Express 4, Prisma 5 on
PostgreSQL 16, Zod for request validation, Vitest + Supertest. No agent
framework, no graph DB, no vector DB, no queue, no scheduler.

## Build history (from code, migrations, and docs)

| Build | What was added | Why | Status | Tests | Known limitations |
|---|---|---|---|---|---|
| **#1 Foundation** (migration `…_init`) | Principal-scoped schema (principals, people, projects, tasks, reminders, goals, decisions, memories, knowledge_documents, skills, agents, permissions, approval_requests, audit_logs); `gatewayExecute`; approvals; audit; `MemoryProvider` + local impl; Markdown knowledge; deterministic router/planner; `system.tasks` skill; Express API | Establish the Jarvis → Skill → Gateway → Audit path | Working | db, permissions, approvals, audit, memory, jarvis-core, api | Regex intent parsing; single-principal API |
| **Hardening pass** (no migration) | `system.memory` + `system.decisions` skills (removed Core → Prisma/Memory bypass); principal-scoped memory update/delete/confirm; principal-scoped atomic `decideApproval`; transactional permission-change audit; knowledge slug path-traversal guard | Close findings from independent audit | Working | two-principal, memory-skill, knowledge, approvals (concurrency) | See "Findings" below — one bypass remains in `context/` |
| **#2 Connector layer** (migration `…_add_connectors`) | `ConnectorProvider`, `ConnectorRegistry`, `CredentialStore` interface + `EnvCredentialStore`, `ConnectionService`, `Connection` model, 5 CONNECTION_* audit events, read-only connection/connector routes | Provider-neutral integration infrastructure | Working | connectors | No provider at the time |
| **#3 Google Calendar read-only** (migration `…_add_google_oauth_and_credential_store`) | `OAuthState` (principal-bound, single-use, 10 min), `EncryptedCredentialStore` (AES-256-GCM, `credential_secrets`), plain-fetch `GoogleOAuthClient`, `GoogleCalendarConnector` (`calendar.read` only), `integrations.calendar` skill, token refresh + revoked path, `calendar.today` intent, OAuth connect/callback routes | First real external integration | Working (mocked) | oauth-state, encrypted-credential-store, google-connector, calendar-skill | **Never exercised against real Google** — no live credentials in this environment |
| **Research & decisions pass** (docs only) | `docs/research/`, `docs/decisions/0000–0005`, agents/permissions/integrations docs | Validate architecture against the Personal Jarvis vision | Docs | — | — |

## Architecture map (as it actually runs)

```
Interface:  api/server.ts  (Express; the only interface today)
               │  POST /api/jarvis ──► JarvisCore.handle({principalId,input})
               │  other routes ────► call Skills directly (tasks, reminders, memory search)
               ▼
Core:       core/router (regex) → core/planner → core/index.ts (dispatch only)
               │  also calls context/retrieval.buildContext()  ◄── see Finding F1
               ▼
Skills:     system.tasks · system.memory · system.decisions · integrations.calendar
               ▼
Gateway:    gatewayExecute → checkPermission (fail-closed)
               ├─ DENIED ───────────► audit ACTION_DENIED, executor never runs
               ├─ APPROVAL_REQUIRED ► create ApprovalRequest(PENDING), audit, executor never runs
               └─ ALLOWED ──────────► run executor closure → audit EXECUTED/FAILED
               ▼
Data/Ext:   Prisma/Postgres · MemoryProvider · CredentialStore · ConnectorRegistry → Google
```

Permissions seeded for the single principal (`db/seed/seed.ts`):
`angel:tasks` READ/CREATE_TASK/CREATE_REMINDER, `angel:memory`
MEMORY_READ/MEMORY_WRITE, `angel:decisions` DECISION_READ,
`angel:calendar` READ — all ALLOWED. Illustrative `angel:gmail` rows
(READ ALLOWED, SEND_EMAIL APPROVAL_REQUIRED, DELETE_ALL DENIED) on an
inactive placeholder skill. **No currently implemented skill ever reaches
APPROVAL_REQUIRED.**

## Claims verified as true

- Strict BlackOS separation: no import, schema, or network reference outside the inert `gateway/bridge/index.ts` (`isEnabled(): false`).
- READ/WRITE/EXECUTE categories and ALLOWED/DENIED/APPROVAL_REQUIRED states exist and are enforced by `gatewayExecute`; missing row ⇒ DENIED.
- All ten `MemoryType`s exist; `INFERENCE` is stored `UNCONFIRMED` at confidence 0.5 and only `confirmMemory` promotes it.
- Core has no runtime import of Prisma, `MemoryProvider`, or connectors (one `import type { CalendarEvent }`, erased at compile time).
- Calendar connector exposes only `calendar.read`; OAuth requests only `calendar.readonly`.
- Tokens never appear in API responses or audit metadata (tested).

## Findings — where reality differs from earlier summaries

| # | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | **Context engine is an unguarded read path.** `context/retrieval` reads tasks via Prisma and memories via `MemoryProvider` directly — no permission check, no audit. Core awaits it on every request and **discards the result**. | `context/retrieval/index.ts:17-30`, `core/index.ts:38` | Medium now (result unused), **High the moment an LLM planner consumes context** |
| F2 | **Approval expiry is stored but never enforced.** `decideApproval` and `listPendingApprovals` ignore `expiresAt`; `gatewayExecute` never sets one. | `gateway/approvals/index.ts` | Medium — must be fixed before any EXECUTE skill |
| F3 | **Approved approvals never execute**, and **the executor model cannot support it**: `gatewayExecute` runs a closure; the stored `parameters` are a hand-picked subset (e.g. `createTask` stores only `title`, dropping `description`/`dueAt`). Nothing could faithfully re-run an approved action from storage. | `gateway/index.ts`, `skills/system/tasks.ts:24` | **Architectural** — blocks Gmail send |
| F4 | **"What are my reminders?" lists tasks.** The router maps it to `task.list`; the declared `reminder.list` intent is never produced. | `core/router/index.ts:30`, `core/types/index.ts:8` | Low (user-visible bug) |
| F5 | **Memory `expiresAt` is not enforced on retrieval**, and search returns `UNCONFIRMED` inferences mixed with facts; Jarvis's reply does not distinguish them. | `memory/local/index.ts:40` | Medium — a path to presenting guesses as facts |
| F6 | **`Principal.timezone` is unused.** "Today" in the calendar skill is the server's local day. | `skills/integrations/calendar.ts` `today()` | Medium for a Chief of Staff (wrong "today" when traveling or server in UTC) |
| F7 | **Raw error messages flow to users and audit.** `gatewayExecute` puts `err.message` into audit metadata and `Result.message`. Prisma error messages can contain query arguments (user content). Provider errors are sanitized; generic errors are not. | `gateway/index.ts:83,87` | Medium — worse once replies go to Telegram |
| F8 | **Reminders never fire.** They are stored; no scheduler or outbound channel exists. | No scheduler anywhere | **High capability gap** — "remind me" silently does nothing |
| F9 | `GET /api/audit` and `GET /api/approvals` are not gateway-mediated. | `api/server.ts` | Low (single local user), must change with real auth |
| F10 | No privacy classification on any entity; `RETRACTED` exists but no retract operation; `deleteMemory` is a provider-level hard delete not exposed through any skill. | `db/schema.prisma` | Prerequisite for bridge; not urgent otherwise |
| F11 | No observability beyond the audit log: no structured logging, no request IDs, no lint. | — | Low now |

None of these invalidate the architecture. All are fixable inside it.

## Resolved by the security & correctness patch

| # | Fix | Where | Regression tests |
|---|---|---|---|
| F1 | Context engine reads tasks/memories only through skills → `gatewayExecute` (per-agent permission, fail-closed, audited); denied sections listed in `withheld`, never fetched. Core no longer calls it (no consumer yet) | `context/retrieval/index.ts`, `core/index.ts` | `tests/context-permissions.test.ts` |
| F4 | `reminder.list` routed and handled; "reminders" removed from the task pattern | `core/router/index.ts`, `core/index.ts` | `tests/reminder-routing.test.ts` |
| F5 | Expired memories excluded at `searchMemory` (kept in DB); type/status preserved through context; replies label `[fact]` vs `[inference, unconfirmed]`; no path changes a memory's type | `memory/local/index.ts`, `skills/system/memory.ts`, `context/retrieval/index.ts` | `tests/memory-integrity.test.ts` |
| F6 | "Today" and "tomorrow at HH:MM" use `Principal.timezone` via `core/time.ts` (built-in `Intl`, DST-safe); calendar times shown in the user's zone | `core/time.ts`, `skills/system/principal.ts`, `skills/system/tasks.ts`, `skills/integrations/calendar.ts` | `tests/timezone.test.ts` |
| F7 | Only `PublicError` messages reach users; audit stores `{errorType, code?, public}`; Core has a sanitizing boundary; redacted developer log | `core/errors.ts`, `gateway/index.ts`, `core/index.ts` | `tests/error-sanitization.test.ts` |

Each regression suite was checked by temporarily reverting its fix and
confirming the suite fails (expiry: 2 failures, routing: 8, errors: 3,
timezone: 1, context: 5), then restoring. No database migration was
needed.

Still open: F2 (approval expiry — deliberately deferred to the approval
execution build), F3, F8, F9, F10, F11, and the Express 4 async-route
issue described in `docs/SECURITY.md` "Error handling".
