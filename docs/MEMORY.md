# Memory

## Memory ≠ Knowledge ≠ Structured state

- **Structured state** (Postgres tables `tasks`, `projects`, `goals`,
  `decisions`, `people`, `reminders`): things with a clear current
  value/status, queried and mutated directly. Not memory.
- **Memory** (`memories` table, this document): long-term, evolving
  understanding *about* Angel — facts, preferences, principles, habits,
  experiences, and inferred patterns — with confidence and confirmation
  state attached.
- **Knowledge** (`knowledge/markdown/*.md`): documents Angel writes and
  curates by hand. Not automatically written by the system.

Putting all of this in one giant table was explicitly avoided — each has
different write patterns (structured state changes via direct user/skill
action; memory changes via inference or explicit "remember that..."
requests; knowledge changes only when Angel edits a file) and different
trust levels.

## MemoryType

`FACT | PREFERENCE | PRINCIPLE | DECISION | GOAL | HABIT | EXPERIENCE | PERSON | PROJECT | INFERENCE`

`DECISION`, `GOAL`, `PERSON`, `PROJECT` overlap in name with structured-state
tables. That's intentional: a `Memory` row of type `PERSON` might capture
"Angel mentioned her sister prefers phone calls over texting" — an
observation *about* a person, not the `Person` record itself. The
structured table is the record; the memory is what's been learned around
it.

## MemoryStatus and the explicit-vs-inferred rule

`ACTIVE | UNCONFIRMED | EXPIRED | RETRACTED`

**An inferred pattern must not automatically become a permanent fact.**
Concretely: `LocalMemoryProvider.addMemory` sets `status: UNCONFIRMED` and
`confidence < 1.0` whenever `type === "INFERENCE"`; every other type
defaults to `ACTIVE` with `confidence: 1.0` (something explicitly stated or
remembered is trusted at face value; something inferred is not). An
`UNCONFIRMED` memory is only promoted via `confirmMemory(id)`, which sets
`status: ACTIVE`, `confidence: 1.0`, and stamps `lastConfirmedAt`. Nothing
in the codebase auto-promotes an inference on a timer or a re-occurrence
count in v0.1 — that would need a deliberate policy decision, deferred to
`docs/ROADMAP.md`.

## Metadata fields

Every memory carries: `source` (e.g. `"conversation"`, `"manual"`,
`"inference:task-pattern"`), `confidence` (0–1), `status`, `createdAt`,
`updatedAt`, `lastConfirmedAt`, `expiresAt`. `expiresAt` lets a memory be
time-bounded (e.g. "traveling until March" shouldn't outlive March) — v0.1
stores the field; a background expiry sweep is deferred.

## The MemoryProvider abstraction

`memory/types/index.ts` defines the interface every other layer depends on:

```ts
interface MemoryProvider {
  addMemory(input: AddMemoryInput): Promise<MemoryRecord>;
  searchMemory(input: SearchMemoryInput): Promise<MemoryRecord[]>;
  updateMemory(id: string, input: UpdateMemoryInput): Promise<MemoryRecord>;
  deleteMemory(id: string): Promise<void>;
  confirmMemory(id: string): Promise<MemoryRecord>;
}
```

`core/`, `context/`, and `api/` all call `getMemoryProvider()`
(`memory/index.ts`), never a concrete class. Swapping providers is a config
change (`MEMORY_PROVIDER=local|mem0`), not a rewrite.

## Why Mem0 is not wired in by default

The task explicitly asked not to hard-wire the whole system to Mem0, and to
implement the adapter only if it could be done cleanly. Doing it properly
requires: translating `MemoryRecord` to and from Mem0's memory objects,
mapping `searchMemory` to Mem0's semantic search, handling its auth/config,
and deciding how `MemoryStatus`/`confidence` (concepts Mem0 doesn't natively
model the same way) round-trip. That's real integration work, not a
five-line stub — building it without testing it against a real Mem0 account
would mean shipping unverified code. `memory/mem0/index.ts` documents the
exact shape the adapter must take and throws a clear error if selected
without being implemented, so the integration point is real and ready, but
nothing fake pretends to work.

## Upgrade path

- **v0.1 (current)**: `LocalMemoryProvider`, Postgres `content ILIKE`
  substring search. Deterministic, no external dependency.
- **Next**: implement `Mem0MemoryProvider` for real, or add an embeddings
  column + pgvector to `LocalMemoryProvider` for semantic search without a
  new external service — see `docs/ROADMAP.md`.
