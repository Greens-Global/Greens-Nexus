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

Status key: ☐ not built or not done, ✅ live on PRODUCTION (released
09/29/2026).

## Status - 09/29/2026: LIVE ON PRODUCTION

Released 09/29/2026. Every item marked built below is on production
(nexus.greensglobal.com and accounting.greensglobal.com).

What went out:
- Accounting database: three migrations applied
  (`20260928100000_lms_core_same_month_tail.sql`,
  `20260928110000_nexus_reports_book_columns_entry.sql`,
  `20260929100000_nexus_report_columns.sql`).
- Accounting app: `main` 62247ea. The first deploy built and then failed
  handing the bundle over ("Artifact storage quota has been hit" on the
  GitHub organization); the workflow now builds and deploys in one job and
  uploads nothing.
- Nexus: `dev` and `main` carry the whole batch. Production had taken all of
  dev at 04:42 the same morning (PR #382), so nothing was held back.
- Nine new Nexus tables exist on production with RLS on; no public table is
  without RLS; the security advisor shows informational notes only.

Checked on production against the real ledger:
- September is no longer 0.00: This Month and Month-to-Date show figures.
- By Month, By Entity and By Vendor each add up to the statement total; the
  September column equals Month-to-Date.
- Cash book, Accrual and Cash side by side, and vs Prior Year answer.
- Balance Sheet balances, in total and in every entity column; current year
  earnings equal the income statement's net income.
- A drill-down opens the lines behind an amount and their net equals it.
- Search works, "500" included (A1 did not come back; it takes 10 to 20
  seconds over all dates), and the filter under a column narrows the result.
- Packages, Leasing, PFS and Access open; the lease form lists the Intacct
  customers.
NOT checked: saving anything on production (a memorized report, a package, a
lease, a guarantor, an access limit), and the PDFs with real figures.

Still to do on production, by a person:
- Roles & Access: grant "Personal Financial Statements" to whoever builds
  the statements with Charmi (nobody has it by default; administrators are
  not let in by role, Global Admins are).
- People - Companies: set the HR contact. Checked 09/29: NONE of the five
  companies has one (Aarav Construction, GGCon, Greens Global, Oversite
  Management, Sacred Natural), so punch and time-off requests still reach
  only the manager and the Global Admins.
- F3: set the eight named people to Exempt. Checked 09/29: none of them is.
  Charmi and Neil each have two people records; Shivani has no pay record
  yet, and the switch lives on the pay record.
- One sentence in the Access limit dialog ("Reports, Packages and Leasing
  only") is on dev and goes to production with the next dev -> main release.

Speed audit, 09/29 (timed on production, from the browser):
- Search: see A1. A short word now waits 0.7 s for the rest of it to be
  typed, because every search that starts runs to its end on the ledger.
- Reports split by customer, vendor, employee, Project-Job or item read every
  ledger line of the period: a year took 7 to 10.2 s. With working memory and
  two covering indexes (accounting migrations `20260929140000`, `20260929150000`)
  a year takes 4.4 to 5.5 s. Still the slowest reports on the screen.
- Balance Sheet over the last 12 month-ends asked for 12 balance sheets at the
  same moment (24 reads of the ledger, the slowest 8.8 s). It is now two
  small reads - where each account stood before the first date, and the
  months since - added up to each month-end on the screen. (One read of every
  month since the books began was tried first and was no faster: 7.6 s.)
- Leasing asked for one read of the whole month per month (12 for a year). It
  is now one read that starts from the tenants (accounting migration
  `20260929130000`). No leases exist yet, so this was fixed before anyone met it.
- Two controls changed one after the other now run one report, not two.
- Fine as they are: Income Statement and Balance Sheet totals (1.5 to 2 s),
  By Month / Entity / Department (2.4 s), Trial Balance (1.9 s), Cash
  Position (1.3 s), drill-downs (under 1.5 s).

Open:
- Bundle budget is 10,000 KB (the build measures 9,902); needs the owner's
  nod like the earlier bumps.
- GitHub artifact storage for the organization is full. The accounting
  deploy no longer needs it; anything else that uploads artifacts in a
  private repository will fail until old artifacts are cleared.
- Backend tests, the seven files that were failing: five are fixed. The
  e-sign files and external sign-in were being answered 429 by the request
  rate limiter (now off for pytest runs, `backend/conftest.py`); the policy
  test was counting people a test of this batch had left behind (that test
  now only runs against its own database). Two remain, both Sagar's:
  `test_task_batch_mail` (uses the machine's date where the code uses the
  business time zone, so "due tomorrow" fails from midnight to about 12:30 PM
  India time) and `test_external_users` (the guest is missing from the
  directory when a caller opts in).


## A. Bugs seen live on production

- ✅ A1. FIXED 09/29, after Neil hit it again that morning ("300" answered
  "covers too many ledger lines to finish in time"). CAUSE: a number was
  matched as a substring first - 300 is inside 13000 (the Accounts Receivable
  code on every receivable line), 1,300.00 and 3,000.00 - so a large share of
  the ledger was read and then thrown away by the whole-number rule; and every
  match was copied in full and read eight times for the totals and facets.
  Every line now carries the whole numbers on it, indexed, and the totals
  come out of one pass (accounting migration `20260929120000_search_fast.sql`,
  which also serves the accounting app's own Search page and Ctrl+K). 34
  searches return line for line what they returned before. On production:
  "300" 1.3 s, "500" 1.3 s, "1500" 1.2 s, "amazon" 1.5 s, "2026" (135,798
  lines) 3.9 s. Still slow by nature: a two-letter word that is on most of
  the ledger ("in", 619,342 lines) takes 8.4 s.
  Search returns "Accounting service returned 500" (02:43). Typed "500",
  then "300", scope All dates / All books, entity Greens Global, Inc. (12000).
  Same error after Refresh. It had worked earlier the same day.
- ✅ A2. No loading state on search (03:28). After typing, nothing shows that
  work is happening, so they did not know whether to press Enter.
- ✅ A3. September shows 0.00 on every line (58:11). P&L, This Month
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
- ✅ A4. Custom dates picker cannot move to the current month (59:23). With
  08/01/2026 - 08/31/2026 selected, the calendar's next-month arrow does
  nothing. Likely the From input is capped at the To date.
- ✅ A5 (resolved 09/25 on data, confirmed 10/02: Vinod's assignment is "Accounting - VSB" set by Charmi at 19:11 that day; since 10/02 a shift type is also set per person from the Schedule row menu). Time Clock shifts: assigning "Accounting - VSB" put the shift under
  the wrong team ("Why is it coming as in the admin team? Didn't I select
  accounting?", 56:22). Vinod's week showed shift "001 / India Admin Team"
  on 4 of 5 days.

## B. Nexus Accounting Reports - layout and controls

Direction: the accounting app's Reports page is the model. One slim row of
dropdowns, the statement starts high on the page. "By the time you actually
get to the report, half your screen is already gone."

- ✅ B1. No chips for report choice (01:48). Profit & Loss / Balance Sheet /
  Trial Balance / Cash Position become a dropdown, like the accounting app's
  "P&L Statement" selector.
- ✅ B2. Tighten the header (02:07). Title block, search, report pills,
  period, filters and entity picker currently take about 45% of the screen
  height before the first row.
- ✅ B3. Remove the Refresh button from the active view (03:38). Data should
  load on its own. If a manual refresh stays, it lives in the top bar.
- ✅ B4. Entity dropdown with search inside it, and multi-select (04:00).
  The accounting app's "Search entity by name or code" is the reference.
- ✅ B5. Full filter set like the accounting app's Dimensions popover (04:20):
  Entity, Department, Vendor, Customer, Employee, Project-Job, Item.
- ✅ B6. Book selector becomes one dropdown: Accrual / Cash / Both (06:09).
  They confirmed a default but the transcript does not say which - ask.
- ✅ B7. Memorize a report (04:57 - 06:02). "Memorize" button top right, asks
  for a name, saved list to reopen it in one click. The accounting app's
  Saved Reports - Save Current View is the reference.
- ✅ B8. Rename "Profit & Loss" to "Income Statement" everywhere (16:44).
- ✅ B9. Historical classes still show (00:56). Rule agreed on the call: a
  class with "(H)" in its name is historical - hide it.
- ✅ B10. The same filters as the accounting app's Reports page (Visesh,
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

- ✅ C1. Every column resizable (06:45). Today only Account is. Descriptions
  are cut off ("Sales Invoice: 2026/09/23 Batch Summary Entry").
- ✅ C2. Show / hide columns, remembered per user (07:41). Doc No is the
  example: off by default, can be turned back on. Matches the task already in
  Nexus: "Settings - Add adjust what columns are visible".
- ✅ C3. A filter box under each column header (08:46 - 10:31), Intacct style.
  Filters stack: Description contains "amazon", then Date = 08/19/2026, then
  amount ends in .55. Intacct uses a leading % for "contains".
- ✅ C4. One font across the table (10:52). Entry number and GL code are in a
  different face from the date and the account name.
- ✅ C5. Banding and compact rows in the drill-down (11:28). Alternating row
  shading like Intacct, no wasted height.
- ✅ C6. Hover highlights the whole row edge to edge (13:28). She reads a
  48-inch monitor and loses the row by the time she reaches the amount.
- ✅ C7. Journal entry popup (08:08, 12:33): larger and resizable. Line
  columns in this order: Account, Amount, Department, Location, Memo, Vendor,
  Project-Job, Item, Employee, Customer - shown even when blank. Entry No,
  Intacct batch and Posted date have no value to them: hide or demote.

## D. Access

- ✅ D1 (Nexus only - see the limit below). Accounting - Access tab, for the
  Full level on Accounting. A limited person reads only their entities on
  reports, search, drill-downs and journal entries, and gets Reports,
  Packages and Leasing only. The accounting APP has no entity limits of its own, so a
  limited person cannot open it at all; limits inside the app are a separate
  piece of work. Entity-level access inside Accounting (21:59 - 23:21). Even the
  accounting team sees only the entities they are granted. Personal and
  family entities are the concern. Set per person under People, managed by
  one manager (Charmi). Neil must never be locked out.

## E. New modules asked for

- ✅ E1. Reporting Package Builder (19:37). Pick 9 or 10 memorized reports
  into a named package, send it out as one PDF. Lenders read it, so the PDF
  has to look professional. Depends on B7.
- ✅ E2 (first version). Accounting - PFS tab, for Global Admins and people
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
- ✅ E3 (first version, built before the Monday walkthrough). Accounting -
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

- ✅ F1. Monitoring Alerts block takes half the Time screen (49:03). Move it
  to Workforce Analytics.
- ✅ F2. Punch change and time-off requests raise no pop-up (49:23). Notify
  the person's manager and HR. The manager acts; HR acts only if the manager
  has not. Pranshu routed these to the employee's own manager plus Global
  Admins on 09/26 (dev); this batch adds the HR contact of the employee's
  company (People - Companies).
- ✅ F3 (DONE on PRODUCTION 10/02: the eight set to Exempt in payroll_rates, Shivani given a rate row; Vinod untouched; undo = time_tracking_exempt back to 0 for those emails) (already in Nexus since Aug 21: People - profile - Compensation -
  Time Tracking - "Exempt"). Nothing to build; the eight people below have to
  be set to Exempt on production. Exempt from time tracking (50:15). A per-person switch on the
  profile; when on, no time card. Time off is still logged by the day. Named:
  Sahil, Charmi, Neil, Rajesh, Darshana, Shivani, Pankaj, Visesh. Vinod stays
  tracked.
- ✅ F4. Remove the California / India toggle and the rounding controls from
  the payroll view (51:44) - previously agreed. Built as: the whole row of
  switches sits behind one Options button. Pay is computed exactly as before.
  ANSWERED 09/30 (Charmi): rounding is a company setting, off by default, an
  admin turns it on. Built 10/02: Settings > Global Settings > Time Clock > Pay
  Rules; the controls are off the timecard; Greens' saved value (on, 5 min) is
  kept.
- ☐ F5. Desktop agents not reporting (52:09). 12-13 people listed, Arnav
  called out. Owner: Sagar or Pranshu.
- ✅ F6 (10/02 Shifts rebuild: Add Shift / Usual Hours from a person's row menu in Schedule; no group of one needed). Shifts: assign a shift to one person directly (55:01 - 56:22). Before:
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
