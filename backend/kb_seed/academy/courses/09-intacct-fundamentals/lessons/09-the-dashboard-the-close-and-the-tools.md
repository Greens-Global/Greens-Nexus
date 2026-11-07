---
title: The Dashboard, the Close and the Tools
summary: The consolidated Dashboard tabs (Overview, Cash, Performance, Close) and where their figures come from, how the Close tab tracks the month, the Budget page, and the Tools pages - Data, Import Hub and Allocations - that prepare files for the ledger without posting to it.
---

## What You'll Be Able to Do

- Read the four Dashboard tabs and say what each one is for.
- Follow the Close tab through a month and know what the site owes it.
- Read the Budget page beside the actuals.
- Say what Import Hub and Allocations produce and why nothing from Nexus posts to the ledger.

## The Dashboard

The **Dashboard** group is the owner's and the controller's picture of the whole company: four tabs, each showing one section at a time, read from the accounting app's finance dashboard over the same private connection every report uses. They are consolidated views, so they open only for people with All Entities.

```figure
{
  "kind": "screen",
  "title": "Dashboard, Overview",
  "device": "computer",
  "module": "Accounting",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Dashboard",
  "actions": ["Overview", "Cash", "Performance", "Close"],
  "parts": [
    { "kind": "tiles", "items": [{ "label": "Revenue, month to date", "value": "$486k" }, { "label": "NOI margin", "value": "61%" }, { "label": "Cash, all accounts", "value": "$1.92M" }, { "label": "Days to close", "value": "4", "n": 1 }] },
    { "kind": "card", "title": "Revenue by Entity, This Month vs Last", "rows": [{ "label": "Temecula", "value": "$168k · up 2%" }, { "label": "Fairfield", "value": "$96k · flat" }, { "label": "Murrieta", "value": "$88k · up 1%" }, { "label": "Escondido", "value": "$79k · down 3%", "tone": "warn", "n": 2 }, { "label": "Valley Center", "value": "$55k · up 4%" }] }
  ],
  "callouts": [{ "n": 1, "text": "Illustrative figures. Every number is read from the accounting app's dashboard, never computed in Nexus and never typed." }, { "n": 2, "text": "A tile or a row opens the entity's statement, and the statement drills to its lines." }]
}
```

| Tab | What it shows |
|---|---|
| **Overview** | Revenue, NOI and margin, cash, and the entities side by side for the month |
| **Cash** | Bank balances, the month's movement, what is coming due |
| **Performance** | Trends by entity: revenue, expenses, NOI, occupancy where the statistical journals carry it |
| **Close** | The month-end steps and where the close stands |

The figures come only through the accounting app's internal dashboard and its calculation modules, which are kept in the accounting repository; Nexus displays them and never recomputes them. Anything a person writes from the dashboard (a note, a close step marked done) carries the writer's name.

## The Close Tab

```figure
{
  "kind": "timeline",
  "title": "A Month on the Close Tab",
  "items": [
    { "at": "Day 1", "label": "Cut-off", "note": "the period's transactions are in; late invoices accrued" },
    { "at": "Day 2", "label": "Bank and card reconciliations", "note": "every account, every statement", "tone": "live" },
    { "at": "Day 3", "label": "Revenue", "note": "Cubby's billing and deposits agree with the ledger; prepaid rent earned down" },
    { "at": "Day 3", "label": "Payables and accruals", "note": "what is received, what is owed but unbilled" },
    { "at": "Day 4", "label": "Adjustments", "note": "prepaids, depreciation, the allowance" },
    { "at": "Day 5", "label": "Review", "note": "variance questions to the sites; Ask My Accountant lines resolved", "tone": "warn" },
    { "at": "Day 6", "label": "Lock", "note": "the period closes; the statements are final" }
  ],
  "caption": "The Fundamentals of Accounting course explained each step. The Close tab is where the accounting team tracks them, and the review step is where a site hears from them."
}
```

What a site owes the close, in order of how often it slows one down: tickets resolved so the cut-off is clean; invoices carrying their ticket numbers so payables match; waivers and refunds with reasons so revenue reconciles; and **same-day answers** to the variance questions in the review step. A site that does those four closes its own month in a day of the accounting team's time instead of a week.

## Budget

**Reports > Budget** shows the budget beside actual by account for the entity and period you pick, with the variance in dollars and percent. The budget itself is loaded by the accounting team; the variance comments the Fundamentals course asked for are written against this page. It is the one report whose main figures are not posted (a budget is worked out, not recorded), so the budget column does not drill down; the actual column does.

## The Tools

| Page | What it does | What it never does |
|---|---|---|
| **Data** | The data checks and refreshes the accounting team runs on the mirror | Change the ledger |
| **Access** | The entity limits (the first lesson) | |
| **Allocations** | Spreads a month's wages across entities by hours by work site, previews the entry, keeps the run, exports an Intacct import file or a workbook | Post anything |
| **Import Hub** | Turns an uploaded bank or brokerage statement (CSV or Excel) into an Intacct import template: pick the date, description and amount columns, the cash account, the offset account and the entity, check the preview, download | Post anything |

The pattern is the same for every tool: Nexus prepares, previews and exports; the accounting team imports and posts in the accounting app. It keeps the one-door rule and it keeps a record of every run.

## A Greens Scenario

On day five of the close the Escondido manager gets two variance questions in the review step: utilities (two bills in one month, timing) and repairs (a roof patch, real). She answers both in the ticket thread the same morning with the ticket numbers, the accounting lead marks the review step done on the Close tab, and the period locks on day six. The owner's Overview the next morning shows the month final.

## Common Mistakes

- **Expecting the Dashboard with one entity.** It is consolidated.
- **Reading the Dashboard before the Close tab says the month is locked.**
- **Waiting a week to answer a variance question.** The whole company's close waits with you.
- **Looking for a Post button in a Tool.** There is none; the file goes to the accounting team.

## Key Points

- The Dashboard's four tabs are consolidated views read from the accounting app; nothing is computed or typed in Nexus; writes carry the writer's name.
- The Close tab tracks the month's steps; the site's part is clean tickets, numbered invoices, reasoned waivers and same-day answers.
- Budget shows plan beside actual; the budget column is worked out and does not drill, the actual column does.
- Import Hub and Allocations prepare and export Intacct import files; the accounting team posts.
