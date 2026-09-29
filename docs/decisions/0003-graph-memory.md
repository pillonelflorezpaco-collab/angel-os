# 0003 — No Neo4j/Graphiti for v0.1; Postgres-only

**Status**: Accepted

## Options considered

**A. PostgreSQL only** (current state).
**B. PostgreSQL + vector** (pgvector or similar, for semantic memory search).
**C. PostgreSQL + Neo4j** (graph queries for relationship-heavy data).
**D. PostgreSQL + Graphiti + Neo4j** (temporal knowledge graph, auto-built from conversation).

## Evaluation

The work order names candidate relationships:
`User -KNOWS-> Person`, `-OWNS-> Project`, `-HAS_GOAL-> Goal`,
`-ATTENDED-> Event`, `-PREFERS-> Preference`, `-DISCUSSED-> Topic`.

Every one of these is already expressible as a normal foreign key in the
current relational schema (`Person.principalId`, `Project.principalId`,
`Goal.principalId`, and so on), because Angel OS has exactly **one**
principal per database — there is no multi-hop "who introduced me to whom
through which project" query need yet, which is the kind of query a graph
database earns its complexity for. A single-principal, foreign-key-scoped
schema doesn't benefit from a graph engine the way a true social/
organizational graph (which is what BlackOS's Neo4j-based ecosystem graph
actually is — many people, many entities, many cross-cutting
relationships) does.

`Graphiti` specifically adds: a second database to operate (Neo4j or
FalkorDB), a second query language (Cypher) alongside Prisma's query
builder, and an LLM-driven auto-extraction pipeline whose accuracy would
need its own evaluation. None of that is justified by a query pattern
that doesn't exist yet.

## Decision

**PostgreSQL only (A)** for v0.1, matching the project's own explicit
instruction: *"Do not add ... Neo4j / Graphiti ... unless there is a
concrete technical reason"* and *"do not implement a graph simply because
it looks sophisticated."* No concrete technical reason has appeared yet.

**Vector search (B)** is the most likely next step, if/when memory search
quality (currently substring match, see `docs/MEMORY.md`) becomes a real
problem — `pgvector` extends the same Postgres instance rather than adding
an operational dependency, which is why it's the documented next step, not
Neo4j.

## When to revisit

Revisit **C/D** if a genuine multi-hop relationship query need appears —
concretely: if Personal Jarvis needs to answer something like "who have I
discussed Project X with, and what did they say about it across multiple
conversations" as a routine query, not a one-off. That is a materially
different access pattern than anything the schema currently needs to
support. Until then, this decision stands.

## Consequences

- No graph database dependency in this repository.
- `connectors/`'s explicit rule against Neo4j/Graphiti (carried from
  Build #1's own instructions) is reaffirmed, not just inherited.
- If BlackOS's own Neo4j-based ecosystem graph is ever bridged to
  (`docs/ARCHITECTURE.md` "Bridge to Business Jarvis / BlackOS"), Personal
  Jarvis still never queries it directly — it goes through the Business
  Jarvis Gateway, which returns already-shaped data, not a live Cypher
  connection. Personal Jarvis remains Postgres-only regardless of what
  BlackOS uses internally.
