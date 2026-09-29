# Life OS — structure (BUILD #12)

Vision → Goal → Project → Quest → Task, plus People and project links.
Decision records, Results and Reviews are BUILD #13.

## Rules
- **Owner-scoped everywhere.** Every row carries `principalId`; every store query filters by it in the same statement.
- **References are same-principal, enforced twice.** The store checks ownership up front (clean "wasn't found", identical for missing vs foreign);
  the `life_owner_guard` trigger rejects any cross-principal FK on goals, projects, quests, tasks, decisions, project_people and project_knowledge,
  whatever wrote the row. `principalId` is immutable (`life_immutable_guard`).
- **Terminal states are final** (DB trigger + conditional updates): goal ACHIEVED/ABANDONED, quest COMPLETED/ABANDONED, task DONE/CANCELLED,
  project ARCHIVED, vision ARCHIVED never reopen. CHECKs tie `closedAt`/`completedAt` to the status.
- **Transitions are atomic**: `updateMany where {id, principalId, status in allowedFrom}`; racing completions produce exactly one winner and one Activity row.
- **Nothing is inferred.** Completion and achievement are the owner's claims; quest `criteria` are required and explicit; the overview exposes plain
  task counts, never a progress score.
- **Writes are ActionDefinitions** (strict Zod schemas, no client principal). LOW: create/update/close/link. SENSITIVE: `PERSON_DELETE` (approval on every interface).
  Voice needs approval for LOW writes (interface policy). Reads use `LIFE_READ` through the READ lane.
- **Activity** (references only): TASK_COMPLETED, ACHIEVEMENT (goal), QUEST_COMPLETED.
- **Context**: `activeGoals` / `activeProjects` sections, `withheld: ["life"]` without `LIFE_READ`.

## Known limits
- Deleting a person nulls task links and removes project links (tasks are kept).
- Decisions still have no writer (BUILD #13).
- Existing databases need `npm run db:seed` for the new permissions before startup verification passes.

# Decision records, results and reviews (BUILD #13)

- **Decision = history.** `DECISION_RECORD` (system.decisions, LOW) stores title, question, options (≥2, at most one chosen), decision, reasoning,
  `expected` (a prediction), `reviewAt` and evidence. Content is immutable (DB trigger `decision_history_guard`); changing your mind records a NEW
  decision that supersedes the old one (a decision can be superseded once; chains are same-principal).
- **Evidence** references the owner's memory / knowledge item / task, or is a free NOTE. The snapshot `label` is copied from the OWNED row by the
  server — never supplied by the client — so a record stays readable if the referenced row is later deleted. A reference is not an upgrade:
  an INFERENCE memory used as evidence stays an INFERENCE.
- **Look-back.** `DECISION_REVIEW` sets `outcome`/`lesson`/`reviewedAt` exactly once (atomic `where reviewedAt is null`, backed by a trigger).
  `expected` is never rewritten, so prediction vs reality stays comparable. `DECISION_READ` lists decisions due for review.
- **Results** (`RESULT_RECORD`, system.life): append-only owner statements about a goal / project / quest / decision, with an optional measurement
  that needs both `value` and `unit`. Nothing is computed.
- **Reviews** (`REVIEW_CREATE`): the owner's words plus a `facts` snapshot of plain counts computed server-side from the principal's own rows
  (tasks completed, quests completed, goals achieved/abandoned, decisions recorded/reviewed, results recorded). Clients cannot supply facts.
  Period ≤ ~3 months, immutable.
- **DB integrity:** `polymorphic_owner_guard` (evidence/result subjects), `append_only_guard` (options, evidence, results, reviews),
  a partial unique index for one chosen option, owner guards on supersession/options/evidence.
- Known limit: Activity has a `DECISION` type only; results and reviews record none.

# Future Self (BUILD #14)

CURRENT → GAP → DESIRED → NEXT, in the owner's words (`Aspiration`), with evidence-only progress (`Metric`, `MetricReading`).
- **No XP, no stored score.** Progress = `(latest − baseline) / (target − baseline)`, clamped to [0,1], computed on read by the pure `future/progress.ts`
  (works for "lower is better" too). Latest is by observation time; a later worse reading lowers progress. With no readings progress is `null`
  ("no evidence yet"), never 0; an aspiration's progress is the mean over metrics that HAVE evidence.
- **No moving goalposts.** Baseline and target are fixed at creation (`metrics` is append-only; no update action; baseline ≠ target).
- **The owner closes, not the maths.** Reaching 100% is informational (`targetReached`); ACHIEVED / RELEASED are explicit owner actions, final, one winner under races.
- **Evidence chain.** ACTION (task/quest) → RESULT (`RESULT_RECORD`) → METRIC reading (`resultId`, owner-checked) → derived PROGRESS. Readings can't be from the future, and closed aspirations take no readings.
- **Isolation:** store ownership checks + DB triggers (`life_owner_guard`, `append_only_guard`, terminal-state guard) as in Life OS.
- **Skill** `system.future` (`FUTURE_READ`; ASPIRATION_CREATE/UPDATE/ACHIEVE/RELEASE, METRIC_CREATE, METRIC_READING_RECORD — all LOW; voice needs approval).
- **Context** gets `activeAspirations` (`withheld: ["future"]` without permission).

# Learning Lab (BUILD #15)

Topics (`LearningTopic`), self-reported study sessions, and recall cards with an append-only review history.
- **Derived, never stored.** What is due, a card's interval, ease, lapses and streak come from `learning/schedule.ts` — a pure SM-2 variant over the review
  history with the clock injected. No score, XP, streak reward or "mastered" flag exists anywhere; overviews are counts (minutes in the last 7/30 days, cards, due, never reviewed).
- **Honest inputs.** Sessions (1–720 whole minutes) and grades (0 again … 3 easy) are the owner's own reports; neither may be dated in the future; both tables are append-only (DB trigger).
  Sessions record Activity `LEARNING_SESSION` by reference (the note is not copied).
- **Owner-authored cards.** Prompt and answer are written by the owner; a card may reference an owned knowledge item as its source. Nothing here generates content.
- **Lifecycle.** Topic ACTIVE ⇄ PAUSED → COMPLETED (owner's claim, final; can't complete twice). Cards ACTIVE → RETIRED (final, no more reviews). Sessions and new cards need an ACTIVE topic; paused/completed topics' cards are not due.
- **Isolation.** Same as the rest of Life OS: store ownership checks + `life_owner_guard` / `life_immutable_guard` / `append_only_guard` triggers.
- **Skill** `system.learning` (`LEARNING_READ`; TOPIC_CREATE/UPDATE/SET_STATUS, SESSION_LOG, CARD_CREATE/REVIEW/RETIRE — LOW; voice needs approval). Context gets `activeLearning` (`withheld: ["learning"]`).
- Known limit: session minutes are unverifiable self-reports; they are shown as such ("self-reported") and never rewarded.

# Jarvis orchestration (BUILD #16): the model proposes, the OS enforces

```
explicit identity → permission-aware context (data) → ModelProvider (UNTRUSTED)
   → parseModelOutput (strict, capped, deduped) → skills/system/jarvis.proposeFromModel
   → proposeAction: permission · interface policy · risk policy · approval · exact binding · audit → real Results
```
- **The model port is inert.** `ModelProvider.propose(input, signal)` receives `{userText, context, tools}` — no principal id, no identity, no handle to the
  database, the gateway or approvals — and returns raw JSON that is never trusted. The context is the same permission-aware package as everywhere (data, not instructions).
- **Proposals are exactly `{skillKey, action, parameters}`.** Any extra key (principalId, identity, approvalId, force, …) invalidates the proposal; at most 5 per turn,
  deduplicated, size-capped. Only registered ActionDefinitions are proposable — reads, approvals, decisions and unknown names are ignored **and audited**
  (`ACTION_REJECTED`, source `jarvis.orchestrator`, reason only — parameters are never copied to audit).
- **Nothing is special-cased for a model.** A proposal goes through `proposeAction` like a human's: strict schema (no client principal), permission (denied → DENIED),
  interface policy (voice → approval), SENSITIVE → pending approval that only the owner can decide. A prompt-injected memory can make an obedient model *propose*
  a deletion; it cannot make it happen.
- **Honest outcomes.** The user-visible lines (✓ / ⏳ / ✗) are written from real Results *before* the model's own words, which are labelled "Jarvis says:". The overall status
  is derived from the Results, never from the model's claim. Model failure/timeout → a fixed safe message, nothing changed, audited.
- **Opt-in.** Core uses `NullModelProvider` by default (behaviour unchanged). A provider is consulted only for input the deterministic router did not understand, and only with an identity.
- **Not built (needs a human decision):** a concrete LLM adapter (API key, network egress, spend). The port, validation and enforcement are model-agnostic and tested with scripted models.
- Model-initiated *reads* are not offered this build: the model gets the context package; extra retrieval would need its own read tool with the same READ-lane checks.

# Connectors and automation (Phase H — assessed, one defect fixed)

**Assessment.** No backend feature needs a generic automation/connector framework: the only automation is the reminder worker (atomic claim, lease, fence, DeliveryPort — already sound),
and the only connector is read-only Google Calendar behind the credential store, the connection service and the READ lane. Building a rules/automation engine now would add attack
surface with no consumer, so it is deliberately **not** built. New connectors/automations stay a future decision, and would each need their own ActionDefinitions, permissions and approval policy.

**Fixed (BUILD #17): concurrent token refresh.** Two calendar reads that both saw an expired token used to both call the provider's refresh endpoint; with rotating refresh tokens the second
call is rejected and the connection was wrongly marked ERROR. Refresh is now single-flight per connection (`connectors/service/refreshLock.ts`): an in-process shared promise plus a
transaction-scoped Postgres advisory lock (auto-released on commit/rollback/disconnect), and the caller re-reads the credential after acquiring the lock so a refresh done elsewhere is reused.
Failure is reported to every waiting caller, the connection is marked ERROR once, and the lock is never left held. Still accepted debt: the refresh remains a maintenance write inside the READ lane.

# Hardening pass (BUILD #19): READ skills take an identity, not a principalId

The legacy READ skills (`listTasks`, `listReminders`, memory `search`/`getMemoryById`/`memoryHistory`, `listActivity`/`summarizeActivity`, `queryDecisions`, and the four calendar reads)
used to take `{principalId, agentKey}`. They now take `(identity: IdentityContext, {agentKey, …})` and derive the principal only from the validated identity
(`skills/readerIdentity.ts`): a missing or malformed identity fails closed before anything is read or audited, and a smuggled `principalId` is overridden.
Jarvis Core follows: every read intent requires an identity, and a request whose `principalId` disagrees with its identity is refused. A boundary test now forbids any
`principalId` field in a skill input type. Debt removed: "legacy READ skills taking principalId and agentKey" (the `agentKey` is still a parameter of the READ lane by design).

# Hardening pass (BUILD #20): outbound Telegram replies are audited

Everything Jarvis sends to Telegram (replies, help, `/pending`, approval results, invalid buttons) now leaves an audit row — `INTERFACE_REPLY_SENT` / `INTERFACE_REPLY_FAILED`
(resource `interface:telegram`, source `interfaces.telegram`) with the **principal**, the reply **kind**, size, button count, request id and a 16-hex **content hash** — never the text and never
the chat id. The adapter labels each reply with who it is for; the poller reports the outcome to an injected `OutboundAudit` (interfaces still have no database access), implemented in
`application/outbound.ts` and wired in `scripts/telegram.ts` (a test fails if the composition root stops wiring it). Nothing is sent to — or audited for — unlinked senders, group chats or ignored updates.
Auditing is after-the-fact and best-effort: a failing audit is logged and never blocks, duplicates or hides a reply (a send that fails is recorded as FAILED and the poll loop continues).
Reminder deliveries were already audited by the reminder engine. Debt removed: "Telegram outbound replies unaudited".
