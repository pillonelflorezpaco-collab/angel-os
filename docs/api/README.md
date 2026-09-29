# Angel OS API contract (v2)

For clients such as GuideHub, a mobile app, or scripts. Every response
carries `X-Angel-API-Version: 2`. A breaking change will bump it.

## Authentication

`Authorization: Bearer aos_…` on every `/api/*` request. Tokens are issued
by an operator (`npm run identity -- create-token <principalId> <INTERFACE>
<label>`), tied to one principal **and one interface**, and revocable.
Only `GET /health` and Google's OAuth redirect
(`/api/integrations/google/calendar/callback`, authenticated by its own
single-use `state`) are unauthenticated.

- `401 { "error": "Unauthorized." }` — no detail, on purpose.
- Never send `principalId`, `principal_id`, or `X-Principal-Id`: you get
  `400 { "error": "principalId cannot be supplied by the client." }`. Who
  you are comes from the token.
- The interface is set by the token. Headers claiming another interface
  are ignored.
- Every response includes `X-Request-Id`; the same id is on the audit rows
  the request caused.

## CORS

Off by default. Set `ANGEL_OS_CORS_ORIGINS` to a comma-separated list of
exact origins to allow a browser client. `*` is never honoured, and no
credentialed mode is used. **Open decision for GuideHub:** a browser app
holding a long-lived bearer token in JavaScript is a real exposure; if
GuideHub has a server component, call the API from there instead.

## Envelope

Skill-backed endpoints return a `Result`:

```json
{ "status": "EXECUTED | DENIED | PENDING_APPROVAL | FAILED",
  "message": "ready-to-display text",
  "data": "endpoint-specific, present when EXECUTED",
  "approvalId": "present when PENDING_APPROVAL" }
```

`message` is written for the user and is safe to show as-is: internal
errors are replaced with a generic message; only deliberate user-facing
messages pass through. Errors from the HTTP layer are `{ "error": string }`.
Dates are ISO-8601 UTC strings.

## Endpoints

| Method & path | Purpose | `data` |
|---|---|---|
| `GET /health` | Liveness (public) | — (`{status,service,version}`) |
| `GET /api/me` | Who am I, through what | `{principal:{id,name,timezone}, interface, authMethod, requestId}` (not a `Result`) |
| `POST /api/jarvis` `{input}` | Ask Jarvis anything (≤ 2000 chars) | varies by intent |
| `GET/POST /api/tasks` | List / add tasks | task rows |
| `GET/POST /api/reminders` | List / add reminders. **POST is an ActionDefinition** (`CREATE_REMINDER`): direct for GuideHub/API/Telegram credentials, `PENDING_APPROVAL` for a VOICE credential; `remindAt` must be a UTC ISO instant | reminder rows / `Result` |
| `GET /api/memory/search?q=` | Search memory | memory rows (`type`, `status` included) |
| `GET /api/activity?range=today\|yesterday\|week&limit=` | Life history, newest first | activity rows |
| `GET /api/activity/summary?range=` | Counts | `{range,timeZone,from,to,total,byType,byArea}` |
| `GET /api/audit[?limit=1..200]` | Security/system trace (not life history), newest first, default 50; only `limit` is accepted; rows have no `agentId` | audit rows |
| `GET /api/approvals` | Caller's pending, unexpired approvals (`ApprovalView[]`, no parameters) | not a `Result` |
| `GET /api/approvals/:id` | One approval incl. the exact stored `parameters` | `ApprovalView` |
| `POST /api/approvals/:id/approve` · `/deny` | Decide (body must be empty `{}`); approve also executes, once | see below |
| `GET /api/connections[/:id]`, `GET /api/connectors` | Connection metadata (never credentials) | — |
| `GET /api/integrations/google/calendar/connect` | Start Google authorization | `{authorizeUrl}` |

Activity row: `{id, type, occurredAt, summary, area, refType, refId,
interfaceSource, metadata}`. `type` is one of `TASK_COMPLETED,
QUEST_COMPLETED, LEARNING_SESSION, KNOWLEDGE_ADDED, HABIT_COMPLETED,
GOAL_PROGRESS, ACHIEVEMENT, MEETING, DECISION, MEMORY_CREATED`. Memory
rows always carry `type` and `status`: an `INFERENCE` is `UNCONFIRMED`
until confirmed and must be shown as a guess, not a fact.

### Approvals (API version 2)

`ApprovalView`: `{id, status: PENDING|APPROVED|DENIED|EXPIRED|CONSUMED, skillKey,
action, resource, summary, risk, requestedAt, expiresAt, decidedAt, consumedAt,
executionStatus: STARTED|SUCCEEDED|FAILED|null, parameters?}` (`parameters` only
on the single-approval GET).

`POST /api/approvals/:id/approve|deny` → `200 {message, executed, execution?:
{status,message}, approval}`. **`executed` is true only if the action really
ran to success** — an approved action that failed returns 200 with
`executed:false` and `execution.status:"FAILED"`. Errors are `{error, code?}`:

| Status | `error` | When |
|---|---|---|
| 400 | `Approval decisions take no parameters.` / principal-override rejection | non-empty body, client `principalId` |
| 401 | `Unauthorized.` | missing/invalid token |
| 403 | `You are not authorized to approve this action.` | interface may not approve this risk (voice) |
| 404 | `Approval not found.` | does not exist **or belongs to someone else** (indistinguishable) |
| 409 | `Approval already consumed.` / `Approval already decided.` | replay, retry, lost race |
| 410 | `Approval expired.` | past `expiresAt` |

The principal always comes from the bearer token; parameters can never be sent
at decision time. **Breaking change from v1:** `POST /approvals/:id/decide`
and the `REJECTED` status are gone (now `approve`/`deny` and `DENIED`).

## Life OS (additive in API version 2)

Reads are plain `GET`s returning a `Result`; **every write is one generic route** that proposes the registered ActionDefinition, so there are no per-entity
write endpoints to drift:

`POST /api/actions/:skillKey/:action` — the JSON body is exactly the action's parameters (strict: unknown fields are rejected, `principalId` is refused).
`GET /api/actions` lists what exists: `[{skillKey, action, category, risk, fields[]}]` (names only — having an entry grants nothing).

**Status codes on these routes:** `200` EXECUTED · `202` PENDING_APPROVAL (`approvalId` in the body; decide with `/api/approvals/:id/approve|deny`; a voice token gets `202` for
LOW writes too, and can never approve SENSITIVE ones) · `403` DENIED (no permission) · `404` unknown action, or the target **wasn't found — missing and someone else's are identical** ·
`422` invalid parameters or a state error (e.g. the goal is already closed) · `400` malformed path id / query / body.

| Read | Returns (`data`) |
|---|---|
| `GET /api/life/history` | what was CLOSED, newest first (capped at 50 each): achieved/abandoned goals, completed/abandoned quests, completed/archived projects, archived visions — history, not a to-do list; closed items never reopen | `{goals, quests, projects, visions}` |
| `GET /api/life/overview` | active visions, goals, projects (with plain task counts `{open,done,cancelled}`), quests — no progress score |
| `GET /api/life/projects/:id` | project with quests, tasks, linked people and knowledge |
| `GET /api/life/people` | people |
| `GET /api/decisions[?dueForReview=true]` · `/api/decisions/:id` | decision records; one with options, evidence (snapshot labels), supersession links, outcome/lesson |
| `GET /api/results[?subjectKind=&subjectId=]` · `/api/reviews` | append-only results / reviews (with server-computed `facts` counts) |
| `GET /api/future/aspirations` · `/:id` | current / gap / desired / next in the owner's words; metrics with **derived** progress — `null` means "no evidence yet", never 0 |
| `GET /api/learning/topics` | topics with self-reported minutes (7/30 days) and card counts / due — no score, streak or XP |
| `GET /api/learning/due[?topicId=&limit=]` · `/api/learning/cards/:id` | due recall cards (derived from review history) / one card's derived state |

Actions (by `skillKey`): `system.life` (VISION_/GOAL_/PROJECT_/QUEST_/PERSON_*, RESULT_RECORD, REVIEW_CREATE), `system.tasks` (CREATE_TASK with optional project/quest/person links,
TASK_UPDATE/COMPLETE/CANCEL, CREATE_REMINDER), `system.decisions` (DECISION_RECORD, DECISION_REVIEW), `system.future` (ASPIRATION_*, METRIC_CREATE, METRIC_READING_RECORD),
`system.learning` (TOPIC_*, SESSION_LOG, CARD_CREATE/REVIEW/RETIRE), `system.memory`, `system.knowledge`. Terminal states (achieved, completed, done, archived, retired, reviewed)
are final. Progress, "due" and counts are always derived on read from evidence — the API has no way to set a score.

`POST /api/jarvis` additionally routes input the deterministic router did not understand to the model orchestrator **only if an operator configured a model**
(none is by default); its proposals go through the same path as `POST /api/actions/...` and outcomes are reported from real results.

## Not provided yet

Cockpit sections beyond the above (skills, habits, finance, fitness…) have no data model, so no endpoints. Nothing here grants unrestricted
database access: every endpoint is a skill behind the gateway. Pagination beyond `limit` (lists are capped server-side), a
permissions-inspection endpoint ("what may I do?" — `GET /api/actions` lists what exists, not what is allowed) and a machine-readable schema per action
(only top-level field names are exposed) are not built. **Open decisions for GuideHub:** token storage in a browser (see CORS) and whether the
cockpit should call the API from a server component.
