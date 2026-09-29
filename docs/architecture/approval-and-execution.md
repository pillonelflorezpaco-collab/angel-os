# Approval & Execution Engine (Build #6)

> LLM/Core **proposes** → Gateway **permits** → the user **approves** → only the execution layer **acts**.

## PROPOSE vs APPROVE vs EXECUTE

| Step | Who | Code | Effect |
|---|---|---|---|
| PROPOSE | Jarvis Core / a skill / a test | `proposeAction(identity, {skillKey, action, parameters})` | validates params, checks permission, applies interface policy; either runs directly (read-only / low-risk) or stores a PENDING approval. **Nothing sensitive runs.** |
| APPROVE | the human, via GuideHub/API/Telegram | `decideApproval(identity, id, "APPROVED" \| "DENIED")` | `PENDING → APPROVED` (or `DENIED`) |
| EXECUTE | the execution layer only | `executeApproval` (called by approve) | claims `APPROVED → CONSUMED`, then runs `ActionDefinition.execute` with the **stored** parameters |

Approving therefore *includes* execution, but as a separate, guarded step: a
failed or refused execution never looks like success (`executed: false`).

## State machine

```
PENDING ──approve──► APPROVED ──claim+execute──► CONSUMED   (terminal)
   │                    │
   ├──deny──► DENIED    └──expire──► EXPIRED                  (terminal)
   └──expire─► EXPIRED
```

Terminal: DENIED, EXPIRED, CONSUMED. Same table in `gateway/approvals/state.ts`
and in a Postgres trigger (`approval_requests_guard`), which also makes the
bound fields immutable (principal, agent, skill, resource, action, parameters,
hash, expiry, request time, creating interface/request id).

## Expiry

Every approval has `expiresAt` (default 15 min, or `ActionDefinition.approvalTtlMs`),
computed from `gateway/clock.ts`. It is enforced:
* on **read** (`listPendingApprovals`, `getApproval`): stale rows are moved to EXPIRED (audited once) and hidden;
* on **decision**: `expireIfStale` first, plus `expiresAt > now` in the `UPDATE ... WHERE`;
* on **execution**: same checks at the claim.

`expiresAt <= now` is expired (boundary is exclusive). `expireStaleApprovals(now)`
is an optional sweep for a future worker; correctness never depends on it.

## Exact action binding

At proposal the parameters are parsed with the definition's **strict** Zod schema
(unknown keys rejected). The validated object is stored with
`payloadHash = SHA-256(canonical{principalId, skillKey, resource, action, parameters})`
(sorted keys at every depth). At execution the row is re-hashed and re-parsed;
any mismatch → nothing runs (`ACTION_DENIED: integrity_check_failed`). Decision
endpoints accept **no parameters** (a non-empty body is a 400). A repeated
identical proposal returns the same pending approval (partial unique index on
`(principalId, payloadHash) WHERE status='PENDING'`).

## Execution flow (`gateway/execution.ts`)

1. load the row `WHERE id AND principalId` → not found = "Approval not found."
2. lazy expiry; already CONSUMED → "Approval already consumed."
3. definition lookup; integrity re-hash + re-validate
4. **permission re-check** (a revoked permission wins; approval never overrides it)
5. **claim**: `UPDATE ... SET status='CONSUMED', executionStatus='STARTED' WHERE id AND principalId AND status='APPROVED' AND expiresAt > now` — exactly one caller gets count 1
6. audit `APPROVAL_CONSUMED`, `ACTION_EXECUTION_STARTED`
7. run `execute(ctx, storedParams)`; `ctx.idempotencyKey` = approval id
8. audit `..._SUCCEEDED` / `..._FAILED`; set `executionStatus`

### Idempotency and its limits
Duplicate HTTP/Telegram deliveries, double taps and concurrent calls cannot run
an action twice (step 5). Execution is **at-most-once, not exactly-once**: a
crash after step 5 leaves `executionStatus = STARTED` and the action is *not*
re-run automatically (a possibly-duplicated irreversible action is worse than a
missed one the user can re-request). Providers that support idempotency keys
must be given `ctx.idempotencyKey`.

## Interface policy (`gateway/policy.ts`)

| | READ | LOW write | SENSITIVE | DANGEROUS |
|---|---|---|---|---|
| GuideHub / Web / Mobile / API / Telegram | direct | direct | approval | approval |
| Voice | direct | approval | approval | refused |

`EXECUTE` is never treated as low. Policy only **tightens** the permission table
(`APPROVAL_REQUIRED` always means approval; `DENIED` is never relaxed). Approving
is additionally gated: **voice cannot approve SENSITIVE/DANGEROUS** actions (403),
though it may deny. An approval can be proposed on one interface and approved on
another (`interfaceSource` vs `decidedVia` are both recorded).

## Interfaces

* **API (v2)**: `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve|deny` — see `docs/api/README.md`.
* **Telegram**: an approval-needed result is shown with inline ✅ Approve / ❌ Deny buttons whose callback data is only `apv:<id>:a|d`; `/pending` lists the caller's pending approvals. Presses are resolved to a principal from Telegram's `from` (linked private chats only; groups, bots and unlinked accounts are ignored silently). The adapter imports only `application/`, `identity/`, `core/` — no gateway/DB.
* **Voice**: an approval-needed result is spoken as "needs your approval … I haven't done anything yet"; voice never approves sensitive actions.

## Layers

`interfaces/*` → `application/{dispatcher,approvals}` → `gateway/{approvals/service, execution}` → `ActionDefinition` (registry). `tests/interfaces-boundary.test.ts` enforces that adapters have no DB/skills/gateway imports and `application/` has no DB/skills/connectors imports.

## Audit vs Activity

Audit gets every lifecycle event (`APPROVAL_CREATED/APPROVED/DENIED/EXPIRED/CONSUMED`, `ACTION_EXECUTION_STARTED/SUCCEEDED/FAILED`) with principal, interface, request id — never parameters or raw errors. **Activity** (user life-history) is untouched: it is written only by real skills when something meaningful happens; the test actions write none.

## Build #7 additions
* The legacy closure path is READ-only (plus a two-entry temporary allow-list) — see `reminders-and-delivery.md` §A.
* Production definitions exist and are registered by `skills/manifest.ts`: `CREATE_REMINDER`, `remember` (`MEMORY_WRITE`).
* SYSTEM is policy-stricter than voice and can never approve. A permission row's category must match the definition's category.
* Success-audit failure → `EXECUTED` + `auditUnconfirmed`; start-audit failure → nothing runs.

## Known limitations
* Only reminders and `remember` are ActionDefinitions; `CREATE_TASK` and memory update/remove/confirm remain on the temporary legacy allow-list. Gmail should be born as an `ActionDefinition`.
* Nothing proposes approvals from natural language yet (Core has no such intent); tests use `proposeAction` directly.
* Legacy (pre-Build-#6) approvals were expired by the migration; a legacy `APPROVED` row fails the integrity check and cannot execute.
* Approval TTL is per definition, not user-configurable; no worker runs the optional expiry sweep; no execution timeout.
* Telegram buttons are not removed after use (a repeat press safely answers "already consumed").
