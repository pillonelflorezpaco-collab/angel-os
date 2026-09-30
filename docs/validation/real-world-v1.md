# Angel OS — real-world validation v1

Question: *can Angel OS actually work as Angel's personal operating system?* Method: synthetic, Angel-like scenarios driven the way Angel
would use the system — natural language through Jarvis Core first, structured actions second, then retrieval and context — in
`tests/acceptance/real-world.test.ts` (12 tests). `expect()` calls are integrity/security invariants that must hold; the grades below are
honest evidence, not assertions. Run it with `ACCEPTANCE_MATRIX_FILE=/tmp/matrix.txt npx vitest run tests/acceptance`.

## Headline
- **The storage, integrity and security layers work end to end.** Every scenario's *structured* path (memory types, decisions and look-backs,
  results, learning objectives/experiments/lessons, Future Self states with evidence, failure/rejection) behaved correctly, kept history
  immutable, refused unsupported claims, and never crossed principals. No P0 was found.
- **The "Angel talks, the OS structures" loop is NOT operational.** Without a model, Jarvis understands ~10 fixed phrases. Free-form
  daily logs are not understood; "remember …" stores everything as a FACT; decisions, lessons, results, experiments and Future Self cannot be
  created from natural language at all. No real model adapter exists (`LLM_PROVIDER` in `.env.example` is unused). Today those domains work
  through the cockpit forms and the API, not through Jarvis.
- **Reading back is thin.** Context has no experiments, objectives, results, lessons, evidence or state history, so "what have I done toward my
  desired future self?" cannot be answered from evidence; "what matters next week/today" is not understood (and nothing is fabricated).

## Pipeline matrix
| Scenario | Stage | Grade | Why |
|---|---|---|---|
| S1 | INPUT→INTERPRETATION | **FAIL** | A free-form daily log is not understood by the deterministic router without a model (status FAILED: "I didn't understand: "I worked several hours on Angel OS tod…"). Only fixed phrases (remember/note, add task, remind me, what happened…) parse. |
| S1 | INTERPRETATION→STRUCTURED STATE | **FAIL** | "remember that <lived experience>" is stored as type FACT / provenance STATED. The router has no notion of experience, lesson, decision or next action; every "remember" is a FACT (see core/index.ts memory.remember). |
| S1 | STORAGE | **PASS** | EXPERIENCE (EXPERIENCED) and LESSON are separate typed memories; fact/experience/inference relabelling is refused by the schema/provider. |
| S1 | ACTIVITY | **PASS** | Activity events after the two memories: MEMORY_CREATED,MEMORY_CREATED,MEMORY_CREATED. |
| S1 | INPUT→ACTION (explicit decision / next action) | **NOT IMPLEMENTED** | The sentence contains a realization but no explicit decision or next action; the system created none (correct). But nothing extracts lesson/decision/next-action from prose — the caller must supply structure. |
| S2 | STORAGE | **PASS** | question, options, chosen option, reasoning, expected outcome, look-back date and evidence are stored. |
| S2 | LEARNING | **PARTIAL** | The look-back stores expected vs actual and a free-text lesson ON the decision row. It is not a LESSON memory, and no next action is created from it — the two are not connected. |
| S2 | RETRIEVAL | **PASS** | "what did I decide about <topic>" works through Jarvis (keyword match on the decision). |
| S3 | STORAGE | **PARTIAL** | A result can attach to a GOAL/PROJECT/QUEST/DECISION — not to a TASK. Completing a task records an activity but no result; the task→result link does not exist (P2). |
| S3 | RESULT→LEARNING | **PASS** | A result and an experience can be linked as evidence to a Future Self state (no score is created). |
| S4 | STORAGE→LEARNING | **PASS** | objective, method, session, observation, evidence links, review transitions and lesson are all stored; a session alone never advances an objective or experiment; confirmation needs repeated observation. |
| S4 | INPUT→INTERPRETATION | **NOT IMPLEMENTED** | "I learned X" / "I studied docker for 90 minutes" are not understood by Jarvis without a model; the flow works through structured actions / the cockpit only. |
| S4 | PARTIAL: objective↔session | **PARTIAL** | A session cannot name the objective it served (SESSION_LOG has no objectiveId); the link is only through the topic. |
| S5 | STORAGE | **PASS** | current/desired/gap/next action stored; state change refused without evidence; fact and inference refused as evidence; lived experience accepted; progress is null (no invented figure). |
| S5 | ACTION | **PASS** | next action is a real task link, shown by name. |
| S6 | RETRIEVAL | **PASS** | keyword retrieval returns the four relevant typed records, excludes irrelevant and foreign ones, and prints the inference as an unconfirmed guess. |
| S6 | RETRIEVAL (semantic) | **PARTIAL** | Retrieval is term overlap: a question worded differently from the stored text ("containers" vs "Docker") will miss. No embeddings by design; this is the honest limit of the current engine. |
| S7 | CONTEXT | **PARTIAL** | Terms extracted from the question: [actually, done, recently, toward, becoming]. Aspirations included: 2. Recent activity items: 5. Memories matched: 0. Decisions matched: 0. |
| S7 | CONTEXT (coverage) | **PARTIAL** | Context has NO experiments, objectives, evidence links, results, lessons-as-such or state history; an aspiration appears only as its current/desired text. It cannot show WHAT was done toward the gap, only recent activity summaries (max 5) and keyword-matched records. |
| S7 | CONTEXT (ownership) | **PASS** | another principal's context contains none of the owner's records. |
| S8 | CAUSAL CHAIN | **PARTIAL** | Decision→result (subject link) and decision→review are linked in the database. The ACTION (task) is NOT linked to the decision, and the LESSON memory links only by a free-text sourceRef — there is no relational decision↔task or decision↔lesson edge. The chain is reconstructable by a human, not queryable. |
| S9 | STORAGE | **PASS** | rejected hypothesis (with contradicting evidence), retained observations, a lesson, an abandoned goal with reason and a negative result are all representable and immutable; failure is not missing data. |
| S9 | LESSON→NEXT ACTION | **PARTIAL** | A lesson does not create or link a next action; the follow-up task is a separate, unlinked write. |
| S10 | WEEKLY SUMMARY | **PARTIAL** | activity.week returns: "This week: 20 recorded. task completed ×2, learning session ×1, decision ×3, memory created ×14.". It summarizes ACTIVITY events (counts by type). Decisions recorded, experiments observed/rejected, lessons and results appear only if an activity event was written for them. |
| S10 | ACTIVITY COVERAGE | **PARTIAL** | Activity types present after the week: DECISION, LEARNING_SESSION, MEMORY_CREATED, TASK_COMPLETED. Not present: ACHIEVEMENT, GOAL_PROGRESS. Experiment observations, experiment status changes, lessons, results and state records produce no activity. |
| S10 | NEXT-WEEK PRIORITIES | **NOT IMPLEMENTED** | "What matters next week / today" is not understood. The raw ingredients exist (open tasks, aspirations' next task, decisions due for review, experiments not yet closed) but nothing assembles them, so nothing is fabricated either. |
| S10 | OPEN LOOPS | **PARTIAL** | Context exposes open tasks (2) and active goals/projects, but not decisions due for review, open experiments/objectives, or aspirations' next actions as open loops. |
| ORCH | INTERPRETATION (with a model) | **PARTIAL** | With a ModelProvider, free text can become EXPERIENCE/DECISION writes through the ordinary gateway path (unknown actions and forged principals are rejected, outcomes are written by the OS). BUT no real model adapter exists: without one (the current default) none of this is reachable from natural language. Tested here with a scripted stand-in only. |
| SEC | IDENTITY | **PASS** | forged principal fields are rejected by strict schemas; mismatched request/identity principals are refused; foreign records never surface. |

## Jarvis / orchestration coverage (deterministic Core, no model)
| Domain | Jarvis reads | Jarvis creates | Updates | Connects | Retrieves later | Perms | Evidence semantics | Gateway path | Audited | Principal |
|---|---|---|---|---|---|---|---|---|---|---|
| Memory | yes ("what do I know about X") | yes, **FACT only** | no | no | yes (keyword) | yes | types shown on read; **collapsed to FACT on create** | yes | yes | yes |
| Knowledge | only inside "brief me on X" | no | no | no | context only | yes | kind/contradicted shown | yes | yes | yes |
| Life | summary inside context; tasks list | tasks only ("add task") | no | no | context | yes | n/a | yes | yes | yes |
| Decisions | yes ("what did I decide about X") | **no** | no | no | yes (keyword) | yes | n/a | yes | yes | yes |
| Future Self | current/desired text in context | **no** | no | no | context | yes | evidence not surfaced | yes | yes | yes |
| Learning | topic summary in context | **no** | no | no | context | yes | evidence not surfaced | yes | yes | yes |
| Context | yes ("brief me on X", cockpit Today) | – | – | – | – | per-section withheld | provenance carried | read lane | yes | yes |

With a `ModelProvider` every registered ActionDefinition is proposable (verified with a scripted stand-in: unknown actions and forged principals
are rejected, voice writes need approval, outcome text is written by the OS). The gap is the missing adapter and the missing interpretation
design, not the safety plumbing.

## Daily workflow — what works today
| Moment | Utterance | Today |
|---|---|---|
| Morning | "What matters today?" | Not understood by Jarvis. The cockpit Today screen (context brief, approvals, decisions due, cards due) is the working substitute. |
| Day | "Remember this." | Works — stored as FACT. |
| Day | "I decided X" / "I learned X" | Not understood. Works via cockpit forms (Decisions screen; learning via API only for sessions/topics). |
| Day | "I finished X" | Not understood. Cockpit completes tasks; no task→result link. |
| Evening | "What did I accomplish / do today?" | Works (activity list), limited to events that write activity. |
| Evening | "What decisions did I make?" | Needs a topic ("what did I decide about X"); the cockpit lists all. |
| Evening | "What remains open?" | "what are my tasks" works; decisions due / open experiments are not "open loops" anywhere but the cockpit. |
| Weekly | "What happened this week?" | Works as counts by activity type only. |
| Weekly | "What is my current gap? What next?" | Cockpit Future Self screen only. Jarvis: no. |

## Gaps
**P0 — none found.** Cross-principal, forged-field, approval, immutability and evidence-typing checks all held under the scenarios.

**P1**
1. No natural-language capture into typed records: `remember` is FACT-only, the router cannot express experience/lesson/decision/result/next action, and no model adapter exists. (Needs a product/architecture decision — how interpretation should propose, and how much a person confirms — so it was reported, not built.)
2. Context cannot support "what have I done toward my desired future self": it omits experiments, objectives, results, lessons, evidence links and state history, and includes at most 5 recent activity summaries.

**P2**
3. Activity coverage: experiment observations/transitions, lessons, results and state records write no activity, so "what happened this week" undercounts real work.
4. No "what matters today / next week" assembly of real open loops (open tasks, aspirations' next task, decisions due, open experiments/objectives). The ingredients exist; nothing combines them (and nothing is fabricated).
5. Missing relational links: task→result (results attach to goal/project/quest/decision only), decision↔action, decision↔lesson (free-text `sourceRef` only), learning session↔objective, lesson→next action.
6. **Fixed in this pass:** context and the cockpit said "no evidence yet" for an aspiration that had evidenced states (the phrase referred only to metric readings). Now "no measured readings yet".

**P3** keyword-only retrieval (no embeddings, by design); `/health` is liveness only (no DB check); a Mem0 provider exists in code behind `MEMORY_PROVIDER` (default local — keep it off); Today's "% by recorded readings" is derived from real readings but is still a percentage.

**P4** "Remembered a experience" grammar.

## Production / VPS readiness — gap list only (nothing deployed)
Present: separate API, worker and cockpit processes; env-based config; encrypted credential store; sign-in throttle and default-deny proxy on the cockpit; CORS off unless origins are listed; hashed API tokens; `SIGINT/SIGTERM` in the worker; audit history outlives principals.
Missing or unverified: Dockerfile/compose (none); `.dockerignore`; documented secret handling for prod (`ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY`, tokens, cockpit hash); PostgreSQL persistence/volume, **backup and restore procedure (none documented)**; migration/seed strategy for prod (`db:seed` creates a fixed principal id — needs a prod-safe bootstrap); health checks that test the DB and worker liveness; graceful shutdown for API/cockpit; API rate limiting (only the cockpit sign-in is throttled); HTTPS/reverse-proxy and `TRUST_PROXY` assumptions written down; structured logging and log retention (console only); audit retention/archival policy; monitoring/alerting; crash-restart policy; DB recovery drill; **isolation from BlackOS** (separate database, Docker stack, secrets and network; any bridge explicit and one-way) — nothing in the repo currently connects them, keep it so.

## Recommended next build (from observed gaps only)
Decide the interpretation design first (P1.1): a small, reviewable "capture" step that proposes typed records from a sentence and shows them for one-tap confirmation, using the existing proposal/approval path — plus P1.2/P2 read-side work (open loops and evidence-aware context). Before that, run the system daily for a week by hand through the cockpit to see which of these gaps actually hurt.

## Not to build yet
Embeddings/vector search, Mem0, gamified scores, more cockpit screens, autonomous execution, connectors, deployment automation, BlackOS bridge.
