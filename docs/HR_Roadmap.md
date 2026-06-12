# Greens People — HR Module Roadmap

> The workforce operating system for the whole Greens group: any worker
> (employee or contractor), under any entity, in any country — hired in a
> pipeline, signed natively, provisioned into M365/Asana with one click,
> scheduled and clocked at geofenced sites, tracked against clients, reviewed,
> and paid. Physical equipment stays in **Item Management** (single source of
> truth); HR links into it, never duplicates it.
>
> Sources: Neil's "Greens Global — People Platform" mockup (Jun 2026),
> Busacta HR teardown, Rippling/BambooHR research, Nexus build sessions.
> Status: ✅ built · 🟡 partial · ❌ not started   (last updated 2026-06-13, evening)

---

## A. Foundation *(structural — build first, everything references it)*

| Status | Item | Source |
|---|---|---|
| ✅ | Employee master records, GG-### codes, status lifecycle (onboarding/active/inactive/left) | built |
| ✅ | People directory (master–detail, filters, counts strip) | built |
| ✅ | Org chart (reports-to tree, connector lines, unlinked bucket, **drag-and-drop reassignment** with loop protection + clear-line drop zone; edit-modal picker is the touch fallback) | built |
| ✅ | Profile photo upload (public-read bucket, backend-only writes) | built |
| ✅ | Private documents (hr-docs bucket, 5-min signed URLs) | built |
| ✅ | Hiring pipeline (stage kanban, history, hired → auto-creates employee) | built |
| ✅ | M365 provisioning — account, **multi-license set** (admin-center-style checkboxes, friendly SKU names, Business Basic pre-ticked as standard), **usage location** (US/IN), manager attr, office field, run/step log, one-time temp password | built |
| ✅ | **Branded welcome email** (hero, details card, first steps; no passwords ever) + Resend-welcome button on provisioned profiles | built |
| ✅ | **Sync from M365** — links existing accounts by work email, backfills empty phone/title/office, **unlinks accounts deleted in the admin center** | built |
| ✅ | Leave v1 (requests, approve/reject, computed balances; new request notifies the manager, decision notifies the employee, stage moves notify the candidate owner) | built |
| ❌ | **Companies/entities table** — Greens, Greens India, MCD, Oversite: legal name, EIN/GSTIN, registered address, logo, authorized signatory; `company` field on every worker | Neil |
| ❌ | **Contractor worker type** — SOW, scope, contract end date, hourly/fixed-fee rate, engagement area, billing client | Neil |
| ❌ | Work sites registry (name, address, lat/long, geofence radius) | Neil |

## B. Profile depth *(the Busacta feel)*

| Status | Item | Source |
|---|---|---|
| 🟡 | Tabbed profile: Overview / Pay & Benefits / Time / Documents / Performance / Assets / Compliance — **autosave on blur**, stat cards (attendance month, pending leave, YTD days) | Busacta |
| ❌ | **Assets tab reads live from Item Management** (deep-link, no duplicate data) | Visesh |
| ❌ | Compensation: base salary + history, pay basis (hourly/salary), pay frequency, currency (USD/INR) — **restricted visibility** (owner + Neil) | Neil/Busacta |
| ❌ | Bank accounts (holder, number, routing/IFSC, type) | Busacta |
| ❌ | Benefits & deductions (health, dental/vision, life & disability, per-paycheck deduction) | Neil |
| ❌ | Right-to-work & compliance: passport / national ID / visa scans, verification status, expiry reminders, consent checklist | Neil |
| ❌ | Emergency contact, addresses, DOB, masked IDs | Rippling |
| ❌ | Inline "Change status" flow (with reason + date) | Busacta |
| 🟡 | Sync from M365 — phone/title/office backfill ✅; photo backfill ❌; **push profile changes back to Entra** ❌ | Visesh |

## C. Hiring, e-sign, onboarding & offboarding

| Status | Item | Source |
|---|---|---|
| ✅ | Pipeline: Applied → Screening → Interview → Offer → Hired, stage notes + timeline | built |
| ❌ | Resume/doc upload on candidates | — |
| ❌ | Interview scheduling (date/time per stage, bell reminder) | — |
| ❌ | **Native e-sign** — draw/type signature, per-entity templates (Offer & Agreement, NDA, Direct Deposit, Handbook Ack, W-9/TIN, Contractor Agreement, SOW), awaiting-signature tracking, audit trail | Neil |
| ❌ | **Self-enrolment links** — employee & contractor fill their own profile + sign before day 1 | Neil/Rippling |
| ❌ | Onboarding checklist per hire: docs → sign → provision → **assign equipment via Item Management** → day-1 tasks, each with owner + due date | Rippling |
| ❌ | **Offboarding engine** — disable Entra account, revoke sessions/licenses, **force-return all checkouts & assignments** (reuses Items force-return), mark Left | Rippling |
| ❌ | Asana provisioning (blocked: confirm tier) · "Ignite" step (blocked: identify product/API) | open |
| ❌ | Rejected-candidate retention auto-purge (N months — ask Neil) | compliance |

## D. Time *(Neil's biggest net-new block)*

| Status | Item | Source |
|---|---|---|
| ❌ | **Time Clock** — clock in/out with geofence validation (inside/outside site radius), punch log | Neil |
| ❌ | Timesheets — weekly view, manager approval/reversal, overtime rules | Neil |
| ❌ | **Client time tracking** — billable hours by client (contractor invoicing basis) | Neil |
| ❌ | Shift scheduling — publish per site, open-shift claiming, **shift swaps** (offer/approve/decline) | Neil |
| ❌ | Attendance & tardiness views + punch-system CSV import (largely derivable from Time Clock once it exists) | Busacta |
| ❌ | Holiday calendar + attendance policies (grace minutes, half-day rules) | Busacta |

## E. Time off *(upgrade v1)*

| Status | Item | Source |
|---|---|---|
| ✅ | Requests, approve/reject, allocated-vs-used balances, manager + employee notifications | built |
| ❌ | Accrual policies — per-month, annualized, tenure-based; per worker type | Neil |
| ❌ | Employee self-service requests (from portal, not HR-recorded) | Rippling |
| ❌ | Team leave calendar ("who's out this week") + on-leave-today on dashboard | Busacta |
| ❌ | Multi-level approval (manager → HR) if wanted | open |

## F. Performance

| Status | Item | Source |
|---|---|---|
| ❌ | Goals — progress %, on-track/at-risk, due dates | Neil |
| ❌ | Review cycles — annual reviews + contractor mid-engagement check-ins, rating, reviewer, feedback history | Neil |

## G. Payroll *(last — feeds from D + B)*

| Status | Item | Source |
|---|---|---|
| ❌ | Pay periods per entity & currency; rows from timesheets/attendance + leave types; gross → deductions → net; Draft → Recompute → Approve → Paid; payslip PDF; export | Neil/Busacta |

## H. Platform

| Status | Item | Source |
|---|---|---|
| 🟡 | Server-side notifications (leave + hiring wired). Add: doc/visa expiry, contract end, review due, upcoming start dates — needs one daily scheduled job | built/Neil |
| ❌ | **Employee portal** — My Profile / My Time Off / My Timesheet / My Schedule / My Documents / My Performance / **My Assets (links to Item Management "My Items")**; HR gets View-as-employee | Neil |
| ❌ | Approvals inbox — leave, timesheets, swaps, signatures in one queue | Neil |
| ❌ | Reports — headcount by entity/dept/type, joiners/leavers, attrition, hours by client/site, leave utilization; CSV export | Rippling |
| ❌ | Audit views (salary changes, document access) | compliance |
| ❌ | Hardening: RLS migrations for all HR tables at prod release, salary field-level access, provisioning test against real tenant, mobile QA pass | Visesh |

---

## Item Management boundary (explicit)

HR **never** stores equipment. The links between the modules:
1. Profile "Assets" tab = live read of the person's checkouts + permanent assignments from Item Management.
2. Onboarding checklist's equipment step deep-links into Items assign flow.
3. Offboarding triggers Items force-return for everything the person holds.
4. Portal "My Assets" routes to the existing My Items view.

## Build order

**A → B → C → D → E/F → H(portal+reports) → G.**
Entities + contractor type first (structural). Estimated 12–15 focused sessions to 100%.

## Open questions

1. What is **Ignite** (product? API?) — blocks provisioning step.
2. **Asana tier** — Enterprise (SCIM) or invite-by-API?
3. **Salary visibility** — owner only, or owner + Neil?
4. **Payroll rules** — US + India? working-day rules, deduction types (Neil).
5. Rejected-candidate **retention period**.
6. Which **punch/biometric system** exists today, if any (CSV import format) — or is the geofenced Time Clock replacing it outright?
