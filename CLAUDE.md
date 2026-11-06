# Greens Nexus — Claude Code Guide

Internal company portal for Greens Global. React 19 + Vite frontend (`frontend/`),
FastAPI + SQLAlchemy backend (`backend/`), Supabase Postgres/storage/realtime,
Microsoft Entra ID (MSAL) auth.

## Run locally

```
# backend (terminal 1) — uses its own SQLite unless DATABASE_URL is set in backend/.env
cd backend && uvicorn main:app --reload --port 8000

# frontend (terminal 2) — talks to localhost:8000 by default
cd frontend && npm run dev
```

Local backend identity comes from `backend/.env`: `NEXUS_SKIP_AUTH=true` +
`NEXUS_DEV_EMAIL=<your work email>`. Change the email to impersonate a different
role for testing. `NEXUS_SKIP_AUTH` is refused on Azure — it can never deploy.

Verify frontend changes compile with `npm run build` before committing.

Before pushing, run what CI runs: `ruff check backend/` and, in `frontend/`,
`npm run lint` and `npx vitest run`. Backend tests run ONE FILE PER PROCESS
(`python -m pytest test_x.py` or `python -m unittest test_x`): most files bind
`database` to their own throwaway SQLite when they are imported, so in a run
of several files the later ones work on the first one's database - a file
that empties tables would empty the wrong ones (Sep 29: a multi-file run
cleared people and roles in a local `greens_nexus.db`). `backend/conftest.py`
turns the request rate limiter off for pytest runs; its own tests switch it on.

## Git workflow (non-negotiable)

- `main` = production. `dev` = integration; every merge auto-deploys
  (Cloudflare Pages frontend ~1 min; Azure backend ~4 min, **restarts the dev API**).
- One branch = one task, not one module. Born from fresh `dev`, merged via PR
  within a day or two, then deleted. If it can't merge by tomorrow evening, the
  task was too big — split it.
- Announce in team chat before merging to `dev` (someone may be mid-testing).
- Never commit directly to `dev`/`main`. Never commit `.env*` files.

## File ownership

| Area | Owner | Files |
|---|---|---|
| Items / checkouts / assignments / notifications UI | **Visesh** | `frontend/src/views/InventoryManagement.jsx`, `frontend/src/inventory/`, `frontend/src/components/Assignments.jsx`, `frontend/src/components/NotificationBell.jsx`, `frontend/src/components/NotificationToasts.jsx`, `backend/routers/items.py` |
| Asset Management / Property Portfolio | **Neil** | `frontend/src/views/PropertyAsset.jsx`, `frontend/src/views/AssetModule.jsx`, `frontend/src/asset/`, `backend/routers/property_assets.py`, property models/tables |

Machine-readable copy: `backend/code_owners.py` (Build Mode routes pins and
the build-notes skill refuses commits by it) - change both together.

**Do not modify the other developer's files** — ask them instead.
**Neil has the final say** (Oct 28 2026): he is head of the company and
Visesh's lead. A change Neil made or a decision he gave (the "(Neil, <date>)"
notes in this file and in code comments) is never changed or undone without
discussing it with him first - the same guardrail as another developer's
files. Neil may green-light work on anyone's files himself.
Shared files (`backend/models.py`, `backend/main.py` migrations list,
`frontend/src/api.js`, `App.jsx`/`Sidebar`): **append only, never reorder**,
keep the diff minimal.

## Backend conventions

- Copy patterns from `backend/routers/items.py` — it is the reference
  implementation for endpoints, permissions, and notifications.
- **Notifications are created server-side only** (see `_notify` in `items.py`).
  Employees get 403 on the notifications POST API, so client-side
  `addNotification` for workflow events silently fails — never rely on it.
  Target notifications at a specific `recipient` email; empty recipient =
  broadcast to all managers (avoid unless intentional).
- One notification per workflow/order, updated in place — never one per item.
  Multi-row updates that batch notifications need `with_for_update()` row locks
  (concurrent requests otherwise race the dedupe; this bit us hard).
- Sessions run with `autoflush=False`: uncommitted changes are NOT visible to
  queries in the same request — sibling-count queries must exclude/add the
  current row manually.
- **Never do blocking I/O on the async event loop.** Background loops (the
  `*_loop` tasks started in `main.py`'s lifespan) and any `async def`
  endpoint/middleware must push synchronous DB queries and outbound HTTP
  (Microsoft Graph) into a thread via `await asyncio.to_thread(...)` —
  copy `reminders_loop` / `long_session_loop`. A sync call left on the loop
  freezes the WHOLE worker (every request it is serving, CORS preflights
  included) for the call's full duration. This caused instance-wide ~16s
  freezes that looked like "random slow modules" and CORS/502 storms (Aug 2);
  the fix was moving the `task_notify` / `ticket_notify` scans into `to_thread`.
- New columns: add to the model in `models.py` AND an
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` line in BOTH of `main.py`'s
  migration lists (SQLite AND Postgres). Model columns missing from the live DB
  break every SELECT with a 500.
- New tables: define the model; `create_all` creates it on startup — but with
  **RLS disabled**. You MUST `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on BOTH
  dev and prod as part of the release. The backend bypasses RLS via the
  privileged `DATABASE_URL`; RLS only locks out the public anon key, so a new
  table without it is fully exposed to anyone holding that key. Run
  `get_advisors` after every release — this gap recurs.
- **AI is OFF - Nexus never spends the Anthropic key unless Neil or Visesh
  explicitly turns it on (Neil, Oct 29 2026: "we cannot afford it").**
  `ai_switch.apply()` runs first thing in `main.py` and blanks
  `ANTHROPIC_API_KEY` for the whole process unless the server carries
  `NEXUS_AI_ENABLED=true` - an Azure app setting only Neil or Visesh sets.
  Every AI feature then reads as "not set up". Never add another way to turn
  it on (a code default, a database row, a Settings switch), never read the
  key under another name or call the API around the switch, never add a
  standalone script that calls Anthropic, and never add credits, auto-reload
  or billing anywhere or suggest doing so - ask Neil. `test_ai_switch.py`
  pins it.
- Photo URLs from clients must pass `_validate_photo_url` (Supabase storage only).
- **Evidence buckets are PRIVATE** (Sep 22): `checkout-photos`, `item-photos`,
  `return-photos`, `ticket-evidence`, `qa-evidence`, `task-files`,
  `ir-documents`, `construction-media`, `asset-files` have `public = false` on dev and prod (`document-images`
  stays public: e-sign signers load it with no login). The database still stores the canonical
  `.../object/public/<bucket>/<path>` URL; browsers open it only through
  `GET /files/view?u=<url>` (`routers/files.py`, signed-URL redirect, login
  required). `api.js` rewrites those URLs to the viewer on every response and
  back to canonical on every JSON request, so screens never see the
  difference - do not build a second path, and never make a new evidence
  bucket public. A new protected bucket goes in BOTH `PROTECTED_BUCKETS` lists
  (`routers/files.py`, `frontend/src/lib/storageView.js`) and gets
  `update storage.buckets set public = false` on dev and prod.
- **Outlook Actionable Messages** (task emails, `task_mail_actions.py` +
  `routers/mail_actions.py`): clicks are authenticated with a Microsoft Entra
  ID token (the legacy substrate.office.com token died Jun 8, 2026 - never
  bring it back). The card is emitted only when BOTH `NEXUS_AM_ORIGINATOR` and
  `NEXUS_AM_AUDIENCE` (AppIdUri, then the Entra app's client id, comma-
  separated) are set; setup is `docs/Actionable-Messages-Setup.md`.
  The signed task token in the URL is what proves an email was ours.
- **Contact Directory** (`routers/directory.py`, Oct 2026): contact fields
  only, never `hr._serialize`; availability (off / leave / holiday / punch /
  shift) is computed per call in `_availability`, the roster is cached per
  company-wall key. Teams presence dots need the `Presence.Read.All`
  APPLICATION permission with admin consent on the Entra app
  (`docs/Teams-Presence-Setup.md`); until then `/directory/presence` answers
  `enabled: false` and the UI shows no dots - never treat that as an error.
- **Rate limiting** (`RequestRateLimit` in `middleware_hardening.py`, Sep 22):
  per-minute budgets keyed on the session/bearer for signed-in callers, per IP
  for anonymous ones, tighter on credential-taking routes, plus a per-IP
  ceiling. In-process per worker, so it is a flood backstop. `/health` and
  `/version` are exempt; a new public probe endpoint goes in `EXEMPT_PREFIXES`
  and a new credential-taking route in `SENSITIVE_PREFIXES` (30/min, always
  per IP whatever headers it carries) - or in `SHARED_SOURCE_PREFIXES` when
  its real callers share an address (Outlook's action servers, GitHub).
- **Confidential HR tickets are invisible by default** (Oct 2026): a
  `task_tickets` row with `confidential_desk` set is hidden from EVERY ORM
  query by the `do_orm_execute` hook in `database.py`. A query sees it only
  when it opts in with `.execution_options(include_confidential=True)`, and
  only after `ticket_confidential.may_read` says the caller may (HR-audience
  routing: the company's HR contact, administrators and Full HR inside their
  reach). A new ticket reader, count, export or code generator must know
  this - a missing opt-in silently drops the row, a blanket opt-in leaks it.
- **Approval badge counts come from one place**: `approvals_inbox.collect`,
  read by `routers/action_counts.py`. A new approval kind registers an
  `@source` in `approvals_inbox.py` - never a separate count query, or the
  badge and the inbox disagree.
  On a phone Approvals is `approvals/ApprovalsPhone.jsx`: one card, two
  decisions, the Filter sheet; the desktop list is unchanged; no bulk
  approve on a phone (Neil, 11/02/2026).

- **Tiers (Neil, 11/02/2026, `docs/Roles.md`):** the role KEYS stay
  `employee | supervisor | manager | administrator | owner` (levels 1-5);
  the words people see are Employee, Supervisor, Manager, **Administrator**
  (4) and **Super Administrator** (5) - never "Global Admin" / "IT Admin"
  (`frontend/scripts/check-role-copy.mjs` fails the lint). An Administrator
  is ALWAYS company-walled (`auth.company_scope`, walls switch on or off);
  only level 5 or a member of a group flagged `is_global_admin` passes the
  walls (`auth.is_global_admin` - no level-4 fallback).
  Exception - TICKETS (hotfix 11/04/2026, Pranshu with Neil's approval):
  an Administrator sees and works every company's tickets; ticket code reads
  `ticket_roles.company_scope` / `ticket_roles.assert_company`, never
  `auth.company_scope`, for a ticket record. People pickers, departments,
  approvers and desk settings stay walled; Ask HR tickets stay HR's. Only a Super
  Administrator flags or touches a flagged group, sets the walls, or grants
  administrator / owner. The five Super Administrators (Neil, Visesh,
  Charmi, Pranshu, Sagar) were set ONCE by `super_admins_seed.apply_once`
  (mark `roles.super_admins_set_2026_11_02`); change them in Settings, never
  in code. Under a person's name the screen shows their JOB TITLE, never the
  tier; the tier is a mark only (`components/TierMark.jsx`: Super
  Administrator a filled shield, Administrator an outline shield, Manager a
  small people glyph, nothing for others), fed by the `tier` field on the
  people payloads (`auth.tier_of`). `useRole()` exposes `myLevel`, `myTier`,
  `myTitle`.

## Frontend conventions

- All server calls go through `frontend/src/api.js` — add new endpoints there.
  It already retries idempotent GETs on 5xx/network with backoff and debounces
  the "reconnecting" banner; do not add a second retry layer on top.
- **Never let a screen render blank.** The whole app is wrapped in
  `RootErrorBoundary` (`main.jsx`) and each view in `ViewErrorBoundary`; the gap
  where MSAL is mid-interaction is filled by `AuthBusyFallback` (`App.jsx`). Any
  new top-level surface or provider that can throw must keep a boundary above it
  — a crash without one unmounts React to a white screen. For pending data show
  a skeleton/loader via `AsyncState.jsx` (`AsyncSection` / `SkeletonBlocks`),
  never nothing. New high-risk views get a render-smoke test (`*.test.jsx`, run
  in CI) so a crash-on-render is caught before merge.
- File uploads: use the existing Supabase upload helpers (they set
  `cacheControl: '31536000'`; image paths are unique and cached immutably).
- Cross-view navigation uses the `nexus:navigate` window event
  (`window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }))`).
- Tab strips use the `.scroll-tabs` class (hidden scrollbars, mobile swipe).
- **Popups are sheets from the right** (Neil, 11/01/2026): on a desktop,
  every popup that is a record, a form or a workspace is a SHEET - docked to
  the right edge, the full height, rounded only where it meets the page -
  that slides in from off screen (`nx-slide-in`, 320ms, `--ease-out`) while
  the scrim fades, its body's first rows cascading in a beat behind the
  frame (`.nx-cascade`, only while the shell carries `is-entering`, the
  first 500ms), and slides out in 220ms with the scrim (the exit waits
  `MOTION.md`; a centered card `MOTION.exit`). The SIZE is still
  Pranshu's 60% rule (Oct 15 2026): `width: max(60vw, <caller's width>)`,
  at least ~420px, never wider than the viewport, and **the 60% is for
  content, not blank space** (Pranshu, Oct 21 2026) - the popup body is a
  flex column and the one part that should take the remaining height (the
  notes textarea's wrapper, the list, the table, the preview) carries
  `className="nx-fill"` so it grows into the space. The shared `Modal` in
  `tasks/components.jsx` does all of this by default (`placement="sheet"`);
  so do `marketing/shared/Modal.jsx`, the task drawer, and every
  class-styled `.modal-overlay > .modal-content.nx-popup` / credvault
  `.cv-modal.nx-popup` through style.css's "Sheets" block. A QUESTION - a
  confirm, an alert, a prompt, "Save your changes?", "Delete this?" - stays
  the centered card: `placement="center"` on the shared Modal, the class
  `nx-center` on a generic `.modal-content`, `center` on the credvault
  Modal, and `ui/dialog.jsx` (DialogHost) as it is. A sheet opened over a
  sheet slides in on top and the one beneath recedes and goes `inert`
  (`lib/sheetStack.js`, `data-nx-under`) until the top one leaves; the top
  is what paints on top - highest z-index, then later in the document - so
  every sheet passes its own z (a drawer under a Modal never recedes it).
  Phones keep the full-screen bottom sheet; nothing here applies under 641px.
  Never a small fixed-width box floating mid-page with empty space around it.
  **Exception - the Workday panels are 85%** (Sagar, Oct 27 2026): Ask HR
  (`views/MyHR.jsx`), Reimbursements (`components/Reimbursements.jsx`) and
  Purchase Requests (`PurchaseRequestsPanel` in
  `components/PurchaseRequests.jsx`) are whole workspaces, not single forms -
  `width: 85vw`, now also sheets from the right (the full height), same
  420px floor and phone sheet. Do not "fix" them back to 60%; the forms they
  open on top (e.g. New Purchase Request) stay on the 60% rule. A click
  outside these three never closes them - it nudges the popup and lights up
  its close button (`lib/usePopupNudge.js`); Close, Cancel and Escape close.
  **Exception - the Help panel** (Neil, 11/04/2026): a long Ask Nexus
  answer or a guide article opens it to a full-height sheet on the right at
  `min(720px, 100vw - 40px)` - a reading width, not the 60% rule - with a
  Shrink / Expand button; short answers keep the small card
  (`support/HelpWidget.jsx`).
- Match the existing inline-style idiom and Inter font; reuse `TYPE_META` /
  status-badge patterns rather than inventing new chip styles.
- **Every amount on every Accounting report drills down to its ledger lines
  and on to the source transaction; columns resizable** (Charmi, call of
  10/27/2026, item 17 - asked before and it did not stick, so it is a house
  rule now; no one should have to ask for it on a new report). A figure that
  is posted opens the lines behind it: on Reports through `drill.js`
  (`requestReportDrill` - the General Ledger lines, `LedgerSearch.jsx`), on
  any other screen in the side panel (`LinesPanel.jsx` with `lineQuery` from
  `reportModel.js`; Open in Reports for the full grid). The lines read like
  Intacct's General Ledger (Doc, Memo/Description, Entity, Vendor, Customer,
  Item, Employee, Department, Debit / Credit, running Balance on a
  drill-down, totals) and every line opens its transaction (`EntryDetail`
  `panel`: right-side panel with Open Full). Every report column takes a
  `ColumnResizer` with `useColumnWidths('<table key>')` so each person's
  widths are kept. Only a figure that is worked out rather than posted
  (a variance, a percent, a budget, a projection, a computed cash-flow line)
  may stay plain - say which and why in the PR.
- **Settings saves one way (Oct 23 2026):** a switch, a select, a chip list
  or a reorder saves on change, with a toast; a form with typed fields keeps
  a draft beside the saved value (`lib/useDraft.js`) and has ONE Save row at
  the group's foot (`components/SaveRow.jsx`: Save disabled until something
  changed, Discard Changes beside it, "Use the Default" on the left for a
  company's own copy of a layered setting) - never a Save per card or per
  field, never a save on blur. Every form says `useGroupDirty(dirty)`
  (`lib/groupDirty.js`), so the Settings shell asks before the subject, the
  scope, the top tab, the module or the browser tab changes; the hook is a
  no-op wherever else the panel renders.
- **The left navigation moves one way (Neil, 11/01/2026):** the strength
  is a setting - the company default under Settings > Branding > Brand Color
  (`navMotion` on the branding config), a person's own under My Profile >
  Appearance (profile prefs `nav.motion`) - resolved by `lib/railMotion.js`
  (reduced motion is always Off) and written to `<html data-rail-motion>` +
  `--rail-lift`. `Sidebar.jsx` owns only the two pills (translateY) and the
  `is-opening` / `is-pop` beats; every visual is the "Rail motion" block in
  style.css: transform and opacity only, `--ease-spring` on the icon lift
  (on the way up only - it settles back ease-out) and the one-time pop (on
  the glyph inside `.nav-ico`, so it composes with the lift) alone - the
  pills, the flyout, the count bump, the cascade and the chevron ease out -
  Bold capped at 1.26, cascade 14ms a row,
  nothing loops, nothing on touch, the phone drawer untouched, the folded
  rail never peeks. The sidebar tooltip (`NavTip`) is the light flyout card.
- **Hold to confirm (Neil, Oct 30 2026, plan
  https://claude.ai/artifact/MU1RMFQ9nHYxSB31XjDwQ1, PRs #883-#884):** an
  action that cannot be taken back (delete forever, void, offboard, end
  access, finalize) is confirmed by pressing and holding `ui/HoldButton.jsx`,
  never a plain click-to-confirm. `HOLD_RECORD_MS` (1.2 s) for one record,
  which holds right on its row with no dialog; `HOLD_MAJOR_MS` (1.8 s) for
  many records or other people, inside `dialog.confirm(msg, { hold: true,
  onConfirm })` so the dialog says what goes. `onConfirm` may return a
  promise (a refusal shows under the button) or `{ undo }` (an Undo toast,
  `dialog.undo`). Keyboard holds work, and a click with no press behind it
  (assistive tech) falls back to the ordinary confirm - keep both. Never
  lengthen the holds or add a second confirm component.
- **Full Screen (Neil, 10/31/2026):** a working surface that needs room
  (the workflow builder, Operations) takes `components/FullScreenButton.jsx`
  - `useFullScreen('<module>')` folds the left navigation away and trims the
  page margins (`html.nx-fullscreen` in style.css), remembered per module in
  this browser, computers only. The header stays (it carries the module's
  tabs). Give another module the same button, never a second mode.
- **Live accent (Neil, 11/02/2026, DESIGN.md "Live accent"):** green stays
  the brand (primary buttons, active nav, links, the N tile, anything done);
  orange means "in progress / now" only - a running shift, progress still
  moving, the current-time marker, a live mode switched on (Act As, a
  company picked in Settings > Applies To). Use the `--wk-live` family in
  style.css (`--wk-live` for bars / outlines / icons, `--wk-live-ink` for the
  rare orange text, `--wk-live-tint` / `--wk-live-line`), never a hand-picked
  orange. Orange is never a button, never a warning (warnings stay yellow +
  icon, orange never on yellow), never small body text, never a count badge.
  A company whose brand is orange / red gets the family in cobalt
  (`liveCollides` in `lib/brandAccent.js`) - read the tokens and it comes for
  free. `ui/ProgressTrack.jsx` is the only progress bar for new work.

## Domain rules

- **Transient items** = checkout/return lifecycle (`item_checkouts`):
  pending → approved → pending_receipt → allocated → returned. Due dates count
  from handover, not request.
- **Permanent items** = assignment lifecycle (`item_assignments`):
  pending_acceptance → active → return_initiated (normal/dead/lost/reassign) → closed.
  Items carry `assigned_to_email` as the current pointer; history lives in the
  assignment rows. Per Neil: Items and Assets are ONE concept — equipment
  warranties/serials belong on the `items` table, do not build a parallel system.
- Photos are evidence: checkout handover, receipt, and return require them
  (lost-item reports are the exception). Permanent-assignment ACCEPTANCE photo
  is optional (Neil, Jul 17 — one-click accept); assignment returns still
  require one.
- People pickers: always the curated Nexus People list (`getPeopleDirectory()`
  → `/myhr/directory`), never M365/GAL-derived lists. Backend approver/allocator
  endpoints filter role-holders against `nexus_employees`.
- Every image-upload widget must accept Ctrl+V clipboard paste (see
  `imageFromPaste` in `inventory/ui/upload.js` / `filesFromPaste` in
  `tasks/lib.js` for the pattern) with an "or press Ctrl+V…" hint.
- Time Clock paid leave: a punch pair whose job category says Sick / Vacation
  (matched by `_leave_class` in `timeclock.py`: "Sick Day", "PTO", "Annual
  Leave"...) is its own pay class - separate "Total Sick hours" / "Total
  Vacation hours" line at the base rate, excluded from the overtime split,
  still counted in `workedMin` (the attested total) - SwipeClock parity
  (Charmi, Sep 21). No separate leave-hours table; approved time-off
  requests are NOT auto-punched.
- Salaried (fixed monthly pay) day bands (Neil / Charmi via Sagar, Oct 31
  2026, `timeclock._attendance_bands`): a past weekday is a full day from
  4 h worked, a half day (half the daily rate docked) from 2.5 h, absent
  (the day docked) below - whatever the person's full-day hours. The Time
  Sheet no longer prints a "Bands:" line; the day statuses say the result.
  India contractors never use these (8 h / 4 h credits, `india_contractor_pay`).

- **Hourly company holidays are unpaid** (Neil, 11/04/2026: "Holidays are
  days off for hourly employees"): `_compute_timecard` lists a holiday the
  person did not work (office closed, no pay) and credits nothing - no
  holidayPay / holidayMin, no IIF Holiday Pay line. Worked hours on a holiday
  pay as usual. Salaried holidays (`_fixed_card`) are a separate rule.
- **The Time Sheet grid lines up** (Neil, 11/04/2026, plan
  https://claude.ai/artifact/V1YPriqxVi3graoHsG3iMN): every time is drawn by
  `components/timesheet/TimeText.jsx` (hours:minutes and AM / PM in boxes of
  their own), a break is its own row, the week total a centered line, row
  actions at the row's end, NO decimal hours anywhere a person reads hours
  (`lib/hoursText.js`; exports stay numeric). No timeline bars, no late /
  variance chips. The signed PDF (`timesheet_pdf.py`) follows the same layout.

- Task emails are BATCHED (Neil, Sep 24): an event that can wait goes into
  `task_email_queue`, and `task_notify.flush_batches` (every minute, inside
  `task_notify_loop`) sends one email per person once their OLDEST pending row
  is older than the company `batchWindowMinutes` (default 60; 0 = instant).
  Relevance is re-checked at send time (deleted / reassigned away / completed /
  muted rows are dropped; nothing left = nothing sent). Mentions, deletions,
  urgent tasks and tasks due today/tomorrow never wait. New task email events
  go through `notify_task_event` - never mail directly - so they batch too.
- **Many tasks at once go through the import engine** (Neil, 10/31/2026):
  a pasted list in any task name box (Home's add row, My Day, the Create
  Task title, the phone quick-add) and the Create form's "Add Several"
  open `tasks/AddSeveralModal.jsx`, which sends rows to `POST /tasks/import`
  (`task_import.run_import`, `source` paste / typed, a project or none) -
  one transaction, one bell and one batched email per person, the same
  dry run first. Never add a second bulk-create path or loop POST /tasks.
  Tasks Home: on a wide window the Updates card leads (left column, first
  in the DOM) and Tasks + Bookmarks stack on the right; a feed that loaded
  empty leaves Tasks on the left; phones stay Tasks, Updates, Bookmarks.
- **The Tickets desk is queues, not tiles** (Neil, 10/31/2026): the main
  page's tabs (`tickets/queues.js`, in this order: Needs Reply, Unassigned,
  Mine, Due Soon, Waiting, All Open, Done, then To Route / To Approve /
  Preventive when non-empty (Preventive, 11/03/2026: the live tickets a
  preventive schedule filed, its count the overdue ones in red when any),
  then the person's saved views, then Raised by Me, then "+ View")
  are filter presets over the tickets TasksContext holds, counted over the
  WHOLE workspace (no count pill on Done, All Open or Raised by Me). The
  server's `needsReply` flag on every `GET /task-tickets` row (`_needs_reply`
  in routers/tickets.py) decides Needs Reply; the client copy in queues.js
  is only a fallback for a row that arrived without the flag and must stay
  identical to `_needs_reply`. The row's Next Clock
  (`ticketMeta.nextClock`) is the ONE SLA wording on the list - red only
  when overdue. The side pane (a row opens beside the list, ↑ ↓ Enter and
  Previous / Next step the queue) is a per-person layout stored with the
  list's columns (`useTableValue('tickets-v3', 'layout')`), desktop List
  view only; phones, the Board, Reports and Support keep the popup drawer.
- **Boards are notes** (Neil, 11/02/2026): a whiteboard is a `nexus_notes`
  row with `kind='board'`, its drawing JSON in `scene` (2 MB cap, type
  `nexus-board`, never through the HTML sanitizer), a PNG `thumb_url`, and an
  optional `source` (the task / ticket / walkthrough / file it marks up).
  Images are files in the private `task-files` bucket under
  `notes/boards/<noteId>/`, never data URLs in the scene. The engine is the
  self-hosted Excalidraw package in `frontend/src/notes/board/Board.jsx`,
  reached only through `notes/board/engine`'s `import()` and split by the
  build into its own lazy chunk - NO manual chunk for it (11/02/2026: a
  manual chunk dragged its shared dependencies in and put 3 MB on first
  paint; `scripts/check-bundle-size.mjs` now fails when the engine is in
  the entry's static graph or first paint passes 3,000 KB); its fonts are copied by
  `scripts/copy-excalidraw-assets.mjs` on build, English only, nothing from a
  CDN (the CSP is self only). Clean look by default, Sketch per board
  (`scene.js` `applyLook`). Live drawing rides the Notes encrypted transport
  (`notes/collabTransport.js`; elements in `Y.Map('elements')`, our
  `boardSync.reconcile` = newest version wins); viewers follow saves because
  `GET /collab` is editors only. "Mark Up" on any image or PDF goes through
  `lib/markup.js` (`openMarkup` -> a new board with the picture placed and
  `source` set; "Attach to <source>" posts a PNG back through the existing
  task / ticket attachment calls). A board in a note is the `boardEmbed`
  node (anchor with `data-type="boardEmbed"`, allowed by `_NoteSanitizer`).
  Never add a second drawing engine, a second markup path, or a Whiteboards
  module - boards live in Notes. jsdom cannot load the engine: tests get the
  global mock in `frontend/vitest.setup.js`. Users never see the word
  Excalidraw. **The engine is behind `notes/board/engine`** (Neil,
  11/02/2026: it must stay replaceable): `engine/index.js` is the contract
  and `loadEngine()`, `engine/excalidraw.jsx` the ONE file that imports the
  package - `scripts/check-engine-imports.mjs` (in `npm run lint`) fails any
  other; Board, the exports and the live session know only the Engine
  object. When the chunk does not load the board shows its last picture
  read-only with Retry (`engine/fallback.jsx`, never blank, never a throw to
  the boundary); every save goes to an IndexedDB draft first
  (`board/draft.js`, offered back on open with Restore / Discard, cleared
  when the save lands); `scene.js compact` runs before a save and a scene
  still over 2 MB is refused with a notice, never sent as a 413.
- **Frontline reach (Neil, 11/02/2026, from the Pebb audit):** Nexus installs
  on the phone (`public/manifest.webmanifest`, `public/sw.js` - push plus the
  offline app shell, see Field offline below) and pushes the BELL: a Web Push
  goes out for every `NexusNotification` row with a named recipient through
  the `after_insert` listener in `backend/push.py` and the leader-only
  `push_loop` (off the event loop); broadcasts never push; never add a
  second push path or push anything that is not a bell row. Push is OFF
  until `NEXUS_VAPID_PRIVATE_KEY` / `NEXUS_VAPID_PUBLIC_KEY` /
  `NEXUS_VAPID_SUBJECT` are set on the server (Neil sets Azure app settings;
  never generate or commit keys); `nexus_push_subscriptions` and
  `nexus_push_outbox` need RLS on dev and prod. People reach each other on
  Teams, never an in-app chat: every Teams link goes through
  `lib/teamsLinks.js` and the two buttons are `components/PersonActions.jsx`
  (hidden for externals and yourself). Announcements publish from
  `announcements_publish.py`'s loop (claimed once with a conditional
  UPDATE), fan out per the post's `notify` (Bell / Bell and Teams / Bell and
  Email - the bell is the push in every mode, never a second push), hide
  scheduled posts from staff, and keep images and files in the private
  `task-files` bucket (a new post uploads under `announcements/new/`, an
  edit under `announcements/<id>/`). Existing posts are stamped published by
  the migration (`notified_at = created_at`) so a release never re-bells them. The planner's scheduled
  labor line is `GET /timeclock/schedule/labor` (hours from
  `shift_attendance._paid_minutes`, rates from the payroll history by day,
  fixed pay counted not priced, managers never see pay).
- **Field offline (Neil, 11/03/2026: FULL OFFLINE for field work now -
  replaces "offline is deferred"; `docs/Offline.md`):** `public/sw.js` keeps
  the app shell (the build writes its file list - `scripts/offline-manifest.mjs`,
  `OFFLINE_SCREENS`): pages NETWORK FIRST (never stale online, the saved copy
  only with no signal), `/assets/*` cache first, the API NEVER cached; a new
  deploy takes over once its files are saved and the "new version" bar asks
  for the reload. What the field reads offline is `lib/offline/store.js`
  `readThrough(name, fetcher)` - per person (account + Act As), cleared on
  sign out, a different person and every Act As change; never show a cached
  copy to anyone else. Every field change goes through the ONE outbox
  (`lib/offline/outbox.js`, the punch-queue rules made general: an id made on
  the phone sent as the idempotency key, saved before it is sent, retry while
  unknown, park on no signal / 401 and replay on online / visible / sign-in,
  a 409 kept for Keep Mine / Use Theirs - never a silent overwrite - and any
  other 4xx Not Sent with the server's words); a kind registers in its own
  module and gets ONE loader line in `lib/offline/kinds.js`. The server side
  is `backend/idempotency.py` (the `Idempotency-Key` header, table
  `nexus_idempotency_keys`, RLS on dev and prod, 7-day purge in
  `reminders_loop`); a route with its own key keeps it (Forms' `entryKey`).
  Never add a second outbox, a second offline cache, a caching rule for the
  API in the worker, or a retry layer on top of api.js's GET retries.
  Nothing is queued under Act As. The emergency switch is the build variable
  `VITE_OFFLINE_SHELL=off` + a redeploy (the worker empties its caches and
  answers nothing, push stays; never unregister it - runbook in the guide).
  `bodQueue` / `punchQueue` keep their own (time-window) rules.
- **Forms are templates (Neil, 11/02/2026, `docs/Forms.md`):** a field form
  (inspection, incident report, vehicle check, checklist) is a `DocTemplate`
  with `doc_type='form'` - the same field list plus form-only keys (`section`,
  `showIf`, `formula`, `repeat`) and types (photo, gps, scan, rating, yesno,
  live signature), built and reviewed under Documents > Forms. Entries are
  their own table (`doc_form_entries`, RLS) with the ONE reach rule in
  `backend/form_audience.py` (shared with announcements: a person with no
  allowed sites is not a site member); a submitter never reviews their own
  entry, and nothing changes an entry's state by itself. Crews fill a form
  from Workday's Fill a Form tile, the shift card (`showOnShifts` for the
  shift's site), the + menu and the Quick Actions dock; photos and
  signatures go to `task-files/forms/<entryKey>/`; the same `entryKey` sent
  twice is one entry. `form.submitted` / `form.reviewed` are emitted through
  `workflows.emit` at the two choke points in `routers/forms.py` with the
  answers FLAT on `extra`; the Insights Forms card carries counts, never
  answers. Never add a second form engine, a second entry store or an
  offline path outside the punch-queue pattern (the outbox above is that
  pattern; Fill a Form already uses it - `forms/formsOffline.js`).
- **Federal forms (Neil, 11/02/2026, `backend/federal_forms/`,
  `docs/Federal-Forms.md`):** Form W-4, Form I-9 (Section 2 by HR) and the
  Direct Deposit Authorization are filled and signed in Nexus Sign - from
  the hiring packet (`HrPacketSetting.federal_forms`, US employees only)
  or one at a time from the person's Documents tab (HR++). ONE package:
  the official PDFs are bundled with their SHA-256, fields come from each
  PDF's own widgets (`maps/*.json`, `prepare()`), editions are pinned
  (`editions.py`: a lapsed edition REFUSES to send, HR is belled 60 days
  ahead), answers are checked by `formats.py` / `rules.py`. SSN, routing
  and account numbers are `sensitive` fields: encrypted at rest
  (`enc:` via `secret_box`), masked to every other party, never in a bell,
  email, log or on the person record, printed only into the sealed PDF,
  which is restricted (`prints_pay`, Pay & Benefits only, never an email
  attachment, every open a `viewed_final` event). This deliberately
  reverses the old "W-4 / I-9 / direct deposit live outside Nexus" notes.
  Never add E-Verify, remote examination, state forms or a second
  template path without Neil.
- **Homebase lifts (Neil, 11/02/2026):** an early punch is NEVER blocked -
  it is recorded and the manager gets one grouped bell per team and day
  (`early_punch.py`, setting `earlyPunchAlertMin`, 0 = off); the weekly
  labor budget (`laborBudgetHours` / `laborBudgetAmount`) is visible on
  the planner to HR++ only (`hr_access.is_hr_for_company`) - managers get
  neither the figure nor the flag; a time-off request carries a
  RECOMMENDATION (`timeoff_recommend.py`: "Recommended: Approve" / "Check
  First" with reasons) and nothing ever approves or rejects by code; an
  announcement may target a work site (`work_site_id`; a person with an
  empty `work_site_ids` is NOT a site member) and its reads route lists
  who has not acknowledged; the planner's live strip (In / On Break /
  Late / Off) reads Late from `shift_expect` like everything else.
- Timesheets are approved through review + Nexus Sign (`timesheet_review.py`;
  ONLY THE EMPLOYEE SIGNS - Neil, Oct 16 2026). After the period's last day
  the manager (else the company's HR contact; nobody at all = the Global
  Admins) clicks Review & Approve - no signature, no submission needed - or
  Send Back with a note (back and forth, one side edits at a time -
  `guard_edit` is called from every timeclock route that changes hours; add
  it to any new one). Approval sends an envelope to the employee, its only
  signer; their signature finalizes the period, and the PDF carries the
  timestamped `approval_log`. Any change after approval (punch-fix request,
  manager edit, Nexus Sign decline) voids the envelope and reopens it to the
  manager; HR (`is_hr`) edits at any point without approval and the employee
  signs the updated card ("approved" state, `employee_approve`). HR's Unlock
  starts a new round ("unlocked"). An employee who left, or has not signed an
  approved card in `UNSIGNED_WAIT_DAYS`, is finalized by HR with a reason
  (`finalize_unsigned`) - never by hiding the signature step. The signed copy
  files to the employee's Egnyte folder (`egnyte_folder`). The old one-click
  `/my-timecard/sign` returns 410; never add a signing path around this.
  `test_timesheet_review_matrix` drives every state x actor x action - keep it
  passing so nobody gets stuck.
- HR signing order (Neil, Oct 22 2026): the company NEVER signs before the
  employee - no pre-signed or countersigned document is ever sent out. An
  offer letter is signed by the candidate only (no company signer, no Signs
  Once; HR's Verify And Send is a review, not a signature); hiring packets,
  separation packages and every other HR packet are signed by the person
  FIRST and countersigned by the company after (a Signs Once signature goes
  on only when its turn comes after the person, never at send).
  `hr_packet_docs.signing_flow` applies this to every packet, old saved
  configs included - never add an order around it.
  HR letters (`hr_letters.py`) are signed by the company signatory only and
  the employee never signs (Neil, Oct 27 2026) - a letter is the company's
  statement, not a pre-signed document sent for the employee's signature.
- Probation (Neil, Oct 27 2026, `hr_probation.py`): JSON on the person
  (`nexus_employees.probation`); `{}` = Not Tracked. Only new employees, by
  start date: new hires (a hired candidate, or added in People with a start
  date whose end is not already past) start by themselves, and a ONE-TIME
  startup pass (`backfill_existing`, nexus_settings mark) started every
  existing employee still inside their window (start + their length not
  passed); past the window or no start date stays Not Tracked. Contractors,
  externals and guests are never tracked. The backfill sends nothing - one
  normal reminder each comes from the daily pass (`remindedFor`).
  Length = company setting (Settings > Hiring & Onboarding > Probation,
  layered through `scoped_settings`) or the person's own; end = start +
  calendar months. A manager's Confirm / Extend / End is a RECOMMENDATION;
  only HR++ (company HR contact, administrator, Full People grant) finalizes.
  Confirm / Extend send a Documents letter through Nexus Sign as a
  `probation` life event, the employee its ONLY signer (company signatory
  printed, never signed); End opens the existing Offboard flow - never a
  second separation path. Confirm ticks ON-33 via the `probation_confirmed`
  signal. The reminder (once per end date) runs in `reminders_loop`.
- Accounting dashboard (Sep 22): the Accounting view's Overview / Cash /
  Performance / Close / Data tabs are the Nexus face of the finance dashboard
  in Nexus Accounting. Figures come ONLY through `backend/routers/
  accounting_dashboard.py` -> the accounting app's `/api/internal/dashboard`
  (internal key), never the accounting database. The calculation modules in
  `frontend/src/accounting/dashboard/model/` are compiled from the accounting
  repo's `src/lib/finance/dashboard/*.ts` - change them THERE, then re-emit
  with tsc (see the accounting repo's CLAUDE.md), never edit the .js by hand.
  Writes carry the caller's name; each tab shows one section at a time.

- **Feature requests are tickets** (Oct 23 2026, `feature_requests.py`): a
  request from What's New is filed as a `feature_request` ticket through
  `tickets.file_ticket`, and every such ticket (whatever door) gets a What's
  New status card (`changelog_feedback.ticket_id`). The card's comments ARE
  the ticket thread (`/task-changelog/requests/{id}/comments` ->
  `post_ticket_comment`) - never store request comments anywhere else. Each
  new request is posted to the "Nexus - Feedback and Bugs" Teams chat via the
  ticket Teams queue (`kind='feedback_chat'`), as the requester if they are in
  the chat, else the assignee, else `NEXUS_FEEDBACK_CHAT_POSTERS`.
  ONE status story: the request status (What's New Manage) leads and
  `push_status_to_ticket` moves the ticket (Shipped = Resolved, Declined =
  Closed, the rest Open / In Progress; no ticket email for it - the What's
  New bell is the notice); a ticket resolved / closed / reopened by ANY path
  moves the request via the before_flush hook in `feature_request_sync.py`
  (wired in `database.py`) - do not add per-route sync calls.
- Accounting entity access (Neil, Sep 25): the Accounting grant opens the
  screen; WHICH entities a person reads is `nexus_access_scopes` rows with
  module `accounting` (Accounting > Access tab, Full level). No rows = every
  entity; an entity brings its sub-entities. Every new accounting read MUST
  take `Depends(entity_scope)` and pass its entities through `_limit` (or
  check them against `_with_children`) - `routers/accounting.py` is the
  reference. One entity always travels as `location`: the accounting app reads
  `locations` only when there are several. Anything that only exists
  consolidated (the dashboard tabs, the accounting app) takes
  `require_unlimited`.
- Personal financial statements (`routers/pfs.py`, Sep 2026) are the most
  sensitive records in Nexus: owners and the explicit `pfs` grant only
  (`bypass_level="owner"` - an administrator's role does NOT open them). Never
  store a full Social Security number, never log a figure, keep the audit rows.
- Leasing (`routers/leasing.py`, Sep 2026): a tenant is an Intacct customer;
  rent received is what posted to the lease's income accounts for that
  customer in that month - never key a payment into Nexus. A tenant who leaves
  is ENDED (`/replace`), never overwritten. Nothing is emailed to a tenant
  automatically.

- Workforce Scorecard (Neil, Oct 10 2026, `workforce_scorecard.py`): hourly
  staff are scored weekly on punched hours vs. expected hours. Expected =
  published shift > shift preset > country standard day (US 8h, IN 9h, Mon-Fri,
  full-time only; part-time with no shift = "No Schedule", never guessed).
  Holidays and approved time off excuse the day; Sick / PTO punches are leave
  that covers it; only days before the person's own local today are scored.
  Access is the `workforce-scorecard` grant (viewer = DIRECT reports - Neil:
  the default; editor = whole reporting line; full = company); the Monday
  email goes to every grant holder with people in scope.
  The screen and the email are built by the same `build_report` - never add a
  second calculation path.

- **Shifts (Oct 14-15 2026, PRs #589-#594, plan https://claude.ai/artifact/1cU9Zec3fXwyWUrEEAadbN).**
  ONE expected-start / Late rule: `backend/shift_expect.py` (earliest live
  placement for the day - a weather-cancelled day is none, never the preset;
  else the usual-hours preset on its working days; grace from the shift type,
  else the company's `defaultGraceMin`; zone placement -> shift type -> the
  company's team zone). `timeclock._shift_start_for`, My Team, the Workforce
  Scorecard and the no-show scan all read it - never add a second rule.
  Shift settings are PER COMPANY (`routers/shift_requests.get_settings(db,
  company_id)` = defaults <- tenant row <- sparse company override;
  `settings_for(db, email)` for a person) and shift types / groups carry
  `company_id` ('' = shared); writes go through `_require_company_manage`.
  Trading (swaps, offers, open-shift requests), releasing a shift to the open
  pool and cross-team open shifts are OFF by default (Neil) - switches in
  Settings > Shifts & Scheduling, per company. `shift_attendance.py`: the no-show
  scan (every minute, in a thread; one rollup bell per team and day to the
  manager, backup manager and group schedulers, one email, resolved in
  place; `noShowAlertMin`, 0 = off) and `actuals()` (On Time / Late / Left
  Early / No-Show / Excused per person-day, from `_day_summaries`; a Sick/PTO
  punch is not a clock-in; non-managers get status words only).
  `shift_rules.py`: rest, days in a row, daily OT (people on the CA rule),
  weekly OT on the PAYROLL week (Sunday), week caps on the display week;
  rules WARN, never block; Share runs `_publish_review` first and a reason
  is required (per the warned person's company) only for rule warnings and
  approved-off / holiday conflicts - the reason is stored only on the warned
  shifts' `shift_change_log` rows and never shown to staff. Every schedule
  write records to `shift_change_log` through `shift_log.record`.
  `shift_calendar.py` writes shared shifts to Outlook (Graph app-only
  Calendars.ReadWrite, `docs/Outlook-Calendar-Setup.md`; waits quietly until
  consent is granted) - OFF by default (Neil, Oct 15: an event filled the
  whole working day): a company turns `outlookCalendarOn` on, and every tick
  `queue_switched_off` takes events off calendars whose company or person
  has it off. Never rename the key back to `outlookCalendar` (every settings
  save stored that one as true), `routers/shift_ical.py` is the signed personal feed,
  `shift_confirm.py` the confirm-my-schedule ask and nudge,
  `shift_offboard.py` clears a leaver's future shifts. Weather (the
  `weather_watch.py` advisory, the `weather_call.py` call and its notices)
  applies ONLY to people in departments with Weather Calls on
  (`hr_departments.weather`, Settings > Companies > Departments; on for
  Construction by default, off for every other department - Neil, 10/29/2026):
  `weather_scope.py` is the one rule every weather path reads - never add a
  second one. New shift tables rely
  on `_enable_rls_everywhere`; run `get_advisors` after each release.
  Holidays (Neil, Oct 30 2026): a country-tagged company holiday applies only
  to people in that country, and a person with no country of their own takes
  their company's (`holiday_policies.person_country` / `company_countries`) -
  every holiday reader passes `person_country`, never the raw field. The
  planner's day header names the holiday; Fill Automatically, the bulk add
  and Copy Week leave each person's company holidays empty
  (`skip_holidays`, on by default, `timeclock._holiday_days`) and say how
  many they skipped.

- **Settings is one tab (Neil, Oct 23 2026, plan
  https://claude.ai/artifact/UGtPmeFBrfU6wXhd474erx; `views/AdminConsole.jsx`).**
  Every setting has ONE scope - the organization, one company, or an
  organization default a company may override - and the screen shows it: a
  rail of SUBJECTS (`SUBJECTS`), a Scope picker ("Every company" or one
  company) and under each subject its setting GROUPS (`GROUPS`), all open -
  no accordions, nothing behind a click. With a company picked, each subject
  shows its company face (the old Company Settings tabs, spread over the
  subjects they belong to: Profile / Departments / Holiday Calendar under
  Companies, sites under Locations, Roles under People & Access, Checklists
  under Hiring & Onboarding, the policy under Workforce Analytics); subjects
  with nothing per company sit under "For every company" in the rail. The
  sub is `<subject>[:<group>][@<companyId>]`; every pre-merge key
  (`global`, `global-<category>`, `company`, `access`, `actas`) still lands
  (`resolveSub`). A new setting = one `GROUPS` entry (subject, face, scope,
  keywords, and `needs` - who may open it, exactly what its save route
  demands: the role tier, an Access Group grant, `people` for an /hr route;
  `mayOpen` is the ONE visibility rule, so never hide a group from inside
  its panel instead) + one `renderGroup` case; the panel stays the
  component its module owns - never a second copy. Panels draw controls with
  `components/settings/SettingsUI.jsx` (Neil, Oct 25 2026: "world class") -
  `SwitchRow` / `SettingRow` / `NumberBox`: title and description left,
  control right, hairline rows; a switch saves on click, typed fields save
  through the group's one `SaveRow` (see "Settings saves one way" under
  Frontend conventions); a group made of rows sets `flush: true`.
  Styles are the `.nx-set-*` rules in style.css; never hand-roll another
  switch. Settings holds what defines the shape
  of a module or a company and is changed rarely by an administrator; a
  module keeps what its managers maintain daily (Tasks > Manage, KB
  collections, Accounting's own tools stay put). Copy says "Settings >
  <subject>", never "Global Settings" / "Company Settings". A setting a company
  may override layers defaults <- tenant row <- `<key>:<company_id>` through
  `backend/scoped_settings.py` (the pay rules and time-off reasons use it;
  Shift Settings and Payroll Readiness have the same shape of their own) -
  readers resolve by the EMPLOYEE's company (`_round_min(db, email)`,
  `_break_cfg_for`, `_compute_timecard`), so a company with no override
  reads the tenant row exactly as before. The leave start date layers the
  same way (`leave_balances.cutover(db, company_id)` / `cutover_for`). ONE
  email logo chain (`email_theme.logo_for`): the recipient's company logo,
  else the module's own logo setting, else Email Appearance, else the
  wordmark - a mail with no recipient at hand keeps the theme's.

- **India Contractor pay (Neil, Oct 27 2026, docs/India-Contractor-Pay.md -
  never change these numbers without Neil).** Contractors on fixed monthly
  pay who work in India, at a company with Settings > Time & Pay > India
  Contractor Policy on (default on for an India company), for months from its Policy
  Starts (default 11/01/2026): credit by hours (8 h full, 4 h half), the
  month-end pool (reading B) buys back missing half days at 4.5 h each with
  a 1.5 h round-up, and approved Extra Time pays 1.35 x daily / 9 - the
  automatic weekend pay and its Rs 500 floor are gone for them. ONE
  calculation: `india_contractor_pay.reconcile`, called from `_fixed_card`;
  claims in `routers/extra_time.py` (approver = the HR contact, else the
  Super Administrators; HR - administrator / owner / Full HR grant - only within
  the contractor's company scope, `extra_time.hr_for`; never your own;
  Review & Approve waits for every claim). For them only, an APPROVED
  Vacation / Sick time off request is paid leave with no punch (Oct 27
  2026, `india_contractor_pay.requested_leave`); Sick and Vacation each
  draw only from their own balance bucket, never borrowing; a leave punch
  on the same day wins, never both.
  A finalized month carries `indiaPolicy` in its snapshot and never
  re-prices; everyone else keeps the old fixed-pay rules exactly.

- **Workflows (Oct 28 2026, `backend/workflows/`, `frontend/src/workflows/`,
  guide `docs/Workflows.md`)** is the ONE cross-module automation engine.
  A module tells it what happened with one `workflows.emit(db, "<key>",
  subject=row, actor=..., changes=...)` line at its choke point (the service
  function, not each route; inside the transaction, never `after_commit`)
  and never builds a second queue, bus or engine; entities, events, actions
  and list sources are registered in `workflows/packs/<module>.py`, and the
  builder draws only what `GET /workflows/catalog` returns. The committed
  `workflows/catalog.lock.json` must be regenerated whenever a registration
  changes (`c.load_packs(); c.write_lock(...)`, see the guide) - the catalog
  test fails otherwise. Tasks automation rules stay the in-request engine
  for task edits and are listed under Workflows > Automations. Every action
  runs as the workflow's owner; no chaining by default (`caused_by_run`,
  depth 2 at most). Eight tables (`workflows`, `workflow_versions`,
  `workflow_events`, `workflow_runs`, `workflow_run_steps`,
  `workflow_waits`, `workflow_approvals`, `workflow_subject_marks`) need RLS
  on dev and prod - run `get_advisors` after each release.
  The builder's canvas (Blueprint, Neil, 10/30/2026) is a computed layout of
  the definition - `frontend/src/workflows/canvas/layout.js`; never store
  node coordinates, and the list's `shape` (`workflows/shape.py`,
  mirrored in `canvas/shape.js`) carries step kinds only.

- **Notes (Neil, Oct 29-31 2026, `routers/notes.py`, `frontend/src/notes/`).**
  Dashboard > Notes (the page), Quick Note (the slide-over from the + menu's
  New Note, or `quickNoteKeys()` - Ctrl+Alt+N / Ctrl+Cmd+N) and the
  dashboard's Notes widget read and write the same rows (`nexus_notes`,
  `nexus_note_versions`, `nexus_note_presence` - each needs RLS on dev and prod). A
  note is private to its owner and the Nexus People it is shared with
  (404, never 403, to anyone else); a mention notifies nobody. Saves carry
  the rev they were read with (409 = Keep Mine / Use Theirs); editors
  co-type live over an ENCRYPTED Realtime channel (the module docstring has
  the rules). Voice notes, videos and dictation (`lib/voice.js`,
  `notes/noteMedia.jsx`) work on the web and the phone alike: on the web
  they sit, named, at the top right of the toolbar - the formatting wraps,
  never scrolls them out of sight - and in the "/" menu; on a phone they ride
  the bar above the keyboard. Dictation is the browser's own speech
  recognition (no AI, no key); a browser without it shows no microphone.
  Make a Task works on the page and in Quick Note. A new editor feature goes
  in BOTH the web toolbar and the phone bar (`NoteEditor.jsx`).

- **Documents (Neil, 10/31/2026, plan https://claude.ai/artifact/VZxM4iUKKnmPfxsNvxxPdJ,
  `routers/documents.py`, `components/DocumentsBrowser.jsx`,
  `lib/documentLibrary.js`).** Four tabs: Documents (one library, `documents-browse`;
  the old Dashboard, My Documents and HR Records tabs and their subs land here),
  Templates, Nexus Sign (its own tab, unchanged - Neil's call) and PDF Tools.
  `GET /documents/library` is every document and envelope the caller may see, one
  row each, no content, and never a second access rule: documents as
  `list_documents` filters them, an envelope for its parties and sender and for HR
  readers as `/esign/requests` lists it, its people only for those who could
  already see them. HR packet rows stay behind `/hr/packet-documents`. A row
  opens beside the list (`DocumentSidePanel.jsx`). Status words live in
  `rowStatus`; the screen says Signed while Nexus Sign and the sealed PDF keep
  Fully Executed. Templates have ONE status (`_template_state`: draft, published,
  changes, archived) and ONE Publish: publishing a draft is the only step that
  makes it usable, a document is made from the published wording
  (`_released`) exactly as an HR packet prints it, and a template live since
  before this is released as it stands on first use or first edit.

- **Sheets and live editing (Neil, 11/05/2026, `routers/documents.py`
  "Working together", `frontend/src/sheets/`, `frontend/src/docLive/`).** A
  spreadsheet is a Document of kind `sheet` (content = the workbook snapshot,
  `type: 'nexus-sheet'`) - folders, tags, the library, archive and versions
  are a document's; no templates, merge fields, PDF / Word export or signing
  (it downloads as .xlsx / .csv in the browser). The engine is ours
  (`sheets/`, own formula engine, no new dependency); rows and columns have
  stable ids and formulas are stored by those ids, so concurrent inserts and
  deletes keep every formula pointing at the right cell. The owner (or an
  administrator) shares with Nexus People, Can Edit / Can View
  (`documents.shared_with`); a share opens the document wherever it sits; an
  editor changes title and content only. Editors type together live over the
  SAME encrypted Realtime transport Notes uses (`notes/collabTransport.js`,
  key from `GET /documents/{id}/collab`, editors only, rotated when an editor
  leaves) through ONE hook, `docLive/useLiveSession.js`; every live save
  carries `ydoc` + `yepoch` + `rev` (409 merges and resends; a save outside
  the session drops the state). Every editable draft document opens live in
  the Document Builder (`LiveDocumentGate`; `docLive/docModel.js`: pages,
  header and footer as Yjs fragments); remote typing is never saved, scanned
  for {{tokens}} or tracked as a change by the receiver. A viewer, a final
  document, a template or a failed session gets the builder as it was;
  `VITE_DOCS_LIVE=off` + a redeploy turns live Docs off. Never add a second
  live channel, a second sheet engine or a sheet store outside `documents`.

- **PDF Tools (Neil, 11/02/2026, `frontend/public/pdf-editor-app/`,
  `views/PdfEditorModule.jsx`, `views/pdfTools/`, `routers/pdf_tools.py`).** A
  static engine in a same-origin iframe, under Documents > PDF Tools. The shell
  reaches it ONLY through `nexus-bridge.js` (postMessage both ways, origin and
  source checked), which reaches the engine ONLY through `window.__pdfEngine`
  and its `pdf-engine:*` events. Every save and export goes through the engine's
  one save layer and `_verifyOutput`: bytes that do not open are never offered,
  and a redaction really removes the content from every output. A test of
  redaction must inflate every stream and decode hex strings - pdf-lib writes
  text as `<...> Tj`, so a plain search of the file finds nothing and proves
  nothing. Egnyte keeps old versions, so a redacted file never goes back in one
  click: Save Back opens the dialog and its warning. Nothing is uploaded to a
  third party, no CDN (the CSP is self only), no AI path. Each open, save, send,
  redact, protect and export writes one Audit Log row through
  `POST /pdf-tools/events` (name, page count and places only, never the file).
  Unsaved work: `setInlineDirty` for navigate() and `usePopGuard` for Back and
  Forward, which App's popstate listener asks first (`runPopGuard`) - never a
  second popstate listener, because Chrome runs a window's listeners in the
  order they were added, capture or not, and jsdom does not. Engine tests are
  `e2e/tests/pdf-tools.spec.mjs` (their own CI job, real browser, real files).

- **Cubby tasks in Nexus Tasks (Neil, Oct 30 2026, `backend/cubby_tasks.py`,
  Settings > Operations > Cubby Tasks).** After each 15-minute Cubby sync
  (`cubby_sync.run_claimed` calls `cubby_tasks.after_sync`), every open
  Cubby task becomes ONE Nexus task linked by Cubby's id (`tasks.cubby_task_id`
  + `cubby_task_links`): in the facility's project from the Settings map
  (no project = skipped and counted, never guessed), assigned to the people
  Cubby has it assigned to - the assignee is NOT in Cubby's API, it comes from
  Cubby's reporting warehouse (`cubby_warehouse.task_rows` / `manager_rows`,
  names matched to Nexus people by work email); a group-assigned or
  unassigned task goes to the project alone. ONE WAY for content: a task
  made in Nexus never goes to Cubby; only Cubby's own fields (title,
  description, due date) refresh, and only once Cubby's `updatedAt` moved.
  Done both ways for Cubby tasks only: closed in Cubby closes it here;
  closed or reopened in Nexus by ANY path is queued by the before_flush hook
  (`cubby_tasks.wire`, in `database.py`) and sent by `cubby_task_push_loop`
  through `ops_cubby_push.set_task_status` behind ITS OWN "Close Tasks in
  Cubby" switch (default OFF; never the rate-and-rent Push to Cubby switch).
  Every Nexus write goes through `routers.tasks._create_task` / `update_task`
  as the facility project's owner - never a second write path.

- **Knowledge Base filing and links (Neil, 11/02/2026):** a page APPLIES TO
  many departments (`kb_documents.departments`, the original comma column,
  read through `kb_core.departments_of`; default = its collection's
  department) - it is shelved in ONE collection and shows under "Also
  Applies Here" in every other department's collection and in the
  department filter on search and `/kb/pages`. An import is filed by RULES
  with no AI (`kb_filer.py`: type from the shape of the text, departments
  and collection from names in it, tags already in use, each with a reason
  the import screen shows); with AI on, Nexus's picks win where it gave one.
  The link graph (`kb_graph.py`: See Also both ways, embeds, pages taught in
  the same course, same collection, shared departments and tags) is walked
  at read time inside the reader's wall - search's "Linked to These
  Results", Ask Nexus's extra sources (the answer step stays behind the AI
  switch) and the page rail's "Around This Page" - never a second index or
  a model-built graph. `test_kb_filing_graph.py` pins it.
- **Training due modes and escalation (Sagar, 11/03/2026, `kb_daily._due_for`,
  `run_escalations`):** an assignment rule or plan is due either WITHIN
  `due_days` of the person's start date (else today) or BY ONE DATE for
  everyone it covers (`due_date` - company-wide, department-wide), with
  `due_days` as the GRACE for someone who joins after that date (their copy
  is due that many days from their start, never a date already past). A
  rule with `new_hires_only` is the onboarding track: only people who start
  on or after the rule's own day, nobody already here. `escalate_days` on a
  rule raises a course still not done that many days after its due date to
  the person's manager (nobody = the company's HR contact), once, then
  weekly, stamping `kb_course_assignments.escalated_at` for Compliance; the
  pass runs under the `kb_daily` Automations switch. A course's
  `default_due_days` only fills a hand assignment with no date picked.
  `test_kb_training_due.py` pins all of it.

## Asana — removed (Sep 2026)

The Asana workspace is gone and the two-way sync, import, OAuth, webhook and
rescue code has been deleted. **Do not rebuild any path to Asana.** The data
was deliberately kept: every `asana_*` table and row (task/comment/attachment/
activity links with their Asana gids, the project map, import jobs, user
tokens) and every Asana-derived column (`synced_with_asana`,
`original_asana_url`, `asana_option_gids`, `employees.asana_id`) stays as a
permanent record of where each task came from - never drop them, and keep
their models and migration lines. Imported content still renders as before
(`[Asana · Name]` comment authors, read-only "Calculated in Asana" fields,
`asana` entries in a task's due-date history).

Rows that still point at Asana-hosted files or pages have dead links (1,834
on dev at removal, ~600 of them files only Asana ever stored). The read-only
`GET /asana-legacy/audit` (`backend/asana_legacy.py`, manager-only, no UI)
lists every one and counts the archived rows. The custom-status merge that
used to live in the sync is `backend/task_status_dedupe.py`; the API's
public-URL helper is `app_url.public_base`.

## Asset Management module (Neil's)

`frontend/src/asset/` (the module, mounted by `views/AssetModule.jsx`) and
`backend/routers/property_assets.py`. The data is real: 24+ properties,
vehicles and equipment with their records (warranties, inspections, plans,
utilities, AHJ, vendors, maintenance, permits, timeline) and an activity log.

- **Saves are per row** (Oct 21 2026): `useNexusStore` diffs the store before
  and after every change (`lib/diff.js`) and `lib/sync.js` POSTs only the rows
  that changed to `/property-assets/changes`; each row carries the `_rev` it
  was read with and a row the server changed since comes back in `conflicts`
  (the tab re-pulls and says so). Never bring back a whole-portfolio save from
  the client - `PUT /workspace` is an officer's seeding tool only.
- **Privacy and scope are the server's**: `GET /workspace` returns only the
  assets the caller may see (`private` assets are officers' alone -
  `property_links.can_see_private`; `nexus_access_scopes` rows for
  `property-asset` narrow the rest) and every row write is checked the same
  way. Only an officer sets or clears Private.
- **Company is a field, not a wall** (Neil, 11/03/2026): every asset carries
  `companyId` (`property_links.property_company` reads it; the old guess is
  only the fallback). Administrators SEE every company's assets - never add
  a company wall to the asset reads. Only ASSIGNING a company is limited to
  the companies the saver may use (`_check_company`, refused per row).
  A ticket on a property files under the property's company (Neil,
  11/03/2026) - ONE rule, `ticket_property_company.resolve`, called by
  `file_ticket`, Batch Create and the re-point on edit; a blank company or
  a filer / requester / assignee who could not see that company keeps
  today's company; preventive `trusted_company` still wins.
- **A property may pin its Egnyte folder** (Neil, 11/03/2026): `egnyteFolder`
  on the asset (Details > Egnyte Folder, Find Folder lists name candidates
  from `GET /property-assets/{id}/egnyte-folders`), checked on the row save
  (`_check_egnyte_folder`: inside the property roots, normalized, no '..').
  Construction files go to the pinned folder FIRST; a pinned folder Egnyte
  says is missing never falls back to a name match or the root - the sweep
  HOLDS the files (`egnyte_status='held'`) until it is back or re-pinned.
- **Files are URLs**: photos and documents go browser -> the PRIVATE
  `asset-files` bucket (`lib/upload.js`) and the record keeps the canonical
  URL; the save refuses a new data: URL. `asset_files_migrate.py` moves the
  old inline ones.
- **Map points come from the server**: `asset_geocode.py` looks each address
  up once (Nominatim, paced, never a private asset) and keeps `geo` on the
  asset; the browser never geocodes.
- The strip is Overview / Maintenance / Records / Timeline; the seven record
  collections live under Records as a segmented control; `view` still holds
  the collection key, so deep links from bells, Critical Items and the
  Activity Log land on the right table.
- **Every open asset is a URL** (Oct 21 2026): `/property-asset/a:<id>:<view>`
  (`assetSub` / `parseAssetSub` in `lib/navigation.js`; the portfolio stays
  `/property-asset/asset-portfolio`, the shell's default sub). The module's
  state writes the segment and a segment arriving from outside (a pasted
  link, Back) sets the state - keep both effects; never navigate by setting
  `activeId` from a URL anywhere else.
- **The street line is the street**: `splitAddress` (`lib/dataNormalization.js`)
  peels "City, ST ZIP" off `address` into city / state / zip / county on every
  load and on create, keeping the original line as `addressRaw`. Add Asset is
  one screen (class, name, one address line, type, stage); everything else is
  filled on the asset.
- **Nothing is deleted by code, ever** (Neil, Oct 21 2026 - the release must
  lose no data): the activity log is append-only (the GET bounds what a tab
  sees, the database keeps everything); Delete Forever works only from the
  Trash, a live asset is moved there instead, and the log stays; a stamped
  row is written only with the `_rev` it was read with - a save without one
  (a cached copy, an old tab) is a conflict, never an overwrite, and deletes
  carry `deleteRevs`; a change the server did not keep leaves no log entry;
  only a NEW `data:` file URL is refused (a legacy path or outside link is a
  link); what the migration or geocoder did to a row travels with a tab's
  next save (`_carry_over`); `PUT /workspace` is refused on a deployed API
  unless `NEXUS_ASSET_SEED_PUT` is set; the save queue keeps a batch through
  404 / 405 / 429 / 401 (a deploy window) and drops only 400 / 403 / 413 /
  422, with a notice. The release runbook with the backups, the bucket and
  the verify lists: https://claude.ai/artifact/MZR3srrjuzCQQYHTMERgNU .
- Equipment and vehicles pair with Item Management (`AddItemModal`) - do not
  build a second warranty/serial system there.
- **Preventive maintenance (Neil, 11/03/2026, Construction plan phase 5).**
  Tickets ARE the work orders - no second queue. A preventive schedule is a
  `property_maintenance_services` row with `kind` calendar / floating /
  meter (`''` = the old service set from a resolved ticket), set under the
  property's Maintenance > Preventive Maintenance and run by the SAME daily
  scan (`maintenance_services.run_daily`, reminders_loop, switch
  `maintenance_services`) - never a second scheduler. Each occurrence files
  ONE ticket through `tickets.file_ticket` as whoever last saved the
  schedule; `property_maintenance_occurrences` (unique schedule + due key)
  is the idempotency key. A preventive ticket carries `service_id`,
  `pm_due_on` (Overdue) and `equipment_asset_id`; closing it by any path
  writes its maintenance record and moves a floating schedule on
  (`maintenance_pm_sync.py`). Meter readings are read from the asset's
  record (`odometer` + the odometer / vservice logs, `hours`), never typed
  twice. Scan to Request: site / equipment tags are `/tickets/place/<p>[/<a>]`
  (`maintenance/placeLink.js`), recognized by the ONE Items scanner and
  printed by the Items TagSheet; `routers/maintenance.py` holds the place
  sheet, Report a Problem, the walled roll-up and Workday's My Work.
  Review rules (11/03/2026): the ticket's company is the TEAM's
  (`file_ticket(trusted_company=)`, the team must be the property's
  company); a preventive ticket = `service_id` AND `pm_due_on` (a
  ticket-born service keeps its old behavior); a schedule save carries its
  `rev`; an occurrence already filed rolls the schedule on; the NEWEST meter
  reading counts (a drop rebases, a jump past 3 intervals waits for Confirm
  Reading); every date is the company's team-zone day
  (`maintenance_services.local_today` / `TodayCache`); resolving a
  preventive ticket by ANY path needs a photo (`require_finish_photo`).

- **Construction Jobs (Neil, 11/03/2026, plan
  https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).** ONE Job record
  (`construction_projects`, `job_type` work_order | project) per piece of
  work, always in a company (`company_id`, walled like the rest of Nexus);
  the work lives in its home module: the Job's own task project
  (`task_project_id`, stamped from the company's "Work Order" /
  "Construction Project" template) holds schedule, milestones and the Punch
  section (Done, then the project status Verified) - Neil overrode Sagar's
  08/04 "independent of Tasks" rule; Tickets are the maintenance work
  orders (Start Job links a ticket; job complete resolves it through the
  desk's own update path); crews from Shifts placements at `project-<id>`,
  hours from `time_punches.jobsite` (hours only, never pay); forms via
  `doc_form_entries.linked_project_id` under the ONE form reach rule; money
  is read from Intacct by the job's Project-Job code (`intacct_project_id`),
  never keyed into Nexus, for `_may_see_cost` + Accounting grant + entity
  access only - change order and contract dollars follow `_may_see_cost`
  everywhere (weekly report and PDFs render them per viewer). Field writes
  use ONE idempotency mechanism: the `Idempotency-Key` in
  `nexus_idempotency_keys` (phone-made ids are only the record's own id and
  the outbox sends that id as the key; docs/Offline.md). Closeout writes to
  Asset Management only through its per-row save (`post_changes`) as the
  person closing out, under their edit permission, with fixed `cx-<record
  id>` ids that are only ever created, never overwritten, never PUT
  /workspace. "Done needs a photo" is enforced on the construction punch
  route only - completing a punch task from Tasks does not ask (known gap).
  AI stays off: nothing in the module waits on it.
  **Round Two (Neil, 11/05/2026, plan
  https://claude.ai/artifact/EpG2gQr8KVi1ZZRaM6zVBE):** a Target Finish
  that moves needs a reason (`change_reason` on the PATCH; kept as a
  `target_moved` activity row with before / after, read by
  `construction_health.target_moves` for the health row and the weekly
  report); a job carries `units` / `square_feet` (cost per unit and per
  square foot on Money and the dashboard's Program table, which reads the
  same `/construction/money/flags` figures as the tab); permits and
  inspections are the closeout records live from day one (`due_on` on an
  inspection = its scheduled day; the Permits And Inspections tab on a
  Project; `construction_field.inspection_tick` bells the superintendent the
  day before, a Failed result bells the managers); a daily log's `subs`
  lines are the subcontractors on site (`construction_field.clean_subs`);
  punch.verified, field_ticket.signed, change_order.sent / approved /
  sent_back / declined, job.closed_out and report.published are Workflows
  events, so a change-order threshold is an automation rule, never code.
  Vendors are Intacct's, through Accounting > Vendors & Customers - never a
  Construction vendor directory (Neil, 11/05/2026).
- **Subs and their papers (Round Two item 7, 11/05/2026,
  `routers/construction_subs.py`, `vendor_compliance.py`):** a sub on a job
  is a `ConstructionJobLink` kind `sub` whose `ref_id` is the Intacct
  VENDORID (picked through `accounting_partners._get`, `note` = the trade);
  the papers are ONE row per VENDORID (`vendor_compliance`: insurance,
  workers comp and license expiry, W-9, with Intacct's name copied in) read
  by the job's Subs tab and by the vendor record's Compliance tab in
  Accounting through the same `construction/VendorCompliance.jsx`; the state
  words (missing / expired / expiring / ok) are `vendor_compliance.state`,
  the one rule; `expiry_tick` (in `field_loop`) bells the managers at 30 /
  7 / 0 days once per paper and date. Never a second compliance store, no
  contact or payment details here, nothing written to Intacct.

## Gotchas

- The shared dev database (Supabase `greens-nexus-dev`) backs the live
  dev.nexus site — if your local backend points at it via `DATABASE_URL`,
  SELECT freely but only mutate rows/tables you created.
- DevTools "Disable cache" makes image caching look broken — uncheck it before
  judging load behavior.
- The root README describes an old static site — ignore it; this file and
  `git log --oneline` are the real documentation.
- Use American English spelling everywhere — code, comments, UI copy, email/
  notification templates, docs (e.g. "color" not "colour", "behavior" not
  "behaviour", "organize" not "organise", "license" not "licence").
- Use US date and time format everywhere in user-facing UI, copy, and exports:
  dates as MM/DD/YYYY (never ISO YYYY-MM-DD or DD/MM/YYYY) and times as 12-hour
  with AM/PM (never 24-hour) - Charmi/Visesh, Aug 4. Use the shared helpers in
  `frontend/src/lib/datetime.js` (formatDate / formatTime / formatDateTime)
  instead of ad-hoc toLocale*/Intl.DateTimeFormat calls so it stays consistent
  app-wide. Date BOXES are `DateField` (`tasks/components.jsx`), never a native
  `<input type="date">` - that one follows the computer's region and shows
  20-10-2026 on an Indian laptop (Neil, Oct 19). `npm run lint` (CI) fails on
  any NEW native date box or toLocaleDateString / toLocaleTimeString /
  Intl.DateTimeFormat call (`frontend/scripts/check-dates.mjs`; older code is
  in its baseline and may only go down).
- **UI text casing (Neil, Jul 28 — supersedes any earlier sentence-case note):
  Titles, headings, tab labels, and buttons use Title Case** ("Punch In",
  "Start Break", "Time Sheet", "Request Time Off"). So do status labels,
  chips and column headers ("In Progress", "On Hold", "Awaiting Approval" -
  never "In progress"; Neil, Sep 30). Body copy, hints, empty states, and
  descriptions stay sentence case.
- **American English, US formats, no exceptions (Neil, Oct 17 2026 - raised
  more than once):** every user-facing string, server-built ones included
  (notification titles and bodies, priority notices, emails, PDFs), shows
  dates as MM/DD/YYYY - never interpolate a raw ISO `2026-10-04` (route it
  through `us_date` / `_us_day` on the backend, `formatDate` on the
  frontend) - times as 12-hour AM/PM, and American spelling. Notice titles
  are Title Case like any other title. The time record is a **"Time Sheet"**
  in copy (two words, capitalized in titles) - not "timecard", "time card"
  or "timesheet"; identifiers and route keys (`timecard`, `timesheet`) stay.
- Never use em dashes in user-facing copy — plain hyphens ("-"). Em dashes
  read as AI-generated (Visesh, Jul 28).
