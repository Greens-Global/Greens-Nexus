---
title: "The Recurring Picture: MRI, MRE, Loans and Fees"
summary: The Nexus records that sit beside the ledger and read it - Monthly Recurring Income, Monthly Recurring Expenses, Loans with their planning, Management Fees, Intercompany and Investments - what each holds, what it reads from the ledger and what a manager uses it for.
---

## What You'll Be Able to Do

- Say what MRI and MRE are, what each line holds, and where the actual figures come from.
- Read a loan's record, its amortization and its planning, and know what a Package has to do with it.
- Explain management fees, intercompany and investments in one sentence each.
- Know which of these a site manager touches and which belong to the accounting team.

## Records Beside the Ledger

The ledger records what happened. Some questions need what is **expected** too: what income should arrive every month, what expenses recur, what each loan will cost next year. Nexus keeps those expectations as its own records, beside the ledger, and reads the ledger to fill in what actually happened. Nothing here posts to Intacct; everything here reads from it.

```figure
{
  "kind": "compare",
  "title": "Expected Beside Actual",
  "columns": [
    { "name": "MRI, Monthly Recurring Income", "note": "what should come in", "facts": ["Every lease, every interest or loan payment coming in", "Type, entity, counterparty, accounts, schedule, amount expected", "Actual = what posted to the income accounts that month", "A missing month shows itself"] },
    { "name": "MRE, Monthly Recurring Expenses", "note": "what should go out", "facts": ["One vendor an entity pays from the same expense accounts on a schedule", "Monthly, quarterly or annual; the amount expected; a category", "Actual = what posted to those accounts for that vendor", "Debt service belongs to Loans, not here"] }
  ]
}
```

## Monthly Recurring Income

**MRI** is one list of every source of income that recurs: a lease on a commercial space, interest coming in, a loan payment owed to a Greens entity. Each line names its type, its entity, the counterparty (a leasing tenant is an Intacct customer, the previous lesson), the income accounts it posts to, its schedule and the amount expected. Each month the line's actual is **read from the ledger**: what posted to those accounts for that customer. A month with nothing posted shows as missing, which is how a lease payment that did not arrive is seen without anyone keying anything.

A tenant who leaves a lease is **ended**, never overwritten, so the history stands; a replacement tenant is a new line. Nothing is emailed to a tenant from here.

## Monthly Recurring Expenses

**MRE** is the expense side: a line is one vendor that one entity pays from the same expense accounts on a schedule (the gate service contract, the pest control contract, the insurance premium, software), with the amount expected each time, a category and notes. The actual is read from the ledger the same way. A line whose actual stops arriving is a contract that lapsed; one whose actual grows is a vendor whose price moved, and both are a manager's question before they are a budget surprise. Debt service is not here; it is Loans.

## Loans

```figure
{
  "kind": "screen",
  "title": "Financing, Loans",
  "device": "computer",
  "module": "Accounting",
  "sub": "Financing",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Financing",
  "parts": [
    { "kind": "table", "title": "Loans", "columns": ["Loan", "Entity", "Lender", "Balance", "Rate", "Payment", "Matures"], "rows": [
      ["Temecula first mortgage", "15001", "Regional Bank", "$4,180,000", "6.10% fixed", "$29,400 monthly", "06/2031"],
      ["Murrieta first mortgage", "15002", "Regional Bank", "$2,640,000", "5.85% fixed", "$18,950 monthly", "03/2030"],
      ["Fairfield line of credit", "15003", "Community Bank", "$310,000", "Prime + 1.00%", "Interest only", "12/2027"]], "n": 1 },
    { "kind": "card", "title": "Temecula first mortgage", "rows": [{ "label": "Amortization", "value": "Schedule through maturity, principal and interest by month" }, { "label": "Planning", "value": "Refinance in 2029 at 5.50%: saves $1,900 a month" }, { "label": "Stress", "value": "At 8.00%: payment $33,100; debt service coverage 1.32" }, { "label": "Lender package", "value": "Quarterly statements, built from Packages", "tone": "ok" }], "n": 2 }
  ],
  "callouts": [{ "n": 1, "text": "Illustrative loans. Each one reads its payments from the ledger and keeps its own terms, schedule and planning here." }, { "n": 2, "text": "Amortization, planning and stress are worked out from the terms, never posted; the lender's quarterly set is a Package." }]
}
```

**Financing > Loans** holds every loan: its entity, lender, terms, the amortization schedule, and what has been paid as the ledger shows it. Two tools sit on each loan: **Planning** (what a refinance, a paydown or a new draw would do) and **Stress** (what a higher rate does to the payment and to the debt service coverage the lender watches). The lender's quarterly reporting is a Package (the Reports lesson) built for that property.

## Management Fees, Intercompany, Investments

| Page | What it is | Who uses it |
|---|---|---|
| **Management Fees** | The asset management agreements between Greens entities: which entity manages which, the fee rate, what has been billed this year, the next billing, the agreement document | The accounting team; owners |
| **Intercompany** | Balances and transactions between Greens entities (one entity paying another's bill, a loan from one to another), which consolidation removes | The accounting team |
| **Investments** | Holdings and their activity, where an entity has them | The accounting team; owners |

A site manager reads none of these in the normal week; they are here so the course names them and so a manager who meets "management fee" on a site's income statement knows what it is: the fee the operating company charges a property entity for running it.

## A Greens Scenario

Fairfield's MRE line for pest control shows no actual for two months. The manager calls the vendor: the contract lapsed when the vendor's billing contact changed and nobody noticed; bait stations have not been checked since. The contract is renewed, the preventive schedule in Asset Management is corrected, and the MRE line fills again the following month. The ledger did not shout; the expectation beside it did.

## Common Mistakes

- **Keying an actual into MRI or MRE.** Actuals are read; only the expectation is kept.
- **Putting a loan payment in MRE.** Debt service is Loans.
- **Overwriting an ended lease** instead of ending it and adding the new tenant.

## Key Points

- MRI and MRE keep what is expected to recur and read the ledger for what actually posted; a missing month shows itself.
- Loans hold terms, amortization, planning and stress, and read their payments from the ledger; the lender's quarter is a Package.
- Management fees, intercompany and investments are the accounting team's pages; know the words when they appear on a statement.
