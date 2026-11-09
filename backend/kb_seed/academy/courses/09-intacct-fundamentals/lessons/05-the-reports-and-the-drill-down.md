---
title: The Reports and the Drill-Down
summary: Where the statements live in the Reports menu, how every posted figure opens its ledger lines and every line opens its entry, Memorize for a view you keep, Report Builder for a report of your own, and Packages for a lender.
teaches: Accounting
---

Repairs on your property's Income Statement read $21,120 for October, and the budget said $14,000. You could email Accounting and wait. Or you could click the number. In Nexus every posted figure opens the lines behind it, and every line opens the entry. This lesson is that path.

## Where the Statements Are

Open **Reports**. Each group opens to the side:

| Group | What is in it |
|---|---|
| **Report Center** | Every report in one list, Report Builder, Packages |
| **Financial** | Balance Sheet, Trial Balance, the Income Statement views, General Ledger, Spend by Vendor, Statement of Cash Flows, Cash Position |
| **Banking & Credit Cards** | Credit Card Activity, Bank Activity |
| **Budget** | Budget, Budget vs. Actual YTD and MTD |
| **Payroll & People** | Compensation, Payroll Summary |
| **Audit & Insights** | Flux Analysis, MRE, MRI, AMA, Manual Journal Entries, Profitability |
| **Tax** | Schedule C (Draft) |

The **Income Statement** opens as T12 (the last 12 full months), YTD vs. Prior Year, This Month vs. Last Month, or by Customer, Job or Department. Above every statement sits the same row: the period, the entities, Columns, the Book and Filters.

## The Drill-Down

```figure
{
  "kind": "screen",
  "title": "From a Figure to Its Entry",
  "device": "computer",
  "module": "Accounting",
  "sub": "Income Statement",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Reports",
  "actions": ["Filters", "Memorize", "Export"],
  "parts": [
    { "kind": "table", "title": "This Month vs. Last Month", "columns": ["Account", "Oct", "Sep"], "rows": [
      ["Rental Income", "$168,400", "$165,100"], ["Repairs", "$21,120", "$9,860"], ["Utilities", "$6,310", "$6,020"]], "n": 1 },
    { "kind": "table", "title": "Repairs, Oct", "columns": ["Date", "Entry", "Doc No", "Vendor", "Description", "Debit", "Balance"], "rows": [
      ["10/05/2026", "APJ-3112", "4830", "Ridgeline Gate", "Gate operator", "$640.00", "$640.00"],
      ["10/19/2026", "APJ-3157", "R-221", "Summit Roofing", "Roof patch", "$11,900.00", "$12,540.00"]], "n": 2 },
    { "kind": "sheet", "title": "10/19/2026 · APJ", "text": "Both sides of the entry", "items": [
      { "label": "Repairs, Roofing", "note": "Debit $11,900.00 · Temecula · Summit Roofing", "n": 3 },
      { "label": "Accounts Payable", "note": "Credit $11,900.00" }], "buttons": ["Open Full", { "label": "Ask", "n": 4 }] }
  ],
  "callouts": [
    { "n": 1, "text": "Click a posted figure." },
    { "n": 2, "text": "Its General Ledger lines open, with a running balance and totals." },
    { "n": 3, "text": "A line opens its journal entry beside the list: account, debit, credit, location, memo, vendor." },
    { "n": 4, "text": "The question mark at a line's end asks My Accountant about it." }
  ]
}
```

1. Click any posted figure. Its **General Ledger lines** open: Date, Entry, Doc No, Account, Description, Entity, Vendor, Customer, Department, Debit, Credit and, on a drill-down, a running **Balance**, with totals.
2. Click a line's entry. The **journal entry** opens in a side panel, both sides of it: Account, Debit, Credit, Department, Location, Memo, Vendor, Project-Job and more. **Open Full** spreads it over the screen.
3. The **question mark** at a line's end asks My Accountant about it (see the lesson Ask My Accountant and the Audit Pages).

On screens outside Reports a figure opens its lines in a side panel instead, with **Open in Reports** for the full grid. Every report column takes a resizer and keeps your width.

Only a figure that is worked out rather than posted (a variance, a percent, a budget) stays plain. Everything posted is clickable.

## Keeping a View: Memorize

Set a statement the way you want it and click **Memorize**. A memorized view with a named period ("Last Month", "Year to Date") moves with the calendar, so next month it is right without touching it. **Export** sends a report to Excel, CSV, PDF, email or Files.

## Report Builder

**Report Center > Report Builder** makes a report of your own: pick GL accounts, entities, Filters, the period, Columns and the Book, add named **Row Groups** (several accounts under one total), and **Run**. **Compare** adds vs Prior Period or vs Prior Year with Variance $ and Variance %. **Save** keeps a draft; **Publish** finishes it, but only you see it until **Share With Everyone**. A report always reads over the reader's own entities.

## Packages

A lender wants the same statements for a property every quarter. A **Package** is that set of memorized reports under one name. **Build PDF** reads each one fresh and returns one PDF.

## At Greens

Back to $21,120. You click it: two lines, a $640 gate service and an $11,900 roof patch. The roof line's entry shows ticket R-221 in the memo. It was a real repair, budgeted as capital next year. You add a note for the variance review instead of a week of email.

## Common Mistakes

- **Arguing with a figure instead of clicking it.**
- **Rebuilding a spreadsheet every month** that a memorized view would keep.
- **Thinking Publish shares a report.** Only Share With Everyone does.

## Key Points

- Reports groups: Report Center, Financial, Banking & Credit Cards, Budget, Payroll & People, Audit & Insights.
- A posted figure opens its General Ledger lines; a line opens its entry; Open Full widens it; the question mark asks.
- Memorize keeps a view; Report Builder builds one; Packages build a lender's PDF.
