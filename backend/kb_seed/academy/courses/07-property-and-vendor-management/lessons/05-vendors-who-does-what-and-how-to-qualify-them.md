---
title: "Vendors: Who Does What and How to Qualify Them"
summary: The trades a storage and RV site depends on, what each one is for, how a vendor is qualified before it sets foot on the site - license, insurance certificate, workers comp, W-9, references - and where that paperwork lives in Nexus.
---

## What You'll Be Able to Do

- Name the trades a site uses and say which problem goes to which one.
- Explain each piece of vendor paperwork and why the site cannot do without it.
- Read a vendor's Compliance tab and act on Expiring Soon, Expired and No Insurance On File.
- Tell a qualified vendor from a handyman with a truck, and why the difference is the company's risk.
- Find and add vendors the way Greens does: in Accounting, never in a side list.

## Who Does What

A storage site cannot employ every trade it needs. It employs people who run the site, and it buys the rest. Knowing which trade owns which problem saves a day on every ticket.

| Trade | Owns | Call them for |
|---|---|---|
| **Gate and access control** | The operator, keypads, loops, intercom, the access software | Anything the gate does wrong; a new code system; a camera at the gate |
| **Overhead and roll-up doors** | Springs, curtains, guides, latches, bottom bars; also swing doors and hallway doors | Any door problem; the lubrication schedule |
| **Roofing** | Metal and membrane roofs, gutters, downspouts, flashing | Leaks, storm damage, the roof walk |
| **Electrical** | Panels, breakers, lighting, photocells, outlets, the gate's power | Dark rows, tripping breakers, a new light pole |
| **HVAC** | The climate buildings' heating and cooling, filters, condensate | Temperature drift, water under a unit, the spring and fall service |
| **Plumbing** | Office fixtures, water heaters, backflow devices, sewer lines | Leaks, backups, the backflow test |
| **Paving and striping** | Asphalt, sealcoat, crack seal, striping, wheel stops, bollards | The asphalt cycle; a bent bollard |
| **Grading and gravel** | Gravel lots, drainage swales, culverts | Ruts, pooling, fresh gravel |
| **Fencing** | Chain-link, slats, block repair, gate hardware | A cut fence, a sagging gate, a new run |
| **Fire protection** | Extinguishers, sprinklers, alarm panels, backflow for fire lines | Tags, tests, panel trouble, the fire inspector's list |
| **Security and cameras** | Cameras, recorders, monitors, cabling | Dead cameras, more coverage, footage retrieval |
| **Landscaping** | Grounds, trees, weeds, irrigation | The schedule; sight lines to the gate |
| **Pest control** | Bait stations, treatments, the log | The contract; a tenant's rodent complaint |
| **Janitorial and pressure washing** | Office, restrooms, hallways, drive aisles | The schedule; a move-out clean of a building |
| **Elevator** | The cars, doors, phones, the inspection certificate | Everything about an elevator; nobody else touches one |
| **Signage** | Gate signs, unit numbers, clear height signs, wayfinding | Faded or missing signs; a re-measure |
| **Locksmith** | Cylinder cores, the control key, office locks | A core change the office cannot do; a lost control key |
| **Towing** | Abandoned and lien vehicles | Only through the lien process (the Vehicle and Boat Liens lesson in RV & Boat Storage) |
| **Auctioneer and lien services** | Lien sales, the notices | Only through the lien process |
| **Waste** | Dumpsters, bulk pickups after a lien sale or a clean-out | The schedule; a bulk pickup |

A general contractor coordinates several trades on one job; a handyman does small work across several. Both have a place. Neither replaces the trade that holds the license the work needs.

## Why the Paperwork Is Not Paperwork

A vendor on the site is working on Greens' property, near Greens' tenants and their belongings, often with the gate open. If the vendor's worker is hurt, if the vendor's truck hits a rig, if the vendor's torch starts a fire, the question is whose insurance pays. Without the right papers on file, the answer can be Greens.

```figure
{
  "kind": "compare",
  "title": "A Qualified Vendor and a Truck With a Name on It",
  "columns": [
    { "name": "Qualified", "note": "papers on file before the first visit", "facts": ["A current license for the trade", "A certificate of insurance naming Greens as additional insured", "Workers compensation for its crew", "A W-9 and a vendor record in Accounting", "References from sites like ours", "A scope and a price in writing"] },
    { "name": "Not qualified", "note": "a good price and a promise", "facts": ["No license, or someone else's", "No certificate, or one that expired in the spring", "Workers who are nobody's employees", "Paid in cash or on a card at the site", "A text message for a scope", "Greens' insurance pays when it goes wrong"] }
  ]
}
```

| Paper | What it is | Why the site needs it |
|---|---|---|
| **License** | The state contractor's license for the trade (electrical, plumbing, roofing and so on), with its number and expiry | Unlicensed work can be illegal, uninsurable and uninspectable; the license is what makes the work the vendor's responsibility |
| **Certificate of insurance (COI)** | A one-page certificate from the vendor's insurer showing general liability coverage, its limits and its expiry, naming Greens as an **additional insured** | When the vendor damages the property or a tenant's goods, the vendor's policy pays. Additional insured status is what lets Greens claim on it directly |
| **Workers compensation** | Coverage for the vendor's own crew if they are hurt on the job | Without it, an injured worker on Greens' property can become Greens' claim |
| **W-9** | The vendor's tax identification form | Accounting cannot pay a vendor it cannot report; no W-9, no check |
| **References** | Two or three sites like ours that the vendor has served | A gate vendor who has never seen a 60 ft rig at a keypad learns on your gate |
| **A written scope and price** | What they will do, for what, by when | A text message is not a scope (the next lesson) |

## Where the Paperwork Lives

```figure
{
  "kind": "screen",
  "title": "A Vendor's Compliance Tab",
  "device": "computer",
  "module": "Accounting",
  "sub": "Vendors & Customers",
  "tabs": ["Record", "Transactions", "Compliance"],
  "tab": "Compliance",
  "parts": [
    { "kind": "text", "title": "Precision Gate Co.", "text": "Vendor V-00418 · Temecula, CA · gate and access control" },
    { "kind": "card", "title": "Papers", "rows": [{ "label": "Insurance Certificate Expires", "value": "12/14/2026", "tone": "warn", "n": 1 }, { "label": "Workers Comp Expires", "value": "03/01/2027", "tone": "ok" }, { "label": "License Expires", "value": "C-61 · 06/30/2027", "tone": "ok" }, { "label": "W-9 On File", "value": "Yes", "tone": "ok" }], "note": "State: Expiring Soon. The managers are belled at 30, 7 and 0 days before each date.", "n": 2 },
    { "kind": "list", "title": "On These Jobs", "items": [{ "label": "Temecula · gate operator service (preventive)", "note": "ticket #4790", "badge": "Overdue", "tone": "bad" }, { "label": "Fairfield · keypad replacement", "note": "ticket #4612 · closed 10/22/2026", "badge": "Closed" }] }
  ],
  "callouts": [
    { "n": 1, "text": "The insurance certificate is the paper that lapses most. Ask for the renewal before the date, not after." },
    { "n": 2, "text": "One state for the vendor: Expiring Soon, Expired or No Insurance On File. An Expired vendor does not come on site until the new certificate is filed." }
  ]
}
```

A vendor is an **Intacct vendor record**, reached in Nexus through **Accounting**, **Vendors & Customers**. Its **Compliance** tab holds the four papers: the insurance certificate's expiry, the workers comp expiry, the license number and expiry, and whether a W-9 is on file. The same tab is what a Construction job's Subs tab shows for its subcontractors; there is one set of papers per vendor, wherever you look at it.

The state words are the rule:

| State | Meaning | What you do |
|---|---|---|
| **Expiring Soon** | A paper expires within 30 days | Ask the vendor for the renewal now; file it when it comes |
| **Expired** | A paper's date has passed | The vendor does no work on site until the new paper is filed, however small the job |
| **No Insurance On File** | No certificate was ever filed | The vendor is not yet a vendor; collect the papers before the first visit |

The managers are belled at 30, 7 and 0 days before each paper's date, once per paper and date. The bell is a reminder; the file is the record.

> [!WARNING]
> Never let a vendor start because "the certificate is in the mail." A certificate is a one-page PDF the vendor's insurer can send in an hour. If it cannot, that tells you something.

## Finding and Adding a Vendor

Greens' approved vendors are already in Accounting with their papers. For a new one:

1. **Ask first** whether an approved vendor covers the trade. The sites share vendors where distance allows, and a vendor that serves three Greens sites gives better response and better rates (the Vendor Relationships lesson).
2. **Collect the papers** before the first visit: the license, the certificate naming Greens as additional insured, workers comp, the W-9, two references.
3. **Ask Accounting to create the vendor record** and file the papers on its Compliance tab. A vendor is never kept in a spreadsheet, a notes file or a phone contact only.
4. **Get the scope and the price in writing** (the next lesson), and only then book the visit.

> [!NOTE]
> Emergency at 9:00 PM and the approved gate vendor does not answer? Call the manager above you. An unqualified vendor at night is a worse problem than a closed gate for an hour. **Pending:** the after-hours vendor list for each site and who holds it (Operations Manager to fill in).

## A Greens Scenario

A roofer who "did the building next door" offers Valley Center's manager a quick fix on a leaking seam for a very good price, cash. The manager asks for a license number, a certificate of insurance naming Greens, and workers comp. The roofer has a license but no certificate; his insurance "lapsed over the summer." The manager thanks him, calls the approved roofing vendor, and raises the ticket with the photos of the stain. The approved roofer comes in two days, at a higher price, with a certificate on file, and the fix is warrantied.

## Common Mistakes

- **Letting a vendor start without the certificate.** "It's in the mail" is a no.
- **A vendor in a spreadsheet or a phone contact only.** If it is not in Accounting, it is not a vendor.
- **Calling a handyman for a licensed trade.** A handyman changes a light bulb; an electrician changes the photocell.
- **Paying from the site.** Cash or a card at the site is never how a vendor is paid.
- **Ignoring Expiring Soon** until it is Expired on the day of a visit.

## Key Points

- Twenty trades, each owning its system; call the one that holds the license.
- Four papers before the first visit: license, certificate of insurance naming Greens as additional insured, workers comp, W-9; plus references and a written scope.
- Vendors are Intacct records in Accounting, Vendors & Customers; the Compliance tab holds the papers; Expiring Soon, Expired and No Insurance On File are the one rule.
- An Expired vendor does no work on site; a new vendor's papers are collected before the first visit.
- Never a side list, never cash at the site.
