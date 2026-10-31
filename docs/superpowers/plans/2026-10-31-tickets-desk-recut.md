# Tickets Desk Re-cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-cut the Tickets module's main page (the agent desk) so it reads like a desk: one bar with work queues and live counts, rows that say what bites next, keyboard flow, phone counts, and an optional preview pane.

**Architecture:** The list page stays client-filtered over the tickets TasksContext already holds; a new pure module `tickets/queues.js` defines the queues (predicate, count, default sort) and `TicketsView.jsx` swaps its scope pills + tiles for `ModuleTabs` driven by it. The server adds one `needsReply` flag per row inside `list_tickets` (it already fetches the latest public comment). Rows get a "Next Clock" (`ticketMeta.nextClock`) and an Updated column; the column kit learns `defaultHidden`. `TicketDrawer` gains an `inline` shell plus Previous / Next so the same component fills a right-hand pane.

**Tech Stack:** React 19 + Vite, inline styles + `tasks/theme`, `components/ModuleTabs.jsx`, `tasks/tableCols.jsx`; FastAPI + SQLAlchemy.

**Spec:** Review + decisions page https://claude.ai/artifact/LAiCyqnBT8Rdbtm7Gvd8xR (Neil, 10/31/2026: all five decisions approved; preview pane built now).

## Global Constraints

- American English, Title Case for tab labels / buttons / column headers, sentence case for hints. MM/DD/YYYY and 12-hour times via `lib/datetime` (`formatDate` / `formatDateTime`); never `toLocale*`.
- No em dashes in user-facing copy.
- Keep intact: honest SLA and pauses; soft `StatusLabel` / `PrioritySignal` (Neil, Oct 14); no one-click resolve (Neil, Sep 30 / Oct 19); Latest Comment opens the Conversation (Neil, Oct 1); inline status / priority from the row (Pranshu); the bulk pill; Board; Reports; the HR desk chip (`deskFilter`); the amber Unassigned call to act (Pranshu, Oct 6).
- Shared files (`components/ModuleTabs.jsx`, `tasks/tableCols.jsx`, `api.js`, `models.py`) are append-only, minimal diff.
- Never a second bulk path; never loop POST. Tests: `npx vitest run <file>`; backend `backend/.venv/bin/python -m pytest backend/test_tickets*.py` one file per process.
- Phones (`useIsMobile()`) keep cards, the filter sheet and `MobileTaskBar`; the preview pane is desktop only.

## Review Focus

1. A saved view made before this change (`filters.scope` = 'all' | 'mine' | 'assigned' | 'approve' | 'route') must still apply: map to a queue, never ignore.
2. The dashboard / bell deep links (`nexus:ticket-filter` 'unassigned' / 'assigned', `takePendingOpen('ticketFilter')`) must land on the Unassigned / Mine tabs.
3. A ticket the requester filed for themselves and works themselves (`requesterId === assigneeId`) must not sit in Needs Reply forever.
4. Column widths saved under the old table key must not shrink the new elastic Title; the key bumps to `tickets-v3`.
5. In pane mode, Escape closes the pane, not the module; a dirty drawer asks before ↑ / ↓ switches tickets (reuse `confirmSwitchTicket`).

---

### Task A: Queues, one bar, phone strip, server flag  (worktree `wt/desk-queues`)

**Files:**
- Create: `frontend/src/tickets/queues.js`, `frontend/src/tickets/queues.test.js`
- Modify: `frontend/src/tickets/TicketsView.jsx` (header, scope → queue, tiles removed, phone strip, deep links, saved views), `frontend/src/tickets/TicketFilters.jsx` (MoreMenu → one ⋯ menu that also holds Export, Columns, Suggest Property Links; SaveViewDialog unchanged), `frontend/src/tickets/ticketTourSteps.js`, `frontend/src/components/ModuleTabs.jsx` (append: optional `tone: 'alarm'` on a tab colors its badge amber), `backend/routers/tickets.py` (`list_tickets` adds `needsReply`), `backend/test_tickets_needs_reply.py` (new)
- Tests to update: `TicketsView.list.test.jsx`, `TicketsView.phone.test.jsx`, `TicketsView.review.test.jsx`, `TicketsView.completed.test.jsx`, `ticketTourSteps.test.js`

**Interfaces (Produces):**
```js
// queues.js
export const QUEUES = [
  { key: 'needs_reply', label: 'Needs Reply', sort: { key: 'clock', dir: 'asc' } },
  { key: 'unassigned',  label: 'Unassigned',  tone: 'alarm' },
  { key: 'mine',        label: 'Mine' },
  { key: 'due_soon',    label: 'Due Soon',    sort: { key: 'clock', dir: 'asc' } },
  { key: 'waiting',     label: 'Waiting' },
  { key: 'open',        label: 'All Open' },
  { key: 'done',        label: 'Done' },
  { key: 'route',       label: 'To Route',    hideWhenEmpty: true, onlyDesk: true },
  { key: 'approve',     label: 'To Approve',  hideWhenEmpty: true },
  { key: 'raised',      label: 'Raised by Me' },
];
export const DEFAULT_QUEUE = 'needs_reply';
// ctx = { me: lowercased email, onDesk: bool, now: ms }
export function queueMatches(key, t, ctx) -> bool
export function queueCounts(tickets, ctx) -> { [key]: number }   // whole workspace, every queue
export function queueDefaultSort(key) -> { key, dir }            // else { key: 'updated', dir: 'desc' }
export function queueFromLegacyScope(scope) -> key               // all->open, mine->raised, assigned->mine, approve->approve, route->route
export function queueFromFilterEvent(f) -> key | null            // 'unassigned'->unassigned, 'assigned'->mine
```
Predicates (live = status not in CLOSED_STATES):
- needs_reply: `t.needsReply === true` (server flag). Client fallback when the flag is undefined (old API): live && !slaPaused(t) && approvalStatus !== 'pending' && (!firstResponseAt || latestComment?.authorId === requesterId) && requesterId !== assigneeId.
- unassigned: live && !assigneeId. mine: live && assigneeId === me. due_soon: live && slaState(t) in (breached, at_risk) or firstResponseState(t) === 'overdue' / 'due'. waiting: status in waiting_user / waiting_vendor / on_hold. open: live. done: !live. route: approvalStatus pending && !approverId (onDesk only). approve: approvalStatus pending && approverId === me. raised: requesterId === me (any status).
- The queue replaces `scope`. Filters (status / priority / type / SLA / department / service area / assignee / search / desk) still apply on top. Inside `open`, a `statusFilter` of resolved / closed shows that status (the old `statusFilterIsClosedOnly` carve-out). The collapsed Completed section is removed (Done is the tab).

Server flag, `list_tickets` after `public_latest` is built:
```python
d["needsReply"] = _needs_reply(t, public_latest.get(t.id))
def _needs_reply(t, latest_public: dict | None) -> bool:
    live = (t.status or "open") not in ("resolved", "closed")
    if not live or t.sla_paused_at or (t.approval_status or "none") == "pending": return False
    req = (t.requester_email or "").lower()
    if req and req == (t.assignee_email or "").lower(): return False
    if not t.first_response_at: return True
    return bool(latest_public) and (latest_public.get("authorId") or "") == req
```
Test file: five cases from Review Focus 3 plus "no first response", "requester wrote last", "desk wrote last", "paused", "closed".

Header (desktop): one `nx-primary-bar` row like `views/Tasks.jsx` lines 277-300: `<ModuleTabs inline overflow tabs=[...QUEUES with badge = count, hidden when hideWhenEmpty && 0, ...ticketViews.map(v => ({ key: `view:${v.id}`, label: v.name })), { key: '__save', label: '+ View' }]>` on the left, `+ Create` on the right. The title row and the five tiles are deleted. Row two: `List | Board | Reports` left; search, Filters (with its count), one `⋯` menu right (Group By, Save Current View, Delete view, Columns, Export, Suggest Property Links when privileged). The toolbar must render the same on all three views.
Phone: the queue tabs replace the All / Mine / Assigned strip (same `.scroll-tabs`, counts in a small chip; `tone: 'alarm'` colors Unassigned's count amber).
Saved views: `saveTicketView` stores `queue` (not `scope`); `applyTicketView` reads `f.queue ?? queueFromLegacyScope(f.scope)`.
Tour: rewrite steps "Every ticket starts from these tabs" / "Five tiles, five shortcuts" for the queues ("Needs Reply is where a desk starts the day...").

- [ ] Write `queues.test.js` (predicates incl. Review Focus 1-3, counts, legacy scope map) → run, fail → implement `queues.js` → pass.
- [ ] Backend test → fail → `_needs_reply` + wiring → `backend/.venv/bin/python -m pytest backend/test_tickets_needs_reply.py` pass; `ruff check backend/`.
- [ ] TicketsView header + phone strip + deep links + saved views; update the five TicketsView tests; `npx vitest run src/tickets`; `npm run lint`.
- [ ] Commit per step on the worktree branch.

### Task B: Rows and columns  (worktree `wt/desk-rows`)

**Files:**
- Modify: `frontend/src/tickets/ticketMeta.js` (`nextClock`), `frontend/src/tickets/ticketViewShared.js` (`TICKET_COLUMNS`), `frontend/src/tickets/TicketList.jsx` (cells, flag rule, avatar clip), `frontend/src/tasks/tableCols.jsx` (append `defaultHidden`), `frontend/src/tickets/ticketExport.js` (Next Clock + Updated columns in the CSV), `frontend/src/tickets/TicketFilters.jsx` (MOBILE_SORTS: `clock:asc` "Next Clock", `updated:desc` "Recently Updated")
- Create: `frontend/src/tickets/nextClock.test.js`
- Tests to update: `TicketsView.list.test.jsx` column assertions, `TicketAtoms.sla.test.jsx` if it reads the Due cell

**Interfaces (Produces):**
```js
// ticketMeta.js
export function nextClock(t, now = Date.now()) -> {
  kind: 'reply' | 'resolve' | 'paused' | 'none',
  state: 'overdue' | 'at_risk' | 'ok' | 'paused' | 'none',
  label: string,   // "Reply overdue 3d" | "Reply due in 2h" | "Overdue 27d" | "Due in 4d" | "Due 11/04/2026" | "Paused · 4d" | ""
  title: string,   // "First response due 10/04/2026 5:59 AM" | "Resolution due ..." | "Paused since ..." (formatDateTime)
  at: number,      // deadline ms for sorting (Infinity when none; paused sorts after live clocks)
}
```
Rules: closed → none. `slaPaused(t)` → paused, counted from `slaPausedAt` (else label "Paused"). No `firstResponseAt` and a `firstResponseDueAt` and requester !== assignee → the reply clock; else the resolution clock (`slaDueAt`, else `slaDueOn` at end of day). Relative words under 7 days ("3h", "2d"), then the date. Red only when overdue, amber at_risk (existing `atRiskMs` window), plain otherwise.

`TICKET_COLUMNS` (table key → `'tickets-v3'`): checkbox 34, type 34, **title** `template: 'minmax(260px, 1fr)'` (minWidth 260), company 130 shrink 80 `defaultHidden` (TicketsView passes `defaultHidden: companyCount <= 1`), state 140 shrink 130, priority 110 shrink 100, **clock** label 'Next Clock' 150 shrink 130 sort by `nextClock(t).at`, requester 140 shrink 110, assignee 140 shrink 110, **updated** label 'Updated' 100 shrink 88 sort `modifiedAt || createdAt` (cell: `commentAgo`-style relative, exact `formatDateTime` in title), created 110 `defaultHidden`, latestComment 260 minWidth 160 shrink 140, resolved 24. Default widths at 1,300 px must not force horizontal scroll (test: sum of shrink floors ≤ 1,300).
`tableCols.jsx`: `const hidden = Array.isArray(saved.hidden) ? saved.hidden : cols.filter((c) => c.defaultHidden).map((c) => c.key)` (fallback only when never set, like `useTableSetting`).
Flags: "Needs a Comment" renders only when `t.assigneeId && live && !slaPaused(t)`; the phone card follows the same rule. Latest Comment cell: give the avatar `flexShrink: 0` and the cell `overflow: hidden` with `minWidth: 0` on the preview so nothing clips past the Resolved column.

- [ ] `nextClock.test.js` at fixed `now` (each kind / state, requester-is-assignee, slaDueOn fallback) → fail → implement → pass.
- [ ] Columns + cells + tableCols + export + mobile sorts; update tests; `npx vitest run src/tickets src/tasks/tableCols`; `npm run lint`.
- [ ] Commit per step.

### Task C: Keyboard, Previous / Next, inline drawer  (worktree `wt/desk-keys`)

**Files:**
- Create: `frontend/src/tickets/useListKeys.js`, `frontend/src/tickets/useListKeys.test.jsx`
- Modify: `frontend/src/tickets/TicketDrawer.jsx` (props `inline`, `onPrev`, `onNext`; header buttons; `[` / `]` keys), `frontend/src/tickets/TicketDrawer.opening.test.jsx` or new `TicketDrawer.pane.test.jsx`
- Do NOT touch `TicketsView.jsx` (Task D wires it).

**Interfaces (Produces):**
```js
// useListKeys.js  - ↑ ↓ move a highlight through `ids`, Enter opens, Escape clears.
// Ignores keys typed in input / textarea / contenteditable / [role=dialog] unless `active` says the pane owns them.
export function useListKeys({ ids, enabled, onOpen, openId }) -> { focusId, setFocusId }
// TicketDrawer props
inline?: boolean   // renders the drawer's header / tabs / body / footer as a plain flex column (no Modal overlay,
                   // no Escape layer of its own, width 100%, height 100%); the caller owns the frame.
onPrev?: () => void, onNext?: () => void   // when either is given the header shows "Previous" / "Next"
                   // (disabled when null); keys [ and ] call them when focus is not in a field.
```
Inline mode must keep: dirty guard on switching (caller calls `confirmSwitchTicket` via `dirtyRef`), the footer actions, the linked-task overlay, and `data-testid="ticket-drawer"` on the root.

- [ ] `useListKeys.test.jsx` → fail → implement → pass.
- [ ] Drawer: `inline` + Previous / Next + keys; test renders inline without a dialog role and clicks Next; `npx vitest run src/tickets/TicketDrawer`; lint.
- [ ] Commit per step.

### Task D: Preview pane wiring + docs  (on the merged branch, after A, B, C)

**Files:**
- Modify: `frontend/src/tickets/TicketsView.jsx`, `frontend/src/tickets/TicketFilters.jsx` (⋯ menu: "Open Tickets in a Side Pane" switch), `CLAUDE.md`, `frontend/src/tickets/ticketTourSteps.js` ("Working a ticket" step mentions ↑ ↓ Enter and the pane)
- Create: `frontend/src/tickets/TicketsView.pane.test.jsx`, `frontend/src/tickets/TicketsView.keys.test.jsx`

Layout pref: `const [layoutPref, setLayoutPref] = useTableSetting('tickets-v3', 'layout', ['modal'])`; `pane = !isMobile && layoutPref[0] === 'pane'`. In pane mode the body is `display: grid; grid-template-columns: minmax(0, 1fr) minmax(420px, 45%)`; the list passes a compressed `cols` (checkbox, type, title, state, clock) and the right cell renders `<TicketDrawer inline key={openId} ticketId={openId} onPrev onNext dirtyRef ... />` or an empty state "Pick a ticket" when `openId` is null. `useListKeys` runs on the sorted visible ids of the current tab (main list only); Enter → `openTicket`; in pane mode ↑ ↓ also open as they move (after the dirty guard). Modal mode keeps today's behavior plus keyboard open / close. Escape in pane mode closes the pane's ticket (openId → null).
CLAUDE.md bullet (after the "Many tasks at once" bullet): the desk's tabs are queues (filter presets over the loaded tickets, counts for the whole workspace, Needs Reply computed by the server in `list_tickets`), the Next Clock column is the one SLA wording on the row, the preview pane is a per-person layout (`useTableSetting('tickets-v3','layout')`) and desktop only.

- [ ] Tests (pane renders inline drawer, Escape clears, ↑ ↓ Enter in modal mode) → implement → pass; full `npx vitest run`; `npm run lint`; `npm run build`.
- [ ] Review pass (3 reviewers), fixes, PR against dev. Merge only on Neil's OK.
