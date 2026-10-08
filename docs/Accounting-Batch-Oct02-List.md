# Accounting batch - Charmi + Neil, 10/01-10/02/2026

**Status 10/02/2026:** every item below BUILT on branch feat/accounting-oct02 (Nexus) + accounting main bf45e29 (not pushed, migration 20261002100000_journals_budgets_partners.sql to apply). Interpretations: "Add AP and AR" = AP/AR journals in the Journals filter; MRE = Flux Analysis first cut pending the Charmi talk; Budget vs Actual lives inside the Budget tab. Release: apply the accounting migration, push accounting main, push Nexus dev + main, RLS on accounting_flux_notes / accounting_partner_changes / accounting_allocation_runs (dev + prod), get_advisors.


Nexus repo: C:\Users\Vlow\Desktop\Greens Nexus - First Build (frontend/src/components/accounting/*, views/Accounting.jsx,
backend/routers/accounting.py, pfs.py). Accounting app repo: C:\Users\Vlow\Desktop\Greens Accounting (internal API under
src/internal-api, finance logic src/lib/finance, Supabase migrations in supabase/migrations). Figures come ONLY through the
accounting app's /api/internal/* (see CLAUDE.md of both repos).

## Reports (Charmi)
R1. "Comments 3 & 4 still not fixed ... everything is still showing combined and not in separate columns. I have the report
    pulled by multiple employees, is it possible to keep them as separate columns?" Screenshot: Income Statement with
    Filters Employee: Amy Bolanos, Employee: Ashley Vizcarra, Columns = Total Only -> one combined column.
    Build: when a dimension filter holds 2+ picks (employee, vendor, customer, department, project, item) the statement
    shows ONE COLUMN PER PICKED VALUE plus a Total column (reportModel.js columns; GET /accounting/reports/buckets with
    by=<dim> and the picked codes). Columns dropdown shows "By Employee (2 picked)" selected; "Total Only" still combines.
    The chips under the title stay. Verify the accounting app honors the picked set in by=<dim> buckets (reports.buckets.ts,
    allDimsFromQuery) - fix there if it does not. Same for 2+ picked entities (already columns) - keep.
R2. Save to Egnyte: "I am not sure where will this be stored?" Build: the dialog shows a live line "Will be saved as
    /Shared/Accounting/Reports/Income Statement - Darshana R. Kadakia MD Inc. (13000) - 01-01-2026 to 12-31-2026.pdf",
    a Browse button that lists Egnyte folders (GET /egnyte/folder?path=) to pick one, a "Create folder" when missing, and
    after saving a toast + inline link "Open in Egnyte" (webUrl from POST /egnyte/upload). SendReportDialog.jsx.
R3. "Maybe we can switch the two tabs and keep accounts as the last tab": toolbar order Entities -> Filters -> All accounts.
    ReportsTab.jsx ~line 300 (EntitiesPicker, AccountsPicker, FiltersButton). Update the comment at line 50 too.
R4. Item 18 from 09/29: "Hidden is still showing up ... there still needs to be an option to see historical accounts."
    Build: Customize gets "Show historical accounts" (prefs.showHistoricalAccounts) feeding AccountsPicker (reportControls
    .jsx:247, the `.filter((v) => !isHistorical(v.name) ...)` at 199); remove any "Hidden" label that still prints.
R5. Drill-down (ledger lines under a report): "Can we not have the scrolling bar and adjust the top width a little bit so
    we can get more data." Build: the drill table scrolls with the page (no inner max-height/overflow box in normal mode;
    keep it only in full-screen), and the Accounting header is slimmer on reports (view-header marginBottom, the title row
    collapses to one line "Accounting · Financial reports ..." when a report is open) so ~6 more rows fit.
R6. "GL Report is fine but it will be nice if we can make all the reports clickable and if the reports can have banding."
    Build: every figure in every report (Income Statement, Balance Sheet, Trial Balance, General Ledger balances, bucket
    columns, totals) opens the drill-down for that account + period + column (bucketDrill in reportModel.js); zebra banding
    on all report tables under .acct-module (style.css), plus hover row highlight.
R7. Neil: "Add a journal filter so that we can see User Defined journals and statistical journals. Add AP and AR as well.
    Now." Build: Filters gets "Journals" (multi-pick, grouped: General, Payables (AP), Receivables (AR), Payroll,
    User Defined, Statistical) backed by the accounting app's journal list (contract J1) and passed to pnl / balance-sheet /
    trial-balance / buckets / search as `journals` (contract J2). Statistical journals are shown but never added into money
    totals (a statistical journal has no currency amounts - show its lines in the drill-down only).
R8. Neil: "MRE needs to be discussed with Charmi / Flux Analysis". Build the recommended first version: report type
    "Flux Analysis" = this period vs prior period (month or quarter) per account with Variance $ and Variance %, rows over
    a threshold (Customize: default 10% and 5,000) flagged, and an Explanation note per account+period saved in Nexus
    (new table accounting_flux_notes: id, entity, account_no, period, note, by, at - RLS at release). Export like other reports.
R9. Neil: "Nothing has been done on MRI and Loan & Financing for me to review." Check MriTab.jsx and the loans view on
    PROD: if they render empty because of missing wiring/config, give each an explicit empty state that says what to set
    up and where; if they are broken, fix them. Report what you found.

## PFS (Charmi + Neil)
P1. Other Holdings lists "ANK Earmarked ETC-7047 (ledger 30000 · 11352)", "NRK & ANK - F&M - 6870 (11301)",
    "NRK-Earmarked ETC-6953 (11351)": "These are bank accounts, so it should be reported under bank accounts and not
    other holdings." Build: Add From the Ledger classifies by the account's GL group / Intacct account type (bank-type
    accounts -> Bank Accounts, retirement titles (IRA/401k/HSA/Roth) -> Retirement, brokerage -> Investment, loans ->
    liabilities), and every line has "Move to..." (edit its section/category) so a wrong guess is one click to fix.
    Existing wrong lines on PROD are moved by the users with that control (no data script).
P2. Liabilities and Real Estate: "The wiring is not done here and also Real Estate." Build: Add From the Ledger on the
    Liabilities tab (liability GL groups: loans, notes, lines of credit, credit cards, mortgages) and on Real Estate (fixed
    asset / land / building accounts become a property line with its mortgage account as the loan; kind picked per line).
P3. Neil: "we should have the ability to do this in excel also" (the statement). Build: Produce Excel next to Produce PDF
    (raw .xlsx via jszip like reportExcel.js, one sheet per section + summary), kept on record like the PDF.
P4. "This only shows Neil Kadakia, how can we see Rajesh & Darshana Kadakia, Sahil & Charmi Desai." Build: New Guarantor
    prefills from People (owners/principals picker), supports Joint with the two names, and the Guarantors rail explains
    "Add each guarantor once; a joint statement lists both names." Make sure anyone with the pfs grant sees every profile.
P5. "Should have the ability to enter Spouse/Co-borrower details as well." Build: Borrower tab gets a Co-Borrower block
    (name, date of birth, SSN last 4 ONLY - never full, phone, email, address, employer, title, marital status) mirroring
    the borrower, stored in details.coBorrower, printed on the PDF/Excel. NEVER store a full SSN, never log figures.
P6. "SCH C and Sch E reporting." Build: a Schedules tab: Schedule E = one block per real estate line whose ledger entity
    is known: rents received, then expenses by IRS line (advertising, auto/travel, cleaning/maintenance, commissions,
    insurance, legal/professional, management fees, mortgage interest, other interest, repairs, supplies, taxes,
    utilities, depreciation, other) mapped from account titles, net; Schedule C = one block per Business Interest line
    with an entity: gross receipts, COGS, expenses by IRS Part II line, net profit. Period = the calendar year of As Of.
    Figures through the existing pnl endpoint per entity. Export to PDF/Excel.
P7. "Add jewelry in BS." Build: asset category "jewelry" ("Jewelry & Personal Property") between Personal Holdings and
    Other Holdings, manual lines with description, appraised value, appraisal date.

## New modules (Charmi + Neil)
N1. "Vendor / Customer DATABASE - edit a vendor, change all the details and get pushed to manager for approval."
    Build: Accounting > Vendors & Customers tab: list from the accounting app (contract V1), search, open a record, edit
    details -> a change request (new Nexus table accounting_partner_changes: id, kind, partner_id, partner_name, changes
    JSON {field: {from, to}}, status pending/approved/declined, requested_by/at, decided_by/at, note; RLS at release);
    managers (accounting grant + manager role) approve/decline from the tab with a bell to the requester; approved
    changes show as the record's current values in Nexus with an "Awaiting Intacct" badge and an Export CSV of approved
    changes for keying into Intacct (Intacct stays the source of truth, one-way).
N2. "Add a budget - open and edit." Build: Accounting > Budget tab: entity + year, a grid of accounts (rows, P&L accounts)
    x months (12 columns) + total, editable cells, Save (contract B1/B2), copy from last year's actuals, copy from the
    Intacct budget when one exists; and Reports > Columns gets "Budget vs Actual" (Actual, Budget, Variance $, Variance %)
    for the Income Statement.
N3. "Allocations journal entry from people and done monthly." Build: Accounting > Allocations tab: pick a month; basis =
    each person's worked hours by work site / entity from Time Clock (the By-location data, GET /timeclock/by-location or
    equivalent) ; cost = that month's wages from the payroll card; a preview JE: for each person, debit each entity's
    wage expense account by its share, credit the paying entity's allocation clearing account; editable account mapping
    (saved in nexus_settings key accounting_allocations_map); Export as an Intacct GL import CSV (same column layout as
    the accounting app's src/lib/finance/intacct-gl-export.ts) and as Excel; each run is kept (new table
    accounting_allocation_runs: id, month, entity, by, at, lines JSON - RLS at release). Nothing is posted anywhere.
N4. Neil: "Payroll Export Nexus to IIF is not working and payroll export from QB to Intacct employee." Build: find why the
    QuickBooks IIF button fails (PayrollTimecard.jsx:983 calls api.timeExportIif and DROPS the result; reqBlob in api.js
    returns a blob that nobody saves; require_stepup can 403) - make it download reliably with a toast, and add
    "Export for Intacct" next to it: an Intacct GL journal import CSV of the period's payroll by employee (wages by pay
    class, department/location dimensions) using the intacct-gl-export.ts column layout.

## Not built (needs a conversation, say so in the UI only if a stub exists)
- MRE itself (R8 is the recommended first cut, pending the Charmi discussion).
