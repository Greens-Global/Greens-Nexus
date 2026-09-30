# Accounting Review Call - 09/29/2026

Source: Teams recording "Call with Charmi and 2 others" (34 min 36 s), transcript
read in full, 40 frames checked. Screen shared: PROD `nexus.greensglobal.com`,
Accounting, signed in as Charmi.

On the call: Charmi Desai, Visesh Lodha, Priyanka Sahu, Urmi Gor. The transcript
puts everything from Charmi's line under her name; the PFS and loans requests
("my bank accounts", "Neil and Archana's PFS") are most likely Neil speaking from
the same room.

Opening verdict: "A major improvement. This is like 90% to where we need to be."

Nothing below is built yet. Times are positions in the recording.
"Seen" = confirmed on the shared screen. "Heard" = said on the call only.

## Priority Called Out on the Call

- PFS was called an emergency (items F5 - F9).
- Excel export with formulas was called critical (item F3).

## Bug Fixes

| # | Where | What is wrong | Time | Evidence |
|---|---|---|---|---|
| B1 | Reports | Three entities picked + "By Entity" gives one combined column ("GREENS GLOBAL, INC.") instead of a column per entity. "By Month" is fine. | 4:51 | Seen |
| B2 | Reports | "By Vendor" with entity Darshana R. Kadakia MD Inc. (13000): vendors from every entity are listed at 0.00, totals look company-wide, and the drill-down opens 0 lines. | 9:32 | Seen |
| B3 | Reports | Balance Sheet "vs Same Date Last Year" failed once with "covers too many ledger lines to finish... pick an entity or narrow the dates", then worked on retry. Intermittent. | 10:54 | Seen |
| B4 | Reports, Access | Entity picker is too narrow: entity numbers are cut off and a sideways scrollbar appears. Same for Departments. | 3:23 | Seen |
| B5 | Reports, Access | Entities are listed A - Z, so 30111 sits above 10101. Order by entity number. | 23:48 | Seen |

## Changes

| # | Where | Change | Time | Evidence |
|---|---|---|---|---|
| C1 | All Accounting tabs | The search box is only on Reports. Show it on every Accounting tab. | 0:29 | Seen |
| C2 | Search results | The Vendors / Customers / Accounts / Journals chips with counts read as clutter. Make them dropdowns. The search boxes under each column name were liked - keep them. | 1:07 | Seen |
| C3 | Ledger grid | Column order: Date, Entry, Account, Description, Entity, then the rest. Description must not take all the width. | 2:19 | Seen |
| C4 | Ledger grid, entry window | "Vendor / Customer" is one column. Split into two columns. | 2:48, 18:35 | Seen |
| C5 | Entity and Department pickers | Wide enough for the full name and number, and tall enough to reach the bottom of the screen. | 3:23, 7:14 | Seen |
| C6 | Entity picker | Historical entities are hidden by default. Customize gets an option to show them. | 4:01 | Heard |
| C7 | Reports toolbar | Rename "Dimensions" to "Filters" and move Department into it (with Vendor, Customer, Employee, Project-Job, Item). Entity and Accounts stay outside. Order: Entities, Accounts, Filters. Accrual / Cash stays outside. | 6:09 | Seen |
| C8 | Reports toolbar | The Total Only / By Month / By Entity selector gets the heading "Columns". | 6:50 | Seen |
| C9 | Customize | Zero balances hidden by default; the option reads "Show". In a multi-period report keep a row if any period has activity, drop it only when every period is empty (example: CAM Charges with activity in March only). | 7:42 | Seen |
| C10 | Reports | Row banding is too faint. About 5% stronger. | 11:42 | Seen |
| C11 | Reports toolbar | One "Export" button with a dropdown (CSV, PDF, Excel) instead of two buttons. | 12:15 | Seen |
| C12 | Reports | Active filters shown under the report title as chips with an X, removed in one click. Today it is plain text ("Filtered by Department 1000") that cannot be clicked off. | 16:53 | Seen |
| C13 | Everywhere in Accounting | Remove "Open Nexus Accounting" (page header) and "Open in Nexus Accounting" (journal entry window). | 18:12 | Seen |
| C14 | Access | "Select All" for entities, then uncheck the few that do not apply. | 18:35 | Seen |
| C15 | PFS, Real Estate | Four categories: Domestic Residential, Domestic Commercial, International Residential, International Commercial. Today: Residential, Commercial, International. | 26:40 | Seen |
| C16 | Leasing | Rename to MRI (Monthly Recurring Income): leases plus interest and loan payments coming in. Still a placeholder today (no leases). Visesh to give a date. MRE (expenses) is a separate, later item. | 28:02 | Seen |

## New Features

| # | Where | Feature | Time | Evidence |
|---|---|---|---|---|
| F1 | Reports | General Ledger report. The list today: Income Statement, Balance Sheet, Trial Balance, Cash Position. Charmi will send the rest of the reports they need. | 9:26 | Seen |
| F2 | Reports | Export extras: send by email, save to Egnyte, share with a person. | 12:15 | Heard |
| F3 | Reports | Excel export: totals highlighted, column widths fitted, and live Excel formulas for the totals. Called critical. | 16:27 | Heard |
| F4 | Saved Reports | Own screen to manage saved reports (rename, edit filters) - the dropdown is too small for many. When a saved report is opened and changed, ask "Do you want to save your changes?" | 13:06 | Seen |
| F5 | PFS | Spouse on a statement ("Neil and Archana's PFS"). The guarantor today shows "Joint" with one name. | 20:12 | Seen |
| F6 | PFS | Assets, liabilities and real estate filled from Intacct automatically so a PFS never needs hand updates. Accurate to the dollar. The Add form already has "Kept by Hand / From the Ledger" and "Share Owned (%)" one row at a time; the ask is to set it up in bulk. | 21:00 | Seen |
| F7 | PFS | Pick accounts by GL group (example: every bank account under Cash for entity 30000, Neil and Archana Kadakia) instead of one by one. | 22:30 | Seen |
| F8 | PFS | Ownership percentage per person per account. | 24:40 | Heard |
| F9 | PFS | As-of date defaults to the last closed period (confirmed correct). PDF layout is fine - no change. | 27:00 | Seen |
| F10 | Packages | A column to comment on and adjust each line before a package goes out (add-backs, example: a $100,000 gate booked as Repairs and Maintenance). | 14:41 | Heard |
| F11 | Access | Log of when each person last opened Accounting. | 19:20 | Heard |
| F12 | Whole app | Two kinds of notification: the quiet bell, and a priority bar across the top of the screen (yellow) that stays until acted on - timecards due, timecard adjustments. | 29:19 | Heard |
| F13 | Data, Loans | Replace the loans spreadsheet (intercompany, external, loans given). Set a loan up once with a loan number and a GL account; the principal balance then comes from Intacct (example: mortgages on the balance sheet). Rate and maturity are typed in. Add fixed vs variable. The Loans table is empty today. | 31:05 | Seen |

## Already Done, or No Build Needed

- Monitoring alerts moved to Workforce: confirmed done on the call. "Pop up to manager" still to be checked (29:00).
- Close checklist and filing calendar: liked as they are (33:29).
- PFS PDF and the as-of date: fine as they are.

## Waiting on Other People

- Charmi: the list of further reports beyond General Ledger (F1).
- Priyanka and Urmi: a closer review of the Close checklist and calendar, with comments.
- Visesh: a date for MRI (C16).

## Answers From Visesh (09/30/2026)

1. Neil was in the same room: the PFS, loans and notification requests are his.
2. C16: "MRI" is the tab name. Leasing is a section inside it.
3. F8: left to my reading of the call. Built as one ownership percentage per
   person per account (each row on a statement carries its own share), which is
   what "my share of that account" on the call describes.
4. F12: the system raises priority notifications; managers can raise one too.
5. F2: not answered. Built to send from the signed-in person's own mailbox.

## Added by Visesh (09/30/2026) - Do This One Last

| # | Where | Feature |
|---|---|---|
| F14 | Access | Bring entity-based access over from Intacct (who may see which entities there), after everything above is done. |
