# Ecosystem research

Survey done before/alongside building Angel OS (branded "Personal Jarvis" —
see `docs/decisions/0000-naming.md`), per the project's own instruction to
research before committing to architecture. This is a desk review of
publicly known projects as of Build #1–#4, not a live audit of each repo's
current state — treat version/activity notes as approximate.

## Personal AI assistant / agent frameworks

| Project | Tech | Architecture | Strengths | Weaknesses | Verdict for us |
|---|---|---|---|---|---|
| **Letta (formerly MemGPT)** | Python | LLM-as-OS: paged context, self-editing memory, tool calls | Pioneered "memory as OS paging" framing; strong on long-context management via summarization/eviction | Heavyweight runtime, opinionated memory model that fights our layered-memory design, Python (we're TypeScript) | Inspiration only — the "memory has tiers with eviction" idea informed `docs/MEMORY.md`, not adopted as a dependency |
| **LangGraph** | Python/JS | Graph-based agent orchestration, explicit state machines | Good for complex multi-step agent graphs, decent TS support | General-purpose graph engine — brings its own state/persistence model that would compete with our Prisma-backed state, adds a dependency for what `core/router` + `core/planner` already do deterministically at v0.1's scale | Not adopted. Revisit only if/when Jarvis Core needs genuine multi-branch planning beyond current deterministic dispatch |
| **AutoGPT / AutoGen-style autonomous agents** | Python | Fully autonomous loop, minimal human gating | Popularized "agent loop" pattern | Autonomy-first design is the opposite of what this project wants — Angel OS's explicit rule is "the LLM never gets direct authority to execute a sensitive action" (`docs/SECURITY.md`); these frameworks assume the opposite default | Explicitly rejected as an architectural model. The Gateway/Approval pattern we built is a direct reaction against this class of design |
| **Mem0** | Python/TS SDK + hosted API | Vector-backed long-term memory as a service | Turnkey semantic memory, has a TS SDK | External dependency for the most sensitive data category (personal long-term memory); vendor lock-in risk; doesn't natively model our `MemoryType`/`MemoryStatus` (explicit-vs-inferred) distinction | Kept as an optional adapter (`memory/mem0/index.ts`), NOT the default — see `docs/decisions/0002-memory-architecture.md`. Local Postgres-backed `MemoryProvider` is default |
| **Graphiti** (Zep) | Python, Neo4j/FalkorDB backend | Temporal knowledge graph built from conversation | Good at "what did we learn over time" relationship queries | Adds a graph DB dependency, a second query language, and operational surface (Build #1's own instruction: no Neo4j/Graphiti "unless there is a concrete technical reason") | Not adopted for v0.1 — see `docs/decisions/0003-graph-memory.md`. Revisit if relationship-heavy queries (who-knows-whom-through-what) become a real, frequent need |
| **Telegram bot frameworks (grammY, Telegraf, python-telegram-bot)** | Node/Python | Thin SDKs over the Bot API | Mature, well-documented, handle webhook/long-poll plumbing | None significant for our use — the risk is architectural misuse (hard-coding intelligence into handlers), not the library itself | Adopt one (grammY, TS-native) purely as the **interface adapter** in `interfaces/telegram/`, never importing into `core/` — matches the Core/Interface separation already established for the API in Build #1 |

## Why "build core, adopt only thin/optional libraries" — not a framework

Personal Jarvis already made this call implicitly across Builds #1–#3
(Express + Prisma + hand-rolled deterministic router, no agent framework).
This research confirms rather than overturns that call. See
`docs/decisions/0001-build-vs-framework.md` for the documented tradeoff
comparison the project instructions asked for.

## What was reused vs rejected, summarized

**Reused as inspiration, not as code or dependency:**
- MemGPT/Letta's tiered-memory framing → `docs/MEMORY.md`'s Memory ≠
  Knowledge ≠ Structured-state split, and `MemoryStatus.UNCONFIRMED` for
  inferred facts.
- The general "agent has an explicit contract (inputs/outputs/permissions)"
  pattern from most agent frameworks → each Skill's fixed
  `SKILL_KEY`/`RESOURCE`/action shape already follows this.

**Explicitly rejected:**
- Autonomous-loop frameworks (AutoGPT-style): contradicts the
  Gateway-mediated execution model at the core of this project's security
  posture.
- A general-purpose agent-graph engine (LangGraph): unnecessary complexity
  at Angel OS's current planning complexity (deterministic intent → plan →
  skill dispatch); would also mean a second source of truth for state
  alongside Postgres.
- Neo4j/Graphiti as the default memory backend: operational overhead not
  yet justified by a real relationship-query need — see decision 0003.

**Adopted as an optional adapter, not a hard dependency:**
- Mem0, behind the `MemoryProvider` interface, selectable via
  `MEMORY_PROVIDER=mem0` — unimplemented by default (`memory/mem0/index.ts`
  documents the integration point without pretending it's wired up).
