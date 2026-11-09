---
title: Entities and the Company Tree
summary: What an Intacct entity is, the kinds Greens keeps in one ledger, how a child code works, when a report is one entity, several or the whole company, and the Entities page.
teaches: Accounting
---

Temecula's manager drills into rental income and finds lines under two codes: the property's and one with a suffix. Is someone else's income landing on his site? No. Once you can read an entity code, the answer takes one look.

## What an Entity Is

In Intacct an **entity** is a set of books inside the one ledger. Each has its own balance sheet, income statement, bank accounts and vendor balances. At Greens each **property is an entity**, and so are the operating companies and the family and personal holdings. The ledger can also add entities up into one picture of the whole, with the balances between Greens entities taken out.

```figure
{
  "kind": "layout",
  "title": "The Company Tree, as Entities",
  "cols": 12,
  "rows": 3,
  "regions": [
    { "label": "The parent", "note": "adds the others up", "x": 1, "y": 1, "w": 12, "h": 1 },
    { "label": "Operating companies", "x": 1, "y": 2, "w": 4, "h": 1 },
    { "label": "Property entities", "note": "one per site", "x": 5, "y": 2, "w": 4, "h": 1 },
    { "label": "Family and personal", "note": "read by few", "x": 9, "y": 2, "w": 4, "h": 1 },
    { "label": "Sub-entities", "note": "a child code under its parent", "x": 5, "y": 3, "w": 4, "h": 1 }
  ],
  "caption": "The shape only. The real list is Records > Entities."
}
```

| Kind | Who reads it |
|---|---|
| **Operating companies** | The accounting team; managers for their own |
| **Property entities** | The property's manager, the accounting team, the lender's package |
| **Sub-entities** | Whoever reads the parent |
| **Family and personal entities** | Owners and the few the Access page names |

Because all of these share one ledger, entity access (see the lesson One Ledger, Two Doors) is what keeps a manager's reports to the property and the family's matters to the family.

## Codes and Child Codes

Every entity has a **code**. A **sub-entity** carries its parent's code with a suffix: if a property is `15001`, a part of it kept on its own books is `15001-1`. Run a report for the parent and its children come along; limit a person to the parent and they read the children too. A line coded `15001-1` belongs to that part of the property, not to another site.

A **Project-Job** code is something else: it is a Construction job's tag on a line (see the lesson Dimensions: Reading One Account Many Ways), not an entity.

## One Entity, Several or the Whole Company

Every report is read for one entity, a list of entities, or everything the person may read added up. The entity picker at the top of the page decides.

| Reading | What you get | Use it for |
|---|---|---|
| One entity | That entity's own statements | A property's month; one lender's package |
| Several | Each one side by side, or summed | Comparing properties |
| All | Everything you may read, with balances between Greens entities removed | The company's month |

A person limited to some entities is offered only those in the picker.

## The Entities Page

**Records > Entities** lists every entity you may read, with its code and its parent. It is a reference, not an editor: entities are made in Intacct by the accounting team. Use it to learn the codes you meet on ledger lines and in the filters. Your manager has the list of which properties have sub-entities until Accounting publishes it.

## At Greens

Back to Temecula. The manager opens Records > Entities: the suffixed code is the covered rows, kept as a sub-entity so their income and their canopy costs can be read on their own. Run for the parent, both sets of lines appear; filtered to the child, only the covered rows. Nothing is doubled.

## Common Mistakes

- **Reading a child code as a different site.** It is part of its parent.
- **Running a property report with every entity picked** and wondering why the figures are too big.
- **Calling a Project-Job code an entity.** It tags a Construction job's lines.
- **Expecting to create or edit an entity in Nexus.** Entities are Intacct's.

## Key Points

- An entity is a set of books in the one ledger; each property is an entity.
- A sub-entity carries its parent's code with a suffix, and a parent brings its children.
- The entity picker decides one, several or all; a limited person sees only their list.
- Records > Entities is the reference for codes; it edits nothing.
