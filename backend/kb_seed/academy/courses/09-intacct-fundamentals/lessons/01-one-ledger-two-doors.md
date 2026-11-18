---
title: One Ledger, Two Doors
summary: What Sage Intacct is, how Nexus Accounting shows the ledger without ever keeping a second one, why nothing is typed into the ledger from Nexus, and how the Accounting grant and entity access decide what you see.
teaches: Accounting
---

It is the first week of the month and a property manager opens Accounting in Nexus to see why repairs ran high. She clicks the figure, reads the lines, finds the gate invoice, and asks a question on it. She never logged in to Intacct, and nothing she did changed the books. This lesson is why that works, and what she can and cannot do there.

## Intacct Is the Ledger

**Sage Intacct** is the accounting system Greens' books live in: every entity, account, journal entry, vendor and customer. The accounting team keys entries, pays bills and closes the month there. Intacct is the source of truth.

**Nexus Accounting** is the second door. It reads a copy of the Intacct ledger that the accounting app keeps in step with Intacct, and shows it as dashboards, statements, reports and records. It never keeps a second set of books.

```figure
{
  "kind": "compare",
  "title": "Two Doors to One Ledger",
  "columns": [
    { "name": "Sage Intacct", "note": "the accounting team's door", "facts": ["Entries are keyed and posted here", "Bills are paid and the month is closed here", "The source of truth"] },
    { "name": "Nexus Accounting", "note": "everyone with the grant", "facts": ["Reads a copy of the ledger", "Statements, reports, records, the drill-down", "Asks questions; never posts"] }
  ]
}
```

## How Fresh the Figures Are

A line posted in Intacct reaches Nexus when the ledger copy next catches up. Dashboard figures are held for a couple of minutes between reads, so two people see the same picture. A report has a **Sync** button that reads its table again from the ledger. If a line you know was posted is not there, press Sync; if it is still missing, ask Accounting.

## Why Nothing Is Typed In

A ledger with two writers is two ledgers. If a site could key a payment into Nexus, Nexus and Intacct would drift apart and nobody could say which was right. So:

- A tenant's payment is taken in **Cubby** and reaches the books through the bank (see the lesson How Cubby Money Reaches the Books).
- A vendor is paid by the accounting team in Intacct, never from a site.
- A wrong account on a line is **asked about** in Nexus, on **Trackers > Ask My Accountant**. Only the bookkeeper may approve the fix and push it to Intacct.
- An allocation or a bank import is **prepared** in Nexus as a file and **posted** by the accounting team.

When a Nexus screen looks like it is editing money, it is editing Nexus's own records beside the ledger (a vendor's insurance papers, a loan's planning) or preparing a file.

## Who Sees What

Two things decide what a person reads:

| | What it does | Where it is set |
|---|---|---|
| **The Accounting grant** | Opens the module. Viewer reads; Editor and Full also keep Nexus's own records | Access Groups |
| **Entity access** | Which Intacct entities the person reads: All Entities by default, or a list | Accounting > Tools > Access, Full level |

A manager limited to one entity reads that entity's statements and nothing else; search, drill-downs and journal entries stop at the same line. The Dashboard tabs show the whole company added up, so they open only for people with All Entities.

**Personal financial statements** (PFS) are separate: owners and an explicit PFS grant only. This course does not cover them.

## Finding Your Way

Open **Accounting** from the left menu. The header carries five menus:

| Menu | What is under it |
|---|---|
| **Dashboard** | Overview, Cash, Performance, Close |
| **Reports** | All Reports, Report Builder, Packages, Financial Statements, Ledger & Banking, Budget vs. Actual, Review, Payroll, Tax |
| **Trackers** | Monthly Recurring Income, Monthly Recurring Expenses, Management Fees, Ask My Accountant, Budgets |
| **Financing** | Loans, Intercompany, Investments |
| **Records** | Vendors, Customers, General Ledger Accounts, Entities, Journals |
| **Tools** | Data, Access, Allocations, Import Hub |

The search box at the top right of every tab finds any posted line by vendor, customer, invoice, amount or memo.

## At Greens

A new Murrieta manager gets the Accounting grant at Viewer level with one entity. The Dashboard tabs are not there, but Reports is, and her Income Statement shows her property alone. She opens repairs, reads the lines, and finds a ticket number in a memo. She saw nothing of another property's, and changed nothing.

## Common Mistakes

- **Looking for a place to type a payment or a correction.** There is none; ask on the line through AMA.
- **Expecting the Dashboard with one entity.** It shows the whole company.
- **Reporting a "missing" line before pressing Sync.**

## Key Points

- Intacct is the ledger; Nexus Accounting reads a copy and never posts.
- Sync reads a report's table again; a line still missing after Sync is a question for Accounting.
- The grant opens the module; entity access narrows it; the Dashboard needs All Entities.
- A fix to the ledger is requested in Nexus and made by the bookkeeper.
