# Accounting Feedback - Sep 23-24, 2026

Source: team call on 09/23 (Neil, Charmi, Priyanka, Urmi, Vinod) and the Teams
thread that followed (09/23 03:07 through 09/24 00:26). Neil's framing at the
end of the call: "Please continue and wrap up, need to focus on ops within a
week hard." So this is a finish-and-close list, not a new roadmap.

Repos: Nexus = this repo. Accounting app = `C:\Users\Vlow\Desktop\Greens Accounting`
(`Greens-Global/greens-accounting`, `main` = production).

## A. Bugs reported (fix first)

- ☐ **Import Hub > Bank to Intacct: drag-and-drop does nothing** (Charmi, 00:16).
  The drop zone in `bank-to-intacct-page.tsx` only opens the file dialog on
  click; wire `onDragOver` / `onDrop` so a dropped CSV/XLSX loads the sheet.
- ☐ **Cannot pick an offset account while Remember is ticked** (Charmi, 00:16).
  `CodeRow` calls `saveRule` on every pick when `remember` is true; a failing
  rule save (RLS / org id / duplicate pattern) surfaces only as a toast and the
  picker appears not to take the value. Reproduce with Remember on, read the
  toast/network error, then make the manual coding stick regardless of the
  rule save and fix the save itself.
- ☐ **"Next: export" cannot be clicked** (Charmi, 00:26). Button is
  `disabled={!ready}`; `ready` needs every line coded. Show why it is blocked
  ("3 lines still need an account") and scroll to the first uncoded line
  instead of a silent disabled button.
- ☐ **Report drill-down: entry number should open the entry** (Charmi, 05:12).
  In the Nexus Accounting drill-down and the accounting app's ledger view the
  `ENTRY` column (e.g. JA-1200298) is plain text; make it a link to the
  journal-entry view.
- ☐ **Time Sheet tab: remove the Timecard / Daily toggle on phone** (Neil,
  03:56, screenshot of nexus.greensglobal.com Time Sheet on mobile).
  Nexus, not accounting. Hourly-employee self-service timecard view.
- ☐ **13-Week Cash Forecast shows wrong numbers** (Charmi 03:07, "completely
  wrong"). Neil's answer: no budget uploaded yet. Decision: change the widget
  to monthly (not weekly), and hide it / show "No budget uploaded" until
  budgets exist. Budgets come after reports are right (Neil).

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

Status: the ledger already stores department, location, vendor_id,
customer_id, employee_id, project_id, class_id per line (`pull.server.ts`
lines 611-660). Missing: **Item** (`ITEMID` is not in `GL_FIELDS`), and the
report Customize drawer only groups by Account type / Parent / Customer /
Month / Quarter. Work:

- ☐ Add `ITEMID` to the GLENTRY field list + ledger column + migration; verify
  the Intacct object name for items on greensglobal prod.
- ☐ Report filter bar: multi-select for each dimension (entity/location already
  exists; add department, employee, vendor, customer, project-job, item).
- ☐ Group-by: add Department / Location / Employee / Vendor / Project-Job / Item.
- ☐ Report RPCs: pass the dimension filters through (keep the `_json` twins;
  never a set-returning RPC that can hit the 1,000-row cap).
- ☐ Label it "Project-Job" everywhere in UI, not "Class".

## C. Bookkeeper / Controller view (Charmi, 03:31 + call 53:03)

Charmi's screenshot (QuickBooks-style Reconciliation panel):
`Account | Last Reconciled | Reconciled Balance | Current Balance`, rows per
bank / credit-card account, filtered by entity, with a Reconcile action.

- ☐ Dashboard Close tab (or a new Reconciliations card): when an entity is
  selected, list that entity's bank + card accounts needing reconciliation,
  last reconciled date, reconciled balance, current balance.
- ☐ Reconciliation cards summary line: "Reconciliations: 3/5 completed | 2
  remaining" (Priyanka, 00:01).
- ☐ Month-End Close: add a small My Tasks / All Tasks / Overdue filter;
  default My Tasks for the bookkeeper dashboard (Priyanka, 00:01).
- ☐ Charmi is sending a screenshot of the exact layout - wait for it before
  polishing.

Existing pieces to reuse: `banking/bank-reconciliation-page.tsx`,
`dashboard/widgets/close.tsx`, `dashboard/close-page.tsx`.

## D. Dashboard polish (Priyanka, 23:17 and 23:40)

- ☐ Period control shows "Year to Date" while the header separately shows
  01/01/2026-09/23/2026. Merge into one control: "Year to Date - 01/01/2026 -
  09/23/2026".
- ☐ Comparison columns on statements: `Account | YTD Actual | Prior Year YTD |
  $ Variance | % Variance` (the report-columns model already has prior-period
  columns; expose them as a preset).
- ☐ KPI cards consistent - every card carries a comparison:
  - Cash on Hand: $ + % vs last month
  - Net Income YTD: vs Prior Year / Budget
  - Operating Margin: +/- vs prior period
  - Liquidity Runway: months vs a target (6 months)

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
