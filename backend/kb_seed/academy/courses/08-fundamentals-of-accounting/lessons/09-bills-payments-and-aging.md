---
title: Bills, Payments and Aging
summary: How a vendor invoice moves through Intacct from bill to approval to payment, what payment terms and the payables aging mean, how the same idea sorts what tenants owe, and where a manager sees each in Nexus.
teaches: Accounting
---

## "When Will I Get Paid?"

The landscaping vendor calls the site: "Our October invoice still hasn't been paid." You do not pay vendors, but you can find out where the bill is and what it is waiting on, and you can tell whether the vendor is early, on time or genuinely overdue.

## From Bill to Payment

In Intacct a vendor invoice is entered as a **bill** in Accounts Payable. It then moves through a few steps:

```figure
{
  "kind": "steps",
  "title": "A Bill in Intacct",
  "items": [
    { "label": "Entered", "note": "the bill is keyed against the vendor record, coded to account and entity" },
    { "label": "Matched", "note": "ordered, received, billed agree" },
    { "label": "Approved", "note": "by the level the amount needs" },
    { "label": "Paid", "note": "on a payment run, by check or bank transfer" },
    { "label": "Cleared", "note": "the payment shows on the bank statement" }
  ]
}
```

Entering the bill records the expense and the payable (the APJ journal in Nexus's Accounting > Records > Journals list is where those entries show). Paying it clears the payable against cash. Who approves at which amount, and when the payment runs happen, is your Accounting team's; ask them rather than promising a vendor a date.

## Payment Terms

Each vendor record carries **terms**: how long after the invoice date payment is due. "Net 30" means due 30 days after the invoice date. In Nexus, Accounting > Records > Vendors opens a vendor's record; its Details tab shows the terms under Billing, and its Ledger Lines tab shows the bills and payments posted against it.

So a $900 invoice dated 10/20 on Net 30 terms is due on 11/19. If the vendor calls on 11/10, it is not late yet. If they call on 12/05 and it is unpaid, find out what it is waiting on: usually a missing match.

## The Payables Aging

A **payables aging** (AP aging) lists what the company owes, by vendor, sorted by how far past due each bill is: current, then 1-30, 31-60, 61-90 and over 90 days past due. Accounting runs it in Intacct to plan the payment runs and to find bills that are stuck. A bill sitting in the older columns is almost always one of three things: no match (the ticket number is missing), a dispute (the work is not finished), or no approval.

## The Same Idea for Tenants

What tenants owe is aged the same way, but by how long it has been unpaid. That is **Aged Receivables** under Operations > Reports, with columns 0-30, 31-60, 61-90, 91-120 and 120+ Days, read from Cubby. Reading it, and why the books expect some of it never to arrive, is the lesson Receivables, Delinquency and Bad Debt.

| | Payables aging | Receivables aging |
|---|---|---|
| **Who owes** | Greens owes vendors | Tenants owe Greens |
| **Where** | Intacct, run by Accounting | Operations > Reports > Aged Receivables |
| **Old columns mean** | A bill stuck on a match, a dispute or an approval | A tenant moving through the lien process |
| **The site's part** | Answer match questions the same day | Calls, autopay, the delinquency steps on time |

## At Greens

The landscaping invoice was dated 10/06 on Net 30, so it was due 11/05; it is now 11/18. The manager opens the vendor in Records > Vendors and sees no payment on Ledger Lines. She emails Accounting with the ticket number for October's service. Accounting had the bill parked waiting for exactly that; it goes on the next run, and she tells the vendor it is moving without promising a date.

## Common Mistakes

- **Promising a vendor a payment date.** The payment runs are Accounting's.
- **Calling a bill late before its terms are up.**
- **Mixing up the two agings.** One is what Greens owes; the other is what tenants owe.

## Key Points

- A bill in Intacct is entered, matched, approved, paid and cleared; entering it records the expense and the payable.
- Terms say when a bill is due: Net 30 is 30 days from the invoice date. Records > Vendors shows a vendor's terms and ledger lines.
- The payables aging sorts what Greens owes by days past due; old bills usually lack a match, an approval or finished work.
- Aged Receivables, under Operations > Reports, sorts what tenants owe the same way.
