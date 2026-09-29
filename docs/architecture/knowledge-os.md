# Knowledge OS (Build #10, PHASE B)

Structured **knowledge about the world**, owned per principal. Memory (information about Angel) is a separate layer; there is no conversion path in either direction (different tables, no shared code, boundary-tested).

## Model (Postgres, no graph database)
| Entity | Purpose |
|---|---|
| `knowledge_sources` | SOURCE: where knowledge came from (note, markdown, book, url *reference* — nothing is ever fetched). Unique `(principalId, contentHash)`: identical content is never ingested twice. |
| `knowledge_items` | Typed knowledge: `FACT CONCEPT PRINCIPLE METHOD PERSON EVENT DATE QUESTION HYPOTHESIS INSIGHT CONTRADICTION EXPERIENCE`. `origin` INGESTED (has a source) or MANUAL (none). Optional `confidence`, `eventAt`. `EXPERIENCE` here means a *documented* case in the world — Angel's own experiences are Memory. |
| `knowledge_relations` | `RELATED_TO EXPLAINS SUPPORTS CONTRADICTS CAUSES EXAMPLE_OF APPLIES_TO INSPIRED_BY DERIVED_FROM PART_OF SIMILAR_TO`, between two items of the same principal. |

A graph database was deliberately not introduced: one-hop relations in Postgres cover retrieval today, and the relation table keeps the door open (recursive queries or a graph store can be added behind the same store interface).

## Ingestion pipeline (`knowledge/pipeline`, pure and deterministic)
`INGEST → PARSE → EXTRACT → CLASSIFY → CONNECT → STORE → RETRIEVE`
* **PARSE**: strips control characters, normalizes line endings, splits markdown headings (fenced code is not structure). Limits: 100k characters, 200 items, 200-char titles, 8000-char bodies (a shortened body is *reported*, never silent).
* **EXTRACT/CLASSIFY**: an unmarked heading is a `CONCEPT` (a described subject). `FACT`, `HYPOTHESIS`, `INSIGHT`, `PRINCIPLE`… appear **only** where the text says so explicitly (`Fact: …`, `## Method: …`). Nothing is guessed; a hypothesis starts at confidence 0.5; EVENT/DATE items read a real ISO date. Text before the first heading is kept as its own concept.
* **CONNECT**: heading nesting becomes `PART_OF`; further relations are explicit (`KNOWLEDGE_RELATE`).
* **Pluggable**: a model-based extractor can implement `Extractor` later; it may only *propose* candidates, which pass through the same validation and the same ActionDefinition. No model is used today.
* **STORE** (`knowledge/store`): one transaction per ingest; concurrent identical ingests collapse to one source.
* Ingested text is **data, never instructions**: it is stored verbatim as inert text, nothing in it can execute, create memory, or change permissions (tested with hostile content). Anything that later feeds it to a model must keep treating it as data.

## Semantic separation and database invariants
* Owner, `kind`, `origin`, `createdAt` and `sourceId` are immutable (trigger): a HYPOTHESIS can never be edited into a FACT. `RETRACTED` is terminal.
* `origin = INGESTED ⇔ sourceId is set`; confidence within 0..1; a relation cannot be a self-relation and **cannot join items of different principals** (trigger — enforced even if the skill is bypassed).
* Contradictions are surfaced: search marks an item `contradicted` when an ACTIVE item CONTRADICTS it; both stay visible. Retracting one side clears the flag.

## Security (BUILD #8 model)
| Action | Risk | Voice | Notes |
|---|---|---|---|
| `KNOWLEDGE_INGEST` | LOW | approval | strict schema; deduplicated by content hash; Activity `KNOWLEDGE_ADDED` (no content) |
| `KNOWLEDGE_ADD` | LOW | approval | manual item |
| `KNOWLEDGE_RELATE` | LOW | approval | both endpoints must be the caller's active items |
| `KNOWLEDGE_RETRACT` | LOW | approval | soft, terminal, reason required |
| `KNOWLEDGE_DELETE_SOURCE` | SENSITIVE | approval, cannot approve | destroys the source and everything derived |
| reads: search / get item / list sources | READ lane (`KNOWLEDGE_READ`) | direct | audited with a `payloadHash`, never raw queries |

Explicit `IdentityContext` everywhere; ownership enforced in every query (`id AND principalId`); the store performs no authorization beyond ownership. **This resolves the earlier "global knowledge" limitation for structured knowledge**: content is now per principal. The three Markdown files remain as a *legacy, read-only, global* document provider behind the same READ permission (they are not migrated automatically; ingest them as sources to make them principal-owned).

## API (GuideHub-ready, no UI)
`GET /api/knowledge/search?q=&kind=&limit=` · `GET /api/knowledge/items/:id` · `GET /api/knowledge/sources` · `POST /api/knowledge/ingest {title, content, format?, sourceKind?, uri?}` (strict body; a VOICE credential gets an approval request). JSON body limit is 256kb.

## Context
The context engine reads structured items through `searchKnowledgeItems` (and legacy documents through `searchKnowledge`), both READ-permission-checked and audited. Items carry `kind`, `contradicted`, `confidence`; the section is `withheld` only when neither source is readable.

## Limitations / not in this phase
No relevance ranking or embeddings (substring search); no model-based extraction; no file/URL fetching; relations are one hop in reads; no interface for editing items (retract + re-add) or for `KNOWLEDGE_DELETE_SOURCE` beyond the skill; the legacy `knowledge_documents` table stays unused; legacy Markdown documents are global.
