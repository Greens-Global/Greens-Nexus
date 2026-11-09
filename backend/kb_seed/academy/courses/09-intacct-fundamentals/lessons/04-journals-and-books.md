---
title: Journals and Books
summary: The journals an entry comes through (general, payables, receivables, payroll, user defined, statistical), why a statistical journal never adds into money, and the books a report is read on - Accrual, Cash, the two side by side, and a user-defined book.
teaches: Accounting
---

Two reports on one desk disagree about October's income by a few thousand dollars. Same entity, same month. Before anyone calls Accounting, look at two small pickers at the top of each report: the journals and the book. Nine times in ten the answer is there.

## Journals

A **journal** is the door an entry came through. Every ledger line carries its journal's code, and the journal filter groups them by kind:

| Kind | What comes through it |
|---|---|
| **Payables (AP)** | Vendor bills and their payments (APJ) |
| **Receivables (AR)** | Customers billed through Intacct, such as commercial leases |
| **Payroll** | Wages, taxes and benefits by pay period (PYRJ) |
| **General** | Everything else the accounting team keys: accruals, depreciation, corrections (GJ) |
| **User Defined** | Entries that belong to a user-defined book only |
| **Statistical** | Quantities, not dollars: hours, units, square feet |

**Records > Journals** lists the journals Greens uses by code, and each one opens its lines for the period you pick. Filtering by journal answers questions no account can: "what posted through payroll this month" is the payroll journal; "which entries did a person key by hand" is the Manual Journal Entries page (see the lesson Ask My Accountant and the Audit Pages).

## Statistical Journals Count, They Do Not Add

A **statistical journal** carries numbers that are not money: hours worked, units, rentable square feet. The payroll hours import, for example, posts each person's regular, overtime, sick and vacation hours as a statistical entry. These numbers let a report divide dollars by a quantity (cost per unit, wages per hour) without a spreadsheet.

The rule: **a statistical journal never adds into a money total.** Nexus leaves it out of every sum and shows its lines on their own. If a total ever looks like hours were added to dollars, that is a question for Accounting.

## Books

A **book** is a timing rule for reading the same ledger.

```figure
{
  "kind": "compare",
  "title": "The Books a Report Can Be Read On",
  "columns": [
    { "name": "Accrual", "note": "the default", "facts": ["Revenue when earned, cost when incurred", "The statements Greens reports on"] },
    { "name": "Cash", "note": "when money moved", "facts": ["Rent when collected, bills when paid", "Answers where the cash went"] },
    { "name": "User-defined", "note": "a purpose of its own", "facts": ["Accrual plus that book's own journals", "Named by the accounting team"] }
  ]
}
```

The Fundamentals of Accounting course explains why accrual tells the truth about a month and cash answers a different question. A **user-defined book** is accrual plus a set of its own journals, kept for a purpose the main books should not carry, such as a fair-market view. Its entries never leak into the accrual statements.

## The Book Picker

Every report has a **Book** picker: **Accrual** (the default), **Cash**, **Accrual and Cash** (two columns side by side, two reads of the same ledger), and any user-defined book the ledger has. A memorized report keeps the book it was saved with.

> [!TIP]
> When someone says "but the bank went down this month," read the Income Statement on Accrual and Cash. The accrual column is what was earned and spent; the cash column is what moved. The gap is usually receivables, bills not yet paid, or a capital purchase.

## At Greens

The two October reports: one was read on Accrual, the other on Cash. Rent for October paid in early November falls in October on Accrual and in November on Cash. Read both on Accrual and they agree to the dollar.

## Common Mistakes

- **Comparing a cash-book figure to an accrual budget.** Budgets are accrual.
- **Adding statistical lines into a money total** in a spreadsheet. Intacct never does.
- **Not looking at the Book picker** before arguing about a month.

## Key Points

- Journals are the doors: payables, receivables, payroll, general, user defined, statistical. Records > Journals lists them.
- Statistical journals count; they never add into money.
- Books are timing rules: Accrual (the default), Cash, Accrual and Cash side by side, and user-defined books.
