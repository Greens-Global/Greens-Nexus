---
title: Journals and Books
summary: The journals an entry posts through (payables, receivables, payroll, general, user-defined and statistical), why a statistical journal never adds into money, the books a report can be read on (accrual, cash, a user-defined book) and the Books picker in Nexus.
---

## What You'll Be Able to Do

- Name the journals and say what kind of entry each one carries.
- Explain why statistical journals never change a dollar total.
- Tell the accrual book from the cash book and from a user-defined book, and read a report on each.
- Use the journal and book filters on a Nexus report.

## Journals

A **journal** is the door an entry came through. Intacct keeps several, each for one kind of activity, and every ledger line carries its journal's symbol:

| Journal | Symbol | What posts through it | Where it starts |
|---|---|---|---|
| **Accounts payable** | APJ | Vendor invoices and their payments | The accounting app's payables |
| **Accounts receivable** | ARJ | Customer invoices and receipts, where customers are billed through Intacct (leases) | The accounting app's receivables |
| **Payroll** | PRJ | Wages, taxes, benefits by period | The payroll import, built from signed Time Sheets |
| **Cash receipts and disbursements** | CRJ, CDJ | Deposits and payments against the bank | The bank feed and the deposit batches (Cubby's rent arrives here) |
| **General** | GJ | Everything else: accruals, depreciation, reclasses, the adjusting entries | Keyed by the accounting team |
| **User-defined** | As named | A book's own entries, kept apart from the main books | The accounting team, for a purpose |
| **Statistical** | As named | Counts, not dollars: units, square feet, occupancy, hours | Imports and entries that carry a quantity |

Why it matters to a reader: filtering a report to one journal answers questions no account can. "What posted through payroll this month" is the PRJ. "Which entries did a person key by hand" is the GJ, and the Manual Journal Entries page (a later lesson) is built on it.

## Statistical Journals Count, They Do Not Add

A **statistical journal** carries numbers that are not money: rentable square feet, units, occupied units, hours. They let a report divide dollars by a quantity (rent per square foot, cost per unit) without anyone typing the quantity into a spreadsheet. Nexus follows Intacct's rule exactly: a statistical journal **never adds into a money total**; the accounting app leaves it out of every sum, and the drill-down shows its lines on their own. A report that includes a statistical journal shows its figures beside the money, never inside it.

## Books

A **book** is a way of reading the same ledger under a different timing rule:

```figure
{
  "kind": "compare",
  "title": "The Books a Report Can Be Read On",
  "columns": [
    { "name": "Accrual", "note": "the default", "facts": ["Revenue when earned, expense when incurred", "The statements Greens reports on", "What the Dashboard and every report show unless you choose otherwise"] },
    { "name": "Cash", "note": "when money moved", "facts": ["Rent when collected, bills when paid", "Answers 'where did the cash go'", "Read beside accrual, never instead of it"] },
    { "name": "User-defined", "note": "a book of its own", "facts": ["Accrual plus that book's own journals", "Kept for one purpose: a fair-market view, an entity's special reporting", "Named by the accounting team; travels by its key"] }
  ]
}
```

The Fundamentals of Accounting course explained why accrual tells the truth about a month and cash answers a different question. Intacct keeps both as books, and the accounting team may add **user-defined books**: the accrual ledger plus a set of that book's own journals, used for a purpose the main books should not carry (a fair-market valuation view, a reporting basis a particular entity needs). A user-defined book is read like any other; its entries sit in its own journals and never leak into the accrual statements.

## The Books Picker in Nexus

Every report page in Nexus Accounting has a **Book** picker: Accrual (the default), Cash, any user-defined book the ledger has, or **Both**, which reads accrual and cash side by side in two columns. Both is two reads of the ledger, never a book of its own, and the quickest way to see whether a month's gap between profit and cash is receivables, payables or a capital spend.

> [!TIP]
> When a manager says "but the bank went down this month," read the Income Statement on Both. The accrual column says what was earned and spent; the cash column says what moved; the difference between them is the answer.

## A Greens Scenario

Charmi asks a site manager why October's income looks lower on one report than another. He checks the Book picker: one report was read on Accrual, the other on Cash, and October's early-November rent payments fall in different months on the two. Same ledger, two timing rules. He re-reads both on Accrual, and they agree to the dollar.

## Common Mistakes

- **Comparing a cash-book figure to an accrual budget.**
- **Adding a statistical journal's lines into a money total.** Intacct does not; neither should a spreadsheet.
- **Not noticing the Book picker.** Two people reading two books argue about one month.

## Key Points

- Journals are the doors entries come through: APJ, ARJ, PRJ, cash journals, GJ, user-defined and statistical; filter by them to answer questions no account can.
- Statistical journals count, they never add into money.
- Books are timing rules on one ledger: accrual (the statements), cash (where the money went), user-defined (a purpose of its own); Both reads two side by side.
