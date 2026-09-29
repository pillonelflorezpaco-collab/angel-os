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
