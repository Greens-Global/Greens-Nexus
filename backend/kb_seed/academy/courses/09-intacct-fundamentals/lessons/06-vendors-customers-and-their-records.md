---
title: Vendors, Customers and Their Records
summary: The Records menu - vendors and customers as Intacct holds them, the four tabs of a vendor record, how a change to a record is requested and approved and waits as Approved - Awaiting Intacct, why a commercial lease tenant is an Intacct customer, and the chart of accounts and journals pages.
teaches: Accounting
---

A gate vendor calls Temecula: they moved, and their checks are going to the old address. The manager opens the vendor in Nexus, sees the old address on the Details tab, and changes it. The vendor's record in Intacct does not change. Not yet. This lesson is what happens instead, and why.

## Vendors

**Accounting > Records > Vendors** lists every vendor in the ledger, number first. Click a row and the record opens beside the list with four tabs:

| Tab | What it holds |
|---|---|
| **Details** | Intacct's record in four groups: Basic Details (name, status), Contact, Address, Billing (terms, the last four of the tax ID) |
| **Ledger Lines** | Every line posted to this vendor across the entities you may read; each opens its entry |
| **Change History** | Every change requested in Nexus, who decided it and when |
| **Compliance** | The insurance certificate, workers comp and license expiry dates and the W-9, with one state word: Papers Current, Expiring Soon, Expired or No Insurance On File |

Inactive vendors are hidden until **Customize > Show Inactive**.

This is the vendor Accounting **pays**. Asset Management also has a **Records > Vendors** list on each property: that one is the property's own list of who services it (contact, contract dates, COI expiration). It is useful on site; it is not the paying record.

## Changing a Record

Intacct stays the source of truth, one way. So editing a vendor in Nexus does not change the vendor. It files a **change request** with only the fields that differ, and the record walks through these words:

```figure
{
  "kind": "steps",
  "title": "A Change Request",
  "items": [
    { "label": "Pending Approval", "note": "filed; the approvers get a bell" },
    { "label": "Approved - Awaiting Intacct", "note": "the record shows the new values with an Awaiting Intacct badge" },
    { "label": "In Intacct", "note": "Accounting keyed it into Intacct" }
  ]
}
```

- **Pending Approval**: a manager with the Accounting grant, or someone at its Full level, approves or declines it from the **Requests** section. The person who asked gets a bell either way.
- **Approved - Awaiting Intacct**: the record shows the new values with an **Awaiting Intacct** badge until Accounting keys them into Intacct.
- **In Intacct** once it is keyed. **Changed In Intacct** means Intacct holds a value different from what was approved, so look before acting. **Declined** carries the decider's note.

A **brand-new vendor** is set up in Intacct by your Accounting team. Send them the vendor's papers (license, insurance naming Greens, workers comp, W-9) before the first visit; no invoice is paid to a name the ledger does not have.

## Customers

**Records > Customers** works the same way, with Details, Ledger Lines and Change History. Most tenants are not Intacct customers at all: their rent is billed and taken in Cubby and reaches the books through the bank. The exception is a **commercial lease**: that tenant is an Intacct customer, and MRI reads rent received as what posted to the lease's income accounts for that customer in that month (see the lesson The Recurring Picture: MRI, MRE, Loans and Fees). Nobody keys a lease payment into Nexus.

## Accounts and Journals

- **General Ledger Accounts** is the chart of accounts as the ledger holds it: search it, Show Inactive, export it.
- **Journals** opens each journal's lines for a period (see the lesson Journals and Books).

## At Greens

Back to the moved vendor. The manager's edit reads Pending Approval; that afternoon an approver approves it and the record shows the new address with Awaiting Intacct. The next morning Accounting keys it, the badge clears, and the next check goes to the right place.

## Common Mistakes

- **Assuming an edit changed Intacct.** It filed a request.
- **Paying attention only to Approved.** Awaiting Intacct means checks still use the old values until it clears.
- **Letting a new vendor work before Accounting sets it up.**
- **Treating a property's Asset Management vendor list as the paying record.**

## Key Points

- A vendor record: Details, Ledger Lines, Change History, Compliance.
- An edit is a request: Pending Approval, then Approved - Awaiting Intacct, then In Intacct.
- A new vendor is set up in Intacct by Accounting, papers first.
- Most tenants live in Cubby; a commercial lease tenant is an Intacct customer.
