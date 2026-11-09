---
title: Ask My Accountant and the Audit Pages
summary: How a question about a ledger line is asked and answered on AMA, how a reclass is sent to the bookkeeper who alone previews and pushes it, and what Manual Journal Entries, Profitability and the Payroll & People reports show and to whom.
teaches: Accounting
---

Murrieta's manager drills into utilities and finds a $412 electricity bill on her property that names Temecula's service address. She cannot fix the ledger, and she should not email a screenshot. She clicks the question mark at the end of the line. Here is what happens next.

## AMA: Ask My Accountant

Every ledger has lines nobody could code with confidence: a card charge with no receipt, a deposit nobody recognized. They are parked on a suspense account called **Ask My Accountant**. The page for them is **Reports > Audit & Insights > AMA**, and it holds two kinds of row:

- every line on the Ask My Accountant account for the period, and
- every line anyone asked about, from a report's drill-down, the search box or a journal entry.

## Asking

1. Find the line (drill into a figure, or use the search box at the top right).
2. Click the **question mark** at the end of the line.
3. Type the question, check the accountant it goes to, and **Send Question**. They get a bell.

Follow it on AMA. The status filter is **Open**, **Answered**, **Resolved** or **All**; the Whose filter is **Everyone**, **Assigned To Me**, **Asked By Me** or **Awaiting Bookkeeper**. A row opens its thread, with **Resolve** (and the account the line was moved to) and **Reopen**.

## Fixing the Account: the Reclass

```figure
{
  "kind": "steps",
  "title": "A Reclass, Start to Finish",
  "items": [
    { "label": "Pick GL", "note": "the right account, and a vendor or customer if needed" },
    { "label": "Send To Bookkeeper", "note": "the line reads Awaiting Bookkeeper" },
    { "label": "Preview Change", "note": "the bookkeeper sees before and after; amounts never change" },
    { "label": "Approve & Push To Intacct", "note": "the original entry is edited and read back; the line is Resolved" }
  ]
}
```

On AMA each line shows its **Other Side**: every account on the other side of the entry, the bank or card the money came from or went to. Type what you know in the line's **Notes**; it saves when you click away and the bookkeeper sees it.

**Pick GL** names the account the line should move to, then **Send To Bookkeeper**. Only a bookkeeper reviews it: they change it, **Send Back** with a note, or **Preview Change**, which reads the original entry and shows exactly what changes. **Approve & Push To Intacct** then edits that entry in Intacct and reads it back to confirm. **Push Reclasses** does a few lines at once, never more than the limit set for the server. Every push is logged, before and after.

This is the one place Nexus changes Intacct, and only the bookkeeper can do it. Anyone may ask; the accounting team decides.

## Manual Journal Entries

**Reports > Audit & Insights > Manual Journal Entries** lists only the entries a **person** keyed in Intacct, not the ones the bank feed and rules create, with who created each one and who last changed it. A system entry a person later changed is marked **Changed by a Person**. Filter by period, entities, journals and user; group by user.

This is segregation of duties made readable. A month that is mostly system entries has a short manual list; a long one is a question to ask, not proof of a mistake.

## Profitability

**Profitability** shows, per entity, revenue, NOI, interest, depreciation, net income, debt service and cash flow after debt service, against the same period a year earlier. Click a figure for the accounts behind it.

## Payroll & People

**Compensation** (hours and gross wages per employee from Time Clock) and **Payroll Summary** (built from the payroll imported into the payroll journal) open only at the Accounting grant's **Full** level, and Compensation asks you to confirm it is you. Managers see hours elsewhere in Nexus, never pay here.

## At Greens

Back to the $412 bill. The manager asks: "This is Temecula's meter; please move it." The account is right; the entity is wrong, which is not something Pick GL changes. The bookkeeper answers the next morning, corrects the entry in Intacct and resolves the question. After the next Sync the bill sits on Temecula's statement, and the thread stays on the line for anyone who asks again.

## Common Mistakes

- **Asking by email** instead of on the line, where the answer and the fix live together.
- **Expecting to push a reclass yourself.** Only a bookkeeper pushes.
- **Reading Manual Journal Entries as a list of errors.** It is a list of hand-made entries.

## Key Points

- AMA holds suspense lines and every question asked on a line: Open, Answered, Resolved.
- A reclass is Pick GL, Send To Bookkeeper, Preview Change, Approve & Push To Intacct; only the bookkeeper pushes.
- Manual Journal Entries shows every hand-keyed or hand-changed entry and who did it.
- Payroll reports open only at Full level; managers never see pay there.
