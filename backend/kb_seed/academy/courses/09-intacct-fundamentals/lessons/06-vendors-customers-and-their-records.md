---
title: Vendors, Customers and Their Records
summary: The Records group - vendors and customers as Intacct holds them, what Nexus adds (requests, ledger lines, change history, compliance), how a new vendor is requested and approved, why a leasing tenant is an Intacct customer, and the General Ledger Accounts and Journals pages.
---

## What You'll Be Able to Do

- Open a vendor's record and read its details, its ledger lines, its change history and its papers.
- Request a new vendor and follow it to Approved, Awaiting Intacct.
- Explain why a leasing tenant is an Intacct customer and what that means for rent received.
- Use the General Ledger Accounts and Journals pages as references.

## Vendors

**Records > Vendors** lists every vendor in the ledger the person may read, with the accounting team's own fields beside Intacct's. A vendor record opens beside the list with four tabs:

```figure
{
  "kind": "screen",
  "title": "A Vendor Record",
  "device": "computer",
  "module": "Accounting",
  "sub": "Vendors & Customers",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Records",
  "parts": [
    { "kind": "list", "title": "Vendors", "items": [{ "label": "Precision Gate Co.", "note": "V-00418 · gate and access control · Temecula, Murrieta", "badge": "Active", "tone": "ok" }, { "label": "Inland Door Service", "note": "V-00392 · roll-up doors", "badge": "Active", "tone": "ok" }, { "label": "Summit Roofing (request)", "note": "requested by D. Reyes 11/06/2026", "badge": "Pending Approval", "tone": "warn", "n": 1 }] },
    { "kind": "sheet", "title": "Precision Gate Co.", "text": "Details · Ledger Lines · Change History · Compliance",
      "items": [{ "label": "Details", "note": "V-00418 · category: Repairs and Maintenance · terms Net 30 · 1099: yes" }, { "label": "Ledger Lines", "note": "every line posted to this vendor, across the entities you may read, drilling to each entry", "n": 2 }, { "label": "Change History", "note": "who changed what on this record, when" }, { "label": "Compliance", "note": "insurance certificate 12/14/2026 · workers comp 03/01/2027 · license C-61 · W-9 on file", "badge": "Expiring Soon", "tone": "warn", "n": 3 }] }
  ],
  "callouts": [{ "n": 1, "text": "A new vendor is requested here and waits for the accounting team: Pending Approval, then Approved, Awaiting Intacct until the record exists in the ledger." }, { "n": 2, "text": "The same ledger lines a report drills to, gathered for one vendor." }, { "n": 3, "text": "The papers the Property & Vendor Management course taught; one row per vendor, read here and on a construction job's Subs tab alike." }]
}
```

| Tab | What it holds |
|---|---|
| **Details** | Intacct's record: code, name, category, terms, 1099 status, the accounting team's notes |
| **Ledger Lines** | Every line posted to this vendor across the entities you may read; each opens its entry |
| **Change History** | Who changed what on the record and when |
| **Compliance** | The insurance certificate, workers comp and license expiries and the W-9; the one state word (Expiring Soon, Expired, No Insurance On File) |

Nothing on the Details tab is edited in Nexus; it is Intacct's. Compliance and the notes are Nexus's own, kept beside the ledger.

### Requesting a Vendor

A site that needs a vendor the ledger does not have asks for one under **Requests**: the name, the trade, the contact and the papers. The request reads **Pending Approval** until the accounting team approves it, then **Approved, Awaiting Intacct** until the record exists in the ledger, and then the vendor is a vendor. No invoice is paid to a name that is only a request, which is why the Vendors lesson in the Property & Vendor Management course said to collect the papers before the first visit.

## Customers

**Records > Customers** is the mirror: the customers the ledger bills through receivables. At Greens most tenants are not Intacct customers at all; their rent is billed and collected in Cubby and reaches the ledger as deposits. The exception is **leasing**: a commercial tenant on a lease is an Intacct customer, invoiced through receivables, and the Leasing records under MRI (the Recurring Picture lesson) read rent received as what posted to the lease's income accounts for that customer in that month. Nobody keys a lease payment into Nexus; the ledger says what arrived.

## General Ledger Accounts and Journals

Two more reference pages under Records:

- **General Ledger Accounts** is the chart of accounts as the ledger holds it: number, name, kind, whether it is active, and the lines posted to it for the period you pick. When the Fundamentals of Accounting course said "learn Greens' chart," this is where it is read.
- **Journals** lists the journals (the Journals and Books lesson), and each one opens to its entries for a period, so "what posted through payroll last month" is one click.

## A Greens Scenario

Dana at Temecula needs a roofer the ledger has never paid. She collects the license, the certificate naming Greens, the workers comp and the W-9, and files the request under Records > Vendors with the trade and the contact. Two days later it reads Approved, Awaiting Intacct; the next morning Summit Roofing is a vendor with a code, its Compliance tab shows the papers she filed, and the roofer's first invoice can be matched and paid.

## Common Mistakes

- **Letting a vendor work before it is a vendor.** A request is not a record.
- **Trying to edit Intacct's fields in Nexus.** Details are the ledger's.
- **Keying a lease payment.** Rent received is read from the ledger, never typed.

## Key Points

- A vendor record has Details (Intacct's), Ledger Lines, Change History and Compliance (Nexus's); a new vendor is requested, approved, then created in Intacct.
- Most tenants live in Cubby; a leasing tenant is an Intacct customer and rent received is what posted.
- General Ledger Accounts and Journals are reference pages: the chart as the ledger holds it, and each journal's entries.
