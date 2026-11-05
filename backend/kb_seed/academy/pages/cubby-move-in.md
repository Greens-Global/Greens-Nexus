---
title: Cubby How-To: Move-In
summary: The move-in from start to finish - pick the unit, preview the move-in charges, choose coverage, take the payment, turn on autopay, get every document done, and set the gate code and lock.
page_type: how_to
tags: cubby, cubby-how-to, move-in, leases
---

## What You'll Be Able to Do

- Run a move-in in Cubby from a lead, a reservation or a walk-in.
- Read the move-in charges preview and explain each line to the customer.
- Set coverage correctly: a Greens plan, the tenant's own policy, or none.
- Take the move-in payment and turn on autopay.
- Finish every document before the tenant leaves: the lease, ID, vehicle details and proof of insurance.
- Assign the gate code and the lock.

## Before You Start

- In Cubby's developer documents a move-in is called a **checkout**. The screen may say Move-In, Rent or Checkout. The button name in Greens' Cubby is on the screenshot.
- Have the customer's **photo ID**. For a vehicle, boat or trailer: the **registration** and **proof of insurance**, and the vehicle's length hitch to bumper.
- Know the charges: the **Administration Fee is $25.00** on a storage or parking lease and the **Mailbox Administration Fee is $10.00** on a mailbox. New move-ins pay **no deposit** (From Greens' Cubby, 11/2026). Other fees are on Greens Fees and Charges.
- Greens bills on the 1st with **jump day 26**: a move-in on or after the 26th pays the rest of this month plus all of next month (From Greens' Cubby, 11/2026). The worked numbers are in the Ledger Worked Examples lesson.

> [!WARNING]
> The order matters. Cubby creates the lease and then charges the payment. **If the payment is declined, Cubby undoes the lease, but the lead stays.** Never hand over a gate code or a lock until the payment has gone through.

## Steps: Choose the Unit

1. Start from the lead or reservation if there is one, so the lead converts. For a walk-in, create the contact first.
2. Pick the unit type (pricing group), then the exact unit. Check on the site map that it is vacant and rentable.
3. For a parking space, check the fit: vehicle length plus a margin, and for covered or enclosed spaces the height.
4. Confirm the move-in date (today, unless it is a future reservation).

> [!NOTE]
> **Pending:** screenshot of choosing the unit in the move-in from Greens' Cubby. Owner: Operations Manager.

## Steps: Preview the Move-In Charges

Cubby works out what is due before you take any money. Its documents call this **Preview Charges** (also Get Move-In Charges).

The lines you can expect:

- Prorated rent from today to the end of the month.
- On or after the 26th, the whole next month as well.
- The $25.00 Administration Fee (or $10.00 on a mailbox).
- The protection plan premium, if they take a Greens plan.
- Any merchandise, such as a lock, and its tax.
- Any discount, as its own line.

1. Open the move-in charges preview.
2. Read each line to the customer.
3. Check the total against what you quoted. If something looks wrong, stop and ask before you charge.

> [!NOTE]
> **Pending:** screenshot of the move-in charges preview from Greens' Cubby. Owner: Operations Manager.

## Steps: Coverage

Every lease has one of three coverage types in Cubby:

| Coverage type | What it means | What you enter |
|---|---|---|
| **Greens plan** (Cubby: Organisation) | The tenant buys Greens' protection plan | The coverage level and monthly premium |
| **Own policy** (Cubby: Private Policy) | The tenant has their own insurance | The policy number and expiration date, and a copy (proof of insurance) |
| **None** | Waived | Only if Greens allows it for this lease |

Greens' plans in Cubby are $2,500 of protection at $9.00 or $14.00 a month and $5,000 at $20.00 or $25.00 a month (From Greens' Cubby, 11/2026). Vehicle tenants carry their own policy: only one vehicle lease is on a Greens plan. What each plan covers and excludes is on Greens Tenant Protection.

1. Ask: "Do you have insurance that covers stored property, or would you like Greens' protection plan?"
2. Choose the coverage type and enter what the table says.
3. For an own policy, check the expiration date is in the future. Cubby raises "Remind Tenant of POI Obligation" tasks when proof of insurance is missing or expires, and "Enroll Tenant in Protection Plan" tasks.

> [!NOTE]
> **Pending:** screenshot of the coverage step from Greens' Cubby. Owner: Operations Manager.

## Steps: Discount

1. If the customer qualifies for a discount program your site offers, add it now.
2. Check that the discount shows as its own line in the move-in charges preview.

## Steps: Take the Payment

1. Choose the payment method: card, bank account (ACH), cash, check, or a card taken outside Cubby's card reader (offline card).
2. The payment must equal the move-in total.
3. Take the payment. Wait until Cubby shows it **succeeded**.
4. If it is **declined**, the lease is undone and nothing posts. Ask for another card or method and run the move-in again.
5. If it shows **pending**, do not run it again. A pending payment has an unknown outcome and running it again can charge the customer twice. Ask your manager.

> [!NOTE]
> **Pending:** screenshot of the payment step from Greens' Cubby. Owner: Operations Manager.

## Steps: Turn On Autopay

1. Offer autopay to every tenant: "Would you like rent to come off this card automatically on the 1st?" About 74% of Greens' active leases are on autopay (From Greens' Cubby, 11/2026).
2. Turn it on in the move-in. Cubby saves the card only after the charge succeeds.

## Steps: Documents

Every lease has required documents, each with a status:

| Document | What you do |
|---|---|
| **Lease agreement** | The tenant signs it electronically. Check it shows Approved, not Signature Needed |
| **Identity** | Check the photo ID matches the person and record it |
| **Vehicle** | For a parking lease: plate, state, and the vehicle type (Trailer, RV, Boat, Truck, SUV, Sedan, Other) |
| **Coverage** | Proof of insurance for an own policy |

1. Send the lease for signing and have the tenant sign before they leave.
2. Approve each document you checked.
3. Fill the vehicle type. It is blank on 696 of Greens' 759 vehicle leases today (From Greens' Cubby, 11/2026), which makes it hard to know what is on the lot.

> [!NOTE]
> **Pending:** screenshot of the documents on a new lease from Greens' Cubby. Owner: Operations Manager.

## Steps: Gate Code, Lock and Notes

1. Set the tenant's **gate access code** and check it is enabled. See Cubby How-To: Gate Code.
2. If the tenant buys or receives a lock, attach it to the lease so it moves to tenant use.
3. Add a note with anything the next person should know: "Stores a 34 ft fifth wheel, backs in, spotter needed."
4. Walk the tenant to the unit or space. Show them the gate, the hours and the rules.

## Example

**Escondido, 11/18/2026.** A customer rents a 10x10 at a made-up $150.00 with the $2,500 plan at $9.00. The move-in charges preview shows prorated rent for 13 days, $65.00; protection $3.90; Administration Fee $25.00; total $93.90 (check against the real preview). She pays by card; it succeeds. You turn on autopay and tell her $159.00 comes off on the 1st. She signs the lease on the tablet, you check her ID and approve it, set her gate code, attach the lock she bought, and add a note. Nothing on the lease shows Incomplete.

## Common Mistakes

1. **Giving the gate code before the payment succeeds.** A declined payment undoes the lease.
2. **Re-running a pending payment.** It can charge twice.
3. **Skipping the preview** and quoting from memory.
4. **Leaving documents incomplete**, especially the signature and the vehicle type.
5. **Choosing None for coverage** without permission.
6. **Not offering autopay.**

## Key Points

- Preview the move-in charges and read each line to the customer.
- The Administration Fee is $25.00 ($10.00 on a mailbox); no deposit on new move-ins (From Greens' Cubby, 11/2026).
- If the payment is declined, Cubby undoes the lease and keeps the lead.
- Coverage is a Greens plan, the tenant's own policy (with number and expiration), or none.
- Nothing leaves the counter incomplete: signed lease, ID, vehicle details, proof of insurance, gate code.
