---
title: "Getting Help: Tickets, Report a Problem and Forms"
summary: Raise a ticket from Help Center, follow it to a resolution, report a problem by scanning a site tag, fill a form on the lot, and read the offline bar.
---

## What You'll Be Able to Do

- Submit a ticket from **Help Center** with a clear title, the right team, photos and a priority.
- Follow your ticket through its statuses and **Confirm Resolution** or **Reopen** it.
- Scan a site QR tag and **Report a Problem** at that place.
- Fill a form (an inspection, an incident report, a checklist), with photos and your location, even with no signal.
- Read the offline bar and know when to tap **Sync Now**, **Review** or **Sign In**.

## Help Center Is for Everyone

Open **Help Center** from the left menu (it is in the System group at the bottom). You do not need the Tickets module to get help; that module is the desk side, where the teams work tickets. Help Center is your side.

Help Center has a search bar at the top and these tiles:

| Tile | What it does |
|---|---|
| **Submit a Ticket** | Raise a request with the right team: IT, HR, facilities, maintenance and more. |
| **Ask Nexus** | Takes you to the search bar to ask a question. Written answers may not be turned on for Greens; if Ask Nexus says it is not set up, search the guide or submit a ticket instead. |
| **Documentation** | The written guide to every Nexus screen. |
| **Knowledge Base & Training** | Every company SOP and policy, and your courses (the Training and Policies lesson). |
| **How Do I...** | Shortcuts to common things, such as Request Time Off or a Time Sheet fix, that go straight to the right screen with no ticket needed. |

Below the tiles is the list of your tickets.

## Submitting a Ticket

```figure
{
  "kind": "screen",
  "title": "Submit a Ticket",
  "device": "computer",
  "module": "Help Center",
  "sub": "System",
  "parts": [
    {
      "kind": "sheet",
      "title": "Submit a Ticket",
      "fields": [
        {
          "label": "Title",
          "value": "Gate 2 keypad not responding",
          "n": 1
        },
        {
          "label": "What Is Happening?",
          "kind": "textarea",
          "value": "Since 7:30 AM the entry keypad shows nothing when a code is typed. Exit loop works. Tried the intercom; no answer."
        },
        {
          "label": "Evidence",
          "hint": "Record Screen · Attach File · or press Ctrl+V to paste a screenshot",
          "n": 2
        },
        {
          "label": "Department",
          "kind": "select",
          "value": "Facilities"
        },
        {
          "label": "Type",
          "kind": "select",
          "value": "Incident"
        },
        {
          "label": "Priority",
          "kind": "select",
          "value": "High",
          "n": 3
        }
      ],
      "buttons": [
        "Cancel",
        {
          "label": "Create Ticket",
          "primary": true
        }
      ]
    },
    {
      "kind": "list",
      "title": "Open Tickets",
      "items": [
        {
          "label": "Light out in the front office",
          "note": "Expect a reply by 11/08/2026 9:00 AM",
          "badge": "Open"
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "Short and specific: what and where."
    },
    {
      "n": 2,
      "text": "Always add a photo; it saves a trip and a phone call."
    },
    {
      "n": 3,
      "text": "Set it honestly."
    }
  ]
}
```

A ticket is the right tool whenever something is broken, missing or needs another team: a gate that will not close, a light out in the front office, a computer that will not print, a question for IT.

1. Open **Help Center** and click **Submit a Ticket**. (Or use **New Ticket** in the + menu or on Dashboard Quick Actions.)
2. Give it a short, specific title, for example "Light out in the front office" or "Gate 2 keypad not responding."
3. Under **What Is Happening?**, describe the problem: where, since when, and what you already tried.
4. Add evidence: **Record Screen**, **Attach File**, or press Ctrl+V to paste a screenshot. On a phone, attach photos from the camera.
5. Pick the department (the team that needs to help you), then what you need help with. If a **Which One?** list appears, pick the one it is about.
6. Leave the type as **Incident** for most problems (something broken), or change it (for example, to a Service Request when you need something set up).
7. Set the **Priority** honestly.
8. Click **Create Ticket**.

As you type, **Suggested Articles** may appear. If one solves it, click **This Solved My Problem** and no ticket is filed.

After you submit, the form shows **What Happens Next**: the ticket number, which team has it and when to expect a first reply. **Open Ticket** goes straight to it, **Copy Link** copies a link to share, and **Create Another** starts a fresh form.

> [!TIP]
> One problem per ticket. A broken gate and a burned-out light are two tickets, because they may go to two different people. And always add a photo; it saves a trip and a phone call.

### Raising One for Someone Else

The **Requester** is you by default. If you are raising it for a coworker (for example, they have no signal), pick them as the Requester. They get the updates, and you can still follow it under **Tickets I'm Following**.

## Following Your Ticket

```figure
{
  "kind": "screen",
  "title": "Your Tickets in Help Center",
  "device": "computer",
  "module": "Help Center",
  "sub": "System",
  "parts": [
    {
      "kind": "tiles",
      "items": [
        {
          "label": "Submit a Ticket",
          "value": "+"
        },
        {
          "label": "Documentation",
          "value": "?"
        },
        {
          "label": "Knowledge Base & Training",
          "value": "2"
        },
        {
          "label": "How Do I...",
          "value": "→"
        }
      ]
    },
    {
      "kind": "list",
      "title": "Open Tickets",
      "items": [
        {
          "label": "Gate 2 keypad not responding",
          "note": "#4830 · Facilities · In Progress since 8:40 AM",
          "badge": "In Progress",
          "tone": "live"
        },
        {
          "label": "Light out in the front office",
          "note": "#4821 · Facilities · they asked which fixture",
          "badge": "Waiting for User",
          "tone": "warn",
          "n": 1
        },
        {
          "label": "Printer will not print from the office computer",
          "note": "#4799 · IT · Expect a reply by 11/08/2026 9:00 AM",
          "badge": "Open"
        }
      ]
    },
    {
      "kind": "list",
      "title": "Closed Tickets",
      "items": [
        {
          "label": "Roll-up door bent at bottom, unit B14",
          "note": "#4712 · Maintenance · you confirmed the fix 11/01/2026",
          "badge": "Closed",
          "n": 2
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "The team is waiting on you. Reply, and it moves again."
    },
    {
      "n": 2,
      "text": "Resolved, then Confirm Resolution and Done, then the short survey."
    }
  ]
}
```

```figure
{
  "kind": "steps",
  "title": "Where a Ticket Goes",
  "items": [
    {
      "label": "New or Open",
      "note": "received, not yet worked"
    },
    {
      "label": "In Progress",
      "note": "someone has it"
    },
    {
      "label": "Waiting",
      "note": "for you, or for an outside vendor"
    },
    {
      "label": "Resolved",
      "note": "the team says it is fixed"
    },
    {
      "label": "Closed",
      "note": "finished"
    }
  ],
  "caption": "Waiting for User means the team is waiting on you. Reply, and it moves again."
}
```

Your tickets are in three lists under the Help Center tiles:

- **Open Tickets:** raised for you and not closed yet. Until someone replies, a row says **Expect a reply by** with the date and time the team aims to answer by. A blue dot means something changed since you last looked.
- **Tickets I'm Following:** raised for someone else, or ones you were added to.
- **Closed Tickets:** finished ones, for reference.

A ticket moves through these statuses:

| Status | Meaning |
|---|---|
| **New** / **Open** | Received, not yet being worked. |
| **In Progress** | Someone has it. |
| **Waiting for User** | The team is waiting on you. Reply! |
| **Waiting for Vendor** | The team is waiting on an outside company (a gate or door vendor, for example). |
| **Resolved** | The team says it is fixed. |
| **Closed** | Finished. |

Click a row to open the full thread and reply. Email and bell updates about your ticket open it right here.

### Resolved, Confirmed or Reopened

- If the problem went away on its own, click **Mark Resolved** and say what fixed it.
- When the team resolves it, check that it really is fixed. Then click **Confirm Resolution** and **Done**, and answer the short 1 to 5 star survey.
- If it is not fixed, click **Reopen** (while it is still Resolved) and say why.

Once a ticket is **Closed**, it stays closed. If the same problem comes back later, submit a new ticket.

## Report a Problem at a Place

```figure
{
  "kind": "screen",
  "title": "Report a Problem, From a Site Tag",
  "device": "phone",
  "module": "Building C",
  "sub": "Murrieta",
  "parts": [
    {
      "kind": "list",
      "title": "Open Tickets Here",
      "items": [
        {
          "label": "Nothing reported at this place",
          "note": "You are the first"
        }
      ],
      "n": 1
    },
    {
      "kind": "form",
      "title": "Report a Problem",
      "fields": [
        {
          "label": "Where",
          "kind": "select",
          "value": "Unit C-108 door"
        },
        {
          "label": "Details",
          "kind": "textarea",
          "value": "Roll-up door bent at bottom left, will not close fully, vacant unit."
        },
        {
          "label": "Photos",
          "value": "2 photos attached",
          "n": 2
        }
      ],
      "buttons": [
        {
          "label": "Send Report",
          "primary": true,
          "n": 3
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "See whether someone beat you to it."
    },
    {
      "n": 2,
      "text": "Photos are evidence: at the time, of the thing, in good light."
    },
    {
      "n": 3,
      "text": "It becomes a ticket for the team that looks after this place, already linked to the property."
    }
  ]
}
```

Some Greens sites and pieces of equipment carry a QR tag. Scan it with your phone's camera and Nexus opens that place:

- **Open Tickets** lists what is already reported there, so you can see if someone beat you to it.
- **Report a Problem** opens a short form: **Where** (the **Common Area** or a specific spot), **Details**, and **Photos**. Click **Send Report**.

The report becomes a ticket for the team that looks after that place, already linked to the property, so you do not have to explain where you are. If you see **You Do Not Have Access to This Place**, the tag belongs to a company you are not part of; use Submit a Ticket instead.

Maintenance staff with assigned work also see a **My Tickets** tile on the Workday Overview, where they start work, scan a tag, and **Mark Done** with a **Photo of the Finished Work**.

## Forms

Inspections, incident reports, vehicle checks and checklists are **forms** in Nexus. You can open **Fill a Form** from several places:

- the **Fill a Form** row on the Workday Overview (it shows only when there is a form you may fill),
- the + menu, under Requests,
- the Quick Actions dock on the Dashboard, when Fill a Form is one of its buttons,
- your shift card, when a form is set to show on shifts at your site.

A form can ask for many kinds of answers: photos, **Stamp My Location** (adds your GPS location), a QR scan, a rating, yes or no, and a signature drawn with your finger. Fill in each field and click **Send**. After it sends, choose **Fill Another** or **Done**.

Your entry is reviewed by someone else; a person never reviews their own entry.

> [!NOTE]
> Photos are evidence. Take them at the time, of the actual thing, in good light. A clear photo of a damaged door, with the unit number in the shot, is worth more than a paragraph.

## Working With No Signal

```figure
{
  "kind": "screen",
  "title": "The Offline Bar",
  "device": "phone",
  "module": "Workday",
  "parts": [
    {
      "kind": "banner",
      "tone": "warn",
      "text": "Waiting to send: 1 form, 1 punch.",
      "buttons": [
        {
          "label": "Sync Now",
          "primary": true,
          "n": 1
        }
      ]
    },
    {
      "kind": "card",
      "title": "Daily Site Inspection",
      "rows": [
        {
          "label": "Sent 2:14 PM",
          "value": "Saved on This Phone",
          "tone": "warn",
          "n": 2
        }
      ],
      "note": "It sends itself when signal comes back. Sending it twice never creates two."
    },
    {
      "kind": "clock",
      "state": "in",
      "value": "6h 20m",
      "label": "Punched in at 8:00 AM",
      "buttons": [
        "Start Break",
        {
          "label": "Punch Out",
          "primary": true
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "Tries right away. Review appears instead when the server refused something; Keep Mine or Use Theirs when someone else changed the same record."
    },
    {
      "n": 2,
      "text": "Nothing to redo. Keep working."
    }
  ]
}
```

You can fill a form, punch and use Workday with no signal. When you click **Send** with no signal, the entry shows **Saved on This Phone** and sends itself when signal comes back. Sending the same entry twice never creates two.

A bar at the top of Nexus tells you what is waiting:

| The bar says | What to do |
|---|---|
| Offline - your changes are saved on this phone and will send when you are back online. | Nothing. Keep working. |
| **Waiting to send** | It sends by itself. **Sync Now** tries right away. |
| Something **not sent** | Tap **Review**: the server refused it and says why. Fix and send again. |
| Something **needs your choice** | Someone else changed the same record. Pick **Keep Mine** or **Use Theirs**. |
| Signed out - sign in when you have signal to send | Tap **Sign In** once you have signal. |

The offline copy belongs to you only and is cleared when you sign out.

## A Greens Scenario

During her afternoon walk at Murrieta, Tasha finds the door of a vacant unit bent at the bottom. She scans the QR tag at the end of the building. **Open Tickets** shows nothing for that door, so she taps **Report a Problem**, picks the spot under **Where**, writes "Roll-up door bent at bottom left, will not close fully, vacant unit," adds two photos and taps **Send Report**.

Next she fills the daily site inspection form from the **Fill a Form** row. She is at the back fence with no signal, so when she taps **Send** it shows **Saved on This Phone**. Back at the office, the bar reads **Waiting to send**; she taps **Sync Now** and it goes through.

Two days later, her ticket shows **Resolved**. She checks the door, it closes properly, and she clicks **Confirm Resolution**, then **Done**.

## Common Mistakes

- **Texting a manager about a broken gate instead of a ticket.** Texts get lost; tickets get tracked.
- **Vague titles like "Problem."** Say what and where.
- **No photos.** Always add one.
- **Ignoring Waiting for User.** The team is stuck until you answer.
- **Confirming before checking.** Look at the fix first.
- **Filling a form twice because you were offline.** It is saved and sends itself.

## Key Points

- **Help Center** is for everyone: **Submit a Ticket**, **Documentation**, **Knowledge Base & Training** and **How Do I...**.
- A good ticket has a specific title, what is happening, photos, the right department and an honest priority. Click **Create Ticket**.
- Follow tickets in **Open Tickets**. Reply when it is **Waiting for User**. **Confirm Resolution** when it is fixed, or **Reopen** while it is Resolved.
- Scan a site QR tag to see **Open Tickets** there and **Report a Problem**.
- Forms send with **Send**; with no signal they show **Saved on This Phone** and send themselves.
- The offline bar: **Sync Now** to send, **Review** for something not sent, **Keep Mine** or **Use Theirs** for a conflict.
