---
title: Budgets and Capital Planning
summary: Operating expense versus capital, how a site's maintenance budget is built and read by its Intacct entity, each system's service life and the reserve, how a capital project runs as a Construction job, and answering leadership at budget time.
teaches: Accounting, Construction
---

Murrieta's manager is asked for next year's maintenance budget, and the gate vendor is the biggest line, a third of it after-hours. "Last year plus five percent" would take ten minutes and defend nothing. This lesson is how to build the number from the record, and how to tell a repair from a capital decision.

## Operating and Capital

| | Operating expense (opex) | Capital (capex) |
|---|---|---|
| **What it is** | Keeps today's property running | Replaces or adds something that lasts years |
| **Examples** | Repairs, preventive service, utilities, pest control, supplies | A new roof, a repave, a gate operator, a canopy row |
| **On the books** | An expense in the month the work is done | An asset, depreciated over its life |
| **Who runs it** | The site manager, inside the budget | Leadership's plan; at Greens, a Construction job |

Why it matters: a manager who patches a failing roof again and again is spending operating money to delay a capital decision that is coming anyway. Write the roof into the capital plan with the evidence, and patch only until the plan funds it.

## The Maintenance Budget

Each property is an **entity** in Intacct, so its actual costs are read from the books by that entity, by vendor and account. A budget is built once a year from three sources:

| Source | What it gives |
|---|---|
| **Last year's actuals** | What the property really cost, by system |
| **The preventive schedules** | Every scheduled visit, priced at the vendor's rate on file |
| **What you know is coming** | The gate with three tickets; the striping due with the sealcoat; the compressor the vendor flagged |

A line built as "gate and access: four quarterly services at $640, one corrective visit, the keypad we expect to replace" can be defended. Last year plus five percent cannot.

Through the year, watch two things:

- **Variance**, the gap between the plan and the actual by line. A line over by March is a conversation in March, not December.
- **Emergency spend.** Every emergency dollar is a preventive dollar nobody spent; a rising emergency line means the schedules are wrong or skipped.

Leadership compares sites of different sizes by **cost per unit** and **cost per space**, worked out from the books. Nobody keys these figures into Nexus.

## Service Life and the Reserve

Every system has a life, and the money to replace it is set aside over that life: the **reserve**. Your part is to know where each system is in its life.

| System | Rough life | What shortens it |
|---|---|---|
| Metal roof | Decades | Standing water, loose fasteners, clogged gutters |
| Asphalt | A couple of decades with the cycle kept; far less without | Skipped crack seal and sealcoat |
| Gate operator | Years; cycles count more than years | Dirt, a dry chain, no service |
| HVAC | A decade or two | Dirty filters, blocked condensate |

"The Building C roof is in its third decade and had four leak tickets this year" gets funded. "The roof is old" waits. The age is in the warranty record and the history is in the Timeline.

## A Capital Project at Greens

```figure
{
  "kind": "steps",
  "title": "A Capital Project, Start to Close-Out",
  "items": [
    { "label": "The case", "note": "tickets, photos, age, quotes" },
    { "label": "The plan", "note": "leadership funds it" },
    { "label": "The job", "note": "a Construction job with its Project-Job code" },
    { "label": "The subs", "note": "Intacct vendors with papers on file" },
    { "label": "The work", "note": "permits, inspections, daily logs" },
    { "label": "Close-out", "note": "new records in Asset Management" }
  ]
}
```

Capital work runs as a **Construction job**: one record per piece of work, in the property's company, with its own schedule, permits and inspections from day one, its subcontractors, and its money read from Intacct by the job's **Project-Job** code (see the lesson The Construction Money Tab). A target finish that moves needs a reason, and the reason is kept.

The site manager builds the case, keeps the site running around the work, inspects as on any repair, and receives the close-out (warranty, finaled permit, clear heights) as new records in Asset Management, never over old ones.

## At Greens

The Murrieta manager pulls the property's costs from Accounting by vendor and account, reads the gate tickets in the Timeline (three summer emergencies, one operator), prices four quarterly services at the rate on file plus one corrective visit, and writes the operator itself into the capital case with its age, the emergencies and a replacement quote. The operating line goes down, the capital line goes up with a reason, and leadership funds the operator for spring.

## Common Mistakes

- **Patching a capital problem with operating money** for years.
- **Last year plus five percent.**
- **Not knowing a system's age** when the warranty record has it.
- **Keying money into Nexus.** It is read from the books.
- **A capital job run as a big ticket** instead of a Construction job.

## Key Points

- Operating keeps today's property running; capital replaces what lasts. The manager runs the first and builds the case for the second.
- A property's costs are read by its Intacct entity; budget from actuals, priced schedules and what is coming.
- Watch variance and the emergency line all year.
- Capital work is a Construction job with a Project-Job code; close-out adds new records to Asset Management.
