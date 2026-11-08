---
title: One Ledger, Two Doors
summary: What Sage Intacct is and why Greens runs its books in it, how Nexus Accounting shows the ledger without ever keeping a second one, the Greens Accounting app that looks like Intacct, who has the Accounting grant and what the entity limit means for what you see.
---

## What You'll Be Able to Do

- Say what Intacct is, what Nexus Accounting is, and how the two relate.
- Explain why nothing in Nexus is ever typed into the ledger by hand.
- Know who holds the Accounting grant and how entity access narrows what a person reads.
- Find your way from the Nexus Accounting module to the accounting app and back.

## Intacct Is the Ledger

**Sage Intacct** is the accounting system Greens' books live in: every entity, every account, every journal entry, every vendor and customer, every report Charmi's team closes the month on. It is the reference tool the accounting team knows, and the Fundamentals of Accounting course's words (accounts, journals, accrual, the close) are Intacct's words too.

Greens reaches the ledger through two doors:

```figure
{
  "kind": "compare",
  "title": "Two Doors to One Ledger",
  "columns": [
    { "name": "Nexus Accounting", "note": "the module in Nexus, for everyone with the grant", "facts": ["Dashboards, financial statements, reports, the drill-down", "Vendors and customers, their records and papers", "Recurring income and expenses, loans, management fees", "Reads the ledger; never writes to Intacct"] },
    { "name": "Greens Accounting", "note": "the standalone app, built to look like Intacct", "facts": ["The accounting team's working tool", "Where entries are keyed and the month is closed", "Mirrors the Intacct ledger in its own database", "Reached from Nexus with Launch"] }
  ],
  "caption": "One ledger. Nexus reads a mirror of it over a private connection; Nexus never talks to Intacct or to the accounting database directly."
}
```

Nexus never keeps a second set of books, never writes to Intacct, and never lets anyone key a dollar into a report. Every figure on a Nexus Accounting screen is read from the accounting app's internal reports, refreshed every few minutes, and every one drills down to the ledger lines behind it. That is the house rule from the Accounting side of CLAUDE.md made visible: a figure that is posted opens the lines behind it, and every line opens its transaction.

## Why Read-Only Matters

A ledger with two writers is two ledgers. If a site could key a payment into Nexus, the rent in Nexus and the rent in Intacct would drift apart, and nobody could say which was right. So:

- A tenant's payment is recorded in **Cubby** and reaches the ledger through the deposit batch.
- A vendor is paid from **payables in the accounting app**, never from a site.
- A reclass (moving a line to a different account) is **asked for** in Nexus (Ask My Accountant) and **done** by the bookkeeper in the accounting app.
- An allocation or an import is **prepared** in Nexus as an Intacct import file and **posted** by the accounting team.

When a Nexus screen looks like it is editing money, it is editing Nexus's own notes about the ledger (a vendor's compliance papers, a loan's planning, a lease record) or preparing a file for the accounting team. The ledger itself has one door.

## Who Sees the Module

```figure
{
  "kind": "screen",
  "title": "Accounting, Access",
  "device": "computer",
  "module": "Accounting",
  "sub": "Tools",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Tools",
  "parts": [
    { "kind": "text", "title": "Access", "text": "Everyone holding the Accounting grant. All Entities is the default; a limit takes effect on the person's next click." },
    { "kind": "table", "columns": ["Person", "Grant level", "Entities"], "rows": [
      ["Charmi K.", "Full", "All Entities"],
      ["Dana Reyes", "Viewer", "Greens Storage Temecula, Greens Storage Murrieta"],
      ["Priya N.", "Viewer", "Greens Storage Temecula"],
      ["Sam O.", "Viewer", "Greens Storage Fairfield"]
    ], "n": 1 },
    { "kind": "card", "note": "Family and personal entities are in the same ledger as the companies. Only Full level may change this list.", "n": 2 }
  ],
  "callouts": [
    { "n": 1, "text": "The grant opens the module; the entity list says which entities the person reads. Reports, search, drill-downs and journal entries all stop at it." },
    { "n": 2, "text": "Anything that only exists consolidated (the dashboard tabs, the accounting app itself) needs All Entities." }
  ]
}
```

Two things decide what a person sees:

| | What it is | Who sets it |
|---|---|---|
| **The Accounting grant** | Opens the Accounting module in the left menu. Viewer reads; Editor and Full edit Nexus's own records (vendors' papers, loans, MRI and MRE) | Access Groups (People & Access) |
| **Entity access** | Which Intacct entities the person reads: All Entities, or a list. An entity brings its sub-entities | Accounting > Tools > Access, Full level only |

A site manager with the grant and one entity reads their own site's statements and nothing else. The consolidated screens (the dashboard's Overview, Cash, Performance and Close; the accounting app) open only for people with All Entities. Administrators and owners are never limited.

**Personal financial statements** (PFS) are a separate matter: owners and an explicit PFS grant only, whatever a person's tier. They are the most sensitive records in Nexus and this course does not touch them.

## Finding Your Way

Open **Accounting** from the left menu (Modules group). The header carries the module's tabs: Dashboard, Reports, Financing, Records and Tools, each a group with pages under it. Every page has the same bones: an entity picker (your entities, or all), a period, a book, and a grid whose figures click.

| Group | Pages |
|---|---|
| **Dashboard** | Overview, Cash, Performance, Close |
| **Reports** | Report Center, Report Builder, Packages; the financial statements; Banking & Credit Cards; Budget; Payroll & People; Audit & Insights (Manual Journal Entries, MRE, MRI, Ask My Accountant, Profitability); Tax |
| **Financing** | Loans, Intercompany, Investments |
| **Records** | Vendors, Customers, General Ledger Accounts, Entities, Journals |
| **Tools** | Data, Access, Allocations, Import Hub |

**Launch** opens the Greens Accounting app for the accounting team. The rest of this course walks the Nexus pages in the order a manager meets them.

## A Greens Scenario

A new site manager at Murrieta is given the Accounting grant at Viewer level with one entity, Greens Storage Murrieta. She opens Accounting: the Dashboard tabs are not there (consolidated only), but Reports is, and her Income Statement shows her site alone. She clicks repairs and maintenance, reads the ledger lines, opens one entry, and sees the vendor's invoice number and the ticket number in the memo. She never saw a dollar of another site's, and nothing she did changed the ledger.

## Common Mistakes

- **Looking for a place to type a payment or a correction in Nexus.** There is none; ask through Ask My Accountant.
- **Expecting the Dashboard tabs with one entity.** They are consolidated views.
- **Treating the accounting app and Nexus as two ledgers.** One ledger; Nexus reads a mirror.

## Key Points

- Intacct is the ledger; the Greens Accounting app is where the accounting team works in it; Nexus Accounting reads a mirror and never writes to Intacct.
- Every figure drills to its ledger lines and every line to its transaction.
- The Accounting grant opens the module; entity access narrows what a person reads; consolidated screens need All Entities; PFS is owners only.
- The module is five groups: Dashboard, Reports, Financing, Records, Tools; Launch opens the accounting app.
