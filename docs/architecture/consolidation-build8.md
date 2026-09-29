# Build #8 — Core security consolidation

Scope: remove the execution and identity ambiguities found by the architecture map audit (a3b5b42).
No new product features; no Knowledge OS, Memory graph, Mem0, GuideHub, Gmail, finance or BlackOS work.

## 1. One execution model

| Mechanism | What it may do now |
|---|---|
| `gatewayExecute` (legacy closure) | **READ only.** WRITE, EXECUTE, APPROVAL_REQUIRED and unknown categories are refused. There is **no allow-list** any more. |
| `proposeAction` + `ActionDefinition` | Every mutation. Explicit identity, strict schema, permission + category match, interface/risk policy, approval, exact binding, audit. |

Production ActionDefinitions (`skills/manifest.ts`):

| Action | Skill / resource | Risk | Voice | Notes |
|---|---|---|---|---|
| `CREATE_TASK` | `system.tasks` / `angel:tasks` | LOW | approval | migrated from the legacy allow-list; no Activity (no task-created activity type exists) |
| `CREATE_REMINDER` | same | LOW | approval | Build #7 |
| `MEMORY_CREATE` | `system.memory` / `angel:memory` | LOW | approval | was `MEMORY_WRITE` (remember) |
| `MEMORY_UPDATE` | same | SENSITIVE | approval, cannot approve | new |
| `MEMORY_CONFIRM` | same | SENSITIVE | approval, cannot approve | new |
| `MEMORY_DELETE` | same | SENSITIVE | approval, cannot approve | new; hard delete |

`MEMORY_WRITE` no longer exists. A migration (`split_memory_write_permission`, data only) renames existing `MEMORY_WRITE` grants to `MEMORY_CREATE`; update/confirm/delete get **no** automatic grant (re-run `npm run db:seed` for the seeded principal, which grants them as `APPROVAL_REQUIRED`). SENSITIVE always needs approval whatever the permission row says; SYSTEM and voice can never approve. Ownership is enforced inside execution by the principal-scoped provider methods: another principal's memory id is "That memory wasn't found." and nothing changes. No public route or Core intent exposes update/confirm/delete.

## 2. Identity rule
**`IdentityContext` is the authoritative caller identity.** For every mutation it is an explicit, mandatory argument (`assertExplicitIdentity` validates it at runtime); the principal is derived from it and there is no independent `principalId` input. ALS (`currentIdentity()`) is never authority: it stamps audit/activity and is used only to detect a *conflicting* caller (an ambient identity for a different principal → the mutation is refused and the conflict audited against the ambient principal). No identity → `FAILED`, no state change, no approval, no side effect. Legacy READ skills still take `principalId` + `agentKey` (temporary; READ only, guarded by the ALS mismatch check when an identity is in scope).

## 3. Knowledge boundary
`Caller (explicit identity) → skills/system/knowledge.ts → gatewayExecute (READ, agent-scoped, audited) → KnowledgeProvider`. Permission `system.knowledge / angel:knowledge / KNOWLEDGE_READ`. The provider does no authorization and imports nothing from gateway/identity/skills/db; only the knowledge skill imports it (boundary-tested). **Limitation:** the documents are still three global files — the *permission gate* is per principal, the *content* is not.

## 4. Context boundary
`DeterministicContextEngine.buildContext({identity, agentKey, query})` requires an explicit identity (`IdentityRequiredError` otherwise), derives the principal from it, and reads only through skills (tasks, memory, knowledge). Denied sections are listed in `withheld` (now including `knowledge`). It has no DB access and cannot import the knowledge provider. It is still **not wired into Jarvis**; no ranking, embeddings or token budgets were added.

## 5. Action parameters
One canonical representation: the **schema-validated parameters**. For ActionDefinitions they are stored in the approval row, hashed (`payloadHash`), re-validated at execution and used by the executor (unchanged from Build #6). For READ-lane requests `ActionRequest.parameters` are fingerprinted in audit as the same canonical `payloadHash` — never stored raw (a read query can be user content). The field is no longer dead.

## 6. Registration invariant (hardened in 8.2)
`registerAction` rejects incomplete definitions (missing skill/action/resource/agent, invalid category/risk/TTL, missing schema/describe/execute, or a risk policy that would run a non-LOW/EXECUTE action directly), and **a duplicate key always throws** — `registerSkillActions()` registers once per process (idempotent across composition roots) and never skips or shadows a key. `verifyProductionActions()` (API listen path, `scripts/telegram.ts`, `scripts/worker.ts`) verifies, **for the configured production principal** (`ANGEL_OS_SYSTEM_PRINCIPAL_ID`, required at startup), that every definition is structurally valid, has a defined interface policy, a registered Skill and Agent, and a permission of the same category that is not DENIED. A permission held only by another principal does not count. Failure stops startup. The API does not run the database check under `NODE_ENV=test`.

**Interface policy is closed by construction (8.2):** `gateway/policy.ts` uses an exhaustive `INTERFACE_POLICY` table keyed by the canonical `INTERFACE_SOURCES`; `assertExplicitIdentity` rejects any interface not in the registry; `routeFor` returns REFUSE and `canApproveFrom` returns false for anything unknown. Do not write `if (source !== "VOICE" && source !== "SYSTEM")`-style logic — a test forbids interface-literal comparisons outside the table.

## 7. Read routes
`GET /audit`, `GET /approvals`, `GET /approvals/:id` were verified, not rewritten: authentication mandatory, principal from the credential only, client `principalId` (query/header/body) → 400, no cross-principal rows, not-found ≡ not-yours, audit rows carry no raw parameters. They remain direct reads (not gateway-mediated) — acceptable for own-data reads; see debt.

## 8. Google
Token refresh is an internal credential-maintenance write (external POST + secret rewrite) that still happens during a calendar READ. Moving it out needs a maintenance action + a lock, so it is **documented debt** (`skills/integrations/calendar.ts`). Added: 10 s timeouts on every Google call (calendar reads, token exchange/refresh, userinfo).

## 9. Audit cascade (analysis, no change)
`AuditLog.principal` is `onDelete: Cascade`, so deleting a principal deletes its audit trail. That contradicts the intent that audit is the durable security record (a compromised or mistaken deletion also erases the evidence). It is unreachable from any interface today (no delete-principal path; tests delete principals directly). Smallest safe future migration: change the audit FK to `ON DELETE RESTRICT` (deleting a principal with history becomes an explicit, deliberate step) and add a trigger forbidding UPDATE/DELETE on `audit_logs`. Not done here: it would change test fixtures and historical data handling.

## Remaining debt
Google refresh in READ (no lock); audit FK cascade; `GET /audit` / `/approvals*` not gateway-mediated; legacy READ skills still take `principalId`; Knowledge content is global; memory update/confirm/delete have no interface yet; task update/complete and decisions writers do not exist; Telegram outbound replies unaudited; API envelope inconsistencies.
