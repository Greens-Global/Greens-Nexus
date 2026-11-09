---
title: "The Maintenance Mindset: Preventive, Corrective, Emergency"
summary: The three kinds of maintenance and what each costs, how the daily walk feeds the ticket desk, the three kinds of preventive schedule in Nexus (Fixed Dates, After Each Completion, By Meter), and how to build a site's preventive year.
teaches: Asset Management, Tickets
---

Saturday, 9:00 PM: Fairfield's gate will not close, and the after-hours rate is already running. Reading the gate's tickets on Monday, you see it told you for weeks: a grind, a slow cycle, a chain that needed tension. This lesson is how to hear the building before it costs you a Saturday night.

## Three Kinds of Maintenance

| Kind | When | What it costs | Example |
|---|---|---|---|
| **Preventive** | On a schedule, before anything fails | The least: planned labor, a quote on file | The gate operator serviced every quarter |
| **Corrective** | It failed, but nobody is in danger and nothing is spreading | A normal visit at a normal rate | A latch that will not slide; a light out |
| **Emergency** | Now, because the site cannot operate or damage is spreading | The most: after-hours rates, no time to quote, often a claim | A gate that will not close; a roof leak into rented units |

The mindset: **every emergency was once a corrective job, and every corrective job was once preventive work nobody did.** The split between the three is the clearest measure of how well a property is run.

## The Walk Feeds the Desk

The daily walk is the building's sensor. What matters is that nothing you see stays in your head or in a text: every finding is a ticket with a photo, raised by scanning the site tag and choosing **Report a Problem**, or from Help Center. A ticket has a number, an owner, a due date and a history. A text has none of those.

> [!TIP]
> Write the ticket for the vendor who will read it. "Gate 1 slow to open, grinding from the motor housing, started 11/02, video attached" tells them what to bring. "Gate acting up" sends them twice.

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
    { "kind": "table", "title": "Preventive Maintenance", "columns": ["Schedule", "Kind", "Next Due"], "rows": [
      ["Gate operator service", "Fixed Dates", "10/26/2026"],
      ["Door lubrication, rows A to D", "After Each Completion", "01/12/2027"],
      ["Skid steer service", "By Meter", "at 1,250 h"]
    ], "n": 1 },
    { "kind": "list", "items": [{ "label": "Gate operator service (preventive)", "note": "due 10/26/2026", "badge": "Overdue", "tone": "bad", "n": 2 }] }
  ],
  "callouts": [
    { "n": 1, "text": "The kind decides what next due means." },
    { "n": 2, "text": "A due schedule files ONE ticket. Closing it with a photo writes the record and moves the schedule on." }
  ]
}
```

A schedule is set on the property under **Maintenance**, **Preventive Maintenance**, with **New Schedule**. You pick one of three kinds:

| Kind | Next due is | Use it for |
|---|---|---|
| **Fixed Dates** | Set dates, whether or not the last one is done | Gate service each quarter, extinguisher service, gutters each October |
| **After Each Completion** | A set time after the last ticket was done | Door lubrication, filter changes: work that should slip when the last visit slipped |
| **By Meter** | Each time a reading passes the next mark | A skid steer's hours, a site vehicle's miles. The reading comes from the asset's own record; nobody types it twice |

How it runs:

1. A daily scan finds every schedule that is due.
2. It files **one ticket** on the property, to the team you assigned. A due date already filed is never filed twice, so look for the existing ticket before you raise one by hand.
3. The team works it like any ticket. A preventive ticket needs a **photo** to resolve; a resolve without one is refused.
4. Closing the ticket writes the **maintenance record** and moves the schedule to its next date or reading.

An unworked preventive ticket goes **Overdue** and shows on the property's Needs Attention card. It is the first thing a visiting regional manager looks at.

## Building the Preventive Year

```figure
{
  "kind": "timeline",
  "title": "A Storage and RV Site's Preventive Year, Inland California",
  "items": [
    { "at": "January", "label": "Roofs and gutters after the first storms" },
    { "at": "March", "label": "Asphalt crack seal and striping", "note": "before the heat" },
    { "at": "Quarterly", "label": "Gate operator service", "note": "test the safety loops and hold-open time with a long rig" },
    { "at": "May", "label": "HVAC on the climate buildings", "note": "before summer" },
    { "at": "June", "label": "Canopy posts, beams and clear height signs" },
    { "at": "September", "label": "Fire protection", "note": "tags, sprinkler and backflow tests, fire lanes" },
    { "at": "October", "label": "Gutters, drains and low spots", "note": "before the rains; grade the gravel" },
    { "at": "December", "label": "Review the year", "note": "which repeat tickets become schedules" }
  ]
}
```

Build your site's own year from three sources: the **manufacturer's interval** for each system, the **weather** at your site, and your **own ticket history** (what broke last year, and when). Write the reason in the schedule's notes. A schedule with a reason survives the next manager; one nobody understands gets skipped.

## At Greens

Fairfield's gate failed three times in a year, twice after hours. The manager reads the three tickets in the Timeline (chain tension, a worn sprocket, a dirty sensor) and sets a Fixed Dates schedule: gate service every three months, assigned to Facilities, with the vendor's checklist in the notes. The next year the gate has one corrective ticket, during office hours, for a keypad.

## Common Mistakes

- **Running the site on corrective work** and calling it normal.
- **Fixing it twice and never scheduling it.** Two of the same ticket is the signal.
- **After Each Completion where the law sets the date.** An extinguisher service is due on its date even if last year's ran late; that is Fixed Dates.
- **A second ticket by hand** for a schedule that already filed one.

## Key Points

- Preventive is the cheapest maintenance, emergency the most expensive; the split measures the property.
- Every finding on the walk is a ticket with a photo, never a text.
- Schedules are Fixed Dates, After Each Completion or By Meter; each due date files one ticket.
- Closing a preventive ticket with its photo writes the record and moves the schedule on.
