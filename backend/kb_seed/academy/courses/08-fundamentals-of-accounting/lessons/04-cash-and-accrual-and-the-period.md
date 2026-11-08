---
title: Cash and Accrual, and the Period
summary: The two ways of deciding when something counts, why accrual books tell the truth about a month, the matching idea, the adjusting entries that make a period right (prepaids, accruals, deferred rent), and what a storage month looks like under each.
---

## What You'll Be Able to Do

- Tell cash-basis from accrual-basis accounting and say which one Greens' statements use.
- Explain matching: revenue in the period it is earned, expenses in the period they helped earn it.
- Name the adjusting entries that make a period right and give a storage example of each.
- Read a month's results and say which items are timing and which are real.

## When Does Something Count

The hardest question in accounting is not what happened but **when it counts**. There are two answers:

```figure
{
  "kind": "compare",
  "title": "Cash Basis and Accrual Basis",
  "columns": [
    { "name": "Cash basis", "note": "it counts when the money moves", "facts": ["Rent counts when the tenant pays", "A repair counts when the vendor is paid", "Simple; the bank statement is the book", "Lies about a month: January looks rich when December's rent arrives late"] },
    { "name": "Accrual basis", "note": "it counts when it is earned or incurred", "facts": ["Rent counts in the month of storage, paid or not", "A repair counts when the work was done", "Needs adjusting entries at month end", "Tells the truth about a month; what Greens' statements use"] }
  ]
}
```

Greens' financial statements are **accrual**. Intacct also keeps a cash view (the Books picker in Nexus Accounting lets a report be read on either, or both side by side), because the cash view answers the third question, where did the cash go. But when someone says "how did Temecula do in October," the answer is the accrual income statement.

## Matching

The idea behind accrual is **matching**: put revenue in the period it was earned, and put the expenses that helped earn it in the same period. A tenant who stores in October and pays on 11/08 earned the company October revenue. The October electricity bill that arrives 11/12 is an October expense. The insurance premium paid in January for the whole year is twelve months of expense, not one.

Matching is what makes October comparable to September and this October comparable to last. Without it a month is just whatever happened to clear the bank.

## The Adjusting Entries

At the end of every period, Accounting makes **adjusting entries** that move things into the right period. At a storage company there are five that recur:

```figure
{
  "kind": "timeline",
  "title": "What Month-End Adjusts",
  "items": [
    { "at": "Prepaid rent", "label": "Rent tenants paid ahead becomes this month's revenue", "note": "the liability earned down as the month arrives" },
    { "at": "Receivables", "label": "Rent owed for this month is recorded as revenue and as money owed", "note": "with an allowance for what will never be collected" },
    { "at": "Prepaids", "label": "A twelfth of the year's insurance, a quarter of the gate contract", "note": "the asset becomes expense as the coverage is used", "tone": "live" },
    { "at": "Accruals", "label": "Wages earned but unpaid; the utility bill not yet in", "note": "the expense belongs here, the cash leaves later" },
    { "at": "Depreciation", "label": "A month of each asset's cost", "note": "the roof, the canopies, the gate operator, worn a little more" }
  ]
}
```

| Adjustment | What it does | Entry |
|---|---|---|
| **Earn down prepaid rent** | Rent paid ahead for this month becomes revenue | Debit Prepaid Rent (liability), credit Rental Income |
| **Record rent earned but unpaid** | This month's storage counts even if the tenant has not paid | Debit Tenant Receivables, credit Rental Income |
| **Allowance for doubtful accounts** | Some receivables will never be collected; the expense is recognized now | Debit Bad Debt Expense, credit Allowance for Doubtful Accounts |
| **Expense a prepaid** | One month of insurance, a quarter of a service contract | Debit Insurance Expense, credit Prepaid Insurance |
| **Accrue an expense** | Wages earned this period, a utility bill not yet received | Debit Wages (or Utilities), credit Accrued Liabilities |
| **Depreciation** | A month of each long-lived asset's cost | Debit Depreciation Expense, credit Accumulated Depreciation |

Each of these reverses or earns down over time, so nothing is counted twice: the accrued utility bill is cleared when the real bill arrives; the prepaid insurance runs to zero when the policy year ends.

## A Storage Month, Both Ways

Take a site in October with these facts: tenants were billed $60,000 of rent for October; $52,000 of it was collected in October, $6,000 arrived in early November, and $2,000 will probably never be collected; $4,000 of November rent was paid early in October; the October electricity bill of $1,800 arrived 11/12; the gate was serviced in October for $640, paid in November; and the $12,000 annual insurance premium was paid in January.

| | Cash basis, October | Accrual basis, October |
|---|---|---|
| Rent | $56,000 collected ($52,000 + $4,000 early) | $60,000 earned, less $2,000 allowance = $58,000 |
| Electricity | $0 (bill paid in November) | $1,800 |
| Gate service | $0 (paid in November) | $640 |
| Insurance | $0 (paid in January) | $1,000 (one twelfth) |

The cash view says October had $56,000 in and almost nothing out. The accrual view says October earned $58,000 and cost $3,440 in these lines. Only the second tells you how the site did.

## Timing or Real

When a month's result surprises you, ask whether the surprise is **timing** (an accrual, a prepaid earning down, a bill that landed in the wrong month) or **real** (more repairs, fewer tenants, a rate change). Timing surprises reverse next month. Real ones do not. The drill-down (every figure to its lines) is how you tell: a $3,000 repairs line that is one accrued invoice dated the wrong month is timing; three gate calls is real.

> [!NOTE]
> Every tenant's rent at Greens is billed monthly in advance through Cubby, so prepaid rent and receivables are large, normal balances that move every month. A jump in receivables is the first sign of a collections problem; the Receivables and Bad Debt lesson picks it up.

## A Greens Scenario

Murrieta's November income statement shows utilities at double the usual. The manager clicks the figure: two electricity bills, one dated 10/28 that arrived late and one for November. Timing, not a leak. He notes it in the variance comment so the owner's review does not go looking for a broken meter. The same report shows repairs up too: three vendor invoices, three different systems. That one is real, and it goes in the budget case.

## Common Mistakes

- **Reading the bank balance as the month's result.**
- **Judging a month before the adjusting entries are in.** The close finishes the month.
- **Chasing a timing variance** as if it were a real one.
- **Counting next month's early rent as this month's income.**

## Key Points

- Cash counts when money moves; accrual counts when it is earned or incurred. Greens' statements are accrual; the cash view is read beside them.
- Matching puts revenue and the expenses that earned it in the same period.
- Month-end adjusts prepaid rent, receivables and the allowance, prepaids, accruals and depreciation.
- A surprise is timing or real; the drill-down tells you which.
