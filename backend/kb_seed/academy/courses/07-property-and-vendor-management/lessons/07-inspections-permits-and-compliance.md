---
title: Inspections, Permits and Compliance
summary: The outside authorities a storage site answers to - the fire authority, building and planning, health, elevator and backflow programs, the insurer - the inspections each one runs, the permits a repair may need, and how the records are kept in Asset Management so nothing lapses.
---

## What You'll Be Able to Do

- Name the authorities that inspect a storage site and what each one looks for.
- Keep the fire inspection cycle: extinguishers, sprinklers, alarms, backflow, lanes, signs.
- Know when a repair needs a permit and who pulls it.
- File every inspection, permit and AHJ contact in Asset Management with its expiry.
- Prepare for an inspection so it is a walk, not a list.

## Who Inspects a Storage Site

```figure
{
  "kind": "compare",
  "title": "The Authorities and What They Look For",
  "columns": [
    { "name": "Fire authority", "note": "the fire marshal or fire department", "facts": ["Extinguishers, tagged and charged", "Sprinklers and alarms tested", "Fire lanes and hydrants clear", "Address visible; Knox box current", "No hazardous storage"] },
    { "name": "Building and planning", "note": "the city or county", "facts": ["Permits for structural, electrical, plumbing and mechanical work", "Signs and fences to code", "Use of the property as approved"] },
    { "name": "Programs", "note": "state and county", "facts": ["Elevator certificate", "Backflow device test", "Stormwater and environmental", "Health, for an office restroom"] },
    { "name": "The insurer", "note": "Greens' carrier", "facts": ["Roofs, electrical, fire protection", "Housekeeping and hazards", "Recommendations with deadlines"] }
  ]
}
```

An **AHJ** (authority having jurisdiction) is any agency that has the right to inspect the property and to require things of it. A storage site typically answers to several, and the Records tab in Asset Management has a collection for them: who they are, their contact, their last visit, their next.

## The Fire Cycle

Fire is the inspection that comes every year and the one that closes a site when it fails. The cycle:

```figure
{
  "kind": "timeline",
  "title": "A Year of Fire Protection",
  "items": [
    { "at": "Monthly", "label": "Extinguisher visual check", "note": "in place, charged, tag initialed, nothing in front of it" },
    { "at": "Quarterly", "label": "Sprinkler and alarm visual", "note": "gauges, valves open and locked, panel clear of trouble" },
    { "at": "Yearly", "label": "Extinguisher service", "note": "the fire protection vendor tags every unit" },
    { "at": "Yearly", "label": "Sprinkler, alarm and backflow tests", "note": "by the vendor, with the reports filed", "tone": "live" },
    { "at": "Yearly", "label": "The fire authority's inspection", "note": "walk it with them; fix every item on the list by its date", "tone": "warn" },
    { "at": "Always", "label": "Lanes, hydrants, address, Knox box", "note": "clear, visible, current" }
  ]
}
```

What the fire inspector asks about at a storage site, and what a prepared manager already has:

| They ask | You have |
|---|---|
| Extinguisher tags | Every unit serviced within the year, the vendor's report in Records |
| Sprinkler and alarm test reports | This year's, in Records, with the deficiencies fixed |
| Fire lanes | Painted, signed, clear; no tenant trailer parked "for an hour" |
| Hydrants and connections | Clear of vehicles and weeds, caps on |
| Hazardous storage | The lease forbids it; the walks look for it; a form logs what was found |
| Address and Knox box | Visible from the street; the box holds current keys and codes |
| Exits and hallways | Lit, signed, unblocked, doors closing on their own |
| Electrical | No open panels, no extension cords, no daisy chains |

> [!WARNING]
> Never silence an alarm panel, close a sprinkler valve or move an extinguisher to make an inspection look better. A false record is worse than a failed inspection; an inspector who finds one stops trusting every record you have.

## Permits

A permit is the building authority's permission to do work and its right to inspect that work. Which repairs need one varies by city and county, but the pattern is steady:

| Usually needs a permit | Usually does not |
|---|---|
| Structural work: a canopy, a wall, a roof replacement | Like-for-like repair of a roof panel or a door |
| Electrical: new circuits, panels, light poles | Replacing a fixture or a photocell on an existing circuit |
| Plumbing: new lines, water heaters, backflow devices | A faucet or a flush valve |
| Mechanical: a new HVAC unit | A filter, a capacitor, a thermostat |
| Signs: a new pylon or monument sign | Replacing a faded panel |
| Grading and paving beyond maintenance; anything that changes drainage | Crack seal, sealcoat, striping |
| Fences and gates above a height, new gate operators | Slats, a hinge, a keypad |

Three rules:

1. **The licensed vendor pulls the permit** in most trades, and the permit cost is in the quote. A vendor who suggests skipping it is telling you what else they skip.
2. **The permit and its final inspection go in Records**, under Permits, with the permit number and the date it was finaled. An open permit (never finaled) is a problem at sale, at refinance and at a claim.
3. **A Construction job carries its own permits and inspections** from day one (the Budgets and Capital Planning lesson): the inspection's scheduled day is recorded, the superintendent is belled the day before, and a failed result bells the managers.

## The Records Tab

```figure
{
  "kind": "screen",
  "title": "Records: Inspections, With Their Dates",
  "device": "computer",
  "module": "Asset Management",
  "sub": "Portfolio",
  "tabs": ["Overview", "Maintenance", "Records", "Timeline"],
  "tab": "Records",
  "actions": [{ "label": "Add Record", "primary": true }],
  "parts": [
    { "kind": "card", "note": "Warranties · Inspections · Plans · Utilities · AHJ · Vendors · Permits", "n": 1 },
    { "kind": "table", "title": "Inspections", "columns": ["Inspection", "By", "Last", "Next", "Result", "File"], "rows": [
      ["Fire extinguishers (annual service)", "SafeGuard Fire Protection", "11/20/2025", "11/30/2026", "Pass", "report.pdf"],
      ["Sprinkler and alarm annual test", "SafeGuard Fire Protection", "09/14/2026", "09/14/2027", "Pass, 2 deficiencies fixed", "report.pdf"],
      ["Backflow device test", "County water program", "04/02/2026", "04/02/2027", "Pass", "cert.pdf"],
      ["Fire authority annual", "County Fire", "10/07/2026", "10/07/2027", "3 items, all closed 10/21/2026", "notice.pdf"],
      ["Elevator certificate", "State elevator program", "05/11/2026", "05/11/2027", "Pass", "cert.pdf"],
      ["Insurance carrier survey", "Carrier loss control", "06/18/2026", "06/18/2028", "2 recommendations, 1 open", "letter.pdf"]
    ], "n": 2 }
  ],
  "callouts": [
    { "n": 1, "text": "Seven collections. A record with a date warns the Overview 90 days ahead." },
    { "n": 2, "text": "Every inspection has a last, a next, a result and the file. The file is what the next inspector, the insurer and the buyer will ask for." }
  ]
}
```

The **Records** tab has seven collections. For this lesson, four matter:

| Collection | What goes in it |
|---|---|
| **Inspections** | Every inspection with who did it, when, the result, the next date and the report |
| **Permits** | Every permit with its number, the work, the vendor, the final inspection date and the document |
| **AHJ** | Every authority with its contact, what it inspects, the last and next visit |
| **Warranties** | Every warranty on a roof, a gate operator, a door, an HVAC unit, with its start, its term and the document; a claim on a warranty needs the paper |

A record with a next date warns the property's Overview 90 days ahead, which is the point: nothing on a storage site should lapse because nobody remembered. Warranties, plans and utilities round out the tab, and the Vendors collection is a pointer to the vendors Accounting holds, never a second list.

## Preparing for an Inspection

An inspection is a walk through a list you already have. The week before:

- [ ] Open Records and check every item with a date in the inspector's area: tags, tests, certificates.
- [ ] Walk the site with the last inspection's list in hand; every item from last year should still be right.
- [ ] Fire lanes, hydrants, exits, address, Knox box: clear, visible, current.
- [ ] The electrical walk: no open panels, no cords, no daisy chains in the office.
- [ ] Hazardous materials: the walks and the forms, and a look at the dumpster area.
- [ ] Have the files ready: the vendor reports, the permits, the warranties.

The day of: walk with the inspector, write every item they name, ask for the written notice, and raise a ticket for each item with its deadline the same day. Then close every one, with photos, and file the closed notice in Records.

## A Greens Scenario

County Fire's annual inspection at Escondido lists three items: an extinguisher past its tag in Building B, a tenant's utility trailer in the fire lane behind Building D, and weeds at a hydrant. The manager raises three tickets that afternoon with the deadline on each, has the extinguisher serviced by the fire vendor (and asks why the yearly service missed one unit; the vendor's count was short, and the schedule note now says 31 units, not 30), calls the tenant to move the trailer and overlocks the lane with cones, and has the weeds cut. All three close with photos within a week. She files the notice and the closure in Records, and next year's inspection is a walk.

## Common Mistakes

- **A fire lane used as parking** "for an hour."
- **An extinguisher count that is short** because nobody counted.
- **Work done without a permit** because the vendor said it was fine.
- **An open permit never finaled.**
- **Inspection reports in an email thread** instead of Records.
- **Preparing the day before** instead of walking the list the week before.

## Key Points

- Several authorities inspect a storage site: fire, building and planning, the programs (elevator, backflow, stormwater) and the insurer; each is an AHJ record.
- The fire cycle is monthly, quarterly and yearly; lanes, hydrants, address and Knox box are always; never fake a record.
- Structural, electrical, plumbing, mechanical, sign and grading work usually needs a permit; the licensed vendor pulls it; the permit and its final go in Records.
- Records holds Inspections, Permits, AHJ and Warranties with their dates; the Overview warns 90 days ahead.
- Prepare the week before; raise a ticket per item the day of; file the closure.
