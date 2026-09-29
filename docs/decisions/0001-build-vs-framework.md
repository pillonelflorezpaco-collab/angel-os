# 0001 — Build the core; adopt frameworks only where they're thin and optional

**Status**: Accepted (retroactively documenting a decision already made across Builds #1–#3)

## Options considered

**A. Build mostly from scratch** — hand-rolled router/planner/gateway, a
thin web framework (Express), an ORM (Prisma), no agent framework.

**B. Adopt an agent framework** (LangGraph, AutoGen, Letta/MemGPT-style
runtime) as the core orchestration engine.

**C. Hybrid** — own core + gateway/permission model, framework-provided
pieces for narrow, well-bounded jobs (e.g., a Telegram SDK for the
interface layer, an optional memory backend behind an interface).

## Evaluation

| Criterion | A. Build | B. Framework | C. Hybrid |
|---|---|---|---|
| Control over execution/permission boundary | Full — the Gateway is the only path to action, by construction | Depends entirely on the framework's own execution model, which usually assumes more agent autonomy than this project wants | Full, same as A, for anything security-relevant |
| Complexity now | Low–medium, understandable end to end | High — a framework's abstractions must be learned and fought when they don't fit | Low for the core, framework complexity isolated to peripheral adapters |
| Maintainability | High — no upstream breaking changes to track for the core | Tied to a fast-moving ecosystem (most agent frameworks are <2 years old and change rapidly) | High for the core; peripheral dependencies are individually easy to replace |
| Future autonomy | Fully our own call, gated by our own Permission/Approval model | Framework's autonomy defaults often need to be fought, not extended | Same as A |
| Memory | Modeled exactly to this project's needs (Memory ≠ Knowledge ≠ Structured state) | Frameworks usually impose their own memory model | Our model for structured/memory data; an optional framework-provided backend only behind `MemoryProvider` |
| Integrations | Built as needed, `ConnectorProvider`-shaped | Often bundled, but generic and not permission-gated the way this project requires | Built as needed, same as A |
| Debugging | Deterministic v0.1 pipeline — traceable end to end (see `docs/ARCHITECTURE.md` "Jarvis Core") | Harder — framework internals add layers between input and action | Same as A for the core; framework-adapter bugs are isolated to their own thin layer |
| Security | The core project requirement — "the LLM never gets direct authority to execute a sensitive action" — is enforced by our own Gateway, not delegated to a framework's judgment | Most frameworks don't have this as a first-class concept | Same as A |
| Vendor lock-in | None | Real — rewriting orchestration logic if the framework is abandoned or pivots | Minimal — any framework-provided piece sits behind an interface (`MemoryProvider`, `ConnectorProvider`) and is swappable |
| Development speed | Slower for generic agent scaffolding, faster for exactly-what-we-need pieces | Faster to a demo, slower to something that matches this project's actual security/memory requirements | Fast where a mature thin library exists (Telegram SDK, HTTP), controlled where it matters |

## Decision

**Hybrid (C)**, with a strong bias toward "build" for anything that
touches the permission/execution/memory model, and "adopt a thin,
swappable library" only for peripheral, well-understood problems (an HTTP
framework, an ORM, a Telegram SDK for the interface layer, an optional
memory backend behind `MemoryProvider`).

This is not a new decision — it is what Builds #1–#3 already did (Express,
Prisma, no agent framework, Mem0 kept optional behind an interface). This
document exists to make that reasoning explicit and revisitable, per the
project's own instruction not to choose technology by popularity.

## Consequences

- Every external dependency this project takes on for something
  security- or memory-relevant must sit behind an interface the core
  depends on, never be called directly from `core/` — this is already
  enforced for `MemoryProvider` and `ConnectorProvider`, and must hold for
  a future Telegram adapter and any future planner upgrade (LLM-assisted
  planning, if ever adopted, still only *proposes* a plan the gateway
  enforces — see `docs/ARCHITECTURE.md` "Jarvis Core").
- Revisit this decision if Jarvis Core's planning complexity outgrows
  deterministic intent→plan dispatch (e.g., genuine multi-step research
  planning with branching) — at that point, a graph-based orchestration
  library becomes worth re-evaluating for the *planning* layer
  specifically, still behind the same Gateway.
