---
title: The Dashboard, the Close and the Tools
summary: The four Dashboard pages, the Close page with its checklist and Account Reconciliations, the Budget pages, and the Tools that prepare files for Intacct without posting to it.
teaches: Accounting
---

It is the fifth of the month. The controller opens Dashboard > Close: the checklist is two-thirds done, one bank account still shows unreconciled, and a balance moved by $40,000 with no explanation yet. A property manager will get one question about that movement today. This lesson is the page that question comes from, and the tools around it.

## The Dashboard

The **Dashboard** menu is the whole company's picture, so it opens only for people with All Entities:

| Page | What it shows |
|---|---|
| **Overview** | Cards you can arrange: revenue, NOI, cash, the entities side by side |
| **Cash** | The cash plan, scenarios and a 13-week forecast |
| **Performance** | Budget against actual against last year, with commentary |
| **Close** | The month-end checklist, reconciliations and the balances to explain |

The figures come from the accounting app's finance dashboard; Nexus shows them and never recomputes or types them. Anything written here (a note, a step ticked) carries the writer's name.

## The Close Page

The **Month-End Close** card is the shared checklist, progress by phase, and the next open tasks. Your Accounting team sets the close calendar and owns the steps. Around it sit the cards that say what is left:

- **Account Reconciliations**: every bank, credit card, mortgage, credit line and brokerage account with its reconciliation status through the month end.
- **Recent Activity**: who reconciled an account or completed a step, and when.
- **Bank and Card Transactions to Code**: imported lines with no GL account yet.
- **Intercompany Balances**: due-to and due-from between entities, with differences to clear.
- **Balance Sheet Changes to Explain**: month-over-month changes over $25,000 or 10%, for the flux review.

## Bank Reconciliation, as Nexus Shows It

A **bank reconciliation** proves the ledger's cash agrees with the bank's statement: every deposit and payment on one side is on the other, and the differences are timing items someone can name. Accounting does the reconciling in Intacct. Nexus shows where each account stands and lets you look.

Click an account on Account Reconciliations and its **Bank Activity** (or **Credit Card Activity**) opens already filtered: every transaction in the period with date, description, vendor, amount and a running balance that starts from the balance before the period. Both reports are also under **Reports > Banking & Credit Cards**.

## What a Site Owes the Close

In order of how often each one slows the close: tickets resolved so costs fall in the right month; invoices carrying their ticket numbers so bills match; waivers and refunds in Cubby with reasons; and **same-day answers** when Accounting asks about a variance. **Flux Analysis** (Reports > Audit & Insights) marks each flagged line Open, Answered or Reviewed, so an unanswered question is visible to everyone.

## Budget

- **Reports > Budget > Budget**: one entity and year, every income statement account by month, edited in place. It can start from Copy From Last Year's Actuals or Copy From Intacct Budget.
- **Budget vs. Actual, YTD** and **MTD**: the income statement against the budget, with Variance $ and Variance %.

A budget is worked out, not posted, so the budget figures do not drill down; the actuals beside them do.

## The Tools

| Page | What it does |
|---|---|
| **Data** | Reference figures the ledger does not carry (Editors and up) |
| **Access** | Which entities each person reads (Full level) |
| **Allocations** | The monthly payroll allocation: wages split across entities by hours worked at each site; a kept run downloads as an Intacct CSV or Excel file |
| **Import Hub** | Builds import files: Bank Statement to Intacct, Payroll Hours to QuickBooks, QuickBooks Payroll to Intacct |

The pattern never changes: Nexus prepares, previews and exports; the accounting team imports and posts. There is no Post button.

## At Greens

On the fifth, Escondido's manager gets a question on the $40,000 movement: a roof replacement booked as a capital asset. She answers the same morning with the ticket number, the line reads Answered, and the controller marks it Reviewed.

## Common Mistakes

- **Expecting the Dashboard with one entity.** It is the whole company.
- **Reading a month as final** before the Close page says the checklist is done.
- **Waiting a week to answer a variance question.** The close waits with you.
- **Looking for a Post button in a Tool.** The file goes to Accounting.

## Key Points

- Dashboard: Overview, Cash, Performance, Close; All Entities only.
- Close shows the checklist, Account Reconciliations and the balances to explain; an account opens its Bank Activity.
- Accounting reconciles in Intacct; Nexus shows the status and the transactions.
- Tools prepare files; the accounting team posts.
