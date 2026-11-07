---
title: The Reports and the Drill-Down
summary: Report Center and memorized reports, the financial statements as Nexus shows them, Buckets and Budget, the Report Builder for a report of your own, Packages for lenders, and the one rule on every screen - every figure opens its lines and every line opens its entry.
---

## What You'll Be Able to Do

- Find a statement in Report Center and read it for your entity, period and book.
- Drill from any figure to its ledger lines and on to the journal entry.
- Build a report of your own in Report Builder, with row groups and a comparison, and share it.
- Explain what a Package is and why a lender's quarter builds itself.

## Report Center

**Reports > Report Center** is the shelf: the standard financial statements and every **memorized report** (a saved definition: which report, which filters, which period words, which book) anyone with the grant has shared. A memorized report with a named period ("Last Quarter", "This Year") moves with the calendar, so the same report is right next month without being touched.

| Report | What it shows |
|---|---|
| **Income Statement** | Revenue, expenses, NOI and net income for the period, by entity or consolidated; a Comparison view against the prior period or year |
| **Balance Sheet** | Assets, liabilities and equity at the period's end |
| **Trial Balance** | Every account's debit or credit balance; where the accounting team starts the close |
| **Cash Position** | Each bank account's balance and the period's movement |
| **Buckets** | An account group's lines grouped by a dimension (the Dimensions lesson) |
| **Budget** | Budget beside actual by account, with variance in dollars and percent |

## The Drill-Down

```figure
{
  "kind": "steps",
  "title": "From a Figure to the Entry Behind It",
  "items": [
    { "label": "The figure", "note": "Repairs and Maintenance, $21,120, on the Income Statement" },
    { "label": "Its lines", "note": "the General Ledger lines: Doc, Memo, Entity, Vendor, Department, Debit, Credit, Balance" },
    { "label": "One line", "note": "APJ, 11/05, Precision Gate Co., #4830 gate operator service, $640.00" },
    { "label": "The entry", "note": "both sides of the journal entry, the attachment, the ticket number in the memo" },
    { "label": "Ask about it", "note": "a question on the line goes to Ask My Accountant" }
  ],
  "caption": "The house rule from the Accounting module's design: every posted figure opens its lines; every line opens its transaction. Only a figure that is worked out rather than posted (a variance, a percent, a budget) stays plain."
}
```

Click any posted figure and the **ledger lines** behind it open: the same columns Intacct's General Ledger shows (document, memo or description, entity, vendor, customer, item, employee, department, debit, credit and a running balance), with totals. Click a line and the **journal entry** opens in a side panel, both sides of it, with Open Full for the whole record. From a line you can also **ask a question**, which lands in Ask My Accountant for the bookkeeper (a later lesson).

Every report column takes a resizer and keeps the width you set, per person, so the grid you arranged is the grid you come back to.

## Report Builder

```figure
{
  "kind": "screen",
  "title": "Report Builder",
  "device": "computer",
  "module": "Accounting",
  "sub": "Report Center",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Reports",
  "actions": ["Run", "Save", { "label": "Publish", "primary": true }],
  "parts": [
    { "kind": "form", "title": "Site Operating Report", "fields": [
      { "label": "Accounts", "value": "4010 to 4290 Revenue; 5010 to 6990 Operating Expenses" },
      { "label": "Entities", "kind": "select", "value": "Temecula, Murrieta, Fairfield" },
      { "label": "Other Dimensions", "value": "Department: Operations", "hint": "vendor, customer, employee, Project-Job, item, journal" },
      { "label": "Period", "kind": "select", "value": "Last Month" },
      { "label": "Book", "kind": "select", "value": "Accrual" },
      { "label": "Compare", "kind": "select", "value": "vs Prior Year, with Variance $ and %", "n": 1 }
    ] },
    { "kind": "table", "title": "Row Groups", "columns": ["Group", "Accounts"], "rows": [["Rental Income", "4010, 4020, 4030"], ["Fees and Other", "4210 to 4290"], ["Repairs and Maintenance", "6210 to 6290"], ["Utilities", "6310 to 6340"]], "n": 2 }
  ],
  "callouts": [{ "n": 1, "text": "Compare adds the prior period or prior year beside this one, with the variance in dollars and percent." }, { "n": 2, "text": "Named row groups gather accounts under one total, so a nonstandard report is built by the person who knows the mapping, never in code." }]
}
```

**Report Builder** makes a report of your own: pick the accounts, the entities and any other dimension, the period and the book, **Run**, then **Save** it under a name or **Publish** it. Named **row groups** gather accounts under one total ("Rental Income" over three accounts), which is how a report with lines the standard statements do not have (a lender's covenant schedule, a tax schedule) is built by the person who knows the mapping. **Compare** adds the prior period or the prior year with the variance in dollars and percent.

A saved report is yours; a published one is marked published and can be **shared with everyone** who has the grant. Either way it reads fresh from the ledger every time, over the entities the reader may see: a person limited to one site builds and reads over that site only.

## Packages

A lender asks for the same set of statements every quarter for every property with a loan. A **Package** is that set, kept under a name: the memorized reports it contains, in order. **Build PDF** reads each one fresh and hands back one document: a cover with the contents, then every statement. Because the reports inside carry named periods, the same package is right next quarter untouched. The Loans lesson comes back to this.

## A Greens Scenario

The owner asks for a one-page operating comparison of the three California vehicle lots, this year against last. The accounting lead opens Report Builder: revenue and operating expense accounts, the three entities, row groups for Rental Income, Fees, Repairs, Utilities and Payroll, Compare vs Prior Year, Accrual. Run, Save as "Vehicle Lots Operating Comparison", Publish, Share With Everyone. Next month the owner opens it from Report Center and it has moved to the new month on its own.

## Common Mistakes

- **Arguing with a figure instead of clicking it.**
- **A spreadsheet rebuilt every month** that a memorized report with a named period would replace.
- **Reading a Package once and then rebuilding it by hand** next quarter.

## Key Points

- Report Center holds the statements and every shared memorized report; named periods move with the calendar.
- Every posted figure opens its General Ledger lines; every line opens its entry; columns keep your widths.
- Report Builder: accounts, entities, dimensions, period, book, row groups, compare; save, publish, share; always read over the reader's entities.
- A Package is a lender's set of statements that builds itself each quarter.
