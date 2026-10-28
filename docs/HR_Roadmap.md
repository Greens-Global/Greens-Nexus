# Greens People - HR Module Roadmap

> The workforce operating system for the whole Greens group: any worker
> (employee or contractor), under any entity, in any country - hired in a
> pipeline, signed natively, provisioned into M365 with one click, scheduled
> and clocked at geofenced sites, reviewed, and paid through the payroll
> provider. Physical equipment stays in **Item Management** (single source of
> truth); HR links into it, never duplicates it.
>
> Sources: Neil's "Greens Global - People Platform" mockup (Jun 2026),
> Busacta HR teardown, Rippling / BambooHR research, the Keka gap analysis
> (Oct 2026), Nexus build sessions.
>
> Status: ✅ built (on `dev`) · 🚀 built, in the HR release PR (`release/hr-oct-2026`,
> waiting on Neil's OK to merge) · 🟡 partial · ❌ not started · ⛔ dropped by Neil
>
> Last updated 10/27/2026. Since 07/07: Time Clock grew into full time and
> attendance (time sheets signed through Nexus Sign, payroll readiness and
> exports, CA meal / rest premiums, differentials, overtime alerts), Shifts
> was rebuilt against Teams Shifts, hiring got its documents, packets,
> interviews and decision vote, onboarding / offboarding / leave checklists
> and life events landed, leave balances went live with a QuickBooks cutover,
> and the Contact Directory, Workforce Scorecard, reimbursements and purchase
> requests shipped. The Oct 27 release (13 PRs plus the India Contractor
> Policy) closes most of the Keka gaps: custom fields, People Analytics,
> one Approvals inbox, HR letters, Duplicate Day, headcount requests and a
> public careers page, Ask HR on tickets, probation, leave depth, salary
> advances, exit statements, and goals / 1:1s / review cycles.

---

## A. Foundation

| Status | Item | Source |
|---|---|---|
| ✅ | Employee master records, GG-### codes, status lifecycle (onboarding / active / inactive / left), People action log and record audit | built |
| ✅ | People directory (master-detail, filters, counts strip); a manager sees their own team (Oct 6 rule) | built |
| ✅ | Org chart with drag-and-drop reassignment, externals folded in | built |
| ✅ | Profile photo upload + editor | built |
| ✅ | Private documents (signed URLs), File Manually into a person's Egnyte folder | built |
| ✅ | Companies / entities (legal name, EIN / GSTIN, signatory, HR contact, logo, holiday calendar, departments); company walls and People scopes | built |
| ✅ | Contractor worker type (scope, SOW, rate, currency, billing client); contractor invoices generated from finalized time sheets | built |
| ✅ | Work sites registry with geofences | built |
| ✅ | M365 provisioning, welcome email, two-way M365 sync | built |
| 🚀 | **Custom fields** on employee records (HR-defined, typed, per company, HR Only / employee view / employee edit; More Details on the profile and in My HR; merge variables in Documents) - #808 | Keka |

## B. Profile depth

| Status | Item | Source |
|---|---|---|
| ✅ | Tabbed profile (Overview / Pay & Benefits / Compliance / Assets / Documents / Checklist / Time) with stat cards | Busacta |
| ✅ | Assets tab reads live from Item Management | Visesh |
| ✅ | Compensation with history, bank accounts, benefits - restricted to owners and the `hr_comp` grant | Neil |
| ✅ | Right to work and compliance, emergency contact, addresses, masked national ID | Neil |
| ✅ | Change status with reason, effective date and audit trail; role change requests (manager asks, HR decides) | Busacta |
| ✅ | Backup Manager per person | Neil |

## C. Hiring, e-sign, onboarding and offboarding

| Status | Item | Source |
|---|---|---|
| ✅ | Pipeline (Applied to Hired), resumes and documents on candidates, screening tasks, interviews with questionnaires and recordings, the decision vote | built |
| ✅ | Offer letters and hiring packets by role and place; the candidate signs first, the company never signs before the employee | Neil |
| ✅ | **Nexus Sign** (native e-sign, multi-party, sealed PDF with certificate, Signs Once) | Neil |
| ✅ | Onboarding, offboarding and leave checklists per person (library, per-company templates, signals that tick steps) | Rippling |
| ✅ | Offboarding engine (blocks sign-in, removes licenses, exports the mailbox, force-returns equipment, ends sessions) and separation packages | Rippling |
| 🚀 | **Headcount requests** (department line, then HR) that become job openings - #814 | Keka |
| 🚀 | **Public careers page** with an apply form, JSON-LD job postings and a sitemap - #814 | Keka |
| 🚀 | **Probation** tracking (company length, reminders, manager recommends, HR finalizes, confirmation / extension letters through Nexus Sign; existing employees still inside their window are picked up once at release) - #817 | Keka |
| 🚀 | **Exits** in progress with the final settlement statement (last pay, advances owed, leave paid out only where the law requires it - use it or lose it otherwise) - #819 | Keka |
| ⛔ | Hiring scorecards | dropped (Neil) |
| ⛔ | Exit survey | dropped (Neil) |
| ❌ | Rejected-candidate retention auto-purge | compliance |

## D. Time

| Status | Item | Source |
|---|---|---|
| ✅ | Time Clock - geofenced punches, break prompts, punch fixes, manager edits, live overtime alert | Neil |
| ✅ | Time Sheets reviewed by the manager and signed by the employee through Nexus Sign; HR's override; finalize; the signed PDF filed to Egnyte | Neil |
| ✅ | Payroll readiness, earnings codes and exports (QuickBooks, Intacct), salaried grid, bulk approve, bonuses | Charmi |
| ✅ | California meal / rest premiums, shift differentials, Sick / Vacation as their own pay classes | Charmi |
| ✅ | Shifts rebuilt against Teams Shifts (schedule, publish, requests, open shifts, rules that warn, attendance and no-shows, iCal feed, weather call) | Neil |
| ✅ | Holiday calendars per company; attendance (On Time / Late / Left Early / No-Show) | Busacta |
| ✅ | Workforce Scorecard (punched vs expected hours, weekly email) | Neil |
| ✅ | BOD / EOD Teams updates and the desktop monitoring agent | Neil |
| 🚀 | **Duplicate Day** - copy one day's punches to other days or people, with undo - #813 | Keka |
| 🚀 | **Add Time From Record** - Duplicate Day grown into HR's paper time sheet entry: one day laid over up to 62 days, every day editable in a review grid (times, breaks, Sick Day / Vacation / Off, Replace), the source document attached, "Entered By HR From Record" on the card and the PDF, one Undo | Keka |
| 🚀 | **India Contractor Work Hours and Extra Time Policy** (credit by hours, month-end reconciliation, Extra Time claims at 1.35x, Policy Starts 11/01/2026) - #821 | Neil |
| ⛔ | Selfie / PIN kiosk clock-in | dropped (Neil) |
| ❌ | Client time tracking (billable hours by client) | Neil |

## E. Time off

| Status | Item | Source |
|---|---|---|
| ✅ | Requests (full and partial days, confidential reasons), approve / reject, request on behalf, approval delegation | built |
| ✅ | Paid leave balances (vacation earned per hour, sick lump sums, anniversary grants) from a QuickBooks cutover; time off onto the time sheet | Neil / Charmi |
| 🚀 | **Leave depth** - Second Approval By HR, the leave year end (use it or lose it on 01/01/2027, carry-over caps), the Team Leave Calendar, People > Leave folded into Time > Time Off - #818 | Keka |
| ⛔ | Comp-off (compensatory leave) | dropped (Neil) |

## F. Performance

| Status | Item | Source |
|---|---|---|
| 🚀 | **Goals** (personal, department, company; check-ins, alignment) and **1:1s** (series, shared agenda, private notes, Outlook invites, action items as tasks) - #815 | Keka |
| 🚀 | **Review cycles** (self and manager reviews, rating scale and company values per company, the employee acknowledges through Nexus Sign; no calibration curve or 9-box (Neil)) - #820 | Keka |
| ⛔ | Pulse surveys | dropped (Neil) |
| ⛔ | Kudos / recognition | dropped (Neil) |

## G. Pay and money

| Status | Item | Source |
|---|---|---|
| ✅ | Reimbursements (approver, then HR with the receipt) and purchase requests | built |
| 🚀 | **Salary advances** (manager tier asks, HR decides and pays out, repaid per pay period on the time sheet and the contractor invoice) - #812 | Keka |
| ⛔ | Payroll engine (gross to net, payslips) - payroll stays with the provider; Nexus exports | dropped (Neil) |
| ⛔ | Expense mileage and category limits | dropped (Neil) |
| ⛔ | PSA (professional services automation) | dropped (Neil) |

## H. Platform

| Status | Item | Source |
|---|---|---|
| ✅ | Server-side notifications, one per workflow, updated in place; batched task emails | built |
| ✅ | **Workday** (employee portal, formerly My HR): profile, Time Sheet, time off, documents to sign, paystubs, equipment, schedule | Neil |
| ✅ | Contact Directory with availability and Teams presence | Neil |
| 🚀 | **Approvals** - one inbox for everything waiting on you (time off, HR's second approval, punch fixes, time sheet reviews and signatures, Nexus Sign, reimbursements, purchase requests, shifts, hiring votes and screening, salary advances, probation, HR letters, headcount, Extra Time), counts that match the nav - #810 | Keka |
| 🚀 | **People Analytics** (headcount, joiners and leavers, attrition voluntary / involuntary, tenure, absence, leave liability; drill to the people) - #809 | Keka |
| 🚀 | **HR letters** employees request from Workday (employment verification, salary certificate, experience letter, address proof, visa NOC), issued through Nexus Sign - #811 | Keka |
| 🚀 | **Ask HR on Tickets** (a confidential HR desk, earlier requests moved over) - #816 | Keka |
| ✅ | Hardening: RLS on every table (`_enable_rls_everywhere`), private evidence buckets, rate limiting | Visesh |

## Pending

| Status | Item | Owner |
|---|---|---|
| 🚀 | Merge `release/hr-oct-2026` to `dev` (Neil's OK), then the release checklist in its PR | Neil |
| ❌ | Client time tracking | open |
| ❌ | Rejected-candidate retention period | Neil |

---

## Item Management boundary (explicit)

HR **never** stores equipment. The links between the modules:
1. Profile "Assets" tab = live read of the person's checkouts and permanent assignments from Item Management.
2. The onboarding checklist's equipment step deep-links into the Items assign flow.
3. Offboarding triggers Items force-return for everything the person holds.
4. Workday "My Equipment" routes to the existing My Items view.
