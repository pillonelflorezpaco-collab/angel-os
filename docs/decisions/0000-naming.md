# 0000 — "Angel OS" and "Personal Jarvis" are the same project

**Status**: Accepted

## Context

The project was scaffolded and built across three implementation builds
under the repository name `angel-os`, with the principal referred to as
"Angel." A later work order described a project called "Personal Jarvis" —
a personal Chief of Staff, architecturally separate from BlackOS (the
business system), with a future secure bridge between the two — in enough
detail to be mistaken for a new project.

On inspection, "Personal Jarvis" as described is not a different system:
it is the same core architecture already implemented (Core/Skill/Gateway
separation, layered memory, READ/WRITE/EXECUTE permissions with an
approval gate, a documented-but-unbuilt BlackOS bridge, Telegram named as
a future interface kept out of the core). Rebuilding it under a second
repository would duplicate three builds' worth of tested, working code for
no architectural benefit.

## Decision

Continue development in the existing `angel-os` repository. Treat
"Personal Jarvis" as the product/vision name for the same system "Angel
OS" is the codebase name for — the way a company might have an internal
codename and a public product name. Documentation may use either name;
code, package name, and repository name stay `angel-os` unless the user
explicitly asks for a rename.

## Consequences

- No new repository was created for this work order.
- The research and architecture-decision documents this work order asked
  for (`docs/research/`, `docs/decisions/`) are added to the existing
  repository, describing and validating the system as it already exists,
  and flagging genuine gaps as roadmap items rather than as a rebuild.
- Where the work order's proposed structure
  (`src/core/`, `src/agents/`, etc.) differs from this repo's existing
  layout (`core/`, `skills/`, `gateway/`, `connectors/`, no top-level
  `src/`), the existing layout is kept — see 0004 for why.
