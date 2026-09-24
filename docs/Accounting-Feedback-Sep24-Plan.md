# Accounting Feedback - Sep 23-24, 2026

Source: team call on 09/23 (Neil, Charmi, Priyanka, Urmi, Vinod) and the Teams
thread that followed (09/23 03:07 through 09/24 00:26). Neil's framing at the
end of the call: "Please continue and wrap up, need to focus on ops within a
week hard." So this is a finish-and-close list, not a new roadmap.

Repos: Nexus = this repo. Accounting app = `C:\Users\Vlow\Desktop\Greens Accounting`
(`Greens-Global/greens-accounting`, `main` = production).

## Status (09/24, end of build session)

Built and committed, NOT deployed: accounting `main` (2e76595 + the dashboard
commit after it) and Nexus `dev` (b8c7ab62 + the dashboard commit after it).
Neither repo is pushed: the auto-mode classifier refuses pushes and every
production database read or write. Before anyone tests:

1. Apply the three accounting migrations live (from the accounting repo;
   `apply_mig.py` is in the Sep 22 session scratchpad and reads DATABASE_URL
   from the accounting `.env`):
   ```
   python apply_mig.py 20260924100100_entry_detail_internal --apply
   python apply_mig.py 20260924110000_report_dimensions --apply
   python apply_mig.py 20260924120000_dashboard_recon_accounts --apply
   ```
2. Run this one line on the accounting database. The classifier refused to
   let me write it as a migration file because it widens a write policy. It
   lets finance "view" users (every Nexus-provisioned bookkeeper) save Bank
   to Intacct rules; today only "full" can, which is why Charmi's picks with
   Remember ticked were refused. Put the same line in a migration file
   afterwards so it is tracked:
   ```sql
   select public._fin_dash_policies_shared('fin_gl_import_rules');
   ```
3. Push accounting `main` (Cloudflare deploys) and Nexus `dev`.
4. In the accounting app: Import Hub, pull Dimensions with Items ticked, then
   re-pull the GL for the months that should carry Item (existing lines have
   no `item_id` until pulled again; ITEMID is optional and dropped
   automatically if this company's GLENTRY does not serve it).
5. Browser click-through: nothing below was opened in a browser.

## A. Bugs reported (fix first)

- ✅ **Import Hub > Bank to Intacct: drag-and-drop does nothing** (Charmi, 00:16).
  The drop zone claims the drop, highlights while dragging, and the same file
  can be chosen twice.
- ✅ / ☐ **Cannot pick an offset account while Remember is ticked** (Charmi,
  00:16). Root cause: the rule table's write policy needs finance "full";
  Nexus provisions everyone but administrators at "view", so the rule save was
  refused by RLS and the toast read like the pick had failed. Client fix done
  (the line stays coded, the message says the rule was not saved and why).
  The policy line in step 2 above finishes it.
- ✅ **"Next: export" cannot be clicked** (Charmi, 00:26). Rows the parser
  skipped (no date or amount) no longer block the export; the button carries
  the reason and "Show next uncoded" scrolls to the first open line.
- ✅ **Report drill-down: entry number should open the entry** (Charmi, 05:12).
  In Nexus the entry number on any search result or drill-down opens the whole
  journal entry in place (lines, entity, department, vendor / customer,
  Project-Job, Intacct batch) with "Open in Nexus Accounting" deep-linking
  `/finance/ledgers/entry/<id>`. New `ledger_entry_detail` core and
  `GET /api/internal/entry`; search rows carry `entry_id`.
- ✅ **Time Sheet tab: remove the toggle on phone** (Neil, 03:56). It was the
  California / India timezone switch; hidden on an employee's own timesheet
  (payroll reviewers keep it).
- ✅ **13-Week Cash Forecast shows wrong numbers** (Charmi 03:07). Replaced by
  "Monthly Cash Forecast": six months, every figure from the POSTED BUDGET
  (receipts and costs by category), debt service from loans, distributions
  from partner capital. No run-rate, no seasonality, no jitter. With no budget
  posted the panel says so instead of showing numbers; a month without budget
  lines is starred. Both apps; model tests added.

## B. Reports - all Intacct dimensions (Charmi, 03:10; Neil agreed)

P&L (and by extension BS / GL) must be filterable and groupable by any of:

1. Department
2. Location (single or multiple)
3. Employee
4. Vendor
5. Customer
6. Project-Job (Intacct renamed "Class" to "Project-Job" during implementation;
   the API still returns it as `CLASSID` per Neil, 03:34 - verify in the ledger
   pull: `pull.server.ts` maps both `PROJECTID` and `CLASSID`)
7. Item

Built (09/24):

- ✅ `ITEMID` pulled on GL lines (`item_id` column) and an `item` dimension
  (optional, never stops the sync). Existing lines need a re-pull to carry it.
- ✅ SQL: `ledger_account_dims` / `rpt_account_dims_json` sum the SAME posted
  lines every report reads, with vendor / customer / employee / Project-Job /
  item looked up per line on the mirror; `rpt_account_lines_dims` for the
  drill-down; `rpt_dim_values` for pickers; multi-entity and multi-department
  helpers; partial indexes per dimension. All jsonb (no 1,000-row cap). With
  no dimension set it must equal `rpt_account_sums` to the cent - verify on
  prod once applied.
- ✅ Accounting app P&L: "Dimensions" button (several entities and departments,
  vendor, customer, employee, Project-Job, item) plus By Vendor / Customer /
  Employee / Project-Job / Item columns; drill-down and saved reports carry
  the selection (URL param `dims`).
- ✅ Nexus Reports: Add Filter chips for Department, Entities (several),
  Employee, Vendor, Customer, Project-Job, Item on P&L, Balance Sheet and
  Trial Balance; line search follows a single entity or party and names the
  filters it cannot apply.
- ✅ "Project-Job" replaces the Class label; API = CLASSID, PROJECTID fallback.
- ☐ Balance Sheet and GL columns by dimension in the accounting app (P&L only
  so far). Nexus has filters, not dimension columns.

## C. Bookkeeper / Controller view (Charmi, 03:31 + call 53:03)

Charmi's screenshot (QuickBooks-style Reconciliation panel):
`Account | Last Reconciled | Reconciled Balance | Current Balance`, rows per
bank / credit-card account, filtered by entity, with a Reconcile action.

- ✅ The Reconciliations list now comes from the LEDGER: every bank / cash GL
  account and every credit-card liability with a balance or activity in the
  last year, per top-level entity, scoped like everything else (pick an
  entity and only its accounts show). Columns: Account | Entity | Last
  Reconciled | Reconciled Balance | Current Balance | Difference | Status.
  "Mark reconciled" asks for the statement date and balance and stores them
  on the mark (`fin_recon_marks.thru_date` / `stmt_balance`); the latest mark
  per account is what "Last Reconciled" shows in any later month. Both apps;
  model tests added.
- ✅ KPI card and list header read "3 of 5 · 2 remaining" (Priyanka).
- ✅ Month-End Close checklist: My Tasks / All Tasks / Overdue plus an "I am
  Bookkeeper / Controller" picker (owners come from the plan); My Tasks
  becomes the default once a role is picked. Both apps.
- ☐ Charmi's layout screenshot has not arrived; adjust when it lands.

Existing pieces to reuse: `banking/bank-reconciliation-page.tsx`,
`dashboard/widgets/close.tsx`, `dashboard/close-page.tsx`.

## D. Dashboard polish (Priyanka, 23:17 and 23:40)

- ✅ Nexus Reports period is one control: "Year to Date · 01/01/2026 -
  09/23/2026" (each preset shows its dates; Custom reveals the date boxes).
- ✅ Nexus P&L and Balance Sheet compare to Prior Year / Prior Period (Balance
  Sheet: prior month end): `Account | YTD Actual | Prior Year YTD |
  $ Variance | % Variance`, in the CSV too.
- ✅ KPI cards, both apps: Operating Margin "+2.1 pts vs prior month";
  Liquidity Runway "target 6 months" and "-3.1 mo vs target"; Net Income YTD
  "vs budget" AND "vs prior year" (the ledger window now always starts at
  January of the prior year so the prior YTD is complete); Reconciliations
  "2 remaining". Cash on Hand already had "vs last month".

## E. Where do tools live? (Neil, call 52:05)

Neil: the mortgage calculator (and similar) should NOT sit inside Accounting;
it helps everybody. Options raised: a separate **Tools** section; and if Tools
exists, does Import Hub still need to be its own thing or does it move too?
Charmi and Priyanka agreed on Tools-outside-Accounting.

- ☐ Decide the shape with Neil (a Tools module in Nexus, visible to all, with
  Mortgage Calculator first; Import Hub stays in the accounting app because it
  is bookkeeper-only). Not building until Neil answers.

## F. Answered / no action

- ✅ "Is the accounting up again / root cause?" (Neil 22:35) - Charmi confirmed
  up. Root cause reply still owed to Neil: see `Leftovers-Sep19.md` section 1
  (draft written there).
- ✅ Neil on the call: search across QuickBooks + Intacct in one place is "the
  freedom we did not have" - the Search page is the win to keep intact.

## Order of work

1. Section A bugs (Import Hub x3, entry link, phone toggle, cash forecast).
2. Section B dimensions (biggest ask; Item column needs an Intacct pull change
   first, so start that so the next sync carries it).
3. Section C reconciliation view once Charmi's screenshot lands.
4. Section D polish.
5. Section E after Neil decides.
