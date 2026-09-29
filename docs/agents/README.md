# Agents (Skills) — what exists, what's named but deferred

## Vocabulary mapping

The work order calls for named specialists (Research Agent, Planning
Agent, Calendar Agent, Task Agent, Knowledge/Memory Agent, Personal
Operations Agent, Chief of Staff/Orchestrator), each with a defined
purpose, capabilities, allowed tools, input/output contract, risk level,
permissions, memory access, and confirmation requirement.

Angel OS already has this shape, under different names:

- **Chief of Staff / Orchestrator** → `JarvisCore` (`core/index.ts`).
  Never executes a domain operation itself — see
  `docs/ARCHITECTURE.md` "Jarvis Core."
- **"Agent" (the caller identity in a permission row)** → the `Agent`
  Prisma model (e.g. `jarvis-core`). This is a narrower concept than the
  work order's "specialist agent": it's *who is asking*, for permission
  purposes, not a bundle of capability + prompt + contract.
- **Specialist capability, with its own input/output contract, resource,
  and permission scope** → what this codebase calls a **Skill**
  (`skills/system/tasks.ts`, `skills/system/memory.ts`,
  `skills/system/decisions.ts`, `skills/integrations/calendar.ts`). Each
  already has exactly the contract the work order asks an "agent" to
  have:

| Work order's agent property | Where it lives today, per Skill |
|---|---|
| Purpose | The module's own doc comment + `SKILL_KEY` |
| Capabilities | The set of `action` strings it calls `gatewayExecute` with |
| Allowed tools | For `integrations.calendar`: the one `CalendarConnector` it resolves via the registry — never another connector |
| Input contract | The TS input interface for each exported function (e.g. `CreateTaskInput`) |
| Output contract | `Result` (`core/types/index.ts`) — every skill function returns the same shape |
| Risk level | `Permission.category` (`READ \| WRITE \| EXECUTE`) per action |
| Permissions | `Permission` rows, seeded in `db/seed/seed.ts`, checked by `gatewayExecute` |
| Memory access | Only `system.memory`'s skill touches `MemoryProvider`; no other skill does |
| Confirmation requirement | `Permission.state === APPROVAL_REQUIRED` → `gatewayExecute` creates a `PENDING` `ApprovalRequest` instead of running |

## Existing "specialists," mapped to the work order's suggested list

| Work order's specialist | Status | Implementation |
|---|---|---|
| Task Agent | **Built** | `skills/system/tasks.ts` (tasks + reminders) |
| Knowledge/Memory Agent | **Built** | `skills/system/memory.ts` + `knowledge/markdown/` |
| Calendar Agent | **Built** (read-only) | `skills/integrations/calendar.ts` |
| Planning Agent | Not built | `core/planner/index.ts` exists but is deterministic intent→plan mapping today, not a planning *specialist* — see `docs/ROADMAP.md` |
| Research Agent | Not built | No web-research capability exists yet |
| Personal Operations Agent | Not built as a distinct thing | Its likely responsibilities (routines, organization) overlap with Task/Reminder today; don't split it out until a concrete need doesn't fit the existing skills |
| Chief of Staff / Orchestrator | **Built** | `JarvisCore` |

## Why not build the rest now

The work order itself says: "Do not create dozens of agents just for the
sake of having agents" and "the orchestrator should decide when
specialization is useful." Angel OS has exactly as many Skills as it has
real capabilities — adding a "Research Agent" module with no research
capability behind it yet would be scaffolding, not architecture. New
Skills get added when a new real capability is built (see
`docs/ROADMAP.md`), following the exact pattern `skills/integrations/
calendar.ts` already established: one `SKILL_KEY`, one seeded permission
row, one `gatewayExecute`-mediated path, tests before it's considered
done.
