# Permissions — implementation reference

Full design and security guarantees live in `docs/SECURITY.md`. This
document is the quick-reference mapping from the work order's permission
vocabulary to what's implemented.

## READ / WRITE / EXECUTE, with risk examples

The work order gives concrete examples of where each category sits. Here
is Angel OS's actual behavior for each:

| Example from the work order | Category | Current implementation |
|---|---|---|
| Reading calendar | READ | `skills/integrations/calendar.ts`, action `READ`, seeded `ALLOWED` |
| Creating a calendar event | WRITE | Not implemented — `GoogleCalendarConnector` declares no `calendar.write` capability at all (see `docs/ARCHITECTURE.md` "Google Calendar connector"); adding it means a new capability + a new, separately-seeded permission row, never inherited from `READ` |
| Sending an email | EXECUTE | Not implemented — `communication.gmail` exists only as an illustrative seeded placeholder (`db/seed/seed.ts`), `SEND_EMAIL` seeded `APPROVAL_REQUIRED` as an example of the pattern, no real Gmail skill exists |
| Sending a Telegram message | EXECUTE | Not implemented — no Telegram interface exists yet (see `docs/decisions/0005-interface-boundary.md`) |
| Deleting important information (HIGH-RISK EXECUTE) | EXECUTE, and should default `DENIED` or `APPROVAL_REQUIRED` | No delete-capable skill exists yet. `memory/local/index.ts`'s `deleteMemory` exists at the provider level but is not currently exposed through any Skill action — see Gaps below |
| Financial transaction (VERY HIGH RISK) | EXECUTE | Not implemented; `docs/SECURITY.md`'s example permission table shows `EXECUTE_TRANSACTION` seeded `DENIED` as the illustrative default for exactly this reason |

## "Asked once ≠ unlimited future permission"

This is enforced structurally, not by convention: every action requires a
`Permission` row scoped to the exact `(principal, agent, skill, resource,
action)` tuple, looked up fresh on every call (`gateway/permissions/
index.ts`'s `checkPermission`). There is no session-level or
conversation-level grant that persists across calls without a `Permission`
row backing it — asking Jarvis to do something once creates no standing
authorization for next time.

## Confirmation gates (Human Confirmation, §11 of the work order)

Implemented as `PermissionState.APPROVAL_REQUIRED` →
`ApprovalRequest`. See `docs/SECURITY.md` "Approval workflow" for the
full state machine (principal-scoped, atomic, one-time-use) and "Approval
execution contract" for the binding rule any future approval→execution
wiring must follow — this is the mechanism behind every one of the work
order's confirmation examples ("Send this email?", "Create this
appointment?", etc.), once a skill that needs them is built.

## Gaps vs. the full vision

- **Per-row delete/high-risk actions**: not yet exposed through any Skill
  — `docs/decisions/0002-memory-architecture.md`'s memory layer has the
  provider method, but no Skill wraps it in a gateway-checked action yet.
  Do not call `MemoryProvider.deleteMemory` from a future Skill without
  seeding its own explicit permission row (likely `APPROVAL_REQUIRED` by
  default, per the work order's own "HIGH-RISK EXECUTE" example).
- **Permission inspection UI**: "Permissions should be explicit and
  inspectable" — today inspectable only via direct DB query or
  `GET /api/audit` (which shows permission *changes*, not the current
  permission table). No `GET /api/permissions` route exists yet.
