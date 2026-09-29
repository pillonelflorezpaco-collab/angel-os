# Reminders, SYSTEM identity and delivery (Build #7)

## A. Two execution paths, one direction of travel

| | Legacy closure path | ActionDefinition path |
|---|---|---|
| Entry | `gatewayExecute(request, closure)` | `proposeAction(identity, {skillKey, action, parameters})` |
| Who may call it | `skills/` only (boundary-tested) | `skills/` only |
| Categories | **READ**, plus the temporary allow-list below | any; risk-classified |
| Interface policy / approval | none | yes (`gateway/policy.ts`, approval engine) |
| Parameters | closure-captured (not stored) | strict schema, hashed, stored, immutable |
| Audit | `ACTION_EXECUTED / FAILED / DENIED` | `ACTION_EXECUTION_*`, `APPROVAL_*` |

`gatewayExecute` now **fails closed**: an `APPROVAL_REQUIRED` permission, an `EXECUTE` (or unknown/missing) category, and any `WRITE` not on the allow-list are refused with `ACTION_DENIED (legacy_path_non_read)` and the closure never runs.

### The allow-list is gone (Build #8)
Build #7 kept a two-entry temporary write allow-list (`CREATE_TASK`, `MEMORY_WRITE`). Build #8 migrated both to ActionDefinitions and **deleted the allow-list**: `gatewayExecute` is a READ-only compatibility lane. See `consolidation-build8.md`.

## B. ActionDefinitions in production
`skills/manifest.ts` (`registerSkillActions()`) registers all production definitions (Build #8: `CREATE_TASK`, `CREATE_REMINDER`, `MEMORY_CREATE/UPDATE/CONFIRM/DELETE`). It is called by every composition root (`api/server.ts`, `scripts/telegram.ts`, `scripts/worker.ts`) and by Jarvis Core, so an approval decided in any process finds its definition. Both are WRITE/LOW: **direct** on GuideHub/API/Telegram, **approval** on voice.

## C. SYSTEM identity (`identity/system.ts`)
A normal `IdentityContext` (frozen, in AsyncLocalStorage) with `interfaceSource: "SYSTEM"`, `authMethod: "system"`, bound to **one explicit principal** (`ANGEL_OS_SYSTEM_PRINCIPAL_ID`). It cannot be built without a principal, no API token or external link can carry the SYSTEM interface, and every existing guard applies unchanged (the gateway refuses actions for any other principal; audit/activity rows are stamped `SYSTEM` + the job's request id). Policy treats SYSTEM like voice, stricter: writes need approval, dangerous actions are refused, and SYSTEM can **never approve**. Background code calls `requireSystemIdentity()` and refuses to run otherwise.

## D. Reminder creation
`Core/API → createReminder(identity, …) → proposeAction → CREATE_REMINDER`. Parameters are `{message ≤500, remindAt: exact UTC instant, taskId?}` (strict). "Tomorrow at 10" is resolved in the **principal's timezone** to one exact instant *before* proposing, so an approval binds one exact time. `taskId` must belong to the same principal. Voice: proposal → approval request → (GuideHub/Telegram/API approves) → exactly one reminder with exactly the stored parameters; deny/expiry create nothing.

## E. Reminder delivery
```
SYSTEM worker (scripts/worker.ts)  ─ separate process, no HTTP
  → ReminderEngine.tick()          (runAsSystem, configured principal only)
  → claim (atomic)                 reminders/claim.ts
  → audit REMINDER_DELIVERY_STARTED (required: if it can't be written, nothing is sent)
  → markSendStarted                (fence: after this a crash means "unknown")
  → DeliveryDispatcher → DeliveryPort → (Telegram Bot API)
  → persist result → audit → Activity (only on a real delivery)
```
## F. DeliveryPort (`application/delivery.ts`)
`deliver({principalId, message, idempotencyKey, correlationId}) → DELIVERED | FAILED{code,retryable} | UNCONFIRMED{code}`. A request carries **no destination**: the port finds it from the principal's *linked* accounts (Telegram: the oldest active link; validated as a numeric id). Only `interfaces/telegram/delivery.ts` implements it today; the engine and skills know nothing about Telegram. The dispatcher falls through to the next port only on `NO_DESTINATION` — never after an unknown outcome.

## G. Worker lifecycle
`npm run worker` (env: `ANGEL_OS_SYSTEM_PRINCIPAL_ID`, `TELEGRAM_BOT_TOKEN`, optional `ANGEL_OS_WORKER_INTERVAL_MS`). Polls every 15 s; each tick first sweeps stale sends, then handles up to 25 due reminders; errors are logged and the loop continues; SIGINT/SIGTERM finish the in-flight reminder, then exit.

## H. Claim / lease semantics
```
PENDING ─claim(lease 2 min, attempts+1)─► CLAIMED ─► SENT
   ▲            │  ├ retryable failure (backoff 30s·2ⁿ, ≤15 min, ≤5 attempts) ─► PENDING
   │            │  ├ definite failure / attempts exhausted ─► FAILED
   │            │  └ outcome unknown ─► UNCONFIRMED   (never re-sent)
   └ lease expired and send NEVER started (worker died before the channel call)
     lease expired AFTER send started ─► UNCONFIRMED (not re-sent)
```
The claim is one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING …`; `deliveryAttempts` is the fence token so a superseded worker cannot record a result. Dismissed/sent/failed/unconfirmed rows are never claimed.

## I. Idempotency — and its limits
Internally at-most-once: durable state, one claimant, `reminder:<id>` idempotency key, and no automatic re-send once a send started with an unknown outcome. **Exactly-once external delivery is not achievable**: Telegram has no idempotency key, so a message can be delivered while our confirmation is lost; that case is recorded as `UNCONFIRMED` (or `DELIVERED_UNPERSISTED` → swept to `UNCONFIRMED`) rather than pretended. The trade-off is deliberate: a possibly-missed reminder is visible and inspectable; a silent duplicate is not.

## J. Audit vs Activity
Audit (security/system trace): `REMINDER_DELIVERY_STARTED/DELIVERED/FAILED/UNCONFIRMED` per attempt, `ACTION_EXECUTION_*` for creation — never message text, chat ids or tokens. Activity (life history): one `REMINDER_DELIVERED` row per real delivery, referencing the reminder id; retries and failures never create Activity. Audit truthfulness: if an action ran but its audit row can't be written, the result is `EXECUTED` + `auditUnconfirmed` (never "failed"); if the *start* audit can't be written, nothing runs.

## K. Voice approval policy
READ direct · LOW write → approval · SENSITIVE → approval · DANGEROUS → refuse. Voice `remember` and voice `CREATE_REMINDER` therefore create nothing until approved elsewhere (or by voice, for LOW risk only).

## Identity administration audit
`TOKEN_CREATED/REVOKED`, `IDENTITY_LINKED/UNLINKED` with actor, principal, target interface, token/link id, outcome — never the token, its hash, or the external account id.

## Known limitations / not yet migrated
* One channel (Telegram), first linked account only; no quiet hours, snooze or recurring reminders.
* **The real Telegram API has never been exercised**: the Bot API client, the delivery port and the worker are tested against fakes only (no bot token was available). Verify with a real bot before relying on it.
* **Spring-forward gaps:** a local time that does not exist (e.g. 02:30 on the US spring-forward day) resolves deterministically to the *previous valid instant* (01:30 local) — the reminder fires an hour EARLY, not late. Ambiguous fall-back times resolve to one of the two valid instants.
* **First worker start:** every already-overdue `PENDING` reminder for the configured principal (including ones created before Build #7) is delivered in the first ticks, each noting when it was due.
* The Google Calendar token refresh (an external POST plus a credential-store rewrite) still runs inside a READ-permission closure (`skills/integrations/calendar.ts`); only its failures have a dedicated audit event.
* `GET /api/audit` and `GET /api/approvals*` are still direct reads (not gateway-mediated) and the GuideHub API envelope is still inconsistent — both deferred.
* The worker is a single polling loop (no leader election needed thanks to the atomic claim, but no metrics).
