---
title: Lien Waivers
summary: Why a vendor's lien waiver protects the property, the four kinds (conditional and unconditional, progress and final), where waivers are kept on a Construction job's commitments, and why Nexus never writes the wording.
teaches: Construction
---

The steel sub on the Temecula canopy job sends its second invoice, $44,000, with a signed form attached titled "Conditional Waiver and Release on Progress Payment." Accounting asks you whether the waiver is on file before they pay. Here is what that form is, why it matters, and where it goes.

## Why Waivers Exist

A contractor or supplier who improves a property and is not paid can, in most states, put a **mechanics lien** on the property: a claim against the property itself, not just against whoever hired them. A lien can follow the property into a sale or refinance. It can even come from a sub-supplier Greens never hired, if the contractor above them did not pay.

A **lien waiver** is the vendor's signed statement giving up its lien rights for the payment it names. Collected with every payment, waivers are how an owner proves that each dollar paid actually cleared the vendor's right to a lien.

## The Four Kinds

| Kind | When you get it | What it waives |
|---|---|---|
| **Conditional Progress** | With the invoice, before payment | The lien for this payment, but only once the payment clears |
| **Unconditional Progress** | After the payment cleared | The lien for this payment, with no condition left |
| **Conditional Final** | With the last invoice | All lien rights on the job, once the final payment clears |
| **Unconditional Final** | After the final payment cleared | All lien rights on the job, no condition left |

The rhythm: **conditional with the invoice, unconditional once paid.** A conditional waiver protects the vendor if the check bounces; the unconditional one is what protects the property. A job is not closed out until the Unconditional Final for every commitment is on file.

## Where Waivers Are Kept

On a Construction job, open the **Money** tab, then the commitment in **Commitments** (see the lesson The Construction Money Tab). The commitment's sheet has a **Lien Waivers** section, newest first, and **Add a Waiver**:

```figure
{
  "kind": "screen",
  "title": "A Commitment's Lien Waivers",
  "device": "computer",
  "module": "Construction",
  "sub": "Canopy Row C Rebuild",
  "parts": [
    { "kind": "sheet", "title": "SC-002 · Summit Steel", "fields": [
      { "label": "Waiver Kind", "kind": "select", "value": "Conditional Progress" },
      { "label": "Through", "value": "10/31/2026" },
      { "label": "Waiver Amount", "value": "44,000.00" },
      { "label": "Signed waiver", "value": "summit-cp-oct.pdf", "n": 1 }
    ], "buttons": [{ "label": "Add Waiver", "primary": true }] }
  ],
  "callouts": [
    { "n": 1, "text": "The vendor's own signed form, attached as received. Nexus never writes the wording." }
  ]
}
```

Each waiver records its **kind**, the day it runs **through**, the **amount**, the day it was received, and the **signed copy** (a PDF or a photo of the page, or paste it with Ctrl+V). The latest waiver shows in the Commitments table's **Lien Waiver** column, so a missing one is visible at a glance. A waiver removed by mistake stays on the record as removed.

## Why Nexus Never Writes the Wording

Several states, California and Texas among them, require their own **statutory** waiver forms, word for word. A home-made waiver can be worthless. So the vendor supplies its own signed form, and Nexus only stores it. Never draft a waiver for a vendor, never edit one, and never accept one with the amount or the date blank.

## Checking a Waiver

Before you add a waiver, read it against the commitment:

- **The vendor's name** matches the commitment's vendor.
- **The amount** matches the invoice it goes with (conditional) or the payment that cleared (unconditional).
- **The through date** covers the work billed.
- **The property or job** is named correctly.
- **It is signed.**

Anything wrong goes back to the vendor before Accounting pays. A question about whether a waiver is enough for a payment goes to your Accounting team.

## At Greens

The Temecula manager opens SC-002 on the Money tab, checks the steel sub's Conditional Progress waiver (right vendor, $44,000, through 10/31/2026, signed), and adds it with the signed PDF. Accounting pays. Two weeks later the sub sends the Unconditional Progress for the same $44,000, and she adds that too. At close-out, the Lien Waiver column shows Unconditional Final on both commitments before the job is closed.

## Common Mistakes

- **Paying with no conditional waiver** on file.
- **Never collecting the unconditional** once the payment cleared.
- **Writing or editing the waiver** instead of attaching the vendor's own form.
- **Closing a job** before every commitment has its Unconditional Final.

## Key Points

- An unpaid vendor or supplier can lien the property; waivers prove each payment cleared that right.
- Four kinds: Conditional and Unconditional, Progress and Final. Conditional with the invoice, unconditional once paid.
- Waivers live on the commitment, under the job's Money tab, with the signed copy attached.
- Nexus never writes waiver wording; the vendor's own signed form is the record.
