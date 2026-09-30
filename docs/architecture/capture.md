# Jarvis capture foundation (v1)

```
user sentence → CaptureModelProvider (interprets; untrusted) → strict parse → proposal (server-derived actions)
  → DRAFT (nothing saved) → owner confirms → each mapped ActionDefinition via proposeAction → gateway → database → audit/activity
```

The model is an interpreter, not an authority. It receives only the user's words and a read-only context of *titles* (no ids, no principal, no
credentials) and returns candidates. It never chooses a principal, interface, permission, risk, approval state, action, table, query or destination —
the schema is closed-world (`capture/schema.ts`): unknown top-level keys refuse the whole output; an invalid candidate is refused alone.

| Piece | File |
|---|---|
| Provider port + `ScriptedModelProvider` (test infrastructure; no real provider is bundled) | `capture/provider.ts` |
| Closed candidate vocabulary (8 types) + strict parsing | `capture/schema.ts` |
| Proposal engine (pure): candidate → the ONE existing action, exact parameters, dependencies, hash | `capture/proposal.ts` |
| Draft persistence (immutable content, single-use atomic claim, outcome written once) | `capture/store.ts`, table `capture_proposals` |
| Service: `interpretCapture`, `confirmCapture`, `cancelCapture` | `skills/system/capture.ts` |

Rules enforced: model confidence is shown, never stored; INFERENCE is saved as an *unconfirmed inference* (there is no FACT candidate); a lived-evidence
link accepts only an EXPERIENCE candidate from the same message; references (goal, project, decision, aspiration, experiment) are resolved by exact title among the
owner's own records — none or several matches becomes a clarification, never a guess; each confirmed item goes through `proposeAction` so permission, interface
policy, approval (voice still needs it), audit and activity are unchanged; SYSTEM and unknown interfaces cannot confirm; the stored draft is hash-checked and
only a fixed whitelist of actions can run; a dependent item (a state citing an experience created in the same message) is skipped if its evidence is not saved.

## Which semantic types have a real ActionDefinition behind them
| Candidate | Status | Maps to | Limits |
|---|---|---|---|
| EXPERIENCE | SUPPORTED | `MEMORY_CREATE` (EXPERIENCE, EXPERIENCED) | |
| INFERENCE | SUPPORTED | `MEMORY_CREATE` (INFERENCE, unconfirmed) | never a fact; model confidence not stored |
| DECISION | SUPPORTED | `DECISION_RECORD` | chosen option must match a listed option |
| RESULT | SUPPORTED (GOAL / PROJECT / DECISION subjects) | `RESULT_RECORD` | no task subject exists in the domain (P2 from validation v1) |
| LESSON | SUPPORTED as a standalone LESSON memory | `MEMORY_CREATE` (LESSON) | `LESSON_RECORD` (from an experiment) is not mapped |
| EXPERIMENT_OBSERVATION | SUPPORTED for an *open* experiment named by its hypothesis | `EXPERIMENT_OBSERVE` | cannot create experiments or change their status from a sentence (a status change is a review) |
| FUTURE_SELF_STATE | SUPPORTED only with an EXPERIENCE in the same message as evidence; otherwise reported UNSUPPORTED | `ASPIRATION_STATE_RECORD` | states need evidence by design; existing aspiration only |
| NEXT_ACTION | SUPPORTED | `CREATE_TASK` | the task is not linked to a decision/aspiration |

Not capturable (no candidate type): FACT, KNOWLEDGE, objectives, study sessions, aspiration/experiment creation.

## Wiring
- **API** (`api/captureRoutes.ts`): `POST /api/capture {text}` → a draft (nothing saved; 503 when no interpreter is connected), `POST /api/capture/:id/confirm {accept?}`, `POST /api/capture/:id/cancel {}`. Identity is the token's; strict bodies; another principal's draft is a 404. The interpreter is `createApp({ captureProvider })`; none is bundled, so a default server answers 503.
- **Cockpit** (`#/capture`, `guidehub/public/capture.js`): one screen — write a sentence, see the draft ("Nothing has been saved yet."), tick items, Confirm / Cancel. It sends back only the ticked item numbers. The proxy allow-list gained exactly the three POST routes (28 rules).
- Browser E2E drives it with `guidehub/e2e/api-with-interpreter.ts` (real API + scripted interpreter).

- **Jarvis Core** (`core/index.ts`, `setCaptureProvider`): when a capture interpreter is set, a sentence Core's deterministic router does not understand becomes a draft, shown in words ("I understood: … Nothing has been saved yet. Say “confirm” … or “cancel”."). Deterministic intents (tasks, reminders, "remember that …", searches) always win and never reach the interpreter. Only the exact words `confirm` / `cancel` (a few fixed variants) act, and only on the caller's own newest pending draft from the *same interface* — a "confirm" from Telegram never confirms a cockpit draft, and voice still ends in "Waiting for your approval". With no interpreter set (the default) Core behaves exactly as before. This also lets the cockpit's Ask box and Telegram reach capture once a provider is connected.

## Not built
No real model provider (so a normal server has no interpreter), "remember that …" is still stored as a FACT by the deterministic router (it does not go through capture), no edit beyond confirming a subset, no draft retention job, no rate limit on interpretation.
