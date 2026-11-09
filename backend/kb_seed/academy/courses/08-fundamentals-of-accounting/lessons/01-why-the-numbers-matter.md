---
title: Why the Numbers Matter
summary: What accounting is for at a storage company, who reads the numbers, the three questions every set of books answers, and how any figure in Nexus Accounting opens to the lines and the entry behind it.
teaches: Accounting
---

## On the 5th of the Month

It is the 5th. Your site's repairs line on the Income Statement is a third higher than last year, and your area manager wants to know why by lunch. You can guess, or you can click the figure and read the answer. This course teaches you to read it.

## Accounting Is Keeping Score, Honestly

Accounting records what a business owns, owes, earns and spends, in a way other people can check. That last part is the point. A manager knows roughly how the site did; the books say exactly, in a form the owners, the bank, the insurer, the tax authorities and an auditor can all read and agree on.

At Greens the score is kept in **Sage Intacct**, run by the Accounting team. Nexus Accounting shows the parts of it the rest of the company needs: the reports and dashboards, a vendor's record, a construction job's money. Nexus never keeps a second set of books; it reads the one set. Each property is its own **entity** in Intacct, so "my site's numbers" means "my entity's numbers."

## The Three Questions

Every set of books answers three questions, each with its own statement:

| Question | The statement | At a storage site |
|---|---|---|
| **What do we own and owe?** | The **balance sheet**, at a moment | The buildings, the cash, what tenants owe; the loan, what vendors are owed, rent paid ahead |
| **Did we make money?** | The **income statement**, over a period | Rent, fees and merchandise, less payroll, utilities, repairs, insurance, taxes and interest |
| **Where did the cash go?** | The **cash flow statement**, over a period | Rent collected, bills paid, loan payments, a new roof |

A site can make money on paper and run short of cash (tenants paying late), or have cash and be losing money (a loan drawn down). That is why there are three statements, not one.

## Every Number Started at a Site

| What happened at the site | What it becomes in the books |
|---|---|
| A tenant pays this month's rent | Revenue for the month, cash in the bank |
| A tenant pays next month early | Cash now, but a **liability** (rent paid ahead) until the month arrives |
| A vendor fixes the gate and sends an invoice | An **expense** now and an **account payable** until it is paid |
| A new gate operator is installed | An **asset**, turned into expense a little each month as **depreciation** |
| You punch in and out | **Payroll expense**, through the Time Sheet you sign |

## Click the Figure

In Nexus Accounting every amount on every report opens the ledger lines that make it up, and every line opens the entry it came from. That trail is how a reviewer, an auditor or a doubtful manager finds out whether a number is right.

```figure
{
  "kind": "screen",
  "device": "computer",
  "module": "Accounting",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Reports",
  "parts": [
    { "kind": "table", "title": "Income Statement", "columns": ["Account", "Oct", "Nov"], "rows": [
      ["Rental Income", "58,200", "58,900"],
      ["Repairs and Maintenance", "2,140", "3,480"],
      ["Utilities", "1,800", "1,750"]
    ], "n": 1 },
    { "kind": "table", "title": "General Ledger", "columns": ["Date", "Entry", "Doc No", "Account", "Vendor", "Debit", "Balance"], "rows": [
      ["11/04/2026", "APJ-2211", "4790", "Repairs", "Gate Pro", "1,240.00", "1,240.00"],
      ["11/19/2026", "APJ-2263", "4830", "Repairs", "Gate Pro", "640.00", "1,880.00"]
    ], "n": 2 },
    { "kind": "sheet", "title": "11/19/2026 · APJ", "text": "Repairs and Maintenance - Debit 640.00 - Memo: #4830 gate operator service - Vendor: Gate Pro", "buttons": ["Open Full", "?"], "n": 3 }
  ],
  "callouts": [
    { "n": 1, "text": "Reports > Financial > Income Statement. Click any amount." },
    { "n": 2, "text": "The ledger lines behind it, with a running Balance." },
    { "n": 3, "text": "A line opens its entry beside the list. The question mark at a line's end asks My Accountant." }
  ]
}
```

The habits that keep the trail whole start at the site: a ticket number on every vendor invoice, a receipt on every card charge, a photo on every work order, a reason on every waiver.

## At Greens

Priya runs Temecula. Her November repairs line is $1,340 over October. She clicks it: two gate invoices, one after hours. She opens one; its memo carries ticket #4830, and the ticket says the operator failed on a Saturday night. The number was right; the gate was the story. She writes that into her variance note and into next year's budget case.

## Common Mistakes

- **Treating the books as Accounting's problem.** Every number started at a site.
- **Confusing profit and cash.** A site can be profitable and short of cash in the same month.
- **Arguing with a figure instead of clicking it.** The lines either explain it or show the mistake.

## Key Points

- Accounting records what the business owns, owes, earns and spends so others can check it. Greens keeps one set of books, in Intacct; Nexus reads it.
- Three questions, three statements: balance sheet, income statement, cash flow statement.
- Each property is an Intacct entity; every figure opens its ledger lines, and every line its entry.
