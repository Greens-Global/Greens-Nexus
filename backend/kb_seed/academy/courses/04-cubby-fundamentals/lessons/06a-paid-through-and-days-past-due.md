---
title: Paid-Through Date and Days Past Due
summary: How Cubby applies a payment oldest charge first, how the paid-through date moves, how to count days past due, where the late fee shows up in Cubby, and how aging buckets work.
---

A Temecula tenant pays $100 toward a $134 bill on the 3rd and asks, "So I'm good now, right?" She is not, and on the 11th a late fee will tell her so. Knowing which charge her $100 paid, and what her paid-through date says, lets you warn her today instead of apologizing next week.

## Oldest Charge First

When several charges are open, Cubby pays the **oldest charge first**: October's rent before November's, last month's late fee before this month's rent. Charges that posted at the same moment (rent and protection on the 1st) are paid in a fixed order: prepaid, deposit, rent, state tax, local tax, then insurance. So **rent is paid before protection**.

A tenant who owes $129 rent and $14 protection and pays $100 has paid $100 of rent; $29 of rent and all $14 of protection are still open.

> [!WARNING]
> A partial payment does not stop the delinquency steps. A tenant who pays "most of it" still gets the next fee or notice. Tell them the full amount that stops the process.

## The Paid-Through Date

The **paid-through date** is the last day the lease is paid up to, and the most useful date on a lease.

- A current tenant at a Greens site is paid through the **last day of this month**.
- Paying a whole month's charges moves it to the end of that month.
- A partial payment does not move it past a month that is not fully paid.
- Prepaid money moves it one month at a time, only as each month's charges post and are paid.

The tenant is **late from** the day after the paid-through date.

## Days Past Due

Cubby counts lateness from the paid-through date, with one day of grace:

**Days past due = today minus the paid-through date, minus 1.**

| Paid-through | Today | Days past due |
|---|---|---|
| 10/31 | 11/01 | 0 (rent is due today) |
| 10/31 | 11/06 | 5 |
| 10/31 | 11/11 | 10 |
| 10/31 | 11/15 | 14 |
| 09/30 | 11/04 | 34 |

## Where the Late Fee Shows Up

Greens' late fee posts by itself at 12:00 AM on the 11th, after 10 full days unpaid. On the ledger it is a fee charge named **CA Late Fee** ("Mailbox Late Fee" and "Commercial Late Fee" on those leases). On the 15th the **CA Preliminary Lien Notice** fee posts the same way. You never type either by hand.

How the amount is worked out for a given rent is taught in How a Storage Site Makes Money; the full ladder of days and what the law requires at each step is in Delinquency and the Lien Process and on Greens Delinquency Timeline. Here you only need to recognize the lines and read them back to the tenant.

## Aging

**Aging** sorts what a tenant owes by how old each charge is. Cubby's **Aged Receivables** report puts each open charge in a bucket: 0-30, 30-60, 60-90, 90-120 and over 120 days. One tenant can sit in two buckets at once: an October rent in 30-60 and a November rent in 0-30.

The collections view looks at the whole lease instead, by days past due. The per-charge view tells accounting how old the money is; the per-lease view tells you whom to call first.

## Reading a Ledger, Line by Line

A made-up Valley Center lease, rent $129, protection $14:

| Date | Line | Charge | Paid or waived | Balance |
|---|---|---|---|---|
| 12/01 | Rent | $129.00 | | $129.00 |
| 12/01 | Protection | $14.00 | | $143.00 |
| 12/01 | Autopay declined | | (nothing posts) | $143.00 |
| 12/04 | Card payment | | $100.00 | $43.00 |
| 12/11 | CA Late Fee | $20.00 | | $63.00 |
| 12/12 | Waive of the late fee, reason "first late payment" | | $20.00 | $43.00 |
| 12/12 | Card payment | | $43.00 | $0.00 |

- On 12/04 the $100 paid rent first, leaving $29 rent and $14 protection open; paid-through stayed 11/30.
- The tenant was still unpaid on the 11th, so the fee posted.
- On 12/12 the fee was waived with a reason and the last $43 paid. Paid-through is now 12/31.

## Common Mistakes

1. **Saying "you're paid up" after a partial payment.** Check what is still open.
2. **Telling a prepaid tenant they are behind** because the paid-through date has not moved yet.
3. **Counting days past due from the 1st without the grace day.**
4. **Typing a late fee by hand.** Cubby posts it.

## Key Points

- Payments go to the oldest charge first; posted together, rent is paid before protection.
- The paid-through date moves only when a whole month is paid.
- Days past due = today minus the paid-through date, minus 1.
- CA Late Fee posts on the 11th and CA Preliminary Lien Notice on the 15th, by themselves.
- Aged Receivables sorts each charge by age; one tenant can be in two buckets.
