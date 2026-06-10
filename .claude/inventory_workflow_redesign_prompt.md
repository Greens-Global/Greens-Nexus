# Handoff: Inventory allocation workflow redesign

Paste this whole thing into a fresh Claude Code session in `frontend/` (repo root one level up) on branch `dev` to continue.

## What just happened

Commit `a73c234` (pushed to `dev`) shipped: allocation/return notifications, a
fixed `StaleDataError` 502 in `backend/routers/notifications.py`, a redesigned
"My Requests" tab (searchable, filterable, completed items collapsed into an
accordion), a "Recent Return Photos" gallery, and — critically — it now
**surfaces** photo-upload failures instead of swallowing them silently. The
user immediately saw the real cause: **the `return-photos` Supabase storage
bucket doesn't exist** ("Bucket not found" toast).

**Already done, just needs the user to run it:** `supabase_return_photos_bucket_setup.sql`
(repo root) creates the bucket + RLS policies — same pattern as the existing
`supabase_realtime_setup.sql`. Ask the user to run it in Supabase Dashboard →
SQL Editor, then verify a return-with-photo actually shows up in the gallery.

## New work: redesign the approval → allocation handoff

The user sent screenshots showing two more problems plus a significant
workflow change request (verbatim):

> "once I click approve [screenshot: notification says 'It will be assigned to
> you by your supervisor shortly'] - workflow goes up but then - there are
> multiple same name - the workflow goes back when we click on track request -
> [screenshot] - supervisor approve shouldn't be there - once manager approves
> - it should prompt two names from the employee list - allocate to
> sai.malladi@greensglobal.com, ankush.narkhede@greensglobal.com and ofc me -
> visesh - so they'd receive a notification saying allocate and once they give
> the laptop and click on allocate either from the inventory management flow
> (need to create allocate button) or from the notification it goes to
> employee and return button goes live - also while manager allocates to any
> of the three of us - it should be in dropdown our name not our email. - add
> this in prompt or if you want you can create one now - also we should also
> have a button to cancel request."

### Bug to investigate first: "multiple same name" / "workflow goes back when clicking Track Request"

In the screenshots, two different requests both named "File Folders (Box of
50)" appear in "My Requests" — one at `IREQ-MQ3101EV` (status "To Be
Allocated", stage tracker shows "Waiting for supervisor") and another at
`IREQ-MQ3101EV`-ish further down at "Approved" stage. **Read the screenshots
again carefully** (they're in this conversation's history /
`C:\Users\Vlow\.claude\image-cache\...\1.png`, `2.png`, `3.png`) — the user
may be looking at duplicate request rows for what should be a single request,
OR the "Track Request →" link inside the notification (in
`NotificationBell.jsx` — the `action.view`/`action.sub` mechanism) navigates
somewhere that shows a stale/different stage than the live one. Find out:
- Is the backend creating duplicate `InventoryRequest` rows? (check
  `create_request` in `backend/routers/inventory_requests.py` — there's
  already a 409 idempotency guard on `id`, so duplicates would mean the
  frontend is generating two different IDs for one submit)
- Or is this just two *separate* requests for the same item name (e.g. user
  submitted twice) and the visual "goes back" is the stage tracker rendering
  an earlier request's state because of a stale `requests` array / realtime
  race in `InventoryContext.jsx`?

### The actual redesign — clarified decisions (already confirmed with the user)

The user answered three scoping questions. Build to these specs:

1. **Allocator list is role/group-based**, not hardcoded. Tag
   `sai.malladi@greensglobal.com`, `ankush.narkhede@greensglobal.com`, and
   the user's own email (`visesh.lodha@greensglobal.com` — confirm exact
   address via `userEmail` in the system reminder / MSAL) with a role at
   "supervisor" level or above in the existing `nexus_roles` table (via
   Admin → Access Manager, already built — see `AdminPanel.jsx` /
   `backend/routers/roles.py`). The inventory allocator-picker dropdown
   should query users at that level, **not** a hardcoded array.

   **Known gap**: `NexusRole` (in `backend/models.py`) only stores
   `email`, `role`, `assigned_by` — **no display name**. But the user
   explicitly wants the dropdown to show *names* ("Sai Malladi", "Ankush
   Narkhede", "Visesh Lodha"), not emails — same pattern as the existing
   hardcoded `MANAGER_NAME = 'Visesh Lodha'` constant in
   `ManagerDashboard.jsx`. You'll need to either:
   - (a) add a `display_name` column to `nexus_roles` (migration +
     update the role-assignment UI/endpoint to capture it), or
   - (b) maintain a small email→name lookup map somewhere central
     (quicker, but drifts from the role system the user asked for).
   (a) is more in the spirit of "role/group-based, editable later without
   code changes" — recommend that, but confirm scope/time tradeoff with
   the user since it touches the Admin panel too.

   New backend endpoint needed: something like
   `GET /inventory-requests/allocators` (manager-accessible, level 3+)
   returning `[{email, name, role}]` for everyone at supervisor level or
   above — `GET /roles` already exists but requires `require_administrator`
   (level 4), too high for a manager (level 3) to use here.

2. **Keep "To Be Allocated → In Use" as a stage** — don't collapse the
   stage tracker. The change is *who* can act on it: instead of "any
   supervisor or manager" (current check at
   `inventory_requests.py:212-213` — `user["level"] < 2`), only the
   *specific person the manager assigned* (plus managers/admins as
   override, probably) should be able to flip it to `allocated`.

   This means `InventoryRequest` needs a new column — e.g.
   `assigned_allocator_email` / `assigned_allocator_name` — set when the
   manager approves (extend the approve flow: instead of a bare "Approve"
   button, show a dropdown of allocators, then call
   `approveRequest(id, managerName, allocatorEmail, allocatorName)` →
   `PATCH /inventory-requests/{id}` with those fields).

   On approval, fire a notification to the assigned person:
   `type: 'allocate_request'` (or similar — check `TYPE_META` in
   `NotificationBell.jsx`), with an action that lets them allocate
   **directly from the notification** (the user explicitly asked for
   this — "either from the inventory management flow ... or from the
   notification"). Look at how `action: { label, view, sub }` currently
   works for "Track Request →" and extend it to support an inline
   action button that calls `allocateItem` directly, OR navigates to
   Inventory Management with the relevant request pre-highlighted/expanded.

   Also need a **new "Allocate" button** in `InventoryManagement.jsx`
   (the user said "need to create allocate button") — likely in a new
   "Assigned to me" section/filter so the three named people can see
   requests waiting on *them* specifically (not just managers via
   `ManagerDashboard`).

3. **Cancel Request button**: visible to the requester on `pending` /
   `approved` ("To Be Allocated") requests — i.e. **before** allocation
   happens (once allocated, cancelling doesn't make sense; they'd return
   it instead). Needs:
   - New status `cancelled` (or reuse `rejected` with a "cancelled by
     requester" flag — but a distinct status is cleaner for the stage
     tracker / `STATUS_META` / `_VALID_TRANSITIONS` in
     `inventory_requests.py`)
   - Backend: allow `pending`/`approved` → `cancelled` transition,
     requester-only (check `requested_by_email == user["email"]`)
   - No stock release needed (stock is only reserved at allocation time,
     per `_reserve_stock`/`_release_stock`)
   - Frontend: button in the "needs action" card group in My Requests,
     confirmation dialog (reuse the `useEscapeKey` + modal patterns
     already in `InventoryManagement.jsx`)

## Hard constraints (don't relitigate these)

- **Always warn before pushing** — backend changes under `backend/**`
  trigger an Azure App Service redeploy/restart of `greens-nexus-api-dev`
  that disrupts the live app. The user got angry about this once
  ("what the fuck are you breaking things") when it happened
  unannounced. State it plainly, then proceed once they say go.
- This is a genuinely large change touching `models.py` (new columns,
  possibly new status), `inventory_requests.py` (transitions + new
  endpoint), `roles.py` or a new endpoint (allocator list), `roles`
  table (display names), `ManagerDashboard.jsx` (approve→assign flow),
  `InventoryManagement.jsx` (allocate button, cancel button, assigned-
  to-me view), `NotificationBell.jsx` (new notification type + inline
  action). **Plan it out and confirm the migration/rollout approach with
  the user before writing code** — a DB migration for new columns on a
  live table needs care (default values, backfill for existing rows
  mid-flight).

## Suggested first steps in the new session

1. Re-read the three screenshots in image-cache to nail down the
   "duplicate request" bug — that's a quick win and worth fixing first
   in isolation (small, low-risk, no schema change).
2. Sketch the `InventoryRequest` schema change + migration plan, and the
   `nexus_roles.display_name` addition, and run it past the user before
   touching code — these are the two structural decisions that ripple
   everywhere else.
3. Build backend first (new column, transition rules, allocator-list
   endpoint, notification on approve), verify with the existing
   `backend/test_unifi_cloud.py`-style manual testing or curl, **then**
   build the frontend pieces, then warn-and-push.
