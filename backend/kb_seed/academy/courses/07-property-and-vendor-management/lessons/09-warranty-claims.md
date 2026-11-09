---
title: Warranty Claims
summary: Where warranties live in Nexus (a property's Records > Warranties, equipment on its Item record), reading a warranty's status, and making the claim before anyone pays to fix a covered failure.
teaches: Asset Management, Item Management
---

The gate operator Murrieta replaced last spring stops mid-cycle. The gate vendor can come today and fix it for $1,100. Before you approve that, one question decides who pays: is the operator still under warranty? If it is, the first call is a claim, not a repair.

## Where Warranties Live

There is one place for each kind of warranty, never a second list:

| What is covered | Where its warranty lives |
|---|---|
| The property: a roof, a canopy row, a building's HVAC, a gate operator built into the site | The property's **Records > Warranties** in Asset Management |
| Equipment Greens owns and tracks: a pressure washer, a camera recorder, a skid steer | The equipment's own record in **Item Management**, with its serial number |

Most property warranties arrive in a closeout package after a Construction job or a big repair. File them the week they arrive, while the paper is in hand.

## Reading a Warranty Record

```figure
{
  "kind": "screen",
  "title": "Records: Warranties",
  "device": "computer",
  "module": "Asset Management",
  "sub": "Portfolio",
  "tabs": ["Overview", "Maintenance", "Records", "Timeline"],
  "tab": "Records",
  "parts": [
    { "kind": "table", "title": "Warranties", "columns": ["Scope", "Party", "Expires", "Status"], "rows": [
      ["Gate operator, main gate", "Precision Gate Co.", "04/15/2027", "Active"],
      ["Roof, Building C", "Summit Roofing", "01/31/2027", "Expiring in 90d"],
      ["HVAC condenser, Building A", "Manufacturer", "", "Incomplete"]
    ], "n": 1 }
  ],
  "callouts": [
    { "n": 1, "text": "Incomplete means the scope or the expiration is missing, so the warranty cannot be tracked." }
  ]
}
```

Each warranty carries:

| Field | What it tells you |
|---|---|
| **Type** | Contractor, Subcontractor, Manufacturer or Other: who stands behind it |
| **Scope / Item Covered** | Exactly what is covered |
| **Name** and contact | Who you call to claim |
| **Start Date** and **Expiration** | The term; Nexus works out the months |
| **Coverage Summary** | What is and is not covered: parts, labor, both, exclusions |
| **Warranty Document** | The paper itself, which the claim needs |

The status is worked out from the expiration: **Active**, **Expiring in 90d**, **Expired**, or **Incomplete** when the scope or expiration is missing. An Incomplete warranty is a claim you will lose; fill in the missing field from the paper.

## Making a Claim

1. **Before any repair is approved**, check Records > Warranties (or the Item) for the failed part.
2. **Read the Coverage Summary.** Parts only? Labor too? Excluded causes such as impact damage or skipped service?
3. **Call the party named on the warranty**, not just any vendor. A different vendor working on a covered part can void the warranty.
4. **Put the claim in the ticket**: the warranty's party, the date you called, the claim or reference number, and the document attached.
5. **Keep the service record ready.** Many warranties require proof of maintenance. The preventive tickets and their photos are that proof.
6. **If the claim is refused**, write the reason in the ticket and only then follow the normal path for a paid repair (see the lesson Getting the Work Done: From Ticket to Invoice).

> [!TIP]
> An expiring warranty is a reason to look before it lapses. When Records shows Expiring in 90d on a roof, have it walked while the warranty can still pay for what the walk finds.

## At Greens

The Murrieta manager opens Records > Warranties: the main gate operator is Active, contractor warranty through 04/15/2027, parts and labor, excluding impact damage. She checks the cameras; nothing hit the gate. She calls the installer named on the warranty, writes the claim number in the ticket with the warranty document attached, and adds the four quarterly service tickets as proof of maintenance. The installer replaces the controller board at no charge. The $1,100 quote is never approved.

## Common Mistakes

- **Paying a vendor to fix a covered part** because nobody looked.
- **Letting another vendor work on a covered part**, voiding the warranty.
- **An Incomplete warranty** left with no expiration, so it never warns.
- **A warranty kept in an email or a desk drawer** instead of on the record.
- **A second warranty list** for equipment that already has an Item record.

## Key Points

- Property warranties are in Records > Warranties; equipment warranties are on its record in Item Management. Never a second list.
- Status is Active, Expiring in 90d, Expired or Incomplete; fix Incomplete from the paper.
- Check for a warranty before approving any repair, and claim through the party named on it.
- Record the claim in the ticket; the preventive tickets prove the maintenance.
