# Item Management — QA report + structural & UI change plan (20 Jul 2026)

## How this QA was run

- **3 deep code audits** (full read of `InventoryManagement.jsx` 8.2k lines, `items.py` 2.7k lines, `Assignments.jsx`, `NotificationBell/Toasts`, `Purchase.jsx`, `RequisitionContext`, `InventoryContext`, `api.js`, models + migrations) — every finding verified against actual code.
- **API-level QA** (earlier today): 32 lifecycle probes + 12 regression probes on a scratch DB — all pass after today's fixes.
- **Live UI smoke** (Playwright against local E2E stack): app boots clean, no console errors, "Assigned · GSE" badge renders correctly in Manage, transient items unaffected. (Banner/accept flows can't be driven headless — no MSAL account in E2E mode — but the same paths were verified at the API level.)
- **Jul 14 audit workbook** (UX-016…UX-030) reconciled — still-open items folded in below.

**Already fixed & committed today (030fb46):** Nexus-People-only pickers, `location_assigned` badge, photo-optional one-click acceptance + banner, Ctrl+V paste app-wide, deleted-item checkout/assign holes, delete-while-held, fake-200 checkout PATCH, transient→permanent silent flip, decline prompt-cancel.

Effort: **S** < ½ day · **M** ½–1 day · **L** multi-day. IDs referenced below (UX-nnn = Jul 14 workbook).

---

## P0 — fix before/at go-live (security + lying UI)

| # | Finding | Where | Effort |
|---|---|---|---|
| P0-1 | **Requisition create accepts client `status`** — any employee can POST `"status":"manager_approved"` and skip approval entirely; client also supplies the row id. Force server-side `pending_manager` + server-generated ids (same hardening items.py already has). | `requisitions.py:21,28,137-141` | S |
| P0-2 | **Broadcast notifications readable by every employee** — GET /notifications returns all `recipient==""` rows to anyone; who-requested-what, order totals, lost-item reports all leak. Server-side: broadcast rows only to level ≥ 3. | `notifications.py:83-89` | S |
| P0-3 | **Fake-success reject, everywhere** (UX-016 family): `rejectRequest`/`rejectRequisition` are fire-and-forget (toast + optimistic flip regardless of outcome), and the bell's reject additionally falls back to PATCHing an *order id* as a checkout id (guaranteed 404, still "Rejected — clearing…"). Make both context fns return promises; await + error-toast at all call sites. | `InventoryContext.jsx:232-239`, `RequisitionContext.jsx:275-282`, `InventoryManagement.jsx:6491`, `NotificationBell.jsx:353-395` | M |
| P0-4 | **Returns/handovers can complete without the required evidence photo**: failed Supabase upload still marks the checkout returned (`photoUploadError` ignored by all callers); AllocateModal's "Photos by You" path has no photo guard at all. | `InventoryContext.jsx:286-330`, `InventoryManagement.jsx:5855-5874,5974` | M |
| P0-5 | **Employee with zero checkouts can never accept a permanent assignment** — My Items renders the "No checkouts yet" empty state instead of mounting the panel that contains the Permanent tab; today's banner deep-links exactly there. Mount `MyCheckoutsPanel` whenever there are assignments too. | `InventoryManagement.jsx:3653-3664` | S |
| P0-6 | **Purchase submit flashes success before the API answers**, then silently deletes the optimistic row on failure (typed reason lost). | `Purchase.jsx:97-107`, `RequisitionContext.jsx:233-240` | S |
| P0-7 | **No transition guards on requisition approve/reject/allocate/return/lost** — reject-after-fulfilled, double-approve (duplicate notifications), return of a never-allocated row all succeed. Port items.py's `_VALID_TRANSITIONS`. | `requisitions.py:196-423` | S |

## P1 — correctness batch (this week)

| # | Finding | Where | Effort |
|---|---|---|---|
| P1-1 | **Checkout/assign TOCTOU double-booking**: availability check → insert with no row lock and no DB constraint; two concurrent requests both create pending rows. Add `with_for_update()` on the item + **partial unique indexes** `item_checkouts(item_id) WHERE status IN (live)` and `item_assignments(item_id) WHERE status IN (live)`. | `items.py:1197-1217,2088-2096,2214-2227` | M |
| P1-2 | **Solo-checkout PATCH takes no FOR UPDATE** (only ordered ones do) — concurrent approve+cancel: cancelled checkout ends up approved. Lock the row at the top of `update_checkout`; same in `request_extension` (double-pending + duplicate broadcast). | `items.py:1308-1318,1680` | S |
| P1-3 | **Raw `status` writes strand items**: generic PATCH accepts any lifecycle status with no cross-check (idle item set `checked_out` = permanently un-requestable); audit-undo restores unvalidated status/serial strings. Make lifecycle derived-only; one admin "reconcile state" endpoint replaces raw writes and also rescues stuck `pending_receipt` (which today has **no exit** if the employee never confirms receipt). | `items.py:758-762,2624-2693,21-28` | M |
| P1-4 | **Batch bulk-assign notification has `ref_id=""`** — can never be auto-cleared or deep-linked; lingers in the bell forever after all N items are accepted. | `items.py:2232-2235` | S |
| P1-5 | **Batch order actions toast full success when items failed** ("3 items rejected" while offline): approve/reject/allocate/return-all loops swallow per-item errors. Count fulfilled vs failed, report both. | `InventoryManagement.jsx:6483-6564,7830-7835` | S |
| P1-6 | **Reassignment chain silently drops the promised next assignee** when the return is accepted as "Retire", or when Force Recover cancels mid-flight — B is never assigned and never notified while the modal claims otherwise. Warn in the modal + notify the dropped assignee. | `items.py:2349,2412-2438`, `Assignments.jsx:472-541` | M |
| P1-7 | **Manager cannot cancel a pending/approved checkout** (only reject-with-notification semantics). Allow level ≥ 3 cancel on pending/approved with a targeted "cancelled by {manager}" notification — symmetric with assignment force-cancel. | `items.py:1340` | S |
| P1-8 | **Mutation refresh swallowed by in-flight 15s poll** — accept/decline can show stale "Awaiting acceptance" for 15s. Make `_asgFetch` queue a follow-up when called during flight. | `Assignments.jsx:34-46` | S |
| P1-9 | **Approve-from-bell false "already processed"** when the checkout list lags the realtime notification; refresh before judging (the auto-action effect above it already has the 90s grace). | `NotificationBell.jsx:292-299` | S |
| P1-10 | **api.js retries non-idempotent POSTs** on timeout/5xx (Azure cold start) — duplicate checkouts/assignments/notifications. Retry GETs only, or add idempotency keys server-side. | `api.js:28-97` | M |
| P1-11 | **"Discard"/"Request again" rewrites a manager-rejected checkout to *cancelled*** — history then blames the employee. Keep rejected rows immutable; re-request should only create the new row. | `InventoryManagement.jsx:2721-2737` | S |
| P1-12 | **Import modal promises "unknown types → Other" but the backend creates new types** (AI-matched or brand-new, then toasts "Added N new types") — two screens promise the opposite of reality (UX-020 adjacent). Align copy + show the would-be-created types in the preview. | `InventoryManagement.jsx:987,994,4605` vs `items.py:552-596` | S |
| P1-13 | **Damage-keyword sniffing auto-retires items on false positives** ("undamaged", "not broken" match). Replace with an explicit condition enum on returns; keep the note free-text. | `items.py:60,1395-1402` | S |
| P1-14 | **Item catalogue photo_url skips `_validate_photo_url`** on create/update — external URLs land in every user's catalogue. | `items.py:524,764` | S |
| P1-15 | **Manager Manage-mode cart bypasses the targeted approver** (no approver step → broadcast to all managers) and is a second, divergent cart implementation. Render `showApprover` and unify to one cart context. | `InventoryManagement.jsx:8165` vs `3734` | M |
| P1-16 | UX-017 / UX-018 (still open): missing-photo warnings ignore `pictureRequired=false`; batch re-request allows 365 days vs backend's 90 cap. | `InventoryManagement.jsx:5351…`, `2256,2303` | S |

## P2 — structural changes

1. **Retire the legacy inventory stack** (`inventory_requests.py` router + `InventoryItem`/`InventoryRequest` models + 34-row mock seed + unused `api.js` wrappers) — no frontend view calls it; it still seeds fake data on fresh DBs, has its own fake-success PATCH, GREATEST/LEAST that errors on SQLite, and an IDOR-by-name-substring in the legacy list. Keep audit history readable. The bell's legacy `inv_request` branch (wired to the wrong API — unactionable) goes with it. **(M)**
2. **`hardware_assets` fold-into-items** (existing CLAUDE.md plan; coordinate before touching): ungated GET + TOCTOU allocate live there today. **(L, plan first)**
3. **Shared `items_common.py`**: one `_ROLE_LEVEL` (currently 3 copies), `_title_case_email` (3 copies), `_nexus_people_only` (2 copies), `_notify`, condition enum; convert inline `user["level"] < 3` checks to `require_level_or_module` so an `inventory:editor` grant behaves consistently (today: can create/assign items but can't approve, and can't even list the assignments it just created). **(M)**
4. **Indexes** (none exist beyond the serial one): `item_checkouts(item_id,status)`, `(order_id)`, `(requested_by_email)`, `item_assignments(item_id,status)`, `(assignee_email)`, `nexus_notifications(recipient,actioned)`, `(ref_id)` — as `CREATE INDEX IF NOT EXISTS` lines in both dialect lists. **(S)**
5. **Backfill the SQLite migration list** (missing: `items.serial_number`, `assigned_to_*`, 11 late `item_checkouts` columns, `nexus_notifications.read_by`) + add the serial unique index on SQLite — teammates' pre-June local DBs 500 on every items SELECT today, and local imports can create duplicate serials silently. **(S)**
6. **Retire `assigned_to_location` fully**: the model field is only ever zeroed; ItemDetailsPanel still *reads* it, so its location box always shows blank ("claims unplaced") — switch panel to `item.location`, drop the column at next release. **(S)**
7. **Requester identity from the token, not the body**: checkout + requisition create trust `requested_by_email` — impersonation + notification misdelivery. Record submitter server-side; keep an explicit on-behalf field (see P3-A). **(S)**
8. **Import serial-range advisory lock** so two concurrent CSV imports don't collide and 500 the whole batch. **(S)**

## P3 — feature work still owed from the Jul 17 meeting

**A. On-behalf checkout ("who is this request for?")** — CartDrawer picker (Purchase.jsx pattern) + `CheckoutIn` beneficiary field. Design must ALSO fix what the audit found in the purchase flow's existing on-behalf: submitter can't see/track the request afterwards (visible only to the beneficiary), approver notification names the beneficiary as the requester, and the name-only datalist silently picks the first duplicate name. Store both `submitted_by` and `for`, show both, match by email. **(M)**

**B. EOM audit/attestation report** (August target) — per-location/holder checklist, select-all confirm, exceptions flag items; `item_audit_runs`/`item_audit_responses` tables. Design questions for Neil: cadence, and whether an exception auto-changes item status. **(L)**

**C. Add-item → assign inline** (Neil's "VL needs to clean this up") + one directory-picker component everywhere (raw `<select>` vs `PersonTypeahead` today). **(S)**

## P4 — UI truth & polish batch

- **Status coherence**: list view labels *pending* items "Checked out" (tile says "Under review"); CSV export writes raw `status` (no holder columns, so who-has-what can't round-trip); GlobalSearch shows raw "available"; Manage sorts by raw status while displaying `displayStatus`; KPI tiles ignore `location_assigned`/`permanently_assigned` so tiles don't sum. One `displayStatus`-everywhere sweep + export columns. (`IM:3618,3865,879-886,5327,8045`, `GlobalSearch.jsx:102`)
- **Silent failures**: manager-side return/add-to-cart/cart-remove/import failures are silent or swallow errors; approver/allocator fetch failure leaves Submit dead with no message (retry + inline error). (`IM:8159,7542,3330,929,2088-2101,6178`)
- **Report modal** status filter is missing `pending_receipt`; batch-delete button count vs filtered selection mismatch; history search only sees the 50 newest rows (slice before filter); declined assignments have no work-queue surfacing. (`IM:1103,5615/5384`, `Assignments.jsx:397-401`)
- **Names**: `auditName()` fabricates names from email local-parts — route through `useNameResolver()`; raw-email fallbacks in Assignments/Purchase; SendAlertModal picker still uses `getAllRoles` instead of the People directory. (UX-023)
- **Toasts/bell**: server-created toasts navigate nowhere (`action=""` — reuse the bell's `destinationFor`); extension toast not actionable; rejected/negative events show a green ✓ icon; `perm_update` bell cards go nowhere; 422 arrays render "[object Object]". (`NotificationToasts.jsx:8-16,105-116`, `NotificationBell.jsx:422-459`, `api.js:98-105`)
- **Modals**: backdrop/ESC close mid-save (UX-022, also ModalShell); native `confirm()` for custom-field delete (UX-021 half-open); zero-count type delete without confirm; ReceiptConfirmModal still has the emoji icons Neil rejected in AllocateModal.
- **Sentence-case sweep** (UX-029, Neil rule): ~60 labels across the three files — "Confirm You Have It", "Take / Upload Photo", "Start Reassignment", "Approve All", all bell TYPE_META labels, Purchase STATUS_LABELs, home cards. One mechanical pass.
- **Copy**: "Extend an Item" home card actually covers return AND extend (UX-030); "Retired" means two different things in adjacent columns (UX-026).
- **Manager Dashboard "Who has what" shows hardcoded sample rows** (e.g. "Dell XPS 15 Laptop" not in the DB) — sample-data-as-live; feed it from `/items` like the module's own board.

## Suggested order

1. **P0 batch** (one branch, ~1–2 days) — P0-1/2/7 are small backend edits; P0-3/4/5/6 are the UI-lying set. These are the "someone gets burned in week one" items.
2. **P1 batch** — backend concurrency + notification fixes first (P1-1..4), then the frontend truthfulness set (P1-5, 11, 12, 15, 16).
3. **P3-A on-behalf checkout** (Neil asked explicitly) with its purchase-flow fixes.
4. **P2 structural** — legacy retirement + shared helpers + indexes/migrations ride along in quiet moments; hardware_assets fold is its own planned task with Visesh/Ankush coordination.
5. **P4 polish** — sentence-case + status-coherence sweeps are mechanical; batch them per file to keep diffs reviewable.
6. **P3-B audit report** — design sign-off from Neil, build in August.

## Verification per batch

- Extend the scratch-DB probe scripts (pattern from today: seed sqlite → drive endpoints → assert) with cases for each P0/P1 backend fix; keep them under `e2e/` as committed specs where stable.
- `npm run build` + the Playwright smoke (app boots, badge, no console errors) per batch.
- Manual pass on dev with two browsers (manager + employee) for the approval/handover/return notification flows — concurrency fixes specifically need the two-actor test.
