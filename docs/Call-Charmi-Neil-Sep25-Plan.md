# Call with Charmi + Neil - Sep 25, 2026 - Plan

Source: Teams recording "Call with Charmi Desai", 09/25/2026, 59m 52s, in
Visesh's OneDrive (Recordings). Read from the Teams transcript plus the shared
screens at each timestamp. Neil was in the room with Charmi, so the transcript
labels both of them "Charmi Desai" - most of the direction below is Neil's.

Not viewed on video, by choice: 14:30 - 36:20 (loan offer letter and the
family's personal financial statement). Neil asked on the call that the
document go nowhere. The structure below comes from what was said, and no
figures from it are recorded here.

Screens they had open: left monitor = Nexus prod / Intacct / Excel, right
monitor = Nexus prod Accounting Reports and the accounting app Reports page.

Status key: ☐ not built, 🔨 built and committed locally (not pushed, not on
any site yet), ✅ live on PRODUCTION.

## Status - 09/29/2026

Nothing is live on a site yet except the database fix for the September
zeros (A3), which took effect when its migration was applied on 09/28.

Where everything is:
- Accounting database (production): all three migrations APPLIED -
  `20260928100000_lms_core_same_month_tail.sql`,
  `20260928110000_nexus_reports_book_columns_entry.sql`,
  `20260929100000_nexus_report_columns.sql`.
- Accounting repo: branch `feature/nexus-reports-sep25` (3 commits on main
  e3cc9a7) is PUSHED to GitHub as a branch. `main` is untouched, so nothing
  is deployed.
- Nexus repo, local only, not pushed:
  - `feature/charmi-neil-sep25` - the whole batch, with dev (e078df92)
    merged in. This is what goes to `dev`.
  - `release/charmi-neil-sep25` - the batch cherry-picked onto production
    `main` (508347c6), nothing of anyone else's unreleased dev work in it.
    This is what goes to `main`.

To release, in this order (the accounting app first, Nexus calls it):
1. Accounting: merge `feature/nexus-reports-sep25` into `main` and push
   (Cloudflare deploys it). Until this is live the new Nexus screens have
   nothing to call, and the Cash book would show accrual figures.
2. Nexus dev: `git push origin feature/charmi-neil-sep25:dev` (a fast
   forward). Run `get_advisors` on dev.
3. Nexus production: push `release/charmi-neil-sep25` and merge it into
   `main`. Run `get_advisors` on prod. Nine new tables are created on boot
   with RLS on: `accounting_saved_reports`, `accounting_report_packages`,
   `accounting_user_prefs`, `pfs_profiles`, `pfs_lines`, `pfs_statements`,
   `leases`, `lease_rates`, `lease_months`.
4. After release, on production:
   - Roles & Access: grant "Personal Financial Statements" to whoever builds
     the statements with Charmi (nobody has it by default; administrators are
     not let in by role, Global Admins are).
   - People - Companies: check each company has its HR contact (needed once
     F-item "HR hears requests" is released, see below).
   - F3: set the eight named people to Exempt.

Held back from production: "the company's HR contact hears punch and time-off
requests". It builds on the team alert recipients Pranshu added on dev on
09/26, which are not on `main` yet, so it goes out with the next dev -> main
release. It IS in the dev branch. The screen half of the same commit (alerts
off the Time screen, header switches behind Options) is in the release.

Bundle budget: the release build measures 9,483 KB against production's cap
of 9,600, so `main` needs no change. On dev the Shifts work and this batch
together measure 9,900 KB, so the dev branch raises the cap to 10,000 - that
needs the owner's nod like the earlier bumps.

Verified locally:
- dev branch: 1,007 frontend tests, production build, the batch's backend
  tests (52). Of the 118 backend test files, 111 pass; the 7 that fail
  (e-sign paper return, roles and upload fields, external auth and users,
  policy config, task batch mail) fail the same way on dev without this
  batch.
- release branch: 786 frontend tests, production build, the batch's backend
  tests (45), the app starts.
- Every screen opened in a browser against a local stand-in for the
  accounting service with made-up figures; the PDF with a column per month
  opened and read.
NOT verified: the new screens against the real ledger - nothing is deployed.


## A. Bugs seen live on production

- ☐ A1 (cause not found yet - needs a look at the accounting database, which
  the session was not allowed to read). What is built: the screen now shows
  the accounting service's own reason instead of "returned 500", and says so
  in plain words when a search runs out of time.
  Search returns "Accounting service returned 500" (02:43). Typed "500",
  then "300", scope All dates / All books, entity Greens Global, Inc. (12000).
  Same error after Refresh. It had worked earlier the same day.
- 🔨 A2. No loading state on search (03:28). After typing, nothing shows that
  work is happening, so they did not know whether to press Enter.
- 🔨 A3. September shows 0.00 on every line (58:11). P&L, This Month
  09/01/2026 - 09/25/2026, accrual: Gross Profit, Operating Income and Net
  Income all 0.00 for MCD Services, Inc. (56000) and Greens Escondido, LLC
  (15000). Charmi believes it is every entity. August for Escondido is fine
  (Rental Income 70,000.00). Intacct has September data. Note the YTD
  drill-down for Greens Global, Inc. did show entries dated 09/23/2026, so
  check whether this is the period preset, those entities, or unposted data.
  CAUSE (09/28): `_lms_core` reads whole months from the month summary and
  partial months from raw lines; a range from the 1st to mid-month of the SAME
  month matched no whole month, no head and no tail, so it read nothing - for
  every entity. Year to date was never affected. Fixed in
  `20260928100000_lms_core_same_month_tail.sql`; 48 of 48 ranges match the raw
  ledger in a local test database (the live logic fails 9).
- 🔨 A4. Custom dates picker cannot move to the current month (59:23). With
  08/01/2026 - 08/31/2026 selected, the calendar's next-month arrow does
  nothing. Likely the From input is capped at the To date.
- ☐ A5. Time Clock shifts: assigning "Accounting - VSB" put the shift under
  the wrong team ("Why is it coming as in the admin team? Didn't I select
  accounting?", 56:22). Vinod's week showed shift "001 / India Admin Team"
  on 4 of 5 days.

## B. Nexus Accounting Reports - layout and controls

Direction: the accounting app's Reports page is the model. One slim row of
dropdowns, the statement starts high on the page. "By the time you actually
get to the report, half your screen is already gone."

- 🔨 B1. No chips for report choice (01:48). Profit & Loss / Balance Sheet /
  Trial Balance / Cash Position become a dropdown, like the accounting app's
  "P&L Statement" selector.
- 🔨 B2. Tighten the header (02:07). Title block, search, report pills,
  period, filters and entity picker currently take about 45% of the screen
  height before the first row.
- 🔨 B3. Remove the Refresh button from the active view (03:38). Data should
  load on its own. If a manual refresh stays, it lives in the top bar.
- 🔨 B4. Entity dropdown with search inside it, and multi-select (04:00).
  The accounting app's "Search entity by name or code" is the reference.
- 🔨 B5. Full filter set like the accounting app's Dimensions popover (04:20):
  Entity, Department, Vendor, Customer, Employee, Project-Job, Item.
- 🔨 B6. Book selector becomes one dropdown: Accrual / Cash / Both (06:09).
  They confirmed a default but the transcript does not say which - ask.
- 🔨 B7. Memorize a report (04:57 - 06:02). "Memorize" button top right, asks
  for a name, saved list to reopen it in one click. The accounting app's
  Saved Reports - Save Current View is the reference.
- 🔨 B8. Rename "Profit & Loss" to "Income Statement" everywhere (16:44).
- 🔨 B9. Historical classes still show (00:56). Rule agreed on the call: a
  class with "(H)" in its name is historical - hide it.
- 🔨 B10. The same filters as the accounting app's Reports page (Visesh,
  09/29, from the call: "the reports are better there"). Built 09/29:
  - Period stepper: the accounting app's named periods (This Month, Last
    Month, Month-to-Date, This Quarter, Last Quarter, Quarter-to-Date, This
    Year, Year-to-Date, Last Year, Trailing 12 Months, Custom Dates) with an
    arrow on each side that moves a month, a quarter or a year at a time. A
    balance sheet steps from month-end to month-end. NOTE: "This Month" used
    to stop today; it is now the whole month, and what it used to mean is
    "Month-to-Date". A report memorized under the old meaning opens as
    Month-to-Date.
  - Columns: Total Only, By Month, By Quarter, By Year, By Entity, By
    Department, By Vendor, By Customer, By Employee, By Project-Job, By Item,
    vs Prior Period, vs Prior Year. Balance Sheet: Total Only, By Entity, By
    Department, Last 12 Month-Ends, Last 4 Quarter-Ends, vs Prior Month-End,
    vs Same Date Last Year, vs Last Year-End. Period columns run latest
    first with a Total at the end; more than 50 vendors (or customers ...)
    keeps the 50 largest and folds the rest into "Other". Every amount drills
    into its own column (that month, that entity, that vendor). The Compare
    dropdown is gone - the comparisons are in Columns; a report memorized
    with a comparison opens the same way.
  - Departments and Accounts are their own dropdowns beside Entities;
    Dimensions keeps vendor, customer, employee, Project-Job and item.
  - Customize: row density and "Hide zero balances".
  - Full screen button; the figures line above the statement (Revenue,
    Expenses, Net Income, Net Margin, and Net Change on a comparison); a Net
    Profit Margin % row under Net Income.
  - CSV and PDF carry whatever columns are on screen; a PDF with many columns
    gets a wider sheet in the same proportions.
  - Not carried over from the accounting app: "P&L by Book (Tax vs Actual)"
    (the Book dropdown's "Accrual and Cash" is the same view), number scale
    (thousands / millions), and the reports Nexus does not have (Cash Flow,
    Partners A/R and A/P, A/R Aging, Unbilled WIP, Revenue per Client, Client
    Billing, Vendor Statement).
  - Needs: accounting migration `20260929100000_nexus_report_columns.sql` and
    the accounting app's new `/api/internal/reports/buckets` route.

## C. Drill-down and journal entry view

- 🔨 C1. Every column resizable (06:45). Today only Account is. Descriptions
  are cut off ("Sales Invoice: 2026/09/23 Batch Summary Entry").
- 🔨 C2. Show / hide columns, remembered per user (07:41). Doc No is the
  example: off by default, can be turned back on. Matches the task already in
  Nexus: "Settings - Add adjust what columns are visible".
- 🔨 C3. A filter box under each column header (08:46 - 10:31), Intacct style.
  Filters stack: Description contains "amazon", then Date = 08/19/2026, then
  amount ends in .55. Intacct uses a leading % for "contains".
- 🔨 C4. One font across the table (10:52). Entry number and GL code are in a
  different face from the date and the account name.
- 🔨 C5. Banding and compact rows in the drill-down (11:28). Alternating row
  shading like Intacct, no wasted height.
- 🔨 C6. Hover highlights the whole row edge to edge (13:28). She reads a
  48-inch monitor and loses the row by the time she reaches the amount.
- 🔨 C7. Journal entry popup (08:08, 12:33): larger and resizable. Line
  columns in this order: Account, Amount, Department, Location, Memo, Vendor,
  Project-Job, Item, Employee, Customer - shown even when blank. Entry No,
  Intacct batch and Posted date have no value to them: hide or demote.

## D. Access

- 🔨 D1 (Nexus only - see the limit below). Accounting - Access tab, for the
  Full level on Accounting. A limited person reads only their entities on
  reports, search, drill-downs and journal entries, and gets Reports and
  Packages only. The accounting APP has no entity limits of its own, so a
  limited person cannot open it at all; limits inside the app are a separate
  piece of work. Entity-level access inside Accounting (21:59 - 23:21). Even the
  accounting team sees only the entities they are granted. Personal and
  family entities are the concern. Set per person under People, managed by
  one manager (Charmi). Neil must never be locked out.

## E. New modules asked for

- 🔨 E1. Reporting Package Builder (19:37). Pick 9 or 10 memorized reports
  into a named package, send it out as one PDF. Lenders read it, so the PDF
  has to look professional. Depends on B7.
- 🔨 E2 (first version). Accounting - PFS tab, for Global Admins and people
  granted "Personal Financial Statements". A guarantor is set up once; each
  line reads the ledger (an entity's accounts at the share owned) or is kept
  by hand; the statement and its PDF are produced for any date and kept as
  sent. NOT in this version: sending it for e-signature from the screen (the
  PDF has signature lines; it can go through Nexus Sign by hand), and the
  one-time mapping of accounts, which is a sitting with Charmi.
  PFS Builder (14:36 - 36:20). Personal financial statement per
  guarantor, generated for a chosen date. Neil called this an emergency: the
  Velixo-driven Excel that did it is gone. Sections, in order: who the
  borrower is; assets (bank, retirement, investment and business accounts,
  each with balance, ownership % and adjusted balance; insurance; personal
  holdings); liabilities (mortgages, business loans, international, auto,
  lines of credit); schedule of real estate (residential, commercial,
  international; type, legal owner, ownership type, address, % owned,
  balance, rate); other holdings; summary = total assets - total liabilities
  = net worth; standard history questions answered once; executive profile
  with photo; e-signed each time. One-time setup with Charmi maps Intacct
  accounts and ownership % to each person or trust. Needs D1 first.
- 🔨 E3 (first version, built before the Monday walkthrough). Accounting -
  Leasing tab: Rent Roll, Outstanding, Tenants. Received = what posted to the
  lease's rental income account (41101 unless changed) for that customer in
  that month - the rule the workbook used. NOT in this version: emails sent
  to tenants automatically (a letter is prepared in the accountant's own
  email; nothing goes out on its own) and rent-increase notices. Arrears from
  before the year on screen are not carried in.
  Leasing / Monthly Recurring Income (36:43 - 47:30). Tenant
  management, residential and commercial. Neil: build it as an app, not a
  copy of the Excel. A tenant is an Intacct customer picked from a dropdown,
  plus what Intacct cannot hold: rent, CAM, late-fee rule, lease start and
  end, rate periods (rent changes while the tenant stays), deposit, terms,
  notes. A new tenant is a new row so history is kept. Each month compare
  expected against what Intacct received; flag short and late; notes for
  repair deductions; reminders to the tenant and rent-increase notices sent
  automatically. Anyone should be able to ask "did the tenant at X pay?".
  Excel columns seen: Property, Region, Internal/External, Landlord, Total
  Rent, Rent, CAMs, Late Fees, Tenant, Customer ID, contact, phone, email,
  address, Rate Start, Lease Start, Lease End, Security Deposit, Lease Terms,
  Location, GL, Status, Notes, then per month: amount, late fee, notes.
  Charmi will share the workbook. Walkthrough continues Monday.

## F. Time Clock / People

- 🔨 F1. Monitoring Alerts block takes half the Time screen (49:03). Move it
  to Workforce Analytics.
- 🔨 F2. Punch change and time-off requests raise no pop-up (49:23). Notify
  the person's manager and HR. The manager acts; HR acts only if the manager
  has not. Pranshu routed these to the employee's own manager plus Global
  Admins on 09/26 (dev); this batch adds the HR contact of the employee's
  company (People - Companies).
- ☐ F3 (already in Nexus since Aug 21: People - profile - Compensation -
  Time Tracking - "Exempt"). Nothing to build; the eight people below have to
  be set to Exempt on production. Exempt from time tracking (50:15). A per-person switch on the
  profile; when on, no time card. Time off is still logged by the day. Named:
  Sahil, Charmi, Neil, Rajesh, Darshana, Shivani, Pankaj, Visesh. Vinod stays
  tracked.
- 🔨 F4. Remove the California / India toggle and the rounding controls from
  the payroll view (51:44) - previously agreed. Built as: the whole row of
  switches sits behind one Options button. Pay is computed exactly as before.
  OPEN QUESTION for Neil: did "turn it off" mean the rounding ITSELF (pay
  computed from raw punch times)? That changes paychecks, so it was not done.
- ☐ F5. Desktop agents not reporting (52:09). 12-13 people listed, Arnav
  called out. Owner: Sagar or Pranshu.
- ☐ F6. Shifts: assign a shift to one person directly (55:01 - 56:22). Today
  it needs a group of one. With Sagar (shifts were given to him on the call),
  together with A5. Not touched in this batch.

## G. Team and process

- ☐ G1. Neil wants the next 8 to 10 items planned for Sagar (53:51).
- ☐ G2. Sagar: an agent in Microsoft Teams that turns a call or chat into
  Nexus tasks (53:34). Neil's point at 58:11: an hour-long call should not
  depend on memory.
- ☐ G3. Charmi will enter these as tasks in Nexus (project "Nexus Module -
  Accounting") and close them as they are delivered.

## Already in that Nexus project on 09/25

Build self storage Underwriting Module for Nexus; Settings - Add adjust what
columns are visible; Mortgage Calculator; Fix the Report tab on dashboard;
Export time to IIF import for quickbooks.

## Suggested order

1. A1 - A4 (production bugs the accounting team hits daily).
2. B1 - B9 and C1 - C7 as one Reports release; Neil's target was "by the end
   of this week or so".
3. F1, F3, F4 (small, asked twice).
4. D1, then E2 (emergency), then E1, then E3.
