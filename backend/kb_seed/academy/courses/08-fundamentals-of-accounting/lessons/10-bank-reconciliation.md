---
title: Bank Reconciliation
summary: What a bank reconciliation is, the three kinds of difference it finds, why every bank and card account is reconciled every month, and where Nexus shows which accounts are done.
teaches: Accounting
---

## $185 That Does Not Agree

The Fairfield bank account says one thing and the books say $185 more. Nobody stole anything: a tenant's card payment that Cubby recorded as paid was returned by the bank a week later. The monthly reconciliation is what found it, and now the desk has a call to make.

## What a Reconciliation Is

A **bank reconciliation** compares the balance in the books with the bank's statement for the same day, item by item, until every difference is explained. Every bank account and every card account is reconciled every month, and so are the loan and credit line balances against the lender's statement. The month cannot close until they are done.

It finishes when the **adjusted book balance** (the books plus anything the bank did that the books missed) equals the **adjusted bank balance** (the statement plus anything the books did that the bank has not posted yet).

## Three Kinds of Difference

```figure
{
  "kind": "compare",
  "title": "What a Reconciliation Finds",
  "columns": [
    { "name": "Timing", "note": "both sides right, different days", "facts": ["A check written, not yet cashed", "A deposit made 10/31, posted by the bank 11/01", "A card payout in transit"] },
    { "name": "Bank items the books missed", "note": "the bank did something", "facts": ["Bank fees and interest", "A returned tenant payment", "A merchant processing fee"] },
    { "name": "Errors", "note": "someone got it wrong", "facts": ["A deposit recorded twice", "$640 keyed as $460", "A charge nobody recognizes"] }
  ]
}
```

Timing items clear themselves next month: the check is cashed, the deposit posts. Bank items need an entry in the books (the fee, the returned payment). Errors need a correction, and a charge nobody recognizes needs a call the same day, because it may be fraud.

## A Worked Example

At month end the books show $48,200 in the operating account; the bank statement shows $47,915.

| | Amount |
|---|---|
| Bank statement balance | $47,915 |
| Plus: deposit made 10/31, posted by the bank 11/01 | +$1,120 |
| Less: check to a vendor, not yet cashed | -$1,020 |
| **Adjusted bank balance** | **$48,015** |
| Book balance | $48,200 |
| Less: tenant card payment returned by the bank | -$185 |
| **Adjusted book balance** | **$48,015** |

The two agree. The returned $185 is recorded in the books, the tenant's balance reopens in Cubby, and the desk calls the tenant.

## Why It Is Monthly, and Independent

The reconciliation is the control that catches a duplicated deposit, a missing one, a returned payment Cubby still shows as paid, and a card charge nobody made. It works only if it is done every month (a difference is easy to explain at 30 days and hard at 180) and by someone who did not handle the cash, so nobody checks their own work.

## Where You See It in Nexus

The reconciling itself is Accounting's work, done against Intacct. Nexus shows where it stands. On Accounting > Dashboard > Close, the **Account Reconciliations** card lists every bank, credit card, loan, credit line and brokerage account with its status, and the **Month-End Close** card shows the close checklist. Clicking an account opens its Bank Activity or Credit Card Activity report: every transaction in the period with a running balance. The screens are walked through in Intacct Fundamentals at Greens.

The site's part is small but real: deposits intact, a returned payment worked the day you hear of it, and a same-day answer when Accounting asks what a deposit or a charge was.

## At Greens

The same Fairfield reconciliation also shows a card charge at a gas station none of the site staff recognize. Accounting asks the cardholder within the hour; nobody made it. The card is locked and the charge disputed. Two findings, one monthly control.

## Common Mistakes

- **Treating a returned payment as Accounting's problem.** The tenant's balance is the site's to work.
- **Skipping the reconciliation in a busy month.** That is the month it mattered.
- **Letting the person who handles the cash reconcile it.**

## Key Points

- A reconciliation explains every difference between the books and the bank until the adjusted balances agree.
- Differences are timing, bank items the books missed, or errors; an unknown charge is a same-day call.
- Every bank, card and loan account is reconciled monthly, by someone independent of the cash.
- Nexus shows status on Accounting > Dashboard > Close (Account Reconciliations); the reconciling is Accounting's.
