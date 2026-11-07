---
title: Payables, Cards and the Bank
summary: How a vendor invoice becomes a payable and then a payment, three-way matching, what the Ramp card does and does not change, why every bank and card account is reconciled every month, and the controls that keep cash safe.
---

## What You'll Be Able to Do

- Trace a vendor invoice from receipt to payment through accounts payable.
- Explain three-way matching and what the site must provide for it.
- Say what a company card charge is in the books and why the receipt still matters.
- Explain a bank reconciliation and the kinds of difference it finds.
- Name the cash controls and why no site ever pays a vendor.

## Accounts Payable

When a vendor's invoice arrives, Accounting records the expense (or the asset) and a liability to the vendor, **accounts payable**. The invoice then waits in payables until it is approved and paid, which is when the liability and the cash both go down. Payables is the company's running list of what it owes and when.

```figure
{
  "kind": "steps",
  "title": "An Invoice Through Payables",
  "items": [
    { "label": "Received", "note": "the invoice arrives, with the ticket or PO number on it" },
    { "label": "Matched", "note": "against the ticket or PO, the scope and the inspection" },
    { "label": "Coded", "note": "to the account, the entity, the department, the job" },
    { "label": "Approved", "note": "by the level the amount needs" },
    { "label": "Paid", "note": "on the payment run, by check, transfer or card" },
    { "label": "Reconciled", "note": "the payment clears the bank and matches" }
  ]
}
```

## Three-Way Matching

Before an invoice is paid, Accounting matches three things: **what was ordered** (the ticket, the scope, or a purchase order), **what was received** (the inspection, the finished-work photo, the receiving note for goods), and **what was billed** (the invoice). When the three agree, the invoice is paid. When they do not, it waits, and someone at the site is asked why.

| The site provides | So that Accounting can |
|---|---|
| The ticket or PO number on the invoice | Find what was ordered in one look |
| The scope on the ticket | Check that the work billed is the work approved |
| The approval, in writing, on the ticket | Confirm the amount was authorized |
| The finished-work photo and Resolved status | Confirm it was received |
| The same-day answer to a question | Keep the vendor paid on time |

The Getting the Work Done lesson in the Property & Vendor Management course taught the site's side of this; here is why it exists. An invoice that cannot be matched is not paid, and a vendor that is not paid on time stops answering the phone at 9:00 PM.

## Coding

Every payable is **coded**: the account it belongs to (repairs and maintenance, gate and access), and the Intacct dimensions that say where (the entity, which is the site; the department; for a construction job, the Project-Job). Coding is what makes a manager's cost-by-system report possible, and a miscoded invoice is a cost that shows up on the wrong site or in the wrong line. When a manager clicks a figure and finds another site's vendor in it, that is a coding error to report.

## Company Cards

Greens uses **Ramp** cards for purchases that do not go through payables: supplies, small parts, travel, software. A card charge is the same expense it would be on an invoice; what changes is the timing and the paperwork. The charge posts to the card account when it happens, the receipt and the coding are attached in Ramp (Nexus Accounting's Banking & Credit Cards section reads the card activity), and the card balance is paid as one liability.

What does not change: **the receipt is still the proof**, the charge is still coded to an account and a site, and a card is never how a vendor is paid for work (the Vendor Relationships lesson). A card charge with no receipt is an expense nobody can defend to an auditor, and a charge with no coding lands in a suspense account where it waits for someone to explain it.

## The Bank Reconciliation

Every month, every bank account and every card account is **reconciled**: the balance in the books is compared, item by item, with the bank's statement until every difference is explained.

```figure
{
  "kind": "compare",
  "title": "What a Reconciliation Finds",
  "columns": [
    { "name": "Timing", "note": "both sides right, different days", "facts": ["A check written, not yet cashed", "A deposit made 10/31, posted by the bank 11/01", "A card payment in transit"] },
    { "name": "Bank items the books missed", "note": "the bank did something", "facts": ["Bank fees and interest", "A returned tenant payment", "A merchant processing fee"] },
    { "name": "Errors", "note": "someone got it wrong", "facts": ["A deposit recorded twice", "A payment keyed as $640 instead of $460", "A charge nobody recognizes: a fraud flag"] }
  ]
}
```

The reconciliation is the control that catches a duplicated deposit, a missing one, a returned tenant payment that Cubby still shows as paid, and a card charge nobody made. It is finished when the adjusted book balance equals the adjusted bank balance, and the close (the next lesson) cannot finish without it.

## Cash Controls

Cash is where businesses are stolen from, so the controls around it are strict and the same everywhere:

| Control | What it means at Greens |
|---|---|
| **Segregation of duties** | The person who approves a payment is not the person who makes it; the person who reconciles the bank is neither |
| **No site pays a vendor** | Every vendor payment runs through payables from Accounting, against a matched invoice |
| **Deposits intact and daily** | What Cubby took in is what reaches the bank, every day, nothing netted against it |
| **Card receipts within days** | A charge with no receipt is followed up; a pattern is a conversation |
| **Refunds through the system** | A tenant refund is issued by the process in Cubby and Accounting, never from a drawer |
| **The reconciliation, monthly, by someone who did not handle the cash** | The independent check |

The site's part is simple: the deposit matches the day, receipts follow every card charge, refunds and waivers carry their reason, and nobody at the site ever pays a vendor or accepts a payment outside Cubby.

## A Greens Scenario

The Fairfield bank reconciliation shows a $185 difference. The bank statement has a returned card payment: a tenant's rent that Cubby recorded as paid bounced a week later. Accounting records the reversal, the tenant's balance reopens in Cubby, and the site's desk calls the tenant. The reconciliation also turns up a card charge at a gas station none of the site staff recognize; the card is locked the same hour and the charge disputed. Two findings, one monthly control.

## Common Mistakes

- **An invoice with no ticket number.** It cannot be matched, so it is not paid.
- **Paying a vendor on a card** because it is faster.
- **A card charge with no receipt** or no coding.
- **Netting cash**: paying a small expense out of the day's deposit.
- **Skipping the reconciliation** in a busy month. That is the month it mattered.

## Key Points

- A vendor invoice is an expense and a payable when received, matched three ways, coded, approved, paid and reconciled.
- Coding (account plus entity, department, job) is what makes a site's reports true; a miscoded invoice is a cost on the wrong site.
- A Ramp card charge is the same expense with the receipt attached in Ramp; a card never pays a vendor for work.
- Every bank and card account is reconciled monthly; it finds timing differences, bank items and errors.
- Cash controls: segregated duties, no payments from the site, deposits intact and daily, receipts, refunds through the system.
