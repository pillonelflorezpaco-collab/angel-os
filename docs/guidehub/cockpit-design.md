# GuideHub cockpit — design (v1, no code)

Status: **step 1 is built** (see `README.md`: sign-in/session BFF, Today, Ask Jarvis, Approvals, three inline actions); steps 2–5 are still design only. This document turns the finished Angel OS backend (API v2) into a product design, and records the
rules a UI must follow so it cannot undermine the guarantees the backend enforces. The UI is a **client of `docs/api/README.md`** — it adds no backend behaviour.

## 1. Principles (the cockpit's non-negotiables)

1. **The token is the identity.** The UI never sends or displays a principal id; every request rides on the bearer token. There is no "switch user" and no admin view.
2. **Show what the system knows, honestly.** Derived values keep their meaning on screen:
   - progress `null` → "No evidence yet" (never 0%, never an empty bar); a target reached is "Target reached" — the **owner** presses "Mark achieved".
   - learning minutes are labelled *self-reported*; "due" cards are a plain count; there are no streaks, XP, levels, badges or leaderboards anywhere.
   - a memory that is an INFERENCE is shown as a guess ("Jarvis thinks…") with a *Confirm* action; a FACT is never visually merged with it.
3. **Nothing happens silently.** Every write shows one of four honest outcomes (§4). Approvals are a first-class, always-reachable surface.
4. **Missing and foreign look identical.** A `404` means "not found" — the UI never hints that something exists but belongs to someone else.
5. **Terminal means terminal.** Achieved / completed / done / archived / retired / reviewed items are read-only; the UI offers no "reopen" (the API has none). Changing your mind = create a new item (a new decision supersedes the old).
6. **No hidden state in the client.** The UI is a projection of API reads; anything it caches is invalidated by the next read. It never computes progress, due dates or counts itself.

## 2. Information architecture

```
Today (home)      Life               Future            Learn             Memory & Knowledge   Approvals   Activity   Settings
 briefing          Visions/Goals      Aspirations       Topics            Memories             pending     timeline   Connections
 open tasks        Projects           Metrics           Due cards         Knowledge items      history*               Interfaces
 due reviews       Quests             Readings          Sessions log      Ingest                                   Audit (security)
 approvals         People             Results           Cards
                   Decisions                            
                   Reviews
```
\*Approval history is not exposed by the API yet (only pending + single); see §8.

### Screen → API map

| Screen | Reads | Writes (`POST /api/actions/:skill/:ACTION`) |
|---|---|---|
| **Today** | `GET /context?q=` (briefing: tasks, goals, projects, aspirations, learning, activity; `withheld`/`unavailable` shown), `GET /approvals`, `GET /decisions?dueForReview=true`, `GET /learning/due` | `TASK_COMPLETE`, `CARD_REVIEW`, `DECISION_REVIEW` inline |
| **Life › Goals/Projects/Quests** | `GET /life/overview`, `GET /life/projects/:id` | `GOAL_*`, `PROJECT_*`, `QUEST_*`, `PROJECT_LINK_*`, `CREATE_TASK`, `TASK_UPDATE/CANCEL` |
| **Life › People** | `GET /life/people` | `PERSON_CREATE/UPDATE`, `PERSON_DELETE` (SENSITIVE → approval) |
| **Life › Decisions** | `GET /decisions`, `GET /decisions/:id` | `DECISION_RECORD` (options, evidence picker, expected outcome, review date), `DECISION_REVIEW` |
| **Life › Reviews/Results** | `GET /reviews`, `GET /results?subjectKind&subjectId` | `REVIEW_CREATE`, `RESULT_RECORD` |
| **Future** | `GET /future/aspirations`, `/:id` | `ASPIRATION_*`, `METRIC_CREATE`, `METRIC_READING_RECORD` |
| **Learn** | `GET /learning/topics`, `/due`, `/cards/:id` | `TOPIC_*`, `SESSION_LOG`, `CARD_CREATE/REVIEW/RETIRE` |
| **Memory & Knowledge** | `GET /memory/search`, `GET /knowledge/search|sources|items/:id` | `MEMORY_*` (update/confirm/delete/retract are SENSITIVE), `KNOWLEDGE_*`, `POST /knowledge/ingest` |
| **Approvals** | `GET /approvals`, `GET /approvals/:id` (exact stored parameters) | `POST /approvals/:id/approve|deny` (empty body) |
| **Activity** | `GET /activity`, `/activity/summary` | — |
| **Settings › Connections** | `GET /connections`, `/connectors`, `/integrations/google/calendar/connect` | — |
| **Settings › Audit** | `GET /audit?limit=` (security trace, distinct from Activity) | — |
| **Ask Jarvis** (global command bar) | — | `POST /jarvis {input}` |

Forms are generated from `GET /actions` (`fields`, `risk`, `category`). Field *types and limits* are not in the catalog yet (§8), so v1 forms are hand-authored per action against `docs/api/README.md`; the catalog is used to detect drift (a new action or field the UI does not know is surfaced in a dev-only banner).

## 3. Key flows

**Ask Jarvis.** One command bar on every screen → `POST /jarvis`. Render `message` verbatim. If `status` is `PENDING_APPROVAL`, show the approval card inline (§4). The UI never interprets or rewrites the message; if a model is configured, model text arrives after the OS-written outcome lines and is already labelled "Jarvis says:".

**Approve.** The approval card shows `summary`, `risk`, `expiresAt` (countdown) and — after expanding — the **exact stored parameters** from `GET /approvals/:id`. Buttons send an empty body. The card resolves only from the response: `executed:true` → done; `executed:false` with `execution.status:"FAILED"` → "Approved but it failed" (not "done"); `409` → "Already decided"; `410` → "Expired"; `403` → "This interface can't approve this action" (voice). No optimistic UI.

**Record a decision.** Question → options (2–6, one chosen) → decision + reasoning → **expected outcome** and review date → evidence (pick from own memories / knowledge / tasks; labels shown are the server's snapshots). After the review date the decision surfaces on Today with "Look back": outcome + lesson, once. The screen shows expected vs actual side by side; it never grades them.

**Track an aspiration.** Current → gap → desired → next step (link to a task/quest). Metrics are created with a fixed baseline and target (the form warns: *these cannot be edited later*). Readings are append-only; a worse later reading lowers the shown value — the UI must not smooth or ratchet it.

**Learn.** Due cards are reviewed one at a time (prompt → reveal → grade 0–3). Study sessions are logged manually. Nothing is auto-timed or auto-credited.

## 4. Write outcomes (one component, four states)

| HTTP | Result.status | UI |
|---|---|---|
| 200 | EXECUTED | success toast with `message`; refetch the affected reads |
| 202 | PENDING_APPROVAL | inline approval card (§3); the item does **not** appear in lists yet |
| 403 | DENIED | "You don't have permission to do that." (no retry button) |
| 404 | FAILED (wasn't found) | "That item no longer exists." (refetch the parent list) |
| 422 | FAILED | show `message`; keep the form open with the user's input |
| 400 | — | client bug; log, show a generic error |
| 401 | — | drop the token, return to sign-in |

`withheld` sections in the briefing render as "Not available to Jarvis (no permission)"; `unavailable` as "Couldn't be read right now" with a retry. Neither is ever an empty state.

## 5. Interfaces and tokens

- The cockpit uses a **GUIDEHUB** token. Voice and Telegram are separate interfaces with stricter policy; the UI does not try to emulate them.
- **Open decision (owner):** where the bearer token lives. Recommended: a small **server-side component** (BFF) that holds the token and proxies `/api/*`; the browser holds only a session cookie. A pure browser app would keep a long-lived bearer token in JavaScript (an XSS-exposed secret). CORS stays off unless a pure browser client is chosen.
- Token issue/revoke stays an operator action (`npm run identity`) in v1; there is no in-app token management.

## 6. Non-goals (v1)

Multi-user or sharing; admin/support impersonation; analytics dashboards or gamification; offline mode; editing terminal items; a generic "any action" console for end users (the catalog drives forms, it is not a free-form RPC box); real-time push (poll on focus and after writes).

## 7. Accessibility and quality bars

Keyboard-complete approval flow; status is never conveyed by colour alone (icon + text for ✓ / ⏳ / ✗); dates shown in the principal's timezone from `GET /me`; every list handles empty, loading, error and "withheld" states; respects prefers-reduced-motion and prefers-color-scheme.

## 8. Backend gaps this design surfaced (all optional, none blocking)

1. **Field types/limits in `GET /api/actions`** (only names today) → would allow generated forms and remove hand-authoring.
2. **`GET /api/permissions`** ("what may I do?") so the UI can hide actions that would be `403`.
3. **Approval history** endpoint (only pending + single are exposed).
4. **Pagination/cursors** beyond the server-side caps (lists are capped at 100–200).
5. **`GET /api/life/goals|quests|visions`** direct lists (the overview returns active items only; closed ones are reachable only via ids you already know).
6. **Token management API** if in-app sign-in (rather than operator-issued tokens) is wanted.

## 9. Delivery plan (suggested)

1. Sign-in + session (BFF), `/me`, Today briefing (read-only) + Ask Jarvis + Approvals.  
2. Life (goals/projects/tasks) and People.  
3. Decisions + Results + Reviews.  
4. Future + Learn.  
5. Memory & Knowledge, Activity, Settings.  

Each step ships only screens whose every write outcome (§4) and read state (§1.2) is handled; the API contract tests in `tests/api-life.test.ts` are the reference for expected statuses.
