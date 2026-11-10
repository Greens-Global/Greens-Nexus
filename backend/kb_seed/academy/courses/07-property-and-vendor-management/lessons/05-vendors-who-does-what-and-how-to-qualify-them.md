---
title: "Vendors: Who Does What and How to Qualify Them"
summary: The trades a storage and RV site depends on, the papers a vendor files before the first visit, the vendor's Compliance tab in Accounting, how a new vendor is requested in Nexus, and how that record differs from the property's own Vendors list.
teaches: Accounting, Asset Management
---

A roofer who "did the building next door" offers Valley Center a quick fix on a leaking seam, cash, today. He has a license; his insurance "lapsed over the summer." The price is good and the leak is real. By the end of this lesson you will know why the answer is no, and what a yes needs.

## Who Does What

A site employs the people who run it and buys every licensed trade.

| Trade | Owns |
|---|---|
| **Gate and access control** | Operator, keypads, loops, intercom, access software |
| **Overhead doors** | Springs, curtains, guides, latches, swing and hallway doors |
| **Roofing** | Roofs, gutters, downspouts, flashing |
| **Electrical** | Panels, breakers, lighting, photocells, the gate's power |
| **HVAC** | Climate buildings' heating and cooling |
| **Plumbing** | Fixtures, water heaters, backflow devices, sewer lines |
| **Paving, striping, grading** | Asphalt, sealcoat, striping, bollards, gravel and drainage |
| **Fire protection** | Extinguishers, sprinklers, alarm panels |
| **Elevator** | Everything about an elevator; nobody else touches one |
| **Towing, auctioneer** | Only through the lien process |

Cameras, fencing, signs, locks, landscaping, pest and waste each have their trade too. A general contractor or a handyman never replaces the trade that holds the license: a handyman changes a bulb; an electrician changes the photocell.

## The Papers Before the First Visit

If a vendor's worker is hurt or its truck hits a rig, the question is whose insurance pays. Without the papers, the answer can be Greens.

| Paper | Why the site needs it |
|---|---|
| **License** for the trade | Unlicensed work can be illegal, uninsurable and uninspectable |
| **Certificate of insurance (COI)** naming Greens as **additional insured** | When the vendor damages property or a tenant's goods, its policy pays, and Greens can claim on it directly |
| **Workers compensation** | Otherwise an injured worker on Greens' property can become Greens' claim |
| **W-9** | Accounting cannot pay a vendor it cannot report |

Add two references from sites like ours, and a written scope and price (see the lesson Getting the Work Done: From Ticket to Invoice).

## Two Vendor Lists, Two Jobs

| | Asset Management, Records > Vendors | Accounting > Records > Vendors |
|---|---|---|
| **What it is** | The property's own list of who services it | The Intacct vendor record Greens pays |
| **What it holds** | Category, company, contact, contract dates, COI Expiration, monthly cost | Details, Ledger Lines, Change History, Compliance |
| **Use it to** | Find who to call for this property | Check the papers, see what was paid |

The papers that decide whether a vendor may work are on the Accounting record's **Compliance** tab.

## The Compliance Tab

```figure
{
  "kind": "screen",
  "title": "A Vendor's Compliance Tab",
  "device": "computer",
  "module": "Accounting",
  "sub": "Vendors",
  "tabs": ["Details", "Ledger Lines", "Change History", "Compliance"],
  "tab": "Compliance",
  "parts": [
    { "kind": "text", "title": "Precision Gate Co.", "text": "Gate and access control" },
    { "kind": "card", "title": "Expiring Soon", "rows": [{ "label": "Insurance Certificate Expires", "value": "12/14/2026", "tone": "warn", "n": 1 }, { "label": "Workers Comp Expires", "value": "03/01/2027" }, { "label": "License Expires", "value": "06/30/2027" }, { "label": "W-9 On File", "value": "Yes" }], "n": 2 }
  ],
  "callouts": [
    { "n": 1, "text": "The certificate lapses most. Ask for the renewal before the date." },
    { "n": 2, "text": "One state for the vendor. Expired means no work on site." }
  ]
}
```

The tab gives the vendor one state:

| State | What you do |
|---|---|
| **Expiring Soon** | A paper expires within 30 days. Ask for the renewal now; the vendor may still work |
| **Expired** | A date has passed. No work on site until the new paper is filed, however small the job |
| **No Insurance On File** | No certificate was ever filed. Collect the papers before the first visit |

Managers are belled at 30, 7 and 0 days before each date. The same papers show on a Construction job's Subs tab: one set per vendor.

> [!WARNING]
> Never let a vendor start because "the certificate is in the mail." A certificate is a one-page PDF an insurer can send in an hour.

## Adding a New Vendor

1. **Ask first** whether an approved vendor already covers the trade. A vendor serving several Greens sites gives better response and rates.
2. **Collect the papers**: license, COI naming Greens as additional insured, workers comp, W-9, references.
3. **Send the papers to Accounting**, who create the Intacct vendor record and file the papers on its Compliance tab. A change to an existing vendor's details (a new address, new terms) is edited on the record in Nexus and becomes a request: **Pending Approval**, then **Approved - Awaiting Intacct** until Accounting keys it in, then **In Intacct**.
4. **Get the scope and price in writing**, and only then book the visit.

A vendor is never kept only in a spreadsheet or a phone contact. In an after-hours emergency with no approved vendor answering, call the manager above you: an unqualified vendor at night is worse than a closed gate for an hour. Your manager has the after-hours vendor list until it is filled in for each site.

## At Greens

With no certificate, the roofer is thanked and declined. The manager raises the ticket with photos and calls the approved roofer, whose papers are current; the fix costs more and is warrantied.

## Common Mistakes

- **Letting a vendor start without the certificate.**
- **Treating the property's Vendors list as approval.** The Compliance tab decides.
- **Calling a handyman for a licensed trade.**
- **Paying from the site.** Cash or a card at the site is never how a vendor is paid.
- **Ignoring Expiring Soon** until it is Expired on the morning of a visit.

## Key Points

- Call the trade that holds the license the work needs.
- Four papers before the first visit: license, COI naming Greens as additional insured, workers comp, W-9.
- Records > Vendors on the property is who services it; Accounting > Records > Vendors is who Greens pays, with the papers.
- Expired does no work on site; a new vendor exists in Intacct, with its papers filed, before its first visit.
