---
title: "The Recurring Picture: MRI, MRE, Loans and Fees"
summary: The Nexus records that keep what is expected beside what the ledger says happened - Monthly Recurring Income, Monthly Recurring Expenses, Loans with the Stress Test and Loan Planning, and Management Fees - and which of them a manager uses.
teaches: Accounting
---

Fairfield's pest control line in MRE shows Missed for two months running. Nobody sent an alarm, and the ledger did not complain: no bill, no line. The empty month beside the expected one is the alarm. This lesson is the records that keep "what should happen" beside "what did".

## Expected Beside Actual

The ledger records what happened. Some questions need what is expected too: which income should arrive every month, which bills recur, what a loan will cost. Nexus keeps those expectations as its own records and reads the ledger for the actual. Nothing here posts to Intacct.

```figure
{
  "kind": "compare",
  "title": "MRI and MRE",
  "columns": [
    { "name": "MRI", "note": "Monthly Recurring Income", "facts": ["Every lease, interest and loan payment coming in", "Actual = what posted to its income accounts for that customer", "A month with nothing posted shows itself"] },
    { "name": "MRE", "note": "Monthly Recurring Expenses", "facts": ["One vendor one entity pays on a schedule", "Actual = what posted for that vendor", "Each month: Paid, Short, Over, Missed or Upcoming"] }
  ]
}
```

Both are under **Trackers**.

## MRI: Monthly Recurring Income

**MRI** is one list of every source of income that recurs: a commercial lease, interest coming in, a loan payment owed to a Greens entity. Each line names its entity, the counterparty (a lease tenant is an Intacct customer), the income accounts, the schedule and the amount expected. The actual is **read from the ledger**, never keyed. A lease payment that did not arrive is seen without anyone typing anything.

A tenant who leaves a lease is **ended**, never overwritten, so the history stands; a new tenant is a new line. Nothing is emailed to a tenant from here.

## MRE: Monthly Recurring Expenses

**MRE** is the expense side: one vendor, one entity, paid on a schedule (a gate service contract, pest control, software). Each month is marked against what was expected:

- **Paid**: the amount arrived, within the line's Variance %.
- **Short** or **Over**: something posted, but less or more than expected.
- **Missed**: nothing posted when something should have.
- **Upcoming**: not due yet.

Missed usually means a contract lapsed or a vendor stopped billing. Over usually means a price moved. Both are a manager's question before they are a budget surprise. Loan payments do not belong in MRE; they are Loans.

## Loans

**Financing > Loans** holds every loan: lender, loan number, entity, monthly payment, balance, principal and interest paid, debt service, rate, maturity and **DSCR** (debt service coverage: net operating income divided by debt service, the figure lenders watch). Payments are read from the ledger.

- **Stress Test** shows what a higher rate does to each loan, or across the portfolio.
- **Loan Planning** has a Mortgage Calculator, the DSCR check for an entity, and Planned Loans to compare.

A lender's quarterly statements are a Package (see the lesson The Reports and the Drill-Down).

## Management Fees, Intercompany, Investments

| Page | What it is |
|---|---|
| **Management Fees** | The agreements under which one Greens entity manages another: each managed entity's revenue from the ledger, the fee it works out to, Billed YTD against Expected YTD |
| **Intercompany** | Balances between Greens entities, which are removed when the company is added up |
| **Investments** | Holdings and their activity |

A manager reads these rarely. Know the words: a **management fee** on a property's Income Statement is the fee the operating company charges that property for running it.

## At Greens

Back to Fairfield's pest control. The manager calls the vendor: their billing contact changed, the contract lapsed, and the bait stations have not been checked since. The contract is renewed, the preventive schedule in Asset Management is put right, and next month the line reads Paid.

## Common Mistakes

- **Keying an actual into MRI or MRE.** Actuals are read; only the expectation is kept.
- **Putting a loan payment in MRE.** That is Loans.
- **Overwriting a lease** instead of ending it and adding the new tenant.
- **Ignoring Missed** because "the ledger looks fine." A missing bill looks fine.

## Key Points

- MRI and MRE keep the expected beside the actual read from the ledger.
- MRE marks each month Paid, Short, Over, Missed or Upcoming.
- Loans read payments from the ledger; Stress Test and Loan Planning work from the terms.
- A management fee is what the operating company charges a property for running it.
