# 0004 — Keep the existing top-level layout, don't move to `src/`

**Status**: Accepted

## Context

A later work order suggested a `src/core/`, `src/agents/`, `src/memory/`,
`src/tools/`, `src/permissions/`, `src/interfaces/`, `src/integrations/`,
`src/infrastructure/` layout. The existing repository already has
`core/`, `skills/` (the work order's "tools"/"agents" combined — see
`docs/agents/README.md`), `memory/`, `gateway/` (the work order's
"permissions" plus approvals/audit), `connectors/` (the work order's
"integrations"), `db/`, `api/`.

## Decision

Keep the existing flat top-level layout. Do not introduce a `src/`
wrapper or rename existing directories to match the suggested names
exactly. Map the work order's vocabulary onto the existing structure
instead of moving files:

| Work order's suggested path | Existing path | Notes |
|---|---|---|
| `src/core/` | `core/` | Router, planner, Jarvis Core, shared types |
| `src/agents/` | `skills/` | See `docs/agents/README.md` — Angel OS uses "Skill" as the unit the Gateway mediates; an "agent" in this codebase is the *caller* (`jarvis-core`), not a capability module |
| `src/memory/` | `memory/` | Unchanged name |
| `src/tools/` | (folded into `skills/` + `connectors/`) | A "tool" in the work order's sense is either a Skill's internal logic or a Connector it calls — kept as two existing concepts rather than a third one |
| `src/permissions/` | `gateway/` | Permissions, approvals, and audit are one module because they're one enforcement boundary — splitting them would let one change without the others, which is the opposite of the guarantee this project needs |
| `src/interfaces/` | `api/` (today), future `interfaces/telegram/` | See `docs/decisions/0005-interface-boundary.md` |
| `src/integrations/` | `connectors/` | Unchanged concept, different name chosen in Build #2 before this work order used "integrations" |
| `src/infrastructure/` | `db/` | Just the Prisma layer today; would gain new content (queues, schedulers) only when the Proactive Engine or retries are built |

## Consequences

Moving working, tested code into a `src/` wrapper for naming symmetry
with a document is pure churn with no behavior change and real risk
(import path breakage across 15+ test files). Not done. Future structural
changes should still follow the existing flat layout unless there's a
concrete reason (e.g., a genuinely new top-level concern) to add a new
top-level directory — matching this project's own repeated principle
of not creating structure for appearance's sake.
