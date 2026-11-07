---
title: Ask My Accountant and the Audit Pages
summary: How a question about a ledger line is asked and answered, the suspense account and the reclass request that only the bookkeeper may push, the Manual Journal Entries page that audits what a person keyed, Profitability and the Payroll & People reports.
---

## What You'll Be Able to Do

- Ask about a ledger line and follow the question to Answered or Resolved.
- Request a GL reclass the right way and say who may push it to the ledger.
- Read the Manual Journal Entries page and say what it is for.
- Know what Profitability and the payroll reports show, and who sees pay.

## Ask My Accountant

Every ledger has lines someone could not code with confidence: a card charge with no receipt, a deposit nobody recognized, a vendor payment with no invoice number. Intacct parks them in a **suspense account**, and at Greens that account is called **Ask My Accountant** (AMA). The Nexus page of the same name does two things:

```figure
{
  "kind": "steps",
  "title": "A Question on a Line",
  "items": [
    { "label": "A line sits in suspense", "note": "or anyone asks about any line from a drill-down" },
    { "label": "Open", "note": "on the Ask My Accountant page, with the Other Side shown" },
    { "label": "The question", "note": "a note typed in the grid, saved per line" },
    { "label": "Answered", "note": "the bookkeeper explains, or asks back" },
    { "label": "GL Reclass requested", "note": "pick the account, and a vendor or customer; it waits for the bookkeeper" },
    { "label": "Pushed and Resolved", "note": "the bookkeeper edits the original entry, previewed first, a few lines at a time" }
  ]
}
```

- **Every line on the suspense account** for the period shows on the page by itself, **Open** until it is answered or resolved. So does any line anyone asked about from a report's drill-down, Ledger Search or a journal entry.
- Each line shows its **Other Side** (the account the money came from or went to, read from the entry) on the first screen, so the question can be answered without a second click, and **Notes** typed in the grid are saved per line for the bookkeeper.
- **GL Reclass** is the request to move a line to a different account (and vendor or customer). It waits for the bookkeeper, who changes it, sends it back, or approves and **pushes** it. The push edits the original entry in the ledger, previewed first, a few lines at a time.

> [!NOTE]
> Nobody but the bookkeeper pushes a reclass. That was a deliberate decision (Neil, 10/22/2026: "Neil should not be able to push"), and it is the read-only rule from the first lesson in its sharpest form: a change to the ledger is made by the accounting team, from a request anyone may make.

The page's tabs are Open, Answered, Resolved and All, each with its count, filtered by entity and period. A manager who finds a cost on the wrong site asks here; the answer and the fix come back on the same line.

## Manual Journal Entries

**Reports > Audit & Insights > Manual Journal Entries** is the auditor's page: only the journal entries a **person keyed** in Intacct, not the entries the bank feed and the rules create, with who created and who last changed each one. A system entry a person later changed counts too and is marked **Changed by a Person**. Filters by period, entities, journals and user; grouped by user or sorted by any column.

Its purpose is the control the Fundamentals course called segregation of duties, made readable: the person who runs accounting can see every hand-made entry and every hand-made change, by whom, and ask about any of them. A storage company whose month is mostly system entries (Cubby's deposits, the bank feed, payroll) has a short manual list; a long one is a question.

## Profitability

**Profitability** reads the ledger by entity and shows each one's revenue, operating expenses and NOI side by side, with the margins, over the period you pick. It is the Fundamentals course's four ratios, computed for every site at once, for the owner's comparison and the manager's benchmark.

## Payroll & People

**Compensation** and **Payroll Summary** read the payroll journal: wages, taxes and benefits by entity, department and period, built from the payroll import that the signed Time Sheets produce. Two rules:

- **Managers never see pay.** The Workday and Shifts courses say it from their side; here the payroll pages open only for the accounting team and the people with the payroll step-up. A manager sees hours, never rates.
- **Allocations** (a Tools page) spreads the month's wages across entities by each person's hours by work site from the Time Clock, previews the entry, and exports it as an Intacct import; nothing posts from Nexus. The basis is the Time Sheet, which is one more reason the Time Sheet is signed, approved and right.

## A Greens Scenario

Murrieta's manager drills into utilities and finds a $412 electricity bill coded to Murrieta that names the Temecula service address. He asks about the line: "This is Temecula's meter; please move it." The bookkeeper answers the next morning, requests the reclass to Temecula's entity, previews the change and pushes it. The line moves on both sites' statements, the question reads Resolved, and both managers' utilities variances are right again.

## Common Mistakes

- **Asking about a line by email** instead of on the line, where the answer and the fix can live together.
- **Expecting to push a reclass yourself.** Only the bookkeeper pushes.
- **Reading the Manual Journal Entries page as a list of mistakes.** It is a list of hand-made entries; most are right, and the point is that each can be seen.

## Key Points

- Ask My Accountant: suspense lines and questions on any line, Open to Answered to Resolved, with the Other Side shown; a GL Reclass is requested by anyone and pushed only by the bookkeeper.
- Manual Journal Entries lists every hand-keyed entry and change, by whom, for the audit; Profitability compares entities on NOI.
- Payroll reports read the payroll journal; managers never see pay; Allocations spreads wages by hours and exports, never posts.
