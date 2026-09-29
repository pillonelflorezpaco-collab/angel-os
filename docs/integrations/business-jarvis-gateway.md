# Future: the Business Jarvis Gateway (Personal Jarvis ↔ BlackOS)

**Status: interface defined, NOT implemented.** `gateway/bridge/index.ts`
remains a disabled placeholder (`isEnabled(): false`). Nothing in this
document authorizes building it — it exists so that when it is built, it
is built correctly, and so this repository never quietly grows an ad hoc
connection to BlackOS instead.

## The ecosystem, as designed

```
                    JARVIS ECOSYSTEM
                           |
              +------------+------------+
              |                         |
       PERSONAL JARVIS             BUSINESS JARVIS
       (this repository,               (BlackOS,
        "Angel OS")                  separate repo)
              |                         |
       Personal world              Black Circle
              |                         |
              +------------+------------+
                           |
                 FUTURE SECURE BRIDGE
              (Business Jarvis Gateway)
```

## Hard boundaries (do not weaken these later without a new decision doc)

- Personal Jarvis never gets a direct connection string to BlackOS's
  Postgres or Neo4j. Not a read replica, not a read-only user, not "just
  for reporting." See `docs/ARCHITECTURE.md` "Bridge to Business Jarvis /
  BlackOS" and `docs/decisions/0003-graph-memory.md`'s closing paragraph.
- BlackOS never gets a direct connection to Personal Jarvis's database
  either — the bridge is bidirectional in principle (Personal Jarvis
  requesting business context; BlackOS's own Jarvis potentially checking
  personal availability) but always mediated, never a shared schema.
- Every bridge request still goes through THIS repository's own Gateway
  (`gateway/index.ts`) — the bridge is a Connector-shaped integration
  (see `docs/ARCHITECTURE.md` "Connector Layer"), not a bypass of it.
  Concretely: a future `BusinessJarvisConnector implements ConnectorProvider`
  would report capabilities like `business.briefing.read`, and a future
  `skills/integrations/business.ts` would call it exactly the way
  `skills/integrations/calendar.ts` calls `GoogleCalendarConnector` today
  — gateway-checked, permission-scoped, audited.

## What Personal Jarvis should eventually be able to request

Per the work order, all **read-only from Personal Jarvis's side** and all
**explicitly authorized, not assumed**:

- business briefing
- business task status
- business KPI summary
- business calendar context
- business research
- approved business actions (i.e., actions BlackOS itself has already
  cleared — Personal Jarvis triggers, never approves, a business action)

## What this means architecturally, before any code exists

1. **BlackOS defines and hosts the gateway API**, not this repository —
   Personal Jarvis is a client of it, the same relationship it has to
   Google's Calendar API today.
2. **Authentication is credential-based**, using the same `CredentialStore`
   abstraction already built (`connectors/credentials/`) — a Business
   Jarvis Gateway API key resolved through `CredentialStore`, never
   hardcoded, never logged, following the exact pattern
   `skills/integrations/calendar.ts` already uses for Google.
3. **Scope is minimal and explicit** — a "business briefing" capability
   does not mean unrestricted BlackOS API access; it means one narrow,
   named, read-only capability with its own `Permission` row, exactly the
   way `calendar.read` (not "full Google account access") is what's
   actually granted today.
4. **Personal data never flows to BlackOS by default.** If a future
   feature needs to share a specific personal fact with Business Jarvis
   (e.g., "I'm unavailable this afternoon" informing a business
   scheduling decision), that is its own explicit, narrowly-scoped,
   separately-permissioned capability — never a blanket sync. This is
   also why `docs/decisions/0002-memory-architecture.md` flags a
   per-memory privacy classification as a gap to close before any bridge
   work begins: today there is no field marking a `Memory` row as
   "personal only, never bridgeable," and that gap must close first.

## Explicitly not done in this work order

No `BusinessJarvisConnector`, no bridge API client, no new `Permission`
rows for business capabilities, no schema change. This document is the
target shape for when that work is explicitly requested.
