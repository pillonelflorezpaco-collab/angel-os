# Interfaces & Identity (Build #5)

One brain, many interfaces. GuideHub, Telegram, voice, mobile, and direct
API clients all reach the **same** backend through the **same** entry
point. Nothing is duplicated per interface: not memory, not tasks, not
knowledge, not permissions, not audit.

```
Interface (adapter: translate transport ⇄ text)
   → Authentication / Identity   (Authenticator → IdentityContext)
   → Dispatcher                   (application/dispatcher.ts — the one door)
   → Jarvis Core → Skill → Gateway → Data / Connector → Audit
```

## Identity

`IdentityContext` (`identity/types.ts`) = `{ principalId, interfaceSource,
authMethod, requestId, credentialId?, metadata? }`. It is **frozen** and can
only be created by an authenticator or by an adapter that has resolved an
external identity. A client can never supply, choose, or override it.

| Credential | Table | Proves | Interface comes from |
|---|---|---|---|
| Bearer API token (`aos_…`) | `api_tokens` (SHA-256 hash only) | Who the caller is | The token (fixed at issue time) |
| Linked external account (e.g. Telegram user id) | `external_identities` | Who sent a message on another platform | The adapter (`TELEGRAM`) |
| OAuth `state` | `oauth_states` | Which principal started a Google authorization | Fixed: `API` |

- **Issuing credentials is CLI-only** (`npm run identity -- …`). No HTTP
  route can create a token or a link, so a client cannot mint access.
- A token's plaintext is shown once at creation and never stored. Losing it
  means issuing a new one.
- `(interface, externalId)` is unique: one external account belongs to
  exactly one principal; re-linking requires an explicit unlink.
- **`principalId` is rejected if a client sends it** — body (any depth),
  query string, or `X-Principal-Id` header — with `400`, even when it equals
  the caller's own id. Silently ignoring it would hide bugs and attacks.
- `findFirst()` principal resolution is gone. Without a credential a request
  is `401`; there is no fallback identity.

### Defence in depth: the request context

The authenticated identity is carried through the request in an
`AsyncLocalStorage` (`identity/context.ts`). It is **not** how skills learn
the principal (they still receive `principalId` explicitly). It is used for
two things only:

1. `recordAuditEvent` and `recordActivity` stamp `interfaceSource` and
   `requestId` from it, so every row says where it came from.
2. `gatewayExecute` refuses any action whose `principalId` differs from the
   authenticated identity (`ACTION_DENIED`, reason `principal_mismatch`,
   recorded against the *requester*). A buggy route or adapter that passes
   the wrong principal cannot act on someone else's data.

## Interface model

`identity/interfaces.ts`: `GUIDEHUB · TELEGRAM · VOICE · MOBILE · WEB · API`.
An interface is only an adapter. **There is no per-interface business logic
anywhere.** The same text from Telegram and from GuideHub reaches the same
skill and produces the same result and the same audit trail, differing only
in `interfaceSource` (tested).

Adapter rules, enforced mechanically by `tests/interfaces-boundary.test.ts`:

- `interfaces/**` may not import `db/`, `skills/`, `gateway/`, `memory/`,
  `knowledge/`, `context/`, `connectors/`, or Prisma — only `identity/`,
  `core/`, and each other. (`db/cursors.ts` and `scripts/telegram.ts` are
  composition-root wiring outside `interfaces/`.)
- `api/` has no database, memory, knowledge, or context access. Google's
  authorization logic moved to `connectors/google/authorization.ts` so the
  HTTP layer is pure HTTP.
- `core/` has no database or memory access.
- No adapter reads a principal from a request field.

## Telegram

`interfaces/telegram/` — adapter, Bot API client, poller. `npm run telegram`
(needs `TELEGRAM_BOT_TOKEN`). Long polling; no public URL or open port.

- Answers only **private chats from linked users**. Group/channel chats,
  bots, non-text updates, and unlinked senders get **no reply** (an unlinked
  sender gets no hint of what the bot is or does).
- Replies are plain text (no `parse_mode`), truncated for Telegram's limit.
- Input over 2000 characters is refused before Jarvis sees it.
- **At-most-once delivery:** the poll cursor (`interface_cursors`) advances
  *before* an update is handled, so a crash never replays a message that may
  have created a task. A dropped message costs the user a resend; a
  duplicate side effect costs more.
- Bot-API errors are rebuilt from method + HTTP status only: the token lives
  in the request URL, so raw errors are never propagated.
- Supports the existing READ and low-risk WRITE intents only. There is no
  EXECUTE skill, so nothing dangerous is reachable.

## Voice (abstraction only)

`interfaces/voice/`: `VoiceSession`, `VoiceInput`, `VoiceOutput`, and
`VoiceDeviceAdapter` (a vendor's `parseRequest` / `renderResponse`), plus
`handleVoiceInput`. No vendor is named in code. Two differently-shaped fake
vendors are tested against the same backend. Voice-specific safety:
transcripts below `MIN_VOICE_CONFIDENCE` are never sent to Jarvis (a
misheard command is the main risk of voice), and only a `VOICE` identity may
call it.

## Activity vs audit

|  | Audit (`audit_logs`) | Activity (`activities`) |
|---|---|---|
| Answers | What did the system do, and was it allowed? | What happened in my life? |
| Written by | The gateway, for every action incl. denials/failures | Skills, only when something meaningful happened |
| Denied action | Recorded (`ACTION_DENIED`) | Not recorded |
| Contains content? | Never | References (`refType`/`refId`) + a generic summary, never a copy |
| Audience | Security / debugging | The user's dashboard |

They share no table and no code path (tested). Activity is best-effort by
design: a failure to record it never fails the action that already
succeeded. Currently produced by: creating a memory (`MEMORY_CREATED`). The
ten types (`TASK_COMPLETED`, `QUEST_COMPLETED`, `LEARNING_SESSION`,
`KNOWLEDGE_ADDED`, `HABIT_COMPLETED`, `GOAL_PROGRESS`, `ACHIEVEMENT`,
`MEETING`, `DECISION`, `MEMORY_CREATED`) exist so future skills have a
place to write; quests, learning, and habits do not exist yet. Reads go
through the gateway (`system.activity` / `ACTIVITY_READ`); ranges
(`today`, `yesterday`, `week` = Monday-start) use the principal's timezone.

## GuideHub

Nothing in this repository referenced GuideHub before this build, so there
were no existing assumptions to audit. The API is designed against a
generic client and documented in `docs/api/README.md`. Decisions that need
GuideHub's real shape are listed there.

## Limitations

- No rate limiting anywhere.
- Tokens don't expire (revocation only).
- Unlinked Telegram senders can't be audited (audit rows need a principal);
  they are only ignored.
- `GET /api/audit` and `GET /api/approvals` are principal-scoped but not
  permission-gated through a skill.
- The Telegram poller and Bot API client were never run against real
  Telegram (no bot token here) — verified with fakes only.
- Reminder lists include past reminders; reminders still never fire.
