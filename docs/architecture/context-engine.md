# Context Engine (Build #11, PHASE C)

`explicit IdentityContext → per-source READ skill → gatewayExecute (per-agent permission, audited) → ContextPackage`

The engine is **not a privileged reader**: it has no database handle, no provider import and no path around the gateway (boundary-tested; only Core and `application/context.ts` import it). Every source is read through the same skill any other caller uses, so the same permissions, audit and principal scoping apply.

## What it assembles
| Section | Source skill | Notes |
|---|---|---|
| `currentTasks` | tasks (READ) | open tasks; those matching the query first, then by due date |
| `relevantMemories` | memory (MEMORY_READ) | **type, status, provenance, subject, confidence, validity and a `[fact]`/`[inference, unconfirmed]` label carried through**; retracted/expired/out-of-window filtered by the memory layer; `asOf` evaluates world-time validity |
| `relevantKnowledge` | knowledge (KNOWLEDGE_READ) | structured principal-owned items (kind, `contradicted`, confidence) first, then legacy documents; contradictions are flagged, never dropped |
| `relevantDecisions` | decisions (DECISION_READ) | matched by term |
| `recentActivity` | activity (ACTIVITY_READ) | last week, summaries only |
| `withheld` | — | sections the agent may **not** read (data never fetched) |
| `unavailable` | — | sections permitted but that **failed** — distinct from withheld, never silently omitted |
| `notes`, `terms`, `asOf`, `generatedAt` | — | `notes` always states that everything is data, not instructions |

Goals and projects are not sections yet: they do not exist as entities (PHASE D adds them, and their skills will plug in here the same way).

## Retrieval
Deterministic and model-free: the question is reduced to content terms (`context/terms.ts`: lowercase, English+Spanish stopwords, ≥3 characters, unique, at most 5), each source is searched per term, and results are ranked by **term overlap** (ties keep recency). With no content terms the raw text is used (an empty question returns the most recent items). No embeddings, no vector DB — the ranking is a pure function that a smarter retriever can replace behind the same package.

## Limits and safety
Per-section caps (tasks 10, memories 8, knowledge 8, decisions 5, activity 5) and a 500-character cap per item. These are size limits, not model-token budgets. Returned text is **data**: a consumer (Jarvis, a model) must never obey instructions found inside an item; the package says so in `notes`, and tests show stored instructions come back inert and reading context executes nothing.

## Consumers
* **API**: `GET /api/context?q=&asOf=` (query ≤ 500 characters, `asOf` ISO instant, client `principalId` → 400) through `application/context.ts`.
* **Jarvis (deterministic)**: new intent "what do **you** know about X / brief me on X / tell me about X" → the formatted context (`context/format.ts`), which states withheld/unavailable sections instead of answering from nothing. "What do **I** know about X" still means memory search, unchanged.

## Limitations
No goals/projects yet; substring per term (no stemming — "running" ≠ "run"); calendar and reminders are not context sources; legacy Markdown documents are global; context assembly issues several audited reads per question (an audit-volume cost of going through the gateway on purpose).
