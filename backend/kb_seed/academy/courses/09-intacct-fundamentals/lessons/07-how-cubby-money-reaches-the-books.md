---
title: How Cubby Money Reaches the Books
summary: Where a tenant's payment goes after Cubby takes it - the payout batches to the bank, the Cubby reports in Operations that show them, the aged receivables, and the Import Hub file Accounting can build - and what belongs to the accounting team.
teaches: Operations, Accounting
---

A Fairfield manager reconciles her week: Cubby says $18,240 in card payments came in, but the bank shows three deposits that add to something else and arrived on different days. Nothing is missing. Card money travels in batches. Knowing how lets you answer the question yourself before it reaches Accounting.

## The Path of a Payment

A tenant pays rent in **Cubby**, at the counter, online or by autopay. Cubby is where the tenant's ledger lives: charges, payments, waivers, the balance. Intacct never sees a single tenant. What reaches the company's books is money arriving at the bank.

```figure
{
  "kind": "steps",
  "title": "From a Tenant to the Ledger",
  "items": [
    { "label": "Payment in Cubby", "note": "card, ACH, cash or check" },
    { "label": "Payout batch", "note": "card and ACH payments paid to the bank together" },
    { "label": "Bank deposit", "note": "one amount for the whole batch" },
    { "label": "Recorded in Intacct", "note": "by the accounting team" }
  ]
}
```

Card and ACH payments are not paid to the bank one by one. The payment processor gathers them and pays them out in **batches**, so one bank deposit can hold many tenants' payments from more than one day, and a batch can land a day or two after the payments in it.

## The Reports That Show It

Open **Operations > Reports**. Pick the facility and the period.

| Report | What it answers |
|---|---|
| **Merchant Services Disbursements** | Card and ACH payouts to the bank by batch, with the payments in each batch |
| **Receipts Summary** | Money received in the period by payment method, with failed and refunded payments counted |
| **Payment Detail** | Every payment: tenant, units, method, status, amount |
| **Aged Receivables** | Every lease that owes money, its balance split into 30, 60, 90 and 120-day buckets |
| **General Ledger (Cash)** and **General Ledger (Accrual)** | Cubby's own journal, line by line, cash or accrual |

**Merchant Services Disbursements** is the one that ties Cubby to the bank: each batch's total is the deposit you see on the bank line, and opening the batch lists the payments inside it. A failed or refunded payment shows on Receipts Summary, which is why the bank can be lower than the day's takings.

**Aged Receivables** is the property's accounts receivable aging. Most tenants owe Cubby, not Intacct, so this aging lives in Cubby's reports, not in Intacct.

## What Accounting Does With It

How each deposit is recorded in Intacct (which accounts, how cash and card are split, how a property's month is tied back to Cubby) is your Accounting team's process. Two things in Nexus help them:

- **Accounting > Tools > Import Hub > Bank Statement to Intacct** turns an uploaded bank or brokerage statement (CSV or Excel) into an Intacct import file: pick the columns, the cash account, the offset account and the entity, check the preview, and **Download Intacct Import**. The file is imported in Intacct by the accounting team; nothing posts from Nexus.
- **Reports > Ledger & Banking > Bank Activity** shows every transaction on one bank account for the period, with a running balance.

## At Greens

Back to Fairfield. The manager opens Merchant Services Disbursements for the week: three batches, each matching one bank deposit. Receipts Summary shows one refunded card payment of $65, which is the gap between Cubby's total and the bank. She sends Accounting nothing, because nothing is wrong.

## Common Mistakes

- **Matching one tenant's payment to one bank deposit.** Deposits are batches.
- **Asking Intacct for a tenant's balance.** The tenant's ledger is Cubby's.
- **Forgetting refunds and failed payments** when comparing takings to the bank.
- **Keying a deposit anywhere in Nexus.** Accounting records it in Intacct.

## Key Points

- Tenants pay in Cubby; card and ACH money reaches the bank in batches.
- Operations > Reports > Merchant Services Disbursements ties each batch to its deposit; Aged Receivables shows who owes and for how long.
- Import Hub builds an Intacct import file from a bank statement; the accounting team posts it.
- How deposits are booked in Intacct is your Accounting team's process.
