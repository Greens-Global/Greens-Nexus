---
title: The Accounting Equation and the Accounts
summary: Assets, liabilities and equity, the equation that always balances, the five kinds of account and what each one holds at a storage company, and how the chart of accounts is organized.
---

## What You'll Be Able to Do

- State the accounting equation and explain why it always balances.
- Sort any item at a storage company into one of five kinds of account: asset, liability, equity, revenue, expense.
- Read a chart of accounts and find the account a transaction belongs in.
- Explain why the same words (deposit, rent, security) mean different things in different accounts.

## The Equation

Everything a business has was paid for by someone. Either the business owes it to somebody (a loan, an unpaid invoice, rent a tenant paid ahead) or it belongs to the owners. That is the whole of the accounting equation:

```figure
{
  "kind": "compare",
  "title": "Assets = Liabilities + Equity",
  "columns": [
    { "name": "Assets", "note": "what the business has", "facts": ["Cash in the bank", "Rent tenants owe", "Prepaid insurance", "Land, buildings, canopies, gate operators", "Less: depreciation taken so far"] },
    { "name": "Liabilities", "note": "what it owes", "facts": ["Vendor invoices not yet paid", "Rent tenants paid ahead", "Payroll earned, not yet paid", "Sales tax collected, not yet remitted", "The mortgage"] },
    { "name": "Equity", "note": "what is the owners'", "facts": ["What the owners put in", "Profits kept in the business over the years", "Less: what was taken out"] }
  ],
  "caption": "The two sides are always equal, because every asset was paid for by a liability or by the owners."
}
```

**Assets = Liabilities + Equity.** The equation balances by construction: a $500,000 building bought with a $400,000 loan and $100,000 of the owners' money is an asset of $500,000 on the left and $400,000 of liability plus $100,000 of equity on the right. When the building earns rent, cash (an asset) goes up and so does equity (the profit belongs to the owners). When a vendor is paid, cash goes down and so does the liability. It never stops balancing.

## The Five Kinds of Account

Revenue and expenses are how equity changes through the year, so accountants track them in their own accounts and roll them into equity at year end. That makes five kinds:

| Kind | What it holds | Normal balance | Storage examples |
|---|---|---|---|
| **Asset** | Things of value the business controls | Debit | Operating cash, tenant receivables, prepaid insurance, land, buildings, site improvements, equipment, accumulated depreciation (a negative asset) |
| **Liability** | What the business owes | Credit | Accounts payable, accrued payroll, prepaid rent (unearned revenue), security deposits held, sales tax payable, notes payable |
| **Equity** | The owners' share | Credit | Owner's capital, retained earnings, distributions |
| **Revenue** | What the business earned in the period | Credit | Rental income, late fees, admin fees, protection plan revenue, merchandise sales, lien sale proceeds |
| **Expense** | What it cost to earn it | Debit | Payroll, payroll taxes, utilities, repairs and maintenance, property tax, insurance, marketing, management fees, depreciation, interest |

"Normal balance" is what the next lesson is about. For now: assets and expenses grow on the debit side; liabilities, equity and revenue grow on the credit side.

## The Chart of Accounts

The **chart of accounts** is the numbered list of every account the company uses. It is organized by kind, so the number tells you what something is before you read its name:

```figure
{
  "kind": "layout",
  "title": "A Chart of Accounts, by Range",
  "cols": 10,
  "rows": 5,
  "regions": [
    { "label": "1000s Assets", "note": "cash, receivables, prepaids, property, equipment, accumulated depreciation", "x": 1, "y": 1, "w": 10, "h": 1 },
    { "label": "2000s Liabilities", "note": "payables, accruals, prepaid rent, deposits, taxes payable, loans", "x": 1, "y": 2, "w": 10, "h": 1 },
    { "label": "3000s Equity", "note": "capital, retained earnings, distributions", "x": 1, "y": 3, "w": 10, "h": 1 },
    { "label": "4000s Revenue", "note": "rental income by product, fees, protection, merchandise, other", "x": 1, "y": 4, "w": 10, "h": 1, "tone": "ok" },
    { "label": "5000s to 8000s Expenses", "note": "payroll, operating, repairs, utilities, insurance, taxes, depreciation, interest", "x": 1, "y": 5, "w": 10, "h": 1 }
  ],
  "caption": "The ranges are the common convention. Greens' own chart, with its account numbers and names, is kept by Accounting."
}
```

A storage company's chart usually breaks rental income into its products (storage units, parking, climate, mailboxes), breaks fees out from rent (late fees, admin fees, lock cutting), and gives repairs and maintenance its own accounts by system so a manager's cost by system can be read without a spreadsheet. Intacct adds **dimensions** on top of the account (which entity, which department, which vendor), so one repairs account can be read per site; the Intacct course covers that.

> [!NOTE]
> **Pending:** Greens' chart of accounts, with the account numbers and names the sites see on their reports, is to be written up as a Library page by Accounting (Charmi), and this lesson is to link it.

## The Same Word, Different Accounts

Plain words hide the account they belong in. Three that trip people up:

| The word | Could be | Which account |
|---|---|---|
| **Deposit** | Cash taken to the bank | An increase in the cash asset |
| | A security deposit a tenant paid | A **liability**: the company holds it and owes it back |
| | A deposit the company paid a vendor | An **asset** (a prepaid) until the work is done |
| **Rent** | Rent earned this month | **Revenue** |
| | Rent a tenant paid for next month | A **liability** (prepaid rent) until next month |
| | Rent the company pays for its own office | An **expense** |
| **Insurance** | The premium Greens pays on the buildings | An **expense**, spread over the policy year through a prepaid asset |
| | What tenants pay for the protection plan | **Revenue** |

When you are not sure, ask two questions: does the company own it or owe it (balance sheet), or did it earn or spend it this period (income statement)?

## A Greens Scenario

A new assistant manager at Escondido takes a tenant's payment on 11/28 for December's rent and a $100 security deposit on a new enclosed unit, and buys a $40 box of printer paper on the office card the same day. Three events, three different homes: the December rent is prepaid rent, a liability, until 12/01; the $100 is a deposit held, a liability, until the tenant moves out; the paper is an office supplies expense. Cash went up by the first two and down by the third, and the equation still balances.

## Common Mistakes

- **Calling every payment revenue.** Rent paid ahead and deposits are liabilities.
- **Reading an account by its name alone.** Read its number and its kind.
- **Treating a big purchase as an expense.** A gate operator is an asset; the Fixed Assets lesson explains why.

## Key Points

- Assets = Liabilities + Equity, always.
- Five kinds of account: assets and expenses grow on the debit side; liabilities, equity and revenue grow on the credit side.
- The chart of accounts is numbered by kind; a storage chart breaks revenue by product and repairs by system.
- The same word can belong in different accounts; ask whether it is owned, owed, earned or spent.
