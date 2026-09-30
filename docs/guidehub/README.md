# GuideHub cockpit — running it (steps 1–3)

**Step 1** (`cockpit-design.md` §9): sign-in + session, the Today briefing, Ask Jarvis, approvals, and three inline actions (complete a task, look back on a decision, review a recall card).
**Step 2 — Life:** `#/life` (visions, goals, projects with plain task counts, open quests, people, and a read-only **History** of everything closed) and `#/life/projects/<id>`
(quests with the owner's own "done when" criteria, tasks, linked people and knowledge). Everything else in the design is later steps.

Life rules the UI enforces (and tests pin): closing something (achieve, abandon, complete, archive) is a guarded, explicit act — abandoning needs a written reason;
a quest must be started before it can be completed and its "done when" is required; **closed items are read-only** (no reopen control exists — the API has none); only transitions the API
allows are offered (the server stays the authority); deleting a person is a **request** — the screen says "Sent for your approval — nothing has changed yet", the approvals badge in the header
updates at once, and the person stays until you approve it on Today. Dates are calendar dates stored as noon UTC so the same date shows everywhere.

**Step 3 — Decisions:** `#/decisions` (what is due for a look-back, everything else, and a record form) and `#/decisions/<id>`.
- **History, not a form to edit.** A decision is recorded once with its question, 2–6 options (one chosen), reasoning, an *expectation* and a look-back date. There is no edit control anywhere (a test forbids one). To change your mind you record a NEW decision that replaces the old one; the old one stays exactly as written, shows "Replaced by…", and can't be replaced twice.
- **Evidence is a pointer, not proof.** Attach a note, or reference one of your own memories, knowledge items or tasks through read-only pickers; the UI never sends a label — the server writes the snapshot from your own row, so a guess (inference) does not become a fact by being cited.
- **The look-back is once, and never graded.** What you expected sits next to what happened; the lesson is optional; afterwards the page says "This is final". Nothing on the page scores or judges the outcome.
- **Results** about a decision are append-only notes; a measurement needs both a value and a unit (zero is a real value).
- A due-for-review decision that was already replaced is never offered as "time to look back" (the list marks it from the newer decision that names it).

## What it is

`guidehub/` is a small **server-side component (BFF)** plus a static, dependency-free frontend (vanilla ES modules, no build step):

```
browser ──(session cookie)──▶ guidehub/server.ts ──(cockpit's own bearer token)──▶ Angel OS API  /api/*
                              serves guidehub/public/*
```

- It imports **nothing** from the backend and has no database: it is a pure HTTP client of the API (`docs/api/README.md`). A boundary test enforces this.
- The API token lives **only on the server**. The browser holds an opaque, HttpOnly, SameSite=Strict session cookie (server-side session, real logout, 12 h absolute / 2 h idle).
- The proxy is **default-deny** (`guidehub/proxy.ts`): only the allow-listed method+path pairs reach the API — `me`, `context`, `approvals` (+ approve/deny with an empty body),
  `jarvis`, `decisions`, `learning/due`, the Life reads (`life/overview|history|people|projects/:id`), the Decisions reads (`decisions/:id`, `results`, and read-only `memory/search`, `knowledge/search`, `tasks` pickers), and 25 named actions. Grow the list one screen at a time; a test pins the exact 19 rules.

## Configure and run

```bash
# 1. a GUIDEHUB token for the cockpit (an operator action; shown once)
npm run identity -- create-token <principalId> GUIDEHUB cockpit
# 2. the sign-in passphrase (prompted, hidden; prints an scrypt hash — nothing is stored)
npm run guidehub:password
# 3. start (API must be running; see docs/api/README.md)
GUIDEHUB_API_TOKEN=aos_… GUIDEHUB_PASSWORD_HASH='scrypt$…' GUIDEHUB_API_URL=http://localhost:3000 npm run guidehub
```

| Variable | Meaning |
|---|---|
| `GUIDEHUB_API_TOKEN` | required; the cockpit's own `aos_…` token (never sent to the browser) |
| `GUIDEHUB_PASSWORD_HASH` | required; from `npm run guidehub:password` |
| `GUIDEHUB_API_URL` | API base, default `http://localhost:3000` |
| `GUIDEHUB_PORT` / `GUIDEHUB_HOST` | default `3100` / `127.0.0.1` (bind wider only behind TLS) |
| `GUIDEHUB_PUBLIC_ORIGIN` | exact origin the browser uses (e.g. `https://cockpit.example.com`); unsafe requests with another `Origin` are refused |
| `GUIDEHUB_INSECURE_COOKIES=1` | **plain-http localhost development only**: drops `Secure` and the `__Host-` cookie prefix |
| `GUIDEHUB_TRUST_PROXY=1` | only when behind a reverse proxy you control (affects the client address used for sign-in throttling) |

A missing or malformed token/hash **refuses to start**. Run it behind HTTPS in any real deployment.

## Security model in one paragraph

Sign-in is a single-owner passphrase (scrypt, constant-time compare) with per-client and global attempt throttling (429 + `Retry-After`) and a fresh session id on every sign-in.
State-changing requests need the `X-Requested-With: guidehub-cockpit` header and a matching `Origin` (if sent), on top of SameSite=Strict. Responses carry a strict CSP
(`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`), `nosniff`, no-referrer and `no-store` for dynamic routes. The frontend never parses markup
(text only), never handles a principal id or token, and never computes progress/due/counts itself. An upstream `401` is reported as a server misconfiguration (502), never as "sign in again".

## Tests

- `tests/guidehub-bff.test.ts` — config, hashing, sessions, throttle, cookie flags, CSRF/origin, the exact proxy allow-list (default deny), header hygiene.
- `tests/guidehub-ui.test.ts` — the design's rules as pure functions (outcomes, "No evidence yet", allowed transitions, terminal states, form→body, routes) + static safety checks across every frontend module (text-only rendering, one fetch wrapper, every call is an allowed route).
- `guidehub/e2e/smoke.cjs` — **opt-in** Chromium run against the real API + cockpit (101 checks, including the Capture screen: sign-in, Today, the whole Life and Decisions journeys, Future Self and Learning views, cross-principal and allow-list probes, phone width, dark mode; screenshots). Optional `GUIDEHUB_E2E_API_TOKEN_B` (a second principal's token) enables the cross-principal checks. Header lists the environment variables.

## Known limits (step 1)

Single owner, one cookie session store in memory (a restart signs everyone out); no in-app token management; no offline mode; reviews (periodic look-backs) are not in the cockpit yet; visions and quests can be created/closed but not edited (the proxy does not allow `VISION_UPDATE`/`QUEST_UPDATE` yet); knowledge links on a project are shown but not editable (Knowledge screen comes later); forms for later screens are not built; the briefing shows what
`GET /api/context` returns (a focus box narrows it). See `cockpit-design.md` §8 for backend gaps that would help later steps.
