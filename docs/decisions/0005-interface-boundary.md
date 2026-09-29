# 0005 — Core/Interface separation; Telegram is an adapter, not the core

**Status**: Accepted (API already follows this; Telegram not yet built)

## Context

The work order requires: "Do not hard-code the intelligence directly into
Telegram handlers," with a pipeline shape of
`Core → Application services → Tool layer → Interface adapters → Telegram`,
and future interfaces (Web, iPhone, desktop, voice, widgets, command
center) named as coming later.

## Decision

`JarvisCore` (`core/index.ts`) is the single entry point for turning a
piece of user input into a `Result`. It has exactly one method surface
that matters here: `handle({ principalId, input })`. It knows nothing
about HTTP, Telegram, or any other transport.

`api/server.ts` is already an interface adapter, not special-cased logic:
`POST /api/jarvis` does argument validation (zod) and calls
`jarvis.handle(...)`, nothing else. A future `interfaces/telegram/`
module must follow the identical shape: parse a Telegram update into
`{ principalId, input }`, call `jarvis.handle(...)`, format the `Result`
back into a Telegram message. It must not contain its own intent parsing,
its own permission logic, or its own database access — if it needs any of
those, that's a sign the logic belongs in `core/`, a `Skill`, or the
`Gateway` instead.

## Principal resolution across interfaces

Today, `api/server.ts`'s `getOrCreatePrincipal()` is a single-principal
stand-in (see `docs/SECURITY.md` "Known limitations"). A Telegram adapter
will need its own mapping from a Telegram user id to a `principalId` —
this is an interface-layer concern (like the API's future auth layer), not
a `core/` concern. `core/` continues to only ever receive an already-
resolved `principalId`, never a raw Telegram/HTTP identity.

## Consequences

- Adding Telegram means adding `interfaces/telegram/`, a Telegram SDK
  dependency (grammY, per `docs/research/README.md`) scoped to that
  directory, and nothing else changes in `core/`, `skills/`, or
  `gateway/`.
- The same applies to any future interface (voice, widgets, a command
  center) — each is a thin adapter translating its transport's input into
  a `JarvisRequest` and its output from a `Result`.
- Not yet built in this work order — see `docs/ROADMAP.md` for sequencing.
