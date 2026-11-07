---
title: Entities and the Company Tree
summary: How Greens' companies, properties and family entities are set up as Intacct entities, the child-code convention, what consolidation means, how an entity travels through every report as a location, and the Entities page.
---

## What You'll Be Able to Do

- Explain what an Intacct entity is and name the kinds Greens has.
- Read an entity code, including a child code, and say what it belongs to.
- Say what consolidated means and when a report is one entity or many.
- Use the entity picker the way every Nexus Accounting page expects.

## What an Entity Is

In Intacct an **entity** is a set of books inside the ledger: a company, a property, a family trust, an individual's holding. Each entity has its own balance sheet and income statement, its own bank accounts, its own vendors' balances; and the ledger can also **consolidate** them, adding them up with the intercompany balances removed, into one picture of the whole.

```figure
{
  "kind": "layout",
  "title": "The Company Tree, as Entities",
  "cols": 12,
  "rows": 4,
  "regions": [
    { "label": "Greens Global", "note": "the consolidating parent", "x": 1, "y": 1, "w": 12, "h": 1, "tone": "ok" },
    { "label": "Operating companies", "note": "the storage operator and its sisters", "x": 1, "y": 2, "w": 4, "h": 1 },
    { "label": "Property entities", "note": "each site that holds its own books", "x": 5, "y": 2, "w": 4, "h": 1 },
    { "label": "Family and personal entities", "note": "in the same ledger, read by few", "x": 9, "y": 2, "w": 4, "h": 1, "tone": "warn" },
    { "label": "Sub-entities", "note": "a child code under its parent, such as 15001-1", "x": 5, "y": 3, "w": 4, "h": 1 },
    { "label": "Every entity: its own bank accounts, vendors, customers, statements", "x": 1, "y": 4, "w": 12, "h": 1 }
  ],
  "caption": "An illustration of the shape. The real tree is the Entities page under Records."
}
```

Greens' ledger holds several kinds side by side:

| Kind | Examples | Who reads them |
|---|---|---|
| **Operating companies** | The storage operator and the other Greens companies | The accounting team; managers for their own |
| **Property entities** | A site that holds its own books, with its own loan and its own statements | Its manager, the accounting team, the lender's package |
| **Sub-entities** | A part of a property kept separately under a child code | The same as the parent |
| **Family and personal entities** | Trusts, holdings, individuals' matters | Owners and the few the Access page names |

Because they share one ledger, the Access page in the previous lesson exists: a person's entity list is what keeps a site manager's reports to the site and the family's matters to the family.

## Codes and Child Codes

Every entity has a **code**. Greens follows Intacct's convention that a **sub-entity** carries its parent's code with a suffix: `15001` is the property, `15001-1` a part of it kept on its own. When a report is run for the parent, its children come along; when a person is limited to the parent, they read the children too. The code is what travels through every report and every ledger line, so a line that says `15001-1` is that sub-entity's, not the parent's.

## Consolidated or One Entity

Every report in Nexus Accounting is read either for **one entity**, for **a list of entities**, or **consolidated** (everything the person may read, added up). The picker at the top of each page decides, and it matters:

| Reading | What you get | Use it for |
|---|---|---|
| One entity | That entity's own statements | A site's month; a lender's package for one property |
| Several entities | Each one's figures side by side, or summed, by the page | Comparing sites |
| Consolidated | Everything the person may read, intercompany removed | The company's month; the Dashboard tabs |

A person limited to one entity reads only that one; the picker offers nothing else. Behind the scenes one entity travels as a **location** on the report request, and several travel as a list; the accounting app reads the list only when there are several. You never have to think about that, but it explains why a page that was fast for one site takes a moment for ten.

## The Entities Page

```figure
{
  "kind": "screen",
  "title": "Records, Entities",
  "device": "computer",
  "module": "Accounting",
  "sub": "Records",
  "tabs": ["Dashboard", "Reports", "Financing", "Records", "Tools"],
  "tab": "Records",
  "parts": [
    { "kind": "table", "title": "Entities", "columns": ["Code", "Name", "Kind", "Parent", "Fiscal year", "Statements"], "rows": [
      ["10000", "Greens Global", "Parent", "", "Calendar", "Consolidated"],
      ["15001", "Greens Storage Temecula", "Property", "10000", "Calendar", "Own"],
      ["15001-1", "Temecula Covered Rows", "Sub-entity", "15001", "Calendar", "With parent"],
      ["15002", "Greens Storage Murrieta", "Property", "10000", "Calendar", "Own"],
      ["15003", "Greens Storage Fairfield", "Property", "10000", "Calendar", "Own"]
    ], "n": 1 }
  ],
  "callouts": [{ "n": 1, "text": "Illustrative codes and names. The real list is the ledger's, read here, never edited here." }]
}
```

**Records > Entities** lists every entity the person may read, with its code, its parent and its kind. It is a reference, not an editor: entities are made in Intacct by the accounting team. Use it to learn the codes you will meet on ledger lines and in the dimension filters.

> [!NOTE]
> **Pending:** the entity list as Greens really has it, with each site's code and which sub-entities exist, is to be written on a Library page by Accounting (Charmi), and this lesson is to link it. The codes above are illustrations of the convention.

## A Greens Scenario

Temecula's manager sees two sets of parking revenue lines when he drills into rental income: one coded to the property and one to a child code. He opens the Entities page: the child is the covered rows, kept as a sub-entity so their income and their canopy costs can be read on their own. Run for the parent, both appear; filtered to the child, only the covered rows. Nothing is duplicated; the sub-entity is just a finer cut of the same site.

## Common Mistakes

- **Reading a child code as a different site.** It is part of its parent.
- **Running a site report consolidated** and wondering why the figures are too big.
- **Expecting to edit an entity in Nexus.** Entities are Intacct's.

## Key Points

- An entity is a set of books inside the ledger: companies, properties, sub-entities, family and personal matters, all in one Intacct ledger.
- A sub-entity carries its parent's code with a suffix (15001-1); a parent brings its children.
- Every report is one entity, several, or consolidated; the picker decides; a limited person reads only their list.
- Records > Entities is the reference for the codes you will meet on every ledger line.
