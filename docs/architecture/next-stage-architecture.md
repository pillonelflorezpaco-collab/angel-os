# Angel OS — Next-Stage Architecture

Written after the verified audit in `current-state.md`. Findings are
referenced as F1–F11 from that document.

## Architecture validation

| Area | Strong | Incomplete / risky | Keep | Change eventually |
|---|---|---|---|---|
| A. Core orchestration | Deterministic, traceable; no data access of its own | F1 discarded context call; F4 routing bug; regex parsing will not scale to natural phrasing | Dispatch-only Core | LLM *proposes* a Plan against a typed action catalog (after Build 6); gateway still decides |
| B. Skills | Uniform shape (`SKILL_KEY`/`RESOURCE`/action → `gatewayExecute`) | Parameters recorded for audit/approval are hand-picked subsets (F3) | The skill module pattern | Actions declared with Zod parameter schemas (Build 6) |
| C. Gateway | Fail-closed, audited, atomic approvals, principal-scoped | No deferred execution (F3); no expiry (F2); raw error text (F7) | `checkPermission`, audit semantics | Add action-handler registry + consume-and-execute |
| D. Interfaces | Core is transport-agnostic (`JarvisCore.handle`) | Only HTTP; no identity; `getOrCreatePrincipal()` = `findFirst()` | The adapter boundary | Per-interface identity mapping |
| E. Memory | Typed, provenance, confidence, inference/fact separation at write time | F5 expiry & inference not respected at read time; no retract/delete action | Postgres `MemoryProvider` | Read-time filtering + labeling; retract/delete skill actions |
| F. Structured state | Principal-scoped, FKs, append-only decisions | `Principal.timezone` unused (F6); reminders inert (F8) | Schema | Timezone-aware date logic; reminder delivery |
| G. Permissions | 5-tuple scoping, category + state, audited changes | Not inspectable by the user | Model unchanged | Read-only inspection skill |
| H. Approvals | Principal-bound, atomic, one-decision-only | Never executes; no expiry; no UX channel | Decision state machine | Execution + expiry + Telegram buttons |
| I. Tool adapters | `ConnectorProvider`/registry; Google shapes kept private | Registry cast (`as unknown as CalendarConnector`) is untyped by capability | Pattern | Typed lookup by capability interface when a 2nd connector exists |
| J. Integrations | Calendar read works end-to-end (mocked) | Never run against real Google | Plain-fetch clients | One manual live validation |
| K. Security | No secrets in logs/responses/audit (tested); encrypted store; OAuth state binding | No API auth (documented); F7; F9 | All existing guarantees | Interface auth per adapter |
| L. Testing | 111 real-DB tests, two-principal suites, concurrency test | No lint; no test that context/read paths are gated | Real-DB testing | Add ESLint + a "no Prisma import outside allowed dirs" rule |
| M. Observability | Audit log is complete for gated actions | No structured logs/request ids (F11) | Audit log as security record | Minimal structured logger (never logging payloads) |
| N. Error handling | Provider errors sanitized; typed domain errors | Generic errors leak `err.message` (F7) | Typed errors | Map unknown errors to a generic message; keep detail server-side only |
| O. Future autonomy | Autonomy structurally impossible without a permission row | No safe path from "approved" to "done" | Gateway as the only door | Build 6 is the autonomy foundation |

Nothing here is unnecessarily complex. The one abstraction worth watching
is `context/`: it currently produces work nobody consumes.

## Memory audit

The layering (structured state / typed memory / Markdown knowledge /
non-persisted working memory) is **sufficient**. No Neo4j, Graphiti,
Mem0, or vector store is justified by any current query pattern.

| Concern | Status | Minimum missing piece |
|---|---|---|
| Provenance, confidence | Present (`source`, `confidence`) | — |
| Inference vs fact | Enforced at write, **not at read** (F5) | Read path returns status; Jarvis labels unconfirmed items ("I think… (unconfirmed)") |
| Expiration | Stored, **not enforced** (F5) | `expiresAt > now OR null` in `searchMemory` |
| Updates / conflicts | Overwrite only; no conflict detection | Defer; on conflicting FACT, prefer "retract old + add new" over silent update |
| Deletion | Hard delete at provider only | See "Memory deletion" |
| Hallucinated memories | Only explicit "remember that…" writes today — low risk | Keep: no automatic memory extraction until an LLM is in the loop, and then only as `INFERENCE` |
| Duplication | Possible (same fact twice) | Defer until it's observed |
| Privacy | None (F10) | See "Privacy classification" |

## Permission & approval audit

`INTENT → PLAN → PERMISSION → APPROVAL → EXECUTION → RESULT` today:

- INTENT → PLAN → PERMISSION: works.
- PERMISSION → APPROVAL: works (row created, audited).
- APPROVAL → EXECUTION: **missing** (F3). This is the most important gap in
  the system, and it is architectural, not a missing call: the executor is
  a closure that exists only during the original request.

Minimum design to close it (Build 6):

1. **Action handler registry** in `gateway/`: `(skillKey, action) →
   { category, paramsSchema (Zod), execute(principalId, params) }`.
   Skills register handlers instead of passing closures.
2. `gatewayExecute(request)` validates `request.parameters` against the
   handler's schema **before** the permission check and stores the full
   validated parameters on the approval. What is approved is exactly what
   will run.
3. `executeApproved(principalId, approvalId)`: one conditional update
   `PENDING+unexpired+owned → APPROVED` (already the pattern), then
   `APPROVED → EXECUTING` atomically (one-time consume), run the handler
   with **stored** parameters only, then `EXECUTED` or `FAILED`. Audit each
   step. Requires additive enum values on `ApprovalStatus`.
4. **Expiry** (F2): default TTL per handler (e.g. 24h for email send);
   expired approvals cannot be approved or executed.
5. **No automatic retry.** A send whose outcome is unknown is marked
   `FAILED` with reason, never re-sent automatically.

Other capabilities: READ-only tools ✅; WRITE tools ✅; EXECUTE tools ✅
for immediate ALLOWED actions, ❌ for approval-gated ones until Build 6;
approval identity ✅ (principal-bound); auditability ✅; revocation ✅
(`setPermission` DENIED, audited); inspection ❌ (see below).

## Gmail readiness

| Piece | Exists? |
|---|---|
| OAuth flow, state binding, encrypted token storage, refresh | ✅ (Google, reusable) |
| Scope parameterization in `GoogleOAuthClient.buildAuthUrl` | ✅ |
| Gmail scopes (`gmail.readonly`, `gmail.compose`) | ❌ — re-consent needed; record granted scopes (non-secret) on `Connection.metadata` |
| Gmail connector (list/read/draft/send) | ❌ |
| Permission placeholders (`angel:gmail` READ / SEND_EMAIL) | ✅ illustrative only, on an inactive skill |
| Approval creation for SEND | ✅ |
| Execution after approval | ❌ — **Build 6 is a hard dependency** |
| Preview / confirmation channel | ❌ — needs an interface (Telegram) |
| Idempotent send | ❌ — Gmail has no idempotency key; rely on one-time approval consume |

Conclusion: Gmail should not be the next build. Two prerequisites
(deferred execution, a confirmation channel) must land first.

## Telegram readiness

Fits the existing boundary (`docs/decisions/0005`) with no Core change:
`interfaces/telegram/` → `{principalId, input}` → `JarvisCore.handle` →
format `Result`.

| Concern | Recommendation |
|---|---|
| Webhook vs polling | **Long polling** first: no public URL, no port exposure, matches local-first. Webhook (with `secret_token` header check) only when deployed |
| Authentication / identity | Bot token as a secret from env (never logged). Allowlist `TELEGRAM_ALLOWED_USER_ID` → the single principal. Unknown senders: no reply, audited. Move to an `InterfaceIdentity` table only when a second principal or interface exists |
| Conversation mapping | Stateless per message (working memory is not persisted by design) |
| Message routing | Text → `JarvisCore.handle`; commands (`/start`, `/help`) handled in the adapter only as static text |
| Confirmation UX | Inline keyboard (Approve / Reject) with `approvalId` in callback data; verify `from.id` is allowlisted and the approval belongs to the mapped principal — **Build 6** |
| Long-running ops | `sendChatAction("typing")`; all current skills are fast |
| Errors | Only sanitized `Result.message` (requires F7 fix first) |
| Rate limits | Single user — handle `429 retry_after`, nothing more |
| Idempotency | Persist the polling offset so a restart cannot replay "create task" messages |
| Library | grammY (thin, TS-native), confined to `interfaces/telegram/` |

A reply to the user's own message is the interface response, not an
EXECUTE side effect. Messages Jarvis sends **unprompted** (reminders,
proactive notices) are EXECUTE actions and go through the gateway.

## Agent / Skill model

Decision: **no separate Agent runtime abstraction now.** Core + Skills
already give each capability a purpose, contract, permission scope, and
risk category (`docs/agents/README.md`). An agent runtime earns its place
only when a capability needs multi-step autonomous reasoning (a real
Research Agent). Until then "agent" stays the permission identity
(`jarvis-core`), and specialists are skills.

## Proactivity

The existing design (trigger → condition → priority → cooldown →
notification → permission → confirmation) is sound. Do not build the
general engine yet. Build its **first concrete instance**: reminder
delivery (F8) — the one proactive behavior the user has already been
promised by the system ("remind me tomorrow at 10").

Minimal shape (Build 5): an in-process poller (no Redis/pg-boss) selects
`reminders WHERE status=PENDING AND remindAt <= now`, atomically flips each
to `SENT` (conditional update — no double delivery across restarts or two
processes), and sends through a gateway action `notify.telegram /
SEND_NOTIFICATION` (EXECUTE, seeded ALLOWED only for the principal's own
chat). Quiet hours and cooldown are fields on that one handler, not a
framework. Generalize into a Proactive Engine only when a second trigger
type (calendar warning) is built.

## Privacy classification

Needed before the BlackOS bridge and before proactive notifications show
content on a lock screen — not before Telegram or Gmail.

- **Where**: `Memory` (column) and `KnowledgeDocument` (Markdown
  front-matter `privacy:`). Structured entities default to `PERSONAL`
  implicitly; add a column only when one of them must cross a boundary.
- **Enum (proposed)**: `PERSONAL` (default), `SENSITIVE` (health, finance,
  relationships — never bridged, never in notification previews),
  `BUSINESS_SHAREABLE` (explicit opt-in only).
- **Propagation**: derived data inherits the most restrictive source.
  Automatic changes may only increase restriction; downgrades only by an
  explicit principal action, audited.
- **Bridge check**: default-deny; only `BUSINESS_SHAREABLE` may cross, and
  only through the Business Jarvis Gateway.

## Memory deletion (minimum safe design)

- Two operations, both skill actions through the gateway:
  **retract** (soft: `status=RETRACTED`, excluded from retrieval, content
  kept for the user's own review) and **delete** (hard: row removed).
- Delete is `WRITE` with `APPROVAL_REQUIRED` → depends on Build 6.
- Audit records `memoryId` and type, never content.
- No derived indexes exist today, so no cascade. When embeddings are ever
  added, vector removal must happen in the same transaction as the row.
- Knowledge documents are user-edited files; deletion is a file operation
  by the user, not a Jarvis action.

## Permission inspection

A read-only skill `system.permissions` (action `READ`, seeded ALLOWED)
returning the principal's permission rows joined with skill names and
connection statuses, plus a Jarvis intent ("what can you do?", "what
permissions do you have?"). Answers come from the database, not from
documentation. Small, zero risk, fits the existing pattern exactly.

## BlackOS boundary

The placeholder (`gateway/bridge/index.ts` + `docs/integrations/
business-jarvis-gateway.md`) is **sufficient as a contract**: it forbids
direct DB/graph access, requires Connector + Skill + Gateway mediation,
credential-store authentication, narrow read-only capabilities, and
personal-data default-deny. Missing requirements to add when built:
per-request identity (which principal asked), rate limiting on both sides,
request/response audit on both sides, data minimization (BlackOS returns
summaries, not rows), and the privacy classification check above.

## Security analysis (delta from existing docs)

Existing guarantees hold (see `docs/SECURITY.md`). New items from this
audit: F1 (ungated context reads), F2 (approval expiry), F7 (error text
leakage), F9 (ungated audit/approval reads). F1 and F7 must be fixed
before any conversational interface that is not localhost-only.

## Research validation

All prior decisions remain valid. No new evidence justifies Neo4j,
Graphiti, Mem0-by-default, Letta, or LangGraph. One refinement: the
action-handler registry from Build 6 doubles as the **tool catalog** a
future LLM planner would use for tool calling (each handler already has a
name, category, and Zod schema) — the same structure serves the gateway
and the planner, so adopting LLM tool-calling later needs no framework.
grammY remains the Telegram recommendation.

## Answers to the required questions

1. **Keep exactly as is**: the gateway permission model, fail-closed
   default, audit semantics, principal scoping, atomic approval decision,
   Skill pattern, connector/credential/OAuth-state design, Postgres-only
   memory, the BlackOS contract.
2. **Improve**: F1–F9, in the build order below.
3. **Single highest-leverage next build**: Telegram inbound adapter
   (Build 4), with its small prerequisite patch.
4. **Its dependencies**: F1, F4, F5, F6, F7 fixed first (all small,
   no schema change); a bot token; nothing else.
5. **Do not build yet**: see the list at the end.
6. **Next 5 builds**: below.
7. **Architecture after them**: diagram below.

## Dependency-aware roadmap

```
Build 4  Telegram inbound adapter  (+ prerequisite patch F1 F4 F5 F6 F7, permission inspection)
   │       reachable from the phone; every existing skill usable
   ▼
Build 5  Reminder delivery          (in-process poller + gateway-mediated outbound notify)
   │       first proactive behavior; reminders stop being inert (F8)
   ▼
Build 6  Deferred action execution  (handler registry, stored params, expiry F2,
   │                                 consume-and-execute, Telegram approve/reject buttons)
   │       APPROVAL_REQUIRED becomes real; memory retract/delete ride on it
   ▼
Build 7  Gmail                      (read, draft = WRITE, send = EXECUTE + approval;
   │                                 incremental scopes; preview in Telegram)
   ▼
Build 8  Privacy classification     (Memory + KnowledgeDocument; prerequisite for
                                     content-bearing notifications and the bridge)
```

Why this order and not "approval engine first": nothing implemented today
requires approval, so building Build 6 first would be infrastructure with
no consumer — the pattern this project has avoided every time. Telegram
first gives Build 6 its natural UX surface (approve buttons), and Build 5
proves the gateway-mediated outbound path Build 6 and Gmail will reuse.

## Architecture after Build 8

```
Telegram (polling) ─┐                         ┌─ Poller (reminders) ─┐
HTTP API ───────────┼─► JarvisCore.handle ─────┤                      │
                    │    router → planner       │                      ▼
                    │         ▼                 │            gateway action notify.telegram
                    │   Skills (tasks, memory,  │
                    │   decisions, calendar,    │
                    │   gmail, permissions)     │
                    │         ▼                 │
                    └──► Gateway: checkPermission ─ ActionHandlerRegistry (Zod schemas)
                              ├ DENIED → audit
                              ├ APPROVAL_REQUIRED → ApprovalRequest(full params, TTL)
                              │       └ Telegram buttons → executeApproved (one-time)
                              └ ALLOWED → handler(stored/validated params) → audit
                                      ▼
                    Postgres · MemoryProvider(+privacy) · CredentialStore · Google (Calendar, Gmail)
                    [Business Jarvis Gateway: still a contract, not code]
```

## Explicitly NOT to build yet

- LLM-based planner / tool calling (after Build 6, on its registry)
- Agent runtime abstraction, Research Agent
- Neo4j, Graphiti, Mem0 by default, vector search
- General Proactive Engine (only reminder delivery)
- Calendar write, Gmail auto-send, any auto-execution of approval-gated actions
- Business Jarvis Gateway / any BlackOS connectivity
- Telegram webhook mode, web frontend, multi-user, retries framework, job queues, n8n

## Final question

*Smallest next implementation with the greatest increase in real Chief
of Staff capability at minimal architectural risk?*

**A Telegram inbound adapter (`interfaces/telegram/`, long polling, one
allowlisted Telegram user mapped to the existing principal) that turns
each message into `JarvisCore.handle({principalId, input})` and replies
with the `Result`, preceded by a small patch set: remove or gate the
discarded context call (F1), fix reminder-intent routing (F4), filter
expired memories and label unconfirmed inferences (F5), use
`Principal.timezone` for "today" (F6), and replace raw error text with
sanitized messages (F7).**

Technically: every capability Angel OS has today — tasks, reminders,
memory, decisions, calendar — is reachable only through `curl` against
localhost. The adapter changes *reach*, not *power*: it adds no new
permission, no schema change, no new side-effect class (replying to the
sender is the interface response, not an EXECUTE action), and no Core
change, because `JarvisCore.handle` already is the transport-agnostic
boundary. Its risk surface is exactly three things — the bot token
(a secret from env), sender identity (allowlist), and message replay
(persisted offset) — each small and testable. The prerequisite patches
are required precisely because a real conversational channel makes F1,
F5, and F7 user-facing: guesses must not be presented as facts, and raw
errors must not reach a chat. Everything after it (reminder delivery,
approvals, Gmail) builds on the channel this creates.
