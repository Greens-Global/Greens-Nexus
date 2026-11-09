---
title: "Cubby How-To: Take a Payment"
summary: Taking card, cash and check payments, taking a card by phone safely, AutoPay, the failed AutoPay call on the 2nd, payment links, and what pending, declined, failed and disputed payments mean.
page_type: how_to
tags: cubby, cubby-how-to, payments, autopay
---

It is the 2nd at Fairfield, and the Tasks tab shows eight "2nd - Call Failed Autopay Tenants." The first tenant's card expired; he wants to read you the new one over the phone. Done right, he is paid in two minutes and his card number is written nowhere.

## Before You Start

- Check you are on the **right lease**. One tenant can have several.
- Look at the ledger: what is open and the paid-through date.
- Cash and checks go in the drawer and are counted at close against Cubby (Cubby How-To: Open and Close Reports).

## Payment Statuses

| Status | Meaning | What you do |
|---|---|---|
| **Succeeded** | The money is in | Nothing more |
| **Declined** | The card or bank said no; nothing posts | Ask for another card or method |
| **Pending** | Outcome unknown | **Do not run it again.** Check later; ask your manager if it stays pending |
| **Failed** | It did not go through, or a bank payment came back | A returned bank payment reopens the charges it paid: call the tenant |
| **Disputed** | The tenant's bank opened a chargeback | Tell your manager the same day |

## Steps: Take a Payment at the Counter

```figure
{"kind": "steps", "title": "Every Payment", "items": [{"label": "Right tenant, right lease", "note": "say the unit number out loud"}, {"label": "Read the balance", "note": "what it is made of"}, {"label": "Enter amount and method"}, {"label": "Wait for succeeded"}, {"label": "Check the ledger", "note": "balance as expected"}, {"label": "Receipt and gate code", "note": "if they were locked out"}]}
```

1. Find the tenant and open the lease.
2. Tell them the balance and what it is made of.
3. Start a payment on the lease and enter the amount. To stop the collection steps it must be the **full** balance; a partial payment needs the "Can take partial payments" permission.
4. Choose the method: **card** (run it and wait for succeeded), **cash** (enter the amount received, count change back, cash in the drawer) or **check** (enter it as a check, check in the drawer).
5. Confirm the payment shows on the ledger and the balance is what you expected. Offer a receipt.
6. If the tenant was locked out, make sure they leave with a working gate code and that any overlock comes off (Cubby How-To: Overlock and Lockout).

A payment pays the **oldest charge first**, rent before protection when they posted together; money paid when nothing is owed becomes prepaid. See Paid-Through Date and Days Past Due.

## Taking a Card by Phone

A card number is the tenant's money. Treat it that way every time.

1. **Enter it straight into Cubby** as the tenant reads it. Never write it on paper, a sticky note, a notepad app or a task, even "just for a second."
2. **Do not repeat it aloud** where anyone else can hear: other customers, a speakerphone, an open office door. Confirm only the last four digits.
3. **Never ask for a card by email or text**, and never accept one sent that way. If a tenant emails a card number, do not use it: tell them the email was deleted, delete it, and take the card by phone or send a payment link.
4. **Never put a card number, expiration date or security code in a note**, a screenshot or a message to a coworker.
5. If you cannot enter it right now, **call back** or send a payment link. Never take it down to enter later.

A card used for a payment is saved to the tenant's account. If they asked you not to keep it, remove it afterward from the **Payments** tab: **Payment methods**, then **Manage payment methods**, then **Remove**.

## Steps: AutoPay On, Off or a New Card

1. To turn it on, open the lease and choose **Rental actions**, then **Set up AutoPay**, with the saved card or bank account or a new one.
2. To change the card, add the new one under **Payment methods** (**Add a method**) and set it for AutoPay. Removing a card also turns off AutoPay on every rental that used it.
3. Check the card's **expiration date**; an expired card makes AutoPay fail.
4. Note it: "AutoPay moved to new card at tenant's request."

## Steps: The Failed AutoPay Call (the 2nd)

On the 2nd, a workflow makes "2nd - Call Failed Autopay Tenants" for every AutoPay declined on the 1st (with versions for mailbox and waste dump customers).

1. Open the task and the lease. Check the card's expiration and whether they paid overnight.
2. Call, kind and direct: "Your autopay for this month didn't go through, and I wanted to help you sort it before any late fee."
3. Offer the easy path: a new card now, a new AutoPay card, or a payment link.
4. Complete the task with a note: reached or not, what was promised, by when.

Still unpaid on the 6th, Cubby makes "6th - Call Past Due Tenants." The days after that are on Greens Delinquency Timeline.

## Steps: Send a Payment Link

A payment link lets the tenant pay from their phone; one link can cover **several leases** for the same tenant.

1. From the tenant's lease or contact, create a payment link and choose the leases it covers.
2. Check the phone or email on file is current, then send it by text or email.
3. Note that you sent it, and set a task to check tomorrow.

Tenants can also pay in the tenant portal.

## Common Mistakes

1. **Writing a card number down**, or reading it back in full.
2. **Running a pending payment again.**
3. **Paying the wrong lease.** Say the unit number out loud.
4. **Telling a tenant a partial payment stops the late fee.**

## Key Points

- A declined card posts nothing; a pending payment is never run twice.
- A card by phone goes straight into Cubby: never written, never repeated aloud, never by email or text.
- Payments pay the oldest charge first; only the full balance stops the steps.
- The 2nd's failed AutoPay call is the most valuable call you make.
