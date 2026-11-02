# Changes from the Item Module Meeting — 17 Jul 2026

Source: `Item Module Meeting.docx` (1h 4m, Neil walkthrough with ops/IT/accounting
teams). Module goes live to everyone **Monday 20 Jul** — items marked MONDAY were
promised for then. Each item below is cross-checked against the current code.

Legend: ✅ already works · 🟡 partial (needs change) · ⬜ not started

---

## A. Item module — code changes (Visesh)

**A1. Batch "assign to location" looks like it does nothing (MONDAY).** 🟡
Neil batch-assigned unassigned items to a location live on the call and they all
still showed **Unassigned** ("your assignment is not operating yet correctly…
get these things ironed out this weekend").
Root cause — it's not a wiring bug: `bulk_assign_to_location`
(`backend/routers/items.py:2155`) only writes `items.location` and by design never
touches assignment state, while the display-status helper (`items.py:86-90`)
calls any permanent item with no *person* holder "unassigned". So location gets
set but the chip never changes.
- Make location a first-class assignment for permanent items: status helper (and
  frontend chips) should render permanent + `location` set + no person holder as
  **"Assigned · \<location\>"**, not "Unassigned". Neil's model: "everything
  should be assigned permanently to that location."
- Refresh the list immediately after batch edit so the change is visible live.
- Dedupe the two paths that write `location`: the Batch Edit "Fields → location"
  checkbox (`bulk-update`) and the "Assign → location" section both write
  `it.location` (only the latter clears legacy `assigned_to_location`). When the
  Assign section is used, ignore/hide the location field checkbox.
- Minor: `bulk_assign_to_location` returns `skipped: []` unconditionally — return
  real feedback like the person path does (`_bulk_assign_blocked`, `items.py:2136`).

**A2. Permanent-item acceptance: drop the mandatory photo + save friction (MONDAY).** 🟡
Neil: "which either way we should not have to do on a permanent item"; Charmi
flagged the extra save; VL on the call: "I'll fix it for permanent items as well."
Pranshu noted it as an official action item.
- Backend `accept_assignment` (`items.py:2212`) 400s without a photo — make the
  photo **optional** for assignment acceptance (keep the field, allow skip).
- Frontend `AcceptAssignmentModal` (`frontend/src/components/Assignments.jsx:278`)
  gates the button on `!file` — allow one-click accept, photo optional.
- ⚠️ This amends the domain rule in CLAUDE.md ("assignment acceptance requires
  photos") — update CLAUDE.md when shipped. Checkout/return photos stay mandatory.

**A3. "Where did that end up?" — make pending acceptance discoverable.** 🟡
Neil assigned himself an iPhone and couldn't find where to accept it (it lives in
My Items → **Permanent** sub-tab, `InventoryManagement.jsx:2498/2577`). The
recipient today only gets a bell notification on the 15s poll; the toast goes to
the *assigner* (`Assignments.jsx:136`).
- Show a toast to the **recipient** when a `perm_assign` notification lands
  (deep-link already routes to the Permanent tab).
- Add an "N items awaiting your acceptance" banner/callout on the Items landing
  view so it can't be missed.

**A4. Checkout on behalf of someone else ("who is this request for?").** ⬜
Neil: construction workers will come to the office and ops will check items out
*for* them — "you need to be able to select someone else… make sure that gets
added in."
- The purchase flow already has exactly this: `forSelf` toggle + directory
  typeahead in `frontend/src/views/Purchase.jsx` (label "WHO IS THIS REQUEST
  FOR?"), beneficiary handling in `backend/routers/requisitions.py`. **Copy that
  pattern into the cart.**
- Frontend: add the toggle + `getPeopleDirectory()` typeahead to `CartDrawer`
  (`InventoryManagement.jsx:2052`); payload currently sends only
  `{reason, approverEmail, days}`.
- Backend: add beneficiary fields to `CheckoutIn` (`items.py:1111`); the checkout
  and its items belong to the beneficiary (My Items, due-date reminders,
  who-has-what), notifications go to beneficiary + approver, history records who
  submitted it.

**A5. EOM audit report / attestation (target: August).** ⬜ (genuinely doesn't exist)
Replaces the ops tool & equipment EOM inventory: "a simple audit report saying,
hey, these items, do you have it or do you not? You'll just select all and say
yes… build and have handled next month."
- New small feature: an audit run generates, per location (or per holder), the
  list of items there; the responsible manager gets a bell notification; the
  screen is a checklist with **select-all → confirm**, per-item exception
  ("don't have it" → flags the item, feeds status like lost/needs replacement).
- Persist runs + responses (new table, e.g. `item_audit_runs` /
  `item_audit_responses`) so there's history of who attested what and when.
- Design before building: cadence (monthly? triggered manually from Manage?),
  and whether exceptions auto-change item status or just flag for a manager.

**A6. Add-item → assign flow cleanup (polish, after Monday).** 🟡
Neil while demoing Add Item: "VL needs to clean this up. This is on his to-do."
Today assign-on-create is a two-step flow — save the item, then a second
`AssignItemModal` pops (`InventoryManagement.jsx:7726`). Also two different
person-picker UIs exist for the same concept (raw `<select>` in
`AssignItemModal` vs `PersonTypeahead` in batch edit).
- Inline the person pick into the Add Item modal when "assign right away" is
  checked; standardise on one directory picker (per People-single-source rule:
  `getPeopleDirectory()`).

---

## B. Data / config tasks (no code, or tiny)

**B1. Access for everyone by MONDAY.** Charmi had no Item Management access;
Sahil had no Asset Management access. VL on the call: "I'll make sure everybody
has access by Monday. I'm just setting up groups." Access levels Neil wants:
- **Manager** access: Sahil (Sam), Valinda, Amy, Miranda only.
- **User** level: everyone else.
- Pattern for bulk uploads: temporarily promote someone (e.g. Ashley) to manager,
  demote after their items are loaded.

**B2. Location data cleanup.** Neil: "there's a location called NRKANK that needs
to be updated." Locations are free text on `items.location` (`models.py:316`) with
a datalist of seen values — this is a dev-DB data fix (rename/normalise), not code.
(Longer-term: a curated locations list like `item_types` would prevent this class
of typo; not asked for, just noting.)

**B3. Asset values (user task, not dev).** Ops/IT to batch-edit honest MSRP values
(homedepot.com lookup). Sai/Desai owns the IT values (GSVC alone should be
~$50–60k, currently $97.30-level garbage). Batch edit already supports this.

**B4. Go-live email Monday.** VL to email all parties that the module is live +
ask for feedback.

**B5. Construction items intake (user task).** Sahil + Ashley (uploads, details)
+ Aarav (photos/organising) to add all construction items as **temporary**
ownership this week. The paste-image add flow (Ctrl+V into Add Item) is the
demoed method.

---

## C. Heard, but other modules / later (not this plan)

- **Asset Management** (coordinate — Ankush's area per CLAUDE.md): maintenance-log
  document upload is waiting on the **Egnyte integration** (~8–10 days, Neil told
  people not to upload yet); inspections / warranties / plans / docs all come
  after Egnyte; future Asana-style task-ticket → maintenance-log connection
  (VL + Sagar), i.e. closing a maintenance ticket auto-writes the property's log.
- **Dev module** is being retired for Roger — everything he needs moves into
  Asset Management.
- **MFA step-up** (Microsoft Authenticator re-auth) promised for HR pay/benefits
  visibility and Credential Vault reveal/copy — matches the existing
  Roles & Access + credvault roadmaps, not an item-module task.
- SOP/KB on hold until AI translation works (VL + Sagar); accounting module ~1
  month out; IR page, marketing, tasks/tickets progressing — status mentions only.

---

## Suggested order

1. **A1 + A2** (Monday promises, small, same files) — one branch.
2. **A3** (small, rides with A1/A2 if time).
3. **B1/B2/B4** config+data alongside.
4. **A4** on-behalf checkout — own branch, copy Purchase.jsx pattern.
5. **A6** add-item polish — own branch.
6. **A5** audit report — design questions to Neil first, build in August.

Verification: run backend + frontend locally (`NEXUS_SKIP_AUTH`), impersonate an
employee for A2/A3 acceptance flow, a manager for A1 batch edit; `npm run build`
before commit.
