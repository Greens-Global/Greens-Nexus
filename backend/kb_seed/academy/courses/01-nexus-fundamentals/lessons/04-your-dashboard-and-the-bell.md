---
title: Your Dashboard and the Bell
summary: Read your Dashboard Home, add the Announcements widget, and use the bell and the yellow priority bar so nothing that needs you slips by.
---

## What You'll Be Able to Do

- Read the Dashboard Home at a glance: the tiles, Needs Your Attention, My Hours and Quick Actions.
- Build your own view with **Customize** and **Add Widget**, including the Announcements widget.
- Use the bell: open a notice, **Mark All Read**, **Clear All**, and find a cleared notice again.
- Act on the yellow priority bar.

## The Dashboard Is Where Nexus Opens

Every time you sign in, Nexus opens on the **Dashboard**. You can always get back to it by clicking **Dashboard** in the left menu or the **N** at the top of the menu.

The Dashboard has tabs across the top:

| Tab | What it is |
|---|---|
| **Dashboard** | Your home page (this lesson). |
| **Approvals** | Decisions waiting on you. Managers and HR always see it; an Employee sees it when something waits on them, under **Yours To Do** (a document to sign, an item to accept). |
| **Notes** | Your private notes (the People, Equipment and Notes lesson). |
| **Links** | Company and personal web links in one searchable place. |

## Reading Home

```figure
{
  "kind": "screen",
  "title": "Home, Top to Bottom",
  "device": "computer",
  "module": "Dashboard",
  "tabs": [
    "Dashboard",
    "Approvals",
    "Notes",
    "Links"
  ],
  "tab": "Dashboard",
  "actions": [
    "Customize"
  ],
  "badge": 4,
  "parts": [
    {
      "kind": "banner",
      "tone": "warn",
      "text": "Your Time Sheet for 10/16 to 10/31 is approved and waiting for your signature.",
      "buttons": [
        "Open"
      ],
      "n": 1
    },
    {
      "kind": "text",
      "title": "Good morning, Marco",
      "text": "On the clock since 8:02 AM · Temecula · 9:14 AM"
    },
    {
      "kind": "tiles",
      "items": [
        {
          "label": "Open Tasks",
          "value": "3"
        },
        {
          "label": "Checked-Out Items",
          "value": "1"
        },
        {
          "label": "My Equipment",
          "value": "4"
        },
        {
          "label": "Signatures Needed",
          "value": "1",
          "n": 2
        }
      ]
    },
    {
      "kind": "card",
      "title": "Needs Your Attention",
      "rows": [
        {
          "label": "Confirm your schedule for 11/10 to 11/16",
          "value": "Open"
        },
        {
          "label": "Ticket #4821 is Waiting for User",
          "value": "Reply",
          "tone": "warn"
        }
      ],
      "n": 3
    },
    {
      "kind": "card",
      "title": "Quick Actions",
      "buttons": [
        "Request an Item",
        "New Task",
        "New Ticket"
      ],
      "note": "Ctrl+K opens search",
      "n": 4
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "The yellow priority bar: the one thing you never ignore."
    },
    {
      "n": 2,
      "text": "A tile above zero is a nudge. Click it to jump to the list."
    },
    {
      "n": 3,
      "text": "Needs Your Attention, or You're All Caught Up."
    },
    {
      "n": 4,
      "text": "One-click shortcuts."
    }
  ]
}
```

The designed default layout is called **Home**. From top to bottom it shows:

1. **A greeting** with your clock status and local time.
2. **Tiles** that count what is with you or waiting on you. Click a tile to jump to that list.
3. **Needs Your Attention:** your latest alerts that need action. When nothing is waiting, it says **You're All Caught Up**.
4. **My Hours:** your hours over the last 7 days. Supervisors and above also see **Team Pulse**, such as who is clocked in now.
5. **Quick Actions:** one-click shortcuts.
6. **Favorites:** the links you starred on the Links tab.

### The Tiles

| Tile | What it counts |
|---|---|
| **Open Tasks** | Tasks due soon or in progress (if you use Tasks). |
| **Checked-Out Items** | Equipment with you right now. |
| **My Equipment** | Items permanently assigned to you. |
| **Signatures Needed** | Documents awaiting your signature. |

A tile with a number above zero is a nudge. Signatures Needed especially: a document waiting on you (an HR form, a policy, a Time Sheet) can hold up your pay or your onboarding.

### Quick Actions

Quick Actions on Home starts the everyday things in one click: **Request an Item**, **New Task** (if you use Tasks) and **New Ticket**. It also reminds you that Ctrl+K opens search.

## Building Your Own View

Home is good for most people. If you want different information, build your own view from widgets:

1. On the Dashboard, click **Customize** at the top right of the greeting. On a phone, Customize is the sliders icon.
2. Click **Add Widget** and pick a widget from the gallery.
3. Drag widgets to move them and drag a corner to resize. **Auto-Fit** closes gaps.
4. Click **Save**, then **Done**.

Your views appear in the view picker beside Home. A view with a star is your default and opens first. If you ever want the designed layout back as your default, the view menu has **Make Home My Default**.

Widgets anyone can add include Time Clock, My Requests, Due Back Soon, Coming Up, Action Required, My Work, My Time, Announcements, Calendar, Notes, Weather, Quick Links and Favorites.

### Add the Announcements Widget

```figure
{
  "kind": "screen",
  "title": "Customize, Add Widget",
  "device": "computer",
  "module": "Dashboard",
  "tabs": [
    "Dashboard",
    "Approvals",
    "Notes",
    "Links"
  ],
  "tab": "Dashboard",
  "actions": [
    "Save",
    {
      "label": "Done",
      "primary": true
    }
  ],
  "parts": [
    {
      "kind": "tiles",
      "items": [
        {
          "label": "Open Tasks",
          "value": "3"
        },
        {
          "label": "Checked-Out Items",
          "value": "1"
        },
        {
          "label": "My Equipment",
          "value": "4"
        }
      ]
    },
    {
      "kind": "sheet",
      "title": "Add Widget",
      "items": [
        {
          "label": "Time Clock",
          "note": "Your clock, right here"
        },
        {
          "label": "Announcements",
          "note": "Live · company posts, with Acknowledge",
          "badge": "Add",
          "tone": "ok",
          "n": 1
        },
        {
          "label": "My Requests",
          "note": "Everything you have asked for"
        },
        {
          "label": "Due Back Soon",
          "note": "Borrowed items coming due"
        },
        {
          "label": "Weather",
          "note": "At your site"
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "Announcements reach your Dashboard only through this widget. Add it on day one."
    }
  ]
}
```

Company announcements reach your Dashboard **only through the Announcements widget**, and it is not on Home by default. If you never add it, you can miss an announcement that asks you to acknowledge something.

1. Click **Customize**.
2. Click **Add Widget** and pick **Announcements** (under Live).
3. Place it, click **Save**, then **Done**.

When an announcement asks you to confirm you read it, it shows an **Acknowledge** button. Read the post, then click **Acknowledge**. Only administrators post announcements; you read and acknowledge them.

> [!TIP]
> Add the Announcements widget on your first day. It takes 30 seconds and it is the most common thing new team members miss.

## The Bell

```figure
{
  "kind": "screen",
  "title": "The Bell, Open",
  "device": "computer",
  "module": "Dashboard",
  "tabs": [
    "Dashboard",
    "Approvals",
    "Notes",
    "Links"
  ],
  "tab": "Dashboard",
  "badge": 7,
  "parts": [
    {
      "kind": "tiles",
      "items": [
        {
          "label": "Open Tasks",
          "value": "3"
        },
        {
          "label": "Checked-Out Items",
          "value": "1"
        },
        {
          "label": "My Equipment",
          "value": "4"
        },
        {
          "label": "Signatures Needed",
          "value": "1"
        }
      ]
    },
    {
      "kind": "card",
      "title": "Needs Your Attention",
      "rows": [
        {
          "label": "Confirm your schedule for 11/10 to 11/16",
          "value": "Open"
        }
      ]
    },
    {
      "kind": "bell",
      "text": "2 need action · 5 updates",
      "items": [
        {
          "label": "Schedule shared for 11/10 to 11/16",
          "note": "Confirm it",
          "n": 1
        },
        {
          "label": "Reply on ticket #4821",
          "note": "Maintenance desk, 10 min ago"
        },
        {
          "label": "Still on Break?",
          "note": "Your break has been open for 60 minutes"
        }
      ],
      "buttons": [
        {
          "label": "Mark All Read",
          "n": 2
        },
        {
          "label": "Clear All",
          "n": 3
        }
      ]
    },
    {
      "kind": "toast",
      "text": "Approve: time off request from Priya N.",
      "buttons": [
        "Open"
      ],
      "n": 4
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "Click a notice to open the exact thing it is about."
    },
    {
      "n": 2,
      "text": "Clears the red number without removing anything."
    },
    {
      "n": 3,
      "text": "Moves updates to Closed, where they stay for 30 days."
    },
    {
      "n": 4,
      "text": "A notice that needs action also pops up briefly as a toast."
    }
  ]
}
```

The bell at the top right holds every alert meant for you: approvals, handovers, mentions, reminders, replies on tickets you raised, a schedule to confirm, a document to sign. A red number on the bell means unread alerts.

Click the bell to open it. The top line sums it up, for example "2 need action · 5 updates," or **All caught up** when there is nothing.

- **Click a notice** to open the exact thing it is about: the ticket, the approval, the schedule.
- **Mark All Read** clears the red number without removing anything.
- **Clear All** moves your updates to **Closed**.

Nothing you clear is gone for good. Cleared notices stay under **Closed** for 30 days, and you can restore one from there if you cleared it by mistake.

Notices that need action (such as Approve or Overdue) also pop up briefly as a toast in the corner of the screen. Repeats are grouped into one notice that updates in place, so you are not flooded.

> [!NOTE]
> Nexus creates bell notices for real workflow events: a ticket reply, a schedule shared, a document to sign. You will not be notified about every small change someone makes. If something matters to you and you did not get a notice, check the module itself.

## The Yellow Priority Bar

Sometimes a notice is important enough that Nexus pins it to the top of every screen as a **yellow bar**: for example, a Time Sheet to sign or a punch fix waiting for your answer. A manager can also raise a priority notice for one person.

- Tap the text to read the full message.
- Click **Open** to go straight to the item. Acting on it clears the bar.
- With several waiting, **Show All** lists them and **Clear All** closes them all. Each one still stays in the bell under Closed for 30 days.

The yellow bar is the one thing in Nexus you should never ignore. It means "this needs you, and it is holding something up."

## A Greens Scenario

Marco is an assistant manager at Temecula. On Monday morning his Dashboard shows **Signatures Needed: 1** and a yellow bar across the top: his Time Sheet for the last pay period is approved and waiting for his signature. He taps the bar text, reads it, and clicks **Open**. The Time Sheet opens; he checks his hours and signs (the Your Time Sheet lesson shows how). The yellow bar disappears and Signatures Needed drops to 0.

Next, he opens the bell. There are three updates about a ticket he raised about a flickering light in the RV aisle. He reads them, then clicks **Clear All**. Later he wants to see one again, so he opens **Closed** in the bell and finds it there.

Finally, Marco realizes he has never seen a company announcement. He clicks **Customize**, then **Add Widget**, picks **Announcements**, clicks **Save**, then **Done**. One announcement asks him to confirm he read the new gate hours policy. He reads it and clicks **Acknowledge**.

## Common Mistakes

- **Never adding the Announcements widget.** Announcements do not show on Home by default.
- **Ignoring the yellow bar.** It is always something that is holding up pay, a request or a teammate.
- **Using Clear All as a to-do list.** Clearing hides a notice; it does not do the work. Open the notice and act first.
- **Panicking after an accidental Clear All.** Everything is under **Closed** for 30 days.

## Key Points

- The Dashboard opens first. Home shows tiles (Open Tasks, Checked-Out Items, My Equipment, Signatures Needed), Needs Your Attention, My Hours and Quick Actions.
- **Customize**, **Add Widget**, **Save**, **Done** builds your own view. Add the **Announcements** widget; it is not on Home by default.
- The bell holds every alert for you. **Mark All Read** clears the count; **Clear All** moves updates to **Closed** for 30 days.
- The yellow priority bar means something needs you now. **Open** goes to it; acting clears it.
- **Acknowledge** an announcement that asks you to, after you read it.
