# GuideHub cockpit — running it (step 1)

Step 1 of `cockpit-design.md`: **sign-in + session, the Today briefing, Ask Jarvis, approvals, and three inline actions** (complete a task, look back on a
decision, review a recall card). Everything else in the design is later steps.

## What it is

`guidehub/` is a small **server-side component (BFF)** plus a static, dependency-free frontend (vanilla ES modules, no build step):

```
browser ──(session cookie)──▶ guidehub/server.ts ──(cockpit's own bearer token)──▶ Angel OS API  /api/*
                              serves guidehub/public/*
```

- It imports **nothing** from the backend and has no database: it is a pure HTTP client of the API (`docs/api/README.md`). A boundary test enforces this.
- The API token lives **only on the server**. The browser holds an opaque, HttpOnly, SameSite=Strict session cookie (server-side session, real logout, 12 h absolute / 2 h idle).
- The proxy is **default-deny** (`guidehub/proxy.ts`): only the allow-listed method+path pairs reach the API — today `me`, `context`, `approvals` (+ approve/deny with an empty body),
  `jarvis`, `decisions`, `learning/due`, and the three inline actions. Grow the list one screen at a time, with a test.

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

- `tests/guidehub-bff.test.ts` — config, hashing, sessions, throttle, cookie flags, CSRF/origin, proxy allow-list, header hygiene (28 tests, 18 mutants killed).
- `tests/guidehub-ui.test.ts` — the design's rules as pure functions (outcomes, "No evidence yet", withheld/unavailable, guesses labelled) + static frontend safety checks.
- `guidehub/e2e/smoke.cjs` — **opt-in** Chromium run against the real API + cockpit (22 checks, screenshots). Header lists the environment variables.

## Known limits (step 1)

Single owner, one cookie session store in memory (a restart signs everyone out); no in-app token management; no offline mode; forms for later screens are not built; the briefing shows what
`GET /api/context` returns (a focus box narrows it). See `cockpit-design.md` §8 for backend gaps that would help later steps.
