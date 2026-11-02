# Frontline Reach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four reach gaps the Pebb audit found (https://claude.ai/artifact/1qq2yHjsBkCnEjAwcBP3tx), in one PR, with nothing added for its own sake: Nexus installs on the phone and pushes; every person has Message and Call into Teams; Announcements gain an image, publish later, a notify choice and acknowledged-by names; the shift planner shows scheduled labor cost.

**Architecture:** A Progressive Web App layer (manifest, a service worker that only handles push, Web Push with VAPID keys from Azure app settings, subscriptions and an outbox in two new RLS tables, a `push_loop` in the lifespan that sends off the event loop) fed by a SQLAlchemy `after_insert` listener on `NexusNotification`, so every module's bell notice pushes without touching the module. Teams deep links through one helper and one `PersonActions` component. Announcements extended on the existing table and tile, published by a loop, notified through push / Teams / email. Labor cost computed server-side from `PayrollRate` for managers.

**Tech Stack:** React 19 + Vite (public/ assets, no PWA plugin), Web Push API, FastAPI + SQLAlchemy, `pywebpush` (new backend dependency), Microsoft Graph (Teams DM queue, mail).

**Spec:** Neil, 11/02/2026: "do it all in one pass" on the four-item cut (install + push; Message and Call; Announcements four adds; labor cost). Deferred by his call: Forms module, Spanish, offline punches, events.

## Global Constraints

- `frontend/public/_headers` (CSP) is a platform file: do not edit. `worker-src 'self'` and `default-src 'self'` already cover the service worker and the manifest.
- Never block the event loop: the push loop sends through `await asyncio.to_thread(...)` like `reminders_loop`.
- New tables need `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on dev and prod at release; list them in the PR (`nexus_push_subscriptions`, `nexus_push_outbox`). New columns go in models.py AND both main.py migration lists.
- Push is OFF until `NEXUS_VAPID_PRIVATE_KEY`, `NEXUS_VAPID_PUBLIC_KEY` and `NEXUS_VAPID_SUBJECT` exist on the server (Neil sets Azure app settings); `GET /push/config` then says `enabled: true`. Never generate or commit keys.
- Quiet notifications stay quiet: push carries the bell's title and body only, one per bell row, respects the existing per-person task-email muting where a row is a task event (read how `task_notify` decides) - no new noise.
- Evidence buckets are private; an announcement's image or file goes to `task-files` under `announcements/<id>/` via the Tasks uploader and is opened through the signed viewer.
- American English, Title Case titles / buttons, sentence-case hints, MM/DD/YYYY via `lib/datetime`, `DateField` not native date inputs, no em dashes. Settings rows use `components/settings/SettingsUI.jsx`; a switch saves on change.
- Shared files append-only: `models.py`, `main.py`, `api.js`, `tasks/components.jsx`, `App.jsx`.

## Interfaces

```python
# backend/push.py  (Task A)
def configured() -> bool                       # all three VAPID settings present
def queue_push(db, recipients: list[str], title: str, body: str, url: str = "", tag: str = "") -> int
    # writes one nexus_push_outbox row per recipient that has >= 1 subscription; returns rows written; no-op when not configured
async def push_loop()                          # lifespan task: drains the outbox every 5 s via to_thread(_send_batch); 404/410 delete the subscription; 5 failures disable it
# routers/push.py: GET /push/config -> {enabled, publicKey}; POST /push/subscribe {endpoint, keys:{p256dh, auth}, userAgent}; DELETE /push/subscribe {endpoint}; GET /push/subscriptions (mine)
# models: NexusPushSubscription(id, email idx, endpoint unique, p256dh, auth, user_agent, created_at, last_ok_at, failures)
#         NexusPushOutbox(id, email idx, title, body, url, tag, created_at, sent_at, error)
# listener: event.listen(NexusNotification, 'after_insert') -> queue_push for rows with a specific recipient (broadcast rows, recipient None, are not pushed)
```
```js
// frontend/src/lib/pwa.js  (Task A)
export function registerServiceWorker()            // after sign-in; /sw.js; no caching, push + notificationclick only
export function useInstallPrompt() -> { canInstall, install(), isStandalone, isIos }
export function usePushSubscription() -> { supported, enabled /* server configured */, subscribed, subscribe(), unsubscribe(), permission }
// frontend/src/lib/teamsLinks.js  (Task B)
export const teamsChatUrl = (email, message = '') => string   // https://teams.microsoft.com/l/chat/0/0?users=...&message=...
export const teamsCallUrl = (email) => string                 // https://teams.microsoft.com/l/call/0/0?users=...
export function canReachOnTeams(person) -> bool               // internal staff with a work email; never externals / guests
// frontend/src/components/PersonActions.jsx  (Task B)
<PersonActions email name size="sm"|"md" message call />        // two icon buttons, Title Case tooltips "Message on Teams" / "Call on Teams", open in a new tab
```
```python
# Announcements (Task C) - nexus_announcements new columns: image_url, file_url, file_name, publish_at (ISO, '' = now), notify ('quiet'|'push_teams'|'email'), notified_at
# GET /announcements hides rows with publish_at in the future from non-administrators and marks them "Scheduled" for administrators
# announcements_loop (lifespan): every 60 s publishes due rows (notified_at '' and publish_at <= now) -> recipients from audience -> push.queue_push + Teams DM queue (notify push_teams) or graph_mail (notify email) -> notified_at
# GET /announcements/{id}/reads already returns names; the tile shows "Acknowledged by Ana Diaz, Bob Lee and 3 more" with the list on click
```
```python
# Labor cost (Task D) - GET /shifts/labor?start=YYYY-MM-DD&end=YYYY-MM-DD[&company_id=] (require_schedule_write)
# -> { hours, cost, days: [{day, hours, cost}], people_without_rate: n, fixed_pay_people: n }   cost from PayrollRate.hourly_rate (history by day via timeclock's rate-for-day helper, exported), fixed-pay people counted not priced
```

## Tasks

- **A (worktree wt/reach-pwa):** manifest + icons (PNG 192 / 512 / 180 generated from the N mark; SVG kept), index.html head (manifest, theme-color, apple-touch-icon, apple-mobile-web-app-capable), `public/sw.js`, `lib/pwa.js`, registration in `main.jsx` after sign-in, My Profile > new section "Phone Notifications" (Install Nexus row with iOS instructions when not installable; "Push to This Device" switch; "Not set up yet" line when the server has no keys), backend `push.py` + router + models + migrations + listener + lifespan loop, `pywebpush` in requirements, tests (backend: subscribe / unsubscribe / outbox per recipient / broadcast skipped / not configured no-op / 410 removes; frontend: hooks with mocked navigator).
- **B (worktree wt/reach-teams):** `teamsLinks.js` + `PersonActions.jsx` + tests; place in Directory cards and `directory/ProfilePanel.jsx`, `OrgChartLens.jsx` nodes, `tickets/TicketDrawer.jsx` requester and assignee rows, `tasks/TaskDetailDrawer.jsx` assignee, `components/PersonHoverCard.jsx`; replace the ad-hoc Teams URLs in `dashboard/essentials/MyTeam.jsx`, `components/TimeAdmin.jsx`, `credvault/CredentialDrawer.jsx`, `directory/lib.js` with the helper (behavior unchanged).
- **C (worktree wt/reach-announce):** model columns + both migration lists, `AnnouncementIn` fields, list visibility, loop + notify fan-out (push through `push.queue_push` - import guarded so the branch builds before A merges), image / file upload in the composer (`storeTaskFile` under `announcements/<id>/`, Ctrl+V paste), "Publish Later" (`DateField` + time), "Notify" select (Quiet / Push and Teams / Email), acknowledged-by names in the row, tests (backend: scheduled hidden from staff, due row published once, fan-out per mode, image URL validated; frontend: composer fields, acknowledged-by text).
- **D (worktree wt/reach-labor):** endpoint + tests (rate by day, fixed pay counted, no rate counted, company scope) and the planner summary line (managers only; "Scheduled 312 h · $7,840 · 2 people without a rate · 1 on fixed pay", `formatMoney` if the repo has one, else `$` with thousands separators).
- **E (main checkout, after merge):** CLAUDE.md bullets (push via the bell listener, no second channel; Teams links through the one helper; announcements publish loop; labor from PayrollRate), three reviewers, fix pass, PR; RLS list for release.
