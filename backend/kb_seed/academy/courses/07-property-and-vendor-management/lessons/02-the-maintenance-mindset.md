---
title: "The Maintenance Mindset: Preventive, Corrective, Emergency"
summary: The three kinds of maintenance and what each one costs, how the daily walk feeds the ticket desk, how preventive schedules work in Nexus (calendar, floating and meter), and a year of preventive work at a storage site.
---

## What You'll Be Able to Do

- Tell preventive, corrective and emergency maintenance apart, and say why the first is the cheapest.
- Turn a repeat problem into a preventive schedule.
- Explain the three schedule kinds in Nexus: calendar, floating and meter.
- Read a preventive ticket and know what closing it does.
- Plan a year of preventive work for a storage and RV site.

## Three Kinds of Maintenance

```figure
{
  "kind": "compare",
  "title": "Preventive, Corrective, Emergency",
  "columns": [
    { "name": "Preventive", "note": "on a schedule, before it fails", "facts": ["A gate operator serviced every quarter", "Gutters cleaned before the rains", "Planned, quoted, the cheapest hour of labor you buy", "Nobody notices, which is the point"] },
    { "name": "Corrective", "note": "it broke; fix it", "facts": ["A door that will not latch", "A light out over the RV row", "A ticket, a vendor visit, a normal invoice", "The tenant noticed first"] },
    { "name": "Emergency", "note": "now, whatever it costs", "facts": ["A gate stuck open at night", "A roof leak over rented units in a storm", "After-hours rates, no quotes, a damage claim behind it", "The most expensive hour you will ever buy"] }
  ]
}
```

Every maintenance dollar at a storage site is one of three kinds. The split between them is the clearest measure of how well a property is run.

| Kind | When | What it costs | Example |
|---|---|---|---|
| **Preventive** | On a schedule, before anything fails | The least: planned labor, parts in stock, a quote on file | Servicing the gate operator every quarter; lubricating door springs on a schedule |
| **Corrective** | After something fails but nobody is in danger and nothing is being damaged | A normal visit at a normal rate | A latch that will not slide; a light out; a bent canopy panel |
| **Emergency** | Now, because the site cannot operate or damage is spreading | The most: after-hours rates, no time to quote, often a claim behind it | A gate that will not close; a roof leak into rented units; a sewer backup |

The mindset: **every emergency was once a corrective job, and every corrective job was once preventive work nobody did.** The gate that fails at 9:00 PM on a Saturday usually told you for weeks: a grind in the motor, a slower cycle, a chain that needed tension. A site that runs mostly on preventive work has few emergencies and a manager who sleeps.

## The Daily Walk Feeds the Desk

The Running the Site lesson in Self-Storage Fundamentals and the Walking the Lot lesson in RV & Boat Storage taught the walks. From the property side, the walk is a **sensor**: it is how the building tells you what is about to fail.

```figure
{
  "kind": "steps",
  "title": "From a Walk to a Work Order",
  "items": [
    { "label": "See it", "note": "a slow gate, a dark light, a stain under a door" },
    { "label": "Photograph it", "note": "with the unit number or the place in the shot" },
    { "label": "Scan the tag", "note": "Report a Problem, or raise a ticket" },
    { "label": "It is a ticket", "note": "on the property, with the right team" },
    { "label": "Work it", "note": "staff, or a qualified vendor" },
    { "label": "Close it", "note": "inspect, photo, the maintenance record writes itself" }
  ]
}
```

What matters is that nothing you see stays in your head or in a text. Every finding is a ticket (scan the site QR tag and use **Report a Problem**, or Submit a Ticket), with a photo. A problem with a ticket has a number, an owner, a due date and a history. A problem in a text has none of those.

> [!TIP]
> Write the ticket for the building, not for yourself. "Gate 1 slow to open, grinding from the motor housing, started about 11/02, video attached" tells the vendor what to bring. "Gate acting up" sends them twice.

## Preventive Schedules in Nexus

```figure
{
  "kind": "screen",
  "title": "Preventive Maintenance on a Property",
  "device": "computer",
  "module": "Asset Management",
  "sub": "Portfolio",
  "tabs": ["Overview", "Maintenance", "Records", "Timeline"],
  "tab": "Maintenance",
  "actions": [{ "label": "New Schedule", "primary": true }],
  "parts": [
    { "kind": "table", "title": "Preventive Maintenance", "columns": ["Schedule", "Kind", "Every", "Next due", "Assigned team", "Last done"], "rows": [
      ["Gate operator service", "Calendar", "3 months", "10/26/2026", "Facilities", "07/24/2026"],
      ["Roll-up door lubrication, rows A to D", "Floating", "6 months after last", "01/12/2027", "Facilities", "07/12/2026"],
      ["Skid steer engine service", "Meter", "250 hours", "at 1,250 h (now 1,212 h)", "Facilities", "at 1,000 h"],
      ["Gutter and downspout cleaning", "Calendar", "Yearly, October", "10/15/2027", "Facilities", "10/09/2026"],
      ["Fire extinguisher inspection", "Calendar", "Yearly", "11/30/2026", "Facilities", "11/20/2025"]
    ], "n": 1 },
    { "kind": "list", "title": "Open Tickets on This Property", "items": [{ "label": "Gate operator service (preventive)", "note": "#4790 · due 10/26/2026 · Overdue", "badge": "Overdue", "tone": "bad", "n": 2 }, { "label": "Gate 1 slow to open, grinding", "note": "#4830 · Waiting for Vendor · Precision Gate Co.", "badge": "Waiting for Vendor", "tone": "warn" }] }
  ],
  "callouts": [
    { "n": 1, "text": "Three kinds of schedule: calendar (a date), floating (so long after the last time it was done), meter (hours or miles on an asset)." },
    { "n": 2, "text": "When a schedule comes due, Nexus files ONE ticket for it. Closing that ticket writes the maintenance record and moves the schedule on." }
  ]
}
```

A preventive schedule is set on the property under **Maintenance**, **Preventive Maintenance**. There are three kinds, and the kind decides what "next due" means:

| Kind | Next due is | Use it for |
|---|---|---|
| **Calendar** | A date: every three months, every October | Gate service, extinguisher inspections, gutter cleaning, pest control |
| **Floating** | So long after the work was last done | Door lubrication, filter changes: things that slip when the last visit slipped |
| **Meter** | A reading on the asset: hours, miles | A skid steer, a pressure washer, a site vehicle. The reading comes from the asset's own record; nobody types it twice |

How it runs:

1. A daily scan finds every schedule that is due.
2. For each one it files **one ticket** on the property, to the team you assigned, as the person who last saved the schedule. The ticket carries the schedule, the due date and the equipment.
3. The team works it like any ticket. A preventive ticket needs a **photo** to resolve; a resolve without one is refused.
4. Closing the ticket writes the **maintenance record** on the property and moves the schedule on: the next date, or the next reading.

A ticket that a schedule filed and nobody worked goes **Overdue**, and the property's Overview counts it among its critical items. Overdue preventive tickets are the first thing a visiting regional manager looks at.

> [!NOTE]
> A schedule saved with a stale copy is refused (every save carries its revision), and an occurrence already filed is never filed twice. If a due ticket seems to be missing, look for the one that already exists before you file another by hand.

## A Year of Preventive Work

```figure
{
  "kind": "timeline",
  "title": "A Storage and RV Site's Preventive Year, Inland California",
  "items": [
    { "at": "January", "label": "Walk the roofs and gutters after the first storms", "note": "look for standing water, loose panels, a downspout off its drain" },
    { "at": "March", "label": "Asphalt: crack seal and striping", "note": "before the heat softens it; repaint faded lines and space numbers" },
    { "at": "April", "label": "Gate operator and keypads", "note": "quarterly service; test the safety loops and the hold-open time with a long rig" },
    { "at": "May", "label": "HVAC on the climate buildings", "note": "filters, coils, a test under load before summer", "tone": "live" },
    { "at": "June", "label": "Canopies and bollards", "note": "walk every post and beam; replace clear height signs" },
    { "at": "July", "label": "Gate operator service", "note": "quarterly" },
    { "at": "September", "label": "Fire protection", "note": "extinguisher tags, sprinkler and backflow tests where the site has them, fire lanes repainted" },
    { "at": "October", "label": "Gutters, drains and the lot's low spots", "note": "before the rains; grade the gravel", "tone": "warn" },
    { "at": "October", "label": "Gate operator service", "note": "quarterly; lights on the photocells checked as the days shorten" },
    { "at": "December", "label": "Review the year", "note": "which corrective tickets should be schedules next year; the budget asks" }
  ],
  "caption": "Texas sites move the storm work to spring and add hail: a canopy and roof walk after every storm season."
}
```

The calendar above is a starting point. Build your site's own from three sources: the manufacturer's service interval for each system (the gate operator's manual says every three months or so many cycles), the weather at your site (the rains, the heat, the hail), and your own ticket history (what broke last year, and when). A schedule with a reason behind it survives the next manager; a schedule nobody understands gets skipped.

## A Greens Scenario

Fairfield's gate failed three times in a year, each time a corrective ticket and a vendor visit, twice after hours. The manager pulls the three tickets from the property's Timeline, reads the vendor's notes (chain tension, a worn sprocket, a dirty sensor), and sets a calendar schedule: gate operator service every three months, assigned to Facilities, with the vendor's checklist in the schedule notes. The next year the gate has one corrective ticket, during office hours, for a keypad.

## Common Mistakes

- **Running the site on corrective work** and calling it normal.
- **Fixing it twice and never scheduling it.** Two of the same ticket is the signal.
- **A preventive ticket closed without the photo.** Nexus refuses it; the photo is the proof the work was done.
- **A schedule with no reason written down.** Write the manufacturer's interval and what happened the year you set it.
- **Filing a second ticket by hand for a schedule that already filed one.**

## Key Points

- Preventive is the cheapest maintenance; emergency the most expensive; the split between them measures the property.
- The daily walk is the sensor; every finding is a ticket with a photo, never a text.
- Preventive schedules are calendar, floating or meter; each due occurrence files one ticket; closing it with a photo writes the record and moves the schedule on.
- Build the site's preventive year from the manufacturer's intervals, the weather and your own ticket history.
