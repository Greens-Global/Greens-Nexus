---
title: "Dimensions: Reading One Account Many Ways"
summary: Intacct's dimensions - entity, department, vendor, customer, employee, Project-Job, item - what each one is at Greens, how they turn one repairs account into a report by site or by vendor, and how every Nexus report filters by them.
---

## What You'll Be Able to Do

- Name Intacct's dimensions and say what each one means at Greens.
- Explain why one account can be read by site, by vendor or by job without a separate account for each.
- Use the dimension filters on a Nexus report and read a Buckets report.
- Know what the site must put on a ticket so a transaction is coded right.

## One Account, Many Tags

In a simple ledger, reading repairs by site would need a repairs account for every site. Intacct does it differently: there is one repairs account, and every transaction posted to it carries **dimensions**, tags that say where and what it was for. A report can then slice the account by any tag.

```figure
{
  "kind": "steps",
  "title": "One Ledger Line, Fully Tagged",
  "items": [
    { "label": "Account", "note": "6210 Repairs and Maintenance, Gate and Access" },
    { "label": "Entity", "note": "15001 Greens Storage Temecula" },
    { "label": "Department", "note": "Operations" },
    { "label": "Vendor", "note": "V-00418 Precision Gate Co." },
    { "label": "Project-Job", "note": "blank for a repair; a job code for construction" },
    { "label": "Journal", "note": "APJ, the payables journal" }
  ],
  "caption": "Every tag is a filter on every report. The account says what; the dimensions say where, who and for which job."
}
```

| Dimension | What it is at Greens | What it lets you read |
|---|---|---|
| **Entity (location)** | The company, property or sub-entity | A site's statements; a site's cost by account |
| **Department** | The part of the business: Operations, Accounting, Construction, Marketing | Payroll and cost by department |
| **Vendor** | The Intacct vendor record | What a vendor was paid, across sites; Billed to Date on a job |
| **Customer** | The Intacct customer record; a leasing tenant is one | Rent received on a lease; a customer's balance |
| **Employee** | The person a payroll or expense line belongs to | Payroll by person on the payroll reports; reimbursements |
| **Project-Job** | A construction job's code | Everything a job cost, however many vendors |
| **Item** | A product or service line where the ledger uses them | Merchandise, fee types |
| **Journal** | Which journal the entry posted through | Payables, receivables, payroll, general, user-defined, statistical |

## Why the Site's Coding Matters

A dimension is only as right as the coding the bookkeeper could give the transaction, and the bookkeeper codes from what the site sent. The Getting the Work Done lesson (Property & Vendor Management) and the Payables lesson (Fundamentals of Accounting) said it from their sides; here it is from the ledger's:

| On the ticket or invoice | Becomes |
|---|---|
| The property | The entity |
| The team or department the work was for | The department |
| The vendor's name as Accounting holds it | The vendor |
| The construction job, where it is one | The Project-Job |
| The scope, line by line | The account (repair or capital; which system) |

A gate repair billed with no ticket number is coded to the account the invoice suggests and the entity the vendor usually serves. Right nine times in ten; the tenth time it lands on the wrong site and shows up as a surprise on someone's report.

## The Filters on Every Report

Every report page in Nexus Accounting carries the dimensions as filters: pick one or several entities, departments, vendors, customers, employees, Project-Jobs or items, and the journals to include. The figures re-read for that slice, and the drill-down shows only its lines. Filters are what make the same Income Statement serve a site manager (one entity), the construction manager (one Project-Job) and the controller (every entity, the payroll journal only).

## Buckets

```figure
{
  "kind": "screen",
  "title": "Buckets, by Vendor, for One Site",
  "device": "computer",
  "module": "Accounting",
  "sub": "Reports",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Reports",
  "actions": ["Entity: Temecula", "Period: This Year", "Book: Accrual"],
  "parts": [
    { "kind": "table", "title": "Repairs and Maintenance, by Vendor", "columns": ["Vendor", "Lines", "Amount", "Share"], "rows": [
      ["Precision Gate Co.", "9", "$6,840.00", "31%"], ["Inland Door Service", "14", "$5,120.00", "23%"], ["SafeGuard Fire Protection", "3", "$3,300.00", "15%"], ["Valley Paving", "2", "$2,900.00", "13%"], ["Others (6)", "11", "$3,960.00", "18%"]], "n": 1 },
    { "kind": "card", "note": "Every amount opens its ledger lines; every line opens its entry. Columns resize and keep your widths.", "n": 2 }
  ],
  "callouts": [{ "n": 1, "text": "Buckets groups an account's lines by one dimension: vendor, customer, department, Project-Job, item or entity." }, { "n": 2, "text": "The drill-down rule, everywhere: a posted figure is never a dead end." }]
}
```

**Buckets** is the report that makes a dimension visible: pick an account (or a group of accounts) and a dimension, and the lines are grouped by it. Repairs by vendor tells a manager which vendor costs most; payroll by department tells the controller where the people are; cost by Project-Job tells a construction manager what a job has spent. Every bucket drills to its lines.

## A Greens Scenario

The construction manager asks what the Temecula canopy job has cost so far across all its vendors. One filter: the job's Project-Job code. The Income Statement and the Buckets report both read only that job's lines: the canopy vendor, the electrician who moved the lights, the striping vendor who redid the row. The same figures appear on the job's Money tab in Construction, because that tab reads the same ledger by the same code.

## Common Mistakes

- **Asking Accounting for a new account** when a dimension filter answers the question.
- **A ticket with no property or job on it.** The dimension cannot be coded from nothing.
- **Reading a Buckets total without the entity filter** and comparing it to a site's budget.

## Key Points

- Intacct keeps one account and tags every line with dimensions: entity, department, vendor, customer, employee, Project-Job, item, journal.
- The site's ticket is where the coding starts: property, team, vendor, job, scope.
- Every Nexus report filters by dimension; Buckets groups an account's lines by one of them; everything drills down.
