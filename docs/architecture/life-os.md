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
