---
title: "Getting the Work Done: From Ticket to Invoice"
summary: The one path a repair takes at Greens - the ticket, the scope, the quotes, the approval, the vendor on site, the inspection and the photo, the closed ticket and the invoice matched to it - with the rules for a vendor on the property and the emergency path.
---

## What You'll Be Able to Do

- Run a repair from the ticket to the paid invoice without a step out of order.
- Write a scope of work a vendor can quote from.
- Know when one quote is enough and when three are needed, and who approves what.
- Keep a vendor on site safe, escorted and out of rented units.
- Inspect and close the work with a photo, and match the invoice to the ticket.
- Take the emergency path without losing the record.

## One Path

```figure
{
  "kind": "steps",
  "title": "From Ticket to Invoice",
  "items": [
    { "label": "Ticket", "note": "the problem, the place, photos" },
    { "label": "Scope", "note": "what is to be done, in writing" },
    { "label": "Quotes", "note": "one, or three, by the amount" },
    { "label": "Approval", "note": "by the right level, in writing" },
    { "label": "Schedule", "note": "the visit, the access, the escort" },
    { "label": "Work", "note": "papers on file, gate code never shared" },
    { "label": "Inspect", "note": "the finished work, a photo" },
    { "label": "Close", "note": "the ticket; the record writes itself" },
    { "label": "Invoice", "note": "matched to the ticket, paid in Accounting" }
  ],
  "caption": "Skip a step and the one after it has nothing to stand on."
}
```

Every repair at Greens, from a $90 keypad button to a $40,000 canopy row, takes the same path. The amount changes how many quotes and which approval, never the steps.

## The Ticket

The ticket is the file. Everything about the job attaches to it: the photos, the scope, the quotes, the approval, the vendor's notes, the finished-work photo, the invoice number. A job with no ticket has no file, and a job with two tickets has two half-files.

A good ticket for a vendor job says:

- **Where**: the property, the building or row, the unit or space number, the equipment.
- **What is wrong**, in the words the trade uses: "the gate stops at about one third open and reverses; the photo eyes are clean; it started 11/02."
- **Since when**, and whether it is getting worse.
- **What has been tried**: the breaker, the track, the manual release.
- **Photos or video**, with the place in the frame.
- **Priority**, honestly: the tenant impact and the risk.

The status **Waiting for Vendor** is the ticket's way of saying the job has left the building. Use it, and put the vendor's name and the promised date in the ticket, so the desk and the manager above you can see where the job stands without a phone call.

```figure
{
  "kind": "screen",
  "title": "A Ticket Waiting for Vendor",
  "device": "computer",
  "module": "Tickets",
  "tabs": ["Needs Reply", "Unassigned", "Mine", "All Open"],
  "tab": "Mine",
  "parts": [
    { "kind": "card", "title": "#4830 · Gate 1 slow to open, grinding from the motor housing", "note": "Temecula · Facilities · High · raised by T. Okafor 11/03/2026 7:52 AM",
      "rows": [{ "label": "Status", "value": "Waiting for Vendor", "tone": "warn", "n": 1 }, { "label": "Vendor", "value": "Precision Gate Co. · visit booked Thu 11/05 8:00 AM" }, { "label": "Scope", "value": "Inspect operator and drive; replace worn sprocket if found; full service (quarterly)" }, { "label": "Quote", "value": "$640 service + parts, approved by D. Reyes 11/03", "tone": "ok", "n": 2 }, { "label": "Next Clock", "value": "vendor update due 11/05 5:00 PM" }],
      "buttons": ["Reply", "Attach File", { "label": "Mark Resolved", "n": 3 }] },
    { "kind": "list", "title": "Thread", "items": [{ "label": "T. Okafor", "note": "Video of the cycle attached. Breaker fine, track clear, started 11/02." }, { "label": "D. Reyes", "note": "Quote from Precision attached. Approved. Booked Thursday 8:00 AM; T. to escort." }] }
  ],
  "callouts": [
    { "n": 1, "text": "The job has left the building. The vendor's name and the promised date are in the ticket, not in your phone." },
    { "n": 2, "text": "The approval is in writing, on the ticket, by the level the amount needs." },
    { "n": 3, "text": "Only after you have inspected the finished work and attached the photo." }
  ]
}
```

## The Scope

A **scope of work** is one paragraph that says what is to be done, where, to what standard, by when, and what is excluded. It is what the vendor quotes against, what you inspect against, and what the invoice is matched to. Without it, every disagreement is your word against the vendor's.

A scope for a small job fits in the ticket: "Replace the failed photocell on light pole 4, RV row B, with the same type; test at dusk; haul away the old unit." A scope for a big job is a document attached to the ticket, and for construction-scale work it becomes a Construction job with its own records (the Budgets and Capital Planning lesson).

What a scope always has:

| Part | Example |
|---|---|
| **Where** | Canopy row C, bays 3 and 4 |
| **What** | Replace two bent roof panels and one bent purlin; re-fasten the adjacent panels |
| **Standard** | Like-for-like materials; matching gauge and color; the manufacturer's fasteners |
| **When** | Within 10 working days; the row cleared of vehicles by us the day before |
| **Included** | Lift, labor, materials, haul-away, a re-measure of the clear height after |
| **Excluded** | Painting; repair of the bollard (separate ticket) |

## Quotes and Approvals

How many quotes and who approves depend on the amount, and the thresholds are set by Greens, not by this course. The shape is the same at every company:

| Size of job | Quotes | Approval |
|---|---|---|
| Small, routine, with an approved vendor on a known rate | The vendor's rate on file | The site manager, inside the site's limit |
| Medium | A written quote, often two | The manager above the site, in writing |
| Large, or anything capital | Three written quotes against one scope | Leadership, through the budget; usually a Construction job or a purchase order |
| Emergency | None at the time; the invoice reviewed after | The site manager acts, tells the manager above the same day |

> [!NOTE]
> **Pending:** Greens' approval limits by level, and who holds each, are to be written here (Operations Manager / a Super Administrator to set). Until then, ask your manager before you approve anything beyond a routine visit at a rate on file.

The rule that never changes: **the approval is in writing, on the ticket, before the vendor starts**, and a job split into two tickets to stay under a limit is not two jobs.

For things the company must buy rather than fix (a new pressure washer, a replacement camera recorder), the request is a **Purchase Request** from Workday (the Nexus Fundamentals course), approved by the manager it names, and the item is received against it.

## The Vendor on Site

```figure
{
  "kind": "screen",
  "title": "The Vendor's Visit, on the Phone",
  "device": "phone",
  "module": "Tickets",
  "parts": [
    { "kind": "card", "title": "#4830 · Gate 1 slow to open", "rows": [{ "label": "Thu 11/05 8:00 AM", "value": "Precision Gate Co.", "tone": "live" }, { "label": "Papers", "value": "Insurance Expiring Soon · ok to work", "tone": "warn", "n": 1 }, { "label": "Escort", "value": "T. Okafor" }] },
    { "kind": "form", "title": "Vendor on site", "fields": [{ "kind": "check", "label": "Signed in at the office; badge issued", "value": true }, { "kind": "check", "label": "Gate opened by staff; no code given", "value": true, "n": 2 }, { "kind": "check", "label": "Work area coned; aisle lane marked", "value": true }, { "kind": "check", "label": "No rented unit opened", "value": true, "n": 3 }, { "kind": "check", "label": "Finished-work photo taken", "value": false }], "buttons": [{ "label": "Save", "primary": true }] }
  ],
  "callouts": [
    { "n": 1, "text": "Expiring Soon may work; Expired may not. Check before they unload." },
    { "n": 2, "text": "A vendor never gets a gate code. Staff open the gate, or the vendor gets a visitor code that expires that day, where the site uses them." },
    { "n": 3, "text": "A vendor goes into a rented unit only with the tenant's written consent, or under an emergency the manager has approved, with a witness and photos." }
  ]
}
```

A vendor on the property is a guest with tools. The rules:

- **Sign in at the office**, every visit. The site knows who is on the property.
- **No gate codes.** Staff open the gate, or the site issues a visitor code that expires that day, where it has them. A vendor with a standing code is a vendor who can come at 2:00 AM.
- **Escort to the work area** and set the boundaries: which aisle is closed, where the truck parks, which units or spaces are off limits.
- **Never into a rented unit** without the tenant's written consent, or an emergency the manager has approved with a witness and photos. The tenant has exclusive control (the Access, Locks and Security lesson).
- **Safety on site.** Cones and a closed lane for anything in an aisle; no hot work (torches, grinders) near stored vehicles or without a permit and a fire watch; no vendor on a roof or in a lift without their own fall protection.
- **Tenants' vehicles are not moved** by the vendor or by staff. If the work needs a space cleared, the tenant moves it.
- **Check the papers** on the vendor's Compliance tab the morning of the visit, not the week before.

## Inspect, Photograph, Close

The job is not done when the vendor leaves. It is done when you have looked at the work against the scope and taken the photo.

1. **Walk the work with the scope in your hand.** Every line of the scope: was it done, to the standard?
2. **Test it.** Cycle the gate ten times. Open and close the door. Turn the light on at dusk.
3. **Photograph the finished work**, with the place in the frame, and attach it to the ticket. A preventive ticket will not resolve without one.
4. **Note what the vendor found and what they recommend.** "Sprocket replaced; chain has about a year left" is next year's schedule.
5. **Mark Resolved**, and when the requester confirms, the ticket closes and the maintenance record writes itself onto the property.

If the work is not to the scope, the ticket stays open, the vendor comes back, and the invoice waits.

## The Invoice

An invoice is paid in Accounting, by Accounting, and only when it matches:

- **The ticket** (or the purchase order) it belongs to; the ticket number goes on the invoice.
- **The scope**: the work the invoice describes is the work that was approved.
- **The quote**: the amount is the approved amount, or the difference is explained and approved.
- **The inspection**: the ticket is resolved with the finished-work photo.

The site never pays a vendor. No cash, no card, no "we'll settle it next visit." The site's job is to make sure the invoice can be matched in one look, and to answer Accounting's questions the same day.

> [!TIP]
> Ask every vendor to put the ticket number on the invoice. An invoice that says "gate repair, Temecula" is a phone call; "#4830 gate operator service and sprocket" is a match.

## The Emergency Path

An emergency (the Maintenance Mindset lesson) skips the quotes, never the record:

1. **Safety first**: people away from the hazard, 911 if needed (the Safety and Emergencies lesson).
2. **Call the approved vendor** for the trade. If none answers, call the manager above you for the after-hours list.
3. **Raise the ticket** before or during the call, from your phone, with photos. Mark it as an emergency.
4. **Tell the manager above you the same day**, in the ticket and by phone.
5. **The vendor's invoice is reviewed after**, against the ticket and the vendor's rate on file, and the emergency becomes a preventive schedule if it could have been one.

## A Greens Scenario

Temecula's gate ticket (above) goes to the approved gate vendor with a scope: inspect the operator and the drive, replace the sprocket if worn, do the quarterly service. The quote comes in at $640 plus parts. The manager approves it in the ticket (inside her limit), books Thursday at 8:00 AM, and names the escort. On Thursday the staff member checks the vendor's Compliance tab (Expiring Soon, fine to work), signs them in, opens the gate herself, cones the entry lane, and stays near. The vendor replaces the sprocket and services the operator. She cycles the gate ten times, photographs the operator with the new sprocket, writes the vendor's note that the chain has about a year left, and marks the ticket Resolved. The invoice arrives with "#4830" on it; Accounting matches it in one look.

## Common Mistakes

- **A vendor started on a text message.** No scope, no quote, no approval: no record.
- **Two tickets for one job**, or a job split to stay under a limit.
- **A gate code given to a vendor.**
- **A rented unit opened for a vendor** without consent or an approved emergency.
- **Resolved before inspected.** The photo comes first.
- **An invoice with no ticket number**, or one paid by the site.

## Key Points

- One path for every repair: ticket, scope, quotes, approval, schedule, work, inspect, close, invoice.
- The ticket is the file; Waiting for Vendor with the vendor's name and date tells everyone where the job is.
- A scope says where, what, to what standard, by when, what is included and excluded.
- Quotes and approvals scale with the amount; the approval is in writing on the ticket before the work starts.
- A vendor signs in, gets no gate code, is escorted, never enters a rented unit, and works with papers on file.
- Inspect against the scope, photograph, then Resolve; the invoice is matched to the ticket and paid by Accounting, never by the site.
- An emergency skips the quotes, never the record.
