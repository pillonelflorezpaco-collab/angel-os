# 0002 — Layered memory, not a single undifferentiated store

**Status**: Accepted (implemented in Build #1, formalized here)

## Context

The project explicitly warns against "a giant undifferentiated memory
database" and asks for a layered design distinguishing working,
structured, long-term, episodic, semantic/knowledge, and temporary memory,
each with source/timestamp/confidence/relevance/privacy/lifecycle.

## Decision

Split by **how the data is produced and trusted**, not by a single
memory abstraction:

| Layer (from the work order) | Where it actually lives today | Why |
|---|---|---|
| Working memory (current conversation) | Not persisted — held only for the duration of one `JarvisCore.handle()` call | A v0.1 deterministic pipeline doesn't need cross-turn conversational state yet; adding persistence here before it's needed would be exactly the "store everything" anti-pattern being avoided. Revisit when multi-turn planning needs it (see `docs/ROADMAP.md`) |
| Structured memory (people, projects, tasks, events, preferences-as-facts, goals, commitments) | Postgres tables: `people`, `projects`, `tasks`, `reminders`, `goals`, `decisions` | These have a clear current value and are queried/mutated directly — not "remembered," just stored |
| Long-term memory (stable facts/preferences) | `Memory` table, `type: FACT \| PREFERENCE \| PRINCIPLE \| ...`, `status: ACTIVE` | Explicit, source-attributed, confidence-scored — see `docs/MEMORY.md` |
| Episodic memory (important past events/interactions) | `Memory` table, `type: EXPERIENCE`, plus `Decision` rows (append-only, superseded not overwritten) | Modeled as a specific `MemoryType` rather than a separate table — the distinguishing property is the `type` field, not a different storage mechanism |
| Semantic/knowledge memory (research, curated reference material) | `KnowledgeDocument` (Markdown files under `knowledge/markdown/`) | Deliberately filesystem-backed, human-editable, not auto-written by the system — see `docs/ARCHITECTURE.md` "Knowledge" |
| Temporary memory (expiring information) | `Memory.expiresAt` (nullable field on the same table) | A property of a memory row, not a separate lifecycle system — see "Known limitations" in `docs/MEMORY.md` for the not-yet-built expiry sweep |

Every `Memory` row already carries: `source`, `createdAt`/`updatedAt`,
`confidence`, `status` (`ACTIVE | UNCONFIRMED | EXPIRED | RETRACTED`),
`lastConfirmedAt`, `expiresAt`. Privacy classification is not yet a
per-row field — see Gaps below.

## Why not one big table, and why not a vector DB by default

A single table (or a single vector store) collapses distinctions this
project needs to make correctly:
- An **inferred** pattern must never silently become a **confirmed**
  fact — this requires a `status` state machine (`UNCONFIRMED →
  confirmMemory() → ACTIVE`), which a flat vector store has no native
  concept of.
- **Structured state** (a task's current status) and **memory** (what
  Jarvis has learned about how the user works) have different write
  paths and different staleness tolerance; merging them would make "list
  my tasks" a semantic-search query instead of an exact one.
- A vector DB by default would mean every memory read pays embedding
  cost and network latency even for the common case (exact-ish substring
  match), and would make "why did Jarvis retrieve this" harder to audit
  than a SQL `WHERE` clause.

## Gaps vs. the full vision (tracked, not silently dropped)

- **Privacy classification per memory row**: not yet a field. Should be
  added before any memory is shared across a future BlackOS bridge (see
  0003 and `docs/ARCHITECTURE.md` "Bridge to Business Jarvis / BlackOS")
  — a memory needs to be markable as "personal only, never bridgeable"
  independent of its `MemoryType`.
- **Working/conversational memory persistence**: intentionally deferred,
  see table above.
- **Semantic search quality**: substring match today; embeddings are a
  documented upgrade path in `docs/MEMORY.md`, not yet built.

## Consequences

Any new structured entity (Note, ResearchTopic, ResearchItem, Document —
named in the work order but not yet in the schema) must be evaluated
against this table before being added: is it structured state (own
table), a memory type (extend the `MemoryType` enum), or knowledge (a
Markdown file)? Don't add a table by default — see `docs/ARCHITECTURE.md`
"Do not create tables just because they're listed."
