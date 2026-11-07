---
title: "Workday: Your Home Base"
summary: Find your way around Workday, the page for your own time and HR record - the Overview tiles, Documents to Sign, My Schedule, My Documents and your profile card.
---

## What You'll Be Able to Do

- Name the four Workday tabs and what each one is for.
- Read the Overview tiles and know which ones open a panel.
- Sign a document from **Documents to Sign**.
- Find your signed copies and paystubs in **My Documents**.
- Update your own contact and emergency details, and know which changes must go through Ask HR instead.

## Workday Is About You

Open **Workday** from the left menu. Workday is everything about your own time and your own HR record, in one place. Only you see your own Workday. Your manager sees your hours and requests in their own screens, not by opening your Workday.

Workday has four tabs:

| Tab | What it is for | Lesson |
|---|---|---|
| **Overview** | The landing page: tiles, documents to sign, the Time Clock, your schedule, your profile, your equipment and your documents. | This lesson and the Punching In, Breaks and Punching Out lesson |
| **Time Sheet** | Your hours for the pay period, day by day, and signing them. | The lesson Your Time Sheet |
| **Time Off** | Request time off and see your requests. | The Schedules and Time Off lesson |
| **Performance** | My Numbers, My Goals, My Reviews and My 1:1s. | This lesson, briefly |

> [!NOTE]
> If your job is salaried and exempt from time tracking, Workday shows no Time Clock and usually no Time Sheet tab. Nexus does not record punches or hours for you. The Time Sheet tab still appears when there is something for you to sign. If that seems wrong for your job, raise a ticket.

## The Overview, Top to Bottom

```figure
{
  "kind": "screen",
  "title": "The Workday Overview",
  "device": "computer",
  "module": "Workday",
  "tabs": [
    "Overview",
    "Time Sheet",
    "Time Off",
    "Performance"
  ],
  "tab": "Overview",
  "badge": 2,
  "parts": [
    {
      "kind": "card",
      "title": "Documents to Sign",
      "rows": [
        {
          "label": "Employee Handbook Acknowledgment",
          "value": "Review & Sign",
          "tone": "ok",
          "n": 1
        }
      ]
    },
    {
      "kind": "tiles",
      "items": [
        {
          "label": "Hours This Week",
          "value": "31h 40m"
        },
        {
          "label": "Time Off This Year",
          "value": "4 days"
        },
        {
          "label": "Time With Us",
          "value": "2 months"
        },
        {
          "label": "Ask HR · Reimbursements · Purchase Request",
          "value": "•",
          "n": 2
        }
      ]
    },
    {
      "kind": "clock",
      "state": "in",
      "value": "3h 12m",
      "label": "Punched in at 8:02 AM",
      "tabs": [
        "Today",
        "This Week",
        "Pay Period"
      ],
      "tab": "Today",
      "buttons": [
        "Start Break",
        {
          "label": "Punch Out",
          "primary": true
        }
      ],
      "n": 3
    },
    {
      "kind": "card",
      "title": "My Schedule",
      "note": "4 shifts · 32 paid hours · next: Tomorrow 9:00 AM",
      "rows": [
        {
          "label": "Mon 11/09",
          "value": "9:00 AM to 5:30 PM"
        },
        {
          "label": "Tue 11/10",
          "value": "9:00 AM to 5:30 PM"
        }
      ],
      "n": 4
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "HR documents wait at the very top. You always sign first."
    },
    {
      "n": 2,
      "text": "The compact rows at the right end open the three Workday panels and Fill a Form."
    },
    {
      "n": 3,
      "text": "The Time Clock, with only the buttons that make sense right now."
    },
    {
      "n": 4,
      "text": "My Schedule: the week summed up, then your days."
    }
  ]
}
```

### Documents to Sign

Whenever a Nexus Sign document is waiting on your signature, a **Documents to Sign** card sits at the very top of the Overview. This is where offer letters, hiring packet forms, policy acknowledgments and HR letters arrive. Click **Review & Sign**, read the document, and sign it right there. The bell and the email about it open the same place.

In every HR document, **you always sign first**. The company never signs before you and never sends you a pre-signed document. If a document needs a company signature too, it is added after yours.

Time Sheets are the one exception to where you sign: they stay on the **Time Sheet** tab (the Your Time Sheet lesson).

### The Tiles

The top row of the Overview is a set of tiles:

| Tile | What it shows |
|---|---|
| **Hours This Week** | Your hours so far this week. |
| **Time Off This Year** | Approved working days off this year (Monday to Friday; a partial day counts as its share of 8 hours). |
| **Time With Us** | How long you have been with the company, from the start date on your HR record. If it is wrong, ask HR. |
| **My Tickets** | Shows only when you have maintenance work assigned to you. |

At the right end, compact rows open the three Workday panels and forms:

| Row | What it opens |
|---|---|
| **Ask HR** | The confidential HR desk. A red dot means HR updated one of your requests. |
| **Reimbursements** | File a claim for something you paid for on the company's behalf. |
| **Purchase Request** | Ask the company to buy something it does not have yet. |
| **Fill a Form** | Shows only when there is a form you may fill, such as an inspection or incident report. |

Ask HR, Reimbursements and Purchase Request open as wide panels from the right. A click outside one of these panels does not close it; it nudges the panel and lights up its close button, so you do not lose a half-written request. Close it with **Close**, **Cancel** or the Escape key. The Ask HR, Reimbursements and Purchases lesson covers all three.

### The Time Clock

Below the tiles is the **Time Clock** card, with **Punch In**, **Start Break**, **End Break** and **Punch Out**, a live dial for the shift you are on, and your hours with a **Today / This Week / Pay Period** switch. The Punching In, Breaks and Punching Out lesson is all about it.

### My Schedule

**My Schedule** shows your week of shifts: a line that sums up the week (shifts, paid hours, time off and your next shift), then your days one by one. When a manager shares a new schedule, a banner here asks you to **Confirm** it. The **My Week | Team** switch shows your group's whole week. The Schedules and Time Off lesson covers schedules.

### Contact & Emergency

```figure
{
  "kind": "screen",
  "title": "Contact & Emergency, Editing",
  "device": "computer",
  "module": "Workday",
  "tabs": [
    "Overview",
    "Time Sheet",
    "Time Off",
    "Performance"
  ],
  "tab": "Overview",
  "parts": [
    {
      "kind": "form",
      "title": "Contact & Emergency",
      "fields": [
        {
          "label": "Personal Email",
          "value": "keisha.m@example.com"
        },
        {
          "label": "Phone",
          "value": "(951) 555-0142"
        },
        {
          "label": "Emergency Contact",
          "value": "Dana Moore"
        },
        {
          "label": "Relationship",
          "value": "Sister"
        },
        {
          "label": "Emergency Phone",
          "value": "(951) 555-0187",
          "n": 1
        }
      ],
      "buttons": [
        "Cancel",
        {
          "label": "Save",
          "primary": true,
          "n": 2
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "These five you change yourself."
    },
    {
      "n": 2,
      "text": "Your name, job title, department and bank details go through Ask HR, Profile Change."
    }
  ]
}
```

Your profile card shows your details and a **Contact & Emergency** section: your personal email, phone, and your emergency contact's name, relationship and phone. Click **Edit**, change what you need, and click **Save**.

Keep this current. If something happens at a site, this is who the company calls.

Some details you cannot change yourself, because they affect payroll or your HR record:

| You change it yourself | Ask HR changes it (Profile Change) |
|---|---|
| Personal email | Your name |
| Phone | Your job title |
| Emergency contact name, relationship and phone | Your department |
| | Your bank details |

For those, open **Ask HR**, click **New Request**, pick **Profile Change**, describe the change and click **Send to HR**. The Ask HR, Reimbursements and Purchases lesson walks through it.

### My Equipment

**My Equipment** lists what is assigned to you or checked out to you, with **Assigned** and **Checkouts** views. **Open Item Management** takes you to the full module (the People, Equipment and Notes lesson).

### My Documents

**My Documents** holds your signed copies, the files HR filed for you, and your paystubs, in folders. When you sign an offer letter, a policy or a Time Sheet, the signed copy lands here. When HR uploads a paystub, it is here too. There is no separate paystubs screen.

> [!TIP]
> Need proof of employment for a landlord or a bank? Do not screenshot a paystub. Open **Ask HR**, click **New Request**, and pick **Request a Letter** (when your company offers HR letters). HR sends a proper letter.

## The Performance Tab, Briefly

**Performance** is one page with **My Numbers**, **My Goals**, **My Reviews** and **My 1:1s**. My Numbers are tiles Nexus works out from what it already records (such as on-time arrival and Time Sheets signed on time); nobody types them in, and time off, sick days, pay and HR requests are never used. My Goals holds up to five open goals. My Reviews is where a review HR starts arrives for your self review and your signature. Only you, the people you report to and HR see your page. You do not need to do anything here in your first week; just know it exists.

## A Greens Scenario

Keisha just started at Murrieta. On day two she opens **Workday** and sees **Documents to Sign** at the top with two items from her hiring packet. She clicks **Review & Sign** on each, reads them and signs. The signed copies appear in **My Documents** a moment later.

Next she scrolls to her profile card. Her emergency contact is blank, so she clicks **Edit** under **Contact & Emergency**, adds her sister's name, relationship and phone, and clicks **Save**.

She also notices her last name is misspelled. She cannot edit her name herself, so she opens **Ask HR**, clicks **New Request**, picks **Profile Change**, writes "My last name is spelled with two Ns" and clicks **Send to HR**.

## Common Mistakes

- **Looking for a Time Sheet in Documents to Sign.** Time Sheets are signed on the Time Sheet tab.
- **Leaving the emergency contact blank.** Fill it in on day one.
- **Asking a manager to change your bank details.** Bank, name, job and department changes go through **Ask HR**, **Profile Change**.
- **Closing a Workday panel by clicking outside it.** It will not close; that protects your draft. Use Close or Cancel.
- **Looking for paystubs in a separate screen.** They are a folder in **My Documents**.

## Key Points

- Workday has four tabs: **Overview**, **Time Sheet**, **Time Off** and **Performance**. Only you see your Workday.
- **Documents to Sign** at the top of Overview is where HR documents wait. Click **Review & Sign**. You always sign first.
- Tiles show Hours This Week, Time Off This Year and Time With Us. Ask HR, Reimbursements and Purchase Request open as panels.
- Edit your contact and emergency details yourself. Name, job, department and bank changes go through **Ask HR**, **Profile Change**.
- **My Documents** holds signed copies, HR files and paystubs.
