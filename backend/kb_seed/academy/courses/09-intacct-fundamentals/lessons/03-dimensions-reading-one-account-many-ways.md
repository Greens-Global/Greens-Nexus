---
title: "Dimensions: Reading One Account Many Ways"
summary: Intacct's dimensions - entity, department, vendor, customer, employee, Project-Job, item, journal - what each means at Greens, how one account is read by site, vendor or job without a new account for each, and what the ticket must carry so a line is coded right.
teaches: Accounting
---

The construction manager asks what the Temecula canopy job has cost so far, across every vendor on it. Nobody opens a spreadsheet. One filter on one report answers it, because every line in the ledger carries tags. This lesson is those tags.

## One Account, Many Tags

A simple ledger would need a repairs account for every site to read repairs by site. Intacct keeps one repairs account, and every line posted to it carries **dimensions**: tags that say where, who and for what. A report can then slice the account by any tag.

| Dimension | What it is at Greens | What it lets you read |
|---|---|---|
| **Entity** | The company or property | A property's statements and costs |
| **Department** | The part of the business the cost is for | Cost and payroll by department |
| **Vendor** | The Intacct vendor record | What one vendor was paid, across properties |
| **Customer** | The Intacct customer; a commercial lease tenant is one | Rent received on a lease |
| **Employee** | The person a payroll or expense line belongs to | Payroll and reimbursements by person |
| **Project-Job** | A Construction job's code | Everything one job cost, however many vendors |
| **Item** | A product or service line, where used | Merchandise, fee types |
| **Journal** | Which journal the entry came through | Payables only, payroll only, hand-keyed only |

## Why the Site's Coding Matters

The bookkeeper codes from what the site sent. What is on the ticket and the invoice becomes the tags:

| On the ticket or invoice | Becomes |
|---|---|
| The property | The entity |
| The team the work was for | The department |
| The vendor's name as Accounting holds it | The vendor |
| The Construction job, if it is one | The Project-Job |
| The scope, line by line | The account (repair or capital, which system) |

An invoice with no ticket number gets coded from guesses: the account the invoice suggests, the property the vendor usually serves. Most of the time that is right. The rest of the time a cost lands on the wrong site and surprises someone's report.

## The Filters on Every Report

Every report page has **Filters** for department, vendor, customer, employee, Project-Job, item and journal, beside the entity picker. The figures read again for that slice, and the drill-down shows only its lines. The same Income Statement then serves a property manager (one entity), a construction manager (one Project-Job) and the controller (every entity, payroll journal only).

Some reports are a dimension already laid out for you:

- **Reports > Financial > Income Statement** has views by Customer, by Job and by Department, a column each.
- **Reports > Financial > Spend by Vendor** groups what was spent by vendor.

```figure
{
  "kind": "screen",
  "title": "Spend by Vendor, One Property",
  "device": "computer",
  "module": "Accounting",
  "sub": "Financial",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Reports",
  "actions": ["Entity: Temecula", "This Year", "Filters"],
  "parts": [
    { "kind": "table", "columns": ["Vendor", "Amount"], "rows": [
      ["Ridgeline Gate Co.", "$6,840.00"], ["Inland Door Service", "$5,120.00"], ["Coastal Fire Safety", "$3,300.00"], ["Valley Paving", "$2,900.00"]], "n": 1 }
  ],
  "callouts": [{ "n": 1, "text": "Every amount opens the lines behind it." }]
}
```

## At Greens

Back to the canopy job. The construction manager opens Income Statement by Job, filters to the job's Project-Job code, and reads the canopy vendor, the electrician who moved the lights and the striping vendor, each drilling to its invoices. The job's Money tab in Construction shows the same figures, because it reads the same ledger by the same code.

## Common Mistakes

- **Asking Accounting for a new account** when a filter answers the question.
- **A ticket with no property or job on it.** A tag cannot be coded from nothing.
- **Comparing a whole-company vendor total to one property's budget.** Pick the entity first.

## Key Points

- One account, many tags: entity, department, vendor, customer, employee, Project-Job, item, journal.
- The ticket is where coding starts: property, team, vendor, job, scope.
- Filters slice every report; Income Statement by Job or by Department and Spend by Vendor lay a tag out for you.
