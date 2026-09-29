# Memory OS (Build #9, PHASE A)

Structured personal memory: **information about Angel**. Knowledge (information about the world) is a separate layer with its own skill and provider; there is no code path from one to the other.

## What already existed and was kept
Principal-scoped provider (every query is `id AND principalId`), INFERENCE created UNCONFIRMED at reduced confidence and staying an INFERENCE after confirmation, query-time expiry, the BUILD #8 ActionDefinitions (create LOW; update/confirm/delete SENSITIVE), gateway READ lane for search.

## What Build #9 added (only what was missing)

| Gap | Addition |
|---|---|
| Free-text `source` only | `provenance` (STATED / OBSERVED / EXPERIENCED / INFERRED), `sourceRef`, `derivedFromId` (an inference's evidence, a lesson's experience) |
| No world-time validity | `validFrom` / `validUntil` (world time) beside `expiresAt` (system lifetime); `occurredAt` for experiences; retrieval takes `asOf` |
| Missing concepts | types `LESSON`, `RELATIONSHIP`, `CONTEXT`; `subject` (who/what it is about) |
| RETRACTED had no writer | `MEMORY_RETRACT` (SENSITIVE): non-destructive, keeps the record and a reason, never retrieved as belief again |
| Updates overwrote silently | append-only `memory_revisions`: the state *before* every approved update/confirm/retract, with request id, interface and approval id |
| Semantics only in code | database CHECKs + guard trigger (below) |

## Semantic separation (enforced in three places: ActionDefinition schema → provider → database)
* `type INFERENCE ⇔ provenance INFERRED`: a belief cannot be relabeled as a fact, and a fact cannot claim to be inferred.
* `type EXPERIENCE ⇒ provenance EXPERIENCED`; `EXPERIENCED` only for EXPERIENCE/LESSON.
* An unconfirmed inference can never have full confidence; confirming promotes **status and confidence, never type**.
* **Owner, type, provenance, creation time and origin link are immutable** (trigger `memories_guard`). No ActionDefinition parameter can carry them.
* Status only moves forward: UNCONFIRMED → ACTIVE → EXPIRED/RETRACTED; RETRACTED and EXPIRED are terminal.
* `derivedFromId` must be the same principal's memory. Turning an inference into a fact is only possible as a **new** FACT created explicitly with a link back — the inference itself is untouched.
* KNOWLEDGE → MEMORY never happens implicitly: neither `memory/` nor the memory skill imports knowledge (boundary-tested); provenance `sourceRef` is descriptive text, never authority.

## Lifecycle
`create → (confirm) → update* → retract | expire | delete`. Delete remains a hard, approved removal (it also removes the history); retract is the non-destructive alternative. Expiry and validity are filtered at query time (no sweep needed for correctness).

## Security (unchanged model, extended)
| Action | Risk | Voice | Notes |
|---|---|---|---|
| `MEMORY_CREATE` | LOW | approval | strict schema incl. provenance/validity; invariants rejected **before** an approval exists |
| `MEMORY_UPDATE` | SENSITIVE | approval, cannot approve | content, confidence, subject, validity; not type/provenance/status |
| `MEMORY_CONFIRM` | SENSITIVE | same | |
| `MEMORY_RETRACT` | SENSITIVE | same | reason required |
| `MEMORY_DELETE` | SENSITIVE | same | hard delete |
| reads: search / get / history | READ lane (`MEMORY_READ`) | direct | audited with a `payloadHash`, never raw content |

Updates/confirm/retract lock the row (`FOR UPDATE`) in one transaction with the revision insert, so concurrent changes serialize and every revision captures the state it actually replaced. The provider still performs no authorization beyond ownership.

## API
`GET /api/memory/search?q=&type=&subject=` (type validated against the enum). No public route for mutations. `get`/`history` are skill functions (READ lane) ready for GuideHub.

## Limitations / not in this phase
No relevance ranking, embeddings or graph; `person`/`project` links are free-text `subject` until Life OS; no expiry sweep (query-time only); revision rows are append-only against UPDATE but a direct SQL DELETE (admin) is not blocked; Core has no natural-language intents for the new fields yet.
