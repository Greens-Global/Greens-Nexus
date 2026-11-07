---
title: Receivables, Delinquency and Bad Debt
summary: What a tenant receivable is, how an aging report reads, why the books expect some rent never to arrive (the allowance), when a balance is written off, how a lien sale closes it, and the numbers a manager is asked about.
---

## What You'll Be Able to Do

- Explain what tenant receivables are and read an aging report.
- Say why the books record an allowance for doubtful accounts before any balance is written off.
- Trace a delinquent balance from the first missed payment to its write-off or lien sale.
- Name the receivables numbers a site is measured on and the habits that move them.

## A Receivable Is Rent Owed

When the 1st bills every tenant, each unpaid charge is a **receivable**: money the tenant owes the company. Most receivables clear within days as autopay runs and tenants pay. The ones that do not are **delinquent**, and delinquency is the one part of accounting the site controls directly.

## The Aging Report

An **aging report** sorts every unpaid balance by how long it has been unpaid:

```figure
{
  "kind": "bars",
  "title": "An Aging Report, Read Left to Right",
  "unit": "%",
  "max": 100,
  "items": [
    { "label": "Current (0 to 10 days)", "value": 60, "text": "the normal lag between the 1st and payment", "tone": "ok" },
    { "label": "11 to 30 days", "value": 22, "text": "the late fee has posted; calls happen here", "tone": "live" },
    { "label": "31 to 60 days", "value": 10, "text": "overlocked; the lien process has begun", "tone": "warn" },
    { "label": "61 to 90 days", "value": 5, "text": "notices sent; a sale date set", "tone": "bad" },
    { "label": "Over 90 days", "value": 3, "text": "sold or written off soon", "tone": "bad" }
  ],
  "caption": "An illustration of the shape. The further right a balance sits, the less of it the company will ever see."
}
```

The columns match the delinquency timeline the Self-Storage Fundamentals course taught (Greens Delinquency Timeline): the late fee, the gate code change, the overlock, the notices, the sale. Accounting reads the same timeline as money: how much is in each column, and how much of it will be collected. Experience says a balance over 90 days is mostly gone.

## The Allowance: Expecting Some Loss

Accrual books record the rent as earned on the 1st, paid or not. But some of it will never arrive, and matching says the loss belongs in the same period as the revenue, not months later when the unit is finally sold. So each month Accounting records an **allowance for doubtful accounts**: an estimate of the receivables that will not be collected, based on the aging (a small share of what is 31 to 60 days old, a larger share of 61 to 90, most of what is over 90).

| Account | Debit | Credit |
|---|---|---|
| Bad Debt Expense | the estimate | |
| Allowance for Doubtful Accounts | | the estimate |

The allowance is a **contra asset**: it sits against receivables on the balance sheet, so the balance sheet shows what the company really expects to collect. Receivables of $90,000 with an allowance of $9,000 is a net $81,000.

## Write-Off and the Lien Sale

When a balance is finally judged uncollectible, usually after the lien sale, it is **written off**: removed from receivables against the allowance. No expense is recorded at write-off, because the expense was recorded when the allowance was built.

| Account | Debit | Credit |
|---|---|---|
| Allowance for Doubtful Accounts | the balance | |
| Tenant Receivables | | the balance |

The lien sale's proceeds go first against the balance (reducing what is written off), then against the lien costs. A recovery after write-off (a former tenant pays later) comes back in as a recovery, never as new rent.

> [!WARNING]
> Training only, not legal advice. The lien process itself is the law's, step by step (the Delinquency and the Lien Process lesson). Accounting records what the process produced; it never speeds the process up or decides when a unit is sold.

## The Numbers a Site Is Measured On

| Number | What it is | What moves it |
|---|---|---|
| **Delinquency rate** | Past-due balances as a share of rent billed, usually on the 10th | Autopay at move-in; calls on the 2nd and the 6th; complete move-in details |
| **Days sales outstanding** | How many days of billing the receivables represent | The same habits; how fast the lien process runs |
| **Over-90 balances** | The share of receivables that is probably lost | How quickly units in default are sold |
| **Bad debt as a share of revenue** | Allowance expense against revenue | All of the above, over the year |
| **Autopay share** | Tenants on autopay | Offered at every move-in |

A site with a high autopay share, calls on schedule and move-in details complete has a short aging report and a small allowance. A site that does not has a long one, and the difference is counted in bad debt expense every month.

## A Greens Scenario

Escondido's bad debt expense is up for the quarter. The manager opens the aging: the over-60 columns have grown, and the units in them are ones where the lien process stalled waiting on a notice. Accounting did not cause it and cannot fix it; the site can. The manager works the lien list with the desk, the units are sold on schedule, the balances are written off against the allowance that already expected them, and next quarter's aging is shorter.

## Common Mistakes

- **Treating receivables as money in the bank.** A receivable is a promise; the allowance says how good a promise.
- **Expecting a write-off to show up as an expense.** The expense was recorded when the allowance was built.
- **Calling a recovery new revenue.**
- **Blaming Accounting for bad debt.** The site's habits set it.

## Key Points

- A receivable is rent owed; the aging report sorts it by how long it has been unpaid, on the same timeline as the lien process.
- The allowance records the expected loss in the period of the revenue; the write-off later clears the balance against it, with no new expense.
- Lien sale proceeds reduce the balance written off; a later recovery is a recovery, not rent.
- Delinquency rate, aging, over-90 balances, bad debt share and autopay share are the site's receivables numbers, and the site's habits move them.
