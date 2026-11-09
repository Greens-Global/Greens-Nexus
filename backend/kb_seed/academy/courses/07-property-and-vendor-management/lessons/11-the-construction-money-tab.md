---
title: The Construction Money Tab
summary: What a manager sees on a Construction job's Money tab - budget, committed, actual, changes, forecast and variance, the commitments - where each figure comes from, and who may see it.
teaches: Construction, Accounting
---

The Temecula canopy job is halfway done, and the regional manager asks one question: "Are we going to come in on budget?" You do not add up invoices in a spreadsheet. You open the job's Money tab, where every figure is read from the books and every amount opens the lines behind it.

## Who Sees It

Money on a Construction job is shown only to the job's own managers and to Manager-tier people in the job's company. Crews never see it, and change order and contract dollars follow the same rule everywhere, including the weekly report and its PDFs. If you cannot see the Money tab on a job, that is the rule working, not a fault.

## Where the Figures Come From

Nobody types money into Nexus. Each job carries an Intacct **Entity** (where it books) and a **Project-Job** code. Actual cost is what Intacct has posted to that Project-Job; Billed to Date on a commitment is read from the same books. A figure that is posted opens its ledger lines when you click it; a figure that is worked out (Remaining, a variance, a share) does not.

## The Figures

```figure
{
  "kind": "screen",
  "title": "A Job's Money Tab",
  "device": "computer",
  "module": "Construction",
  "sub": "Canopy Row C Rebuild",
  "parts": [
    { "kind": "card", "title": "Money", "rows": [
      { "label": "Budget", "value": "$180,000" },
      { "label": "Committed", "value": "$152,400" },
      { "label": "Actual to Date", "value": "$96,250", "n": 1 },
      { "label": "Pending Changes", "value": "$6,800" },
      { "label": "Forecast at Completion", "value": "$186,800", "n": 2 },
      { "label": "Variance", "value": "-$6,800" }
    ] },
    { "kind": "table", "title": "Commitments", "columns": ["Vendor", "Amount", "Billed to Date", "Lien Waiver"], "rows": [
      ["Summit Steel", "$118,000", "$74,000", "Unconditional Progress"],
      ["Valley Electric", "$34,400", "$12,000", "None received yet"]
    ], "n": 3 }
  ],
  "callouts": [
    { "n": 1, "text": "Read from Intacct by the job's Project-Job code. Click it for the ledger lines." },
    { "n": 2, "text": "Worked out: the larger of Budget plus Pending Changes, or what is spent and still owed." },
    { "n": 3, "text": "One row per subcontract or purchase order." }
  ]
}
```

| Figure | What it means |
|---|---|
| **Budget** | The job's contract value plus approved changes, set on Edit Job |
| **Requested, Not Yet Billed** | Reimbursements on the job that were approved but have not reached the books yet |
| **Committed** | The live subcontracts and purchase orders |
| **Actual to Date** | What Intacct has posted to the job |
| **Approved Changes** / **Pending Changes** | Change orders approved, and those still waiting |
| **Forecast at Completion** | The larger of: Budget plus Pending Changes, or Actual to Date plus commitments not billed yet plus Requested, Not Yet Billed |
| **Variance** | Budget less the forecast; red when the job is heading over |
| **Cost per Unit** / **Cost per Square Foot** | The job's cost over its units and square feet, for comparing jobs |

## Commitments

A **commitment** is a subcontract or purchase order with one Intacct vendor on the job. The Commitments table shows each one's **Number**, **Vendor**, **Scope**, **Amount**, **Billed to Date** (read from the books, never typed), **Remaining**, **Retainage Held** and **Lien Waiver** (see the lesson Lien Waivers). Three rules:

- **A new amount needs a reason**, kept with the before and after.
- **Nothing is deleted.** A commitment that ends is **Void**, and stays on the record.
- **Vendors are Intacct's.** A sub on the job is an Intacct vendor with its papers on the Compliance tab; there is no Construction vendor directory.

## Reading It Like a Manager

- **Forecast above Budget** is the headline. Find which commitment or change drives it.
- **Pending Changes** are tomorrow's overrun. Push for a decision before the work is done.
- **Billed to Date close to Amount** on a commitment with work still open is a question for the sub before the next invoice.
- **Actual to Date that looks wrong** is a ledger question: click it, read the lines, and ask Accounting about a line that does not belong.

## At Greens

The Money tab shows Actual to Date $96,250, with $66,400 of the commitments not billed yet: spent and owed is $162,650, well inside the $180,000 Budget. But a $6,800 change for a revised footing is still pending, so the Forecast at Completion reads $186,800 and the Variance is -$6,800. The manager's answer is one line: "On budget except the footing change, which needs a decision this week." While there, he clicks Actual to Date, finds a camera invoice coded to the job by mistake, and asks Accounting to recode it.

## Common Mistakes

- **Keeping a shadow spreadsheet** of the job's costs.
- **Treating Pending Changes as settled.**
- **Typing a billed figure** instead of asking why the books differ.
- **Sharing the Money tab's figures** with a crew member who cannot see them.

## Key Points

- Money shows only to the job's managers and Manager-tier people in its company; crews never see it.
- Every figure is read from Intacct by the job's Project-Job code; posted figures drill to their lines.
- Forecast at Completion against Budget is the headline; Pending Changes are the early warning.
- Commitments are one per vendor, changed with a reason, voided, never deleted.
