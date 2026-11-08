---
title: Your Time Sheet
summary: Read your Time Sheet, ask for a missing punch or a break fix, follow your change requests, and sign your Time Sheet in Nexus Sign once your manager approves it.
---

## What You'll Be Able to Do

- Read your Time Sheet for a pay period, including breaks and leave lines.
- Ask for a missing clock-out, a missing clock-in, a break fix or extra time, with a reason.
- Follow and cancel your change requests.
- Explain who approves your Time Sheet, who signs it, and what happens if something changes after approval.
- Add approved time off to your Time Sheet so you are paid for it.

## Why Your Time Sheet Matters

Your Time Sheet is the record your pay is built from. Payroll pays the hours on it, and your signature says those hours are right. That makes it the most important screen in Nexus for you. Check it at least once a week, not just on signing day. A missing punch is easy to fix the day after and much harder to remember three weeks later.

## Reading Your Time Sheet

```figure
{
  "kind": "screen",
  "title": "A Week on the Time Sheet",
  "device": "computer",
  "module": "Workday",
  "tabs": [
    "Overview",
    "Time Sheet",
    "Time Off",
    "Performance"
  ],
  "tab": "Time Sheet",
  "actions": [
    "◀  11/01 to 11/15  ▶"
  ],
  "parts": [
    {
      "kind": "table",
      "columns": [
        "Day",
        "In",
        "Out",
        "Hours",
        "Where"
      ],
      "rows": [
        [
          "Mon 11/02",
          "8:02 AM",
          "12:00 PM",
          "3:58",
          "Fairfield"
        ],
        [
          "",
          "Break",
          "",
          "0:30",
          ""
        ],
        [
          "",
          "12:30 PM",
          "4:45 PM",
          "4:15",
          "Fairfield"
        ],
        [
          "Tue 11/03",
          "7:58 AM",
          "4:31 PM",
          "8:33",
          "Fairfield"
        ],
        [
          "Wed 11/04",
          "8:05 AM",
          "Missing",
          "",
          "Approx. Location"
        ],
        [
          "Thu 11/05",
          "Sick",
          "",
          "8:00",
          ""
        ],
        [
          "Week",
          "",
          "",
          "33:04",
          ""
        ]
      ],
      "n": 1
    },
    {
      "kind": "card",
      "title": "Change Requests This Period",
      "rows": [
        {
          "label": "Wed 11/04 · clock-out 5:00 PM",
          "value": "Not Yet Approved",
          "tone": "warn",
          "n": 2
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "A shift with a break is two punch pairs with the break on its own row; hours read as hours and minutes; each punch shows where it was made. The red Missing cell is a forgotten clock-out."
    },
    {
      "n": 2,
      "text": "Every request you sent this period, with its status. Click one to Cancel Request while it waits."
    }
  ]
}
```

Open **Workday** and click the **Time Sheet** tab. You see the current pay period, day by day.

- **Move between pay periods** with the arrows beside the dates, or click the dates to pick a recent period from the list (the current one is marked).
- **A shift with a break** shows as two punch pairs: clock-in to the start of the break, then the end of the break to clock-out, each with its hours, and the break between them on its own row.
- **Sick, vacation and personal hours** show on their own lines.
- **Hours read as hours and minutes**, for example 8:15 for eight hours and fifteen minutes. Nexus never shows hours as decimals on screen, so you will never see 8.25 and wonder what it means.
- **Each punch shows where it was made** (the Punching In, Breaks and Punching Out lesson): the site name, Out of Location, Approx. Location, Location Off or No Location.

On a phone, each day is its own card.

## When Something Is Missing or Wrong

You cannot simply edit your own punches. Instead, you **ask for a change**, with a reason, and your approver (usually your manager) decides. Every original punch stays on record with who changed what. This protects you: nobody can quietly change your hours either.

### A Missing Clock-Out

```figure
{
  "kind": "screen",
  "title": "Request a Missing Punch",
  "device": "card",
  "parts": [
    {
      "kind": "dialog",
      "title": "Request a Missing Punch",
      "text": "Wed 11/04 · clocked in at 8:05 AM, no clock-out recorded.",
      "fields": [
        {
          "label": "Clock-Out Time",
          "value": "5:00 PM",
          "n": 1
        },
        {
          "label": "Reason",
          "kind": "textarea",
          "value": "Forgot to punch out, left at 5:00 PM after locking the gate.",
          "n": 2
        }
      ],
      "buttons": [
        "Cancel",
        {
          "label": "Send to Approver",
          "primary": true
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "The real time you stopped working, in your own time zone."
    },
    {
      "n": 2,
      "text": "Required. Write what happened and the real time, something your manager can check."
    }
  ]
}
```

If you forgot to punch out, the day shows a red **Missing** cell, and on a phone the row offers **Add Clock-Out**.

1. Click the red **Missing** cell (or **Add Clock-Out**).
2. The **Request a Missing Punch** box opens. Enter the real time you stopped working.
3. Give a reason, for example "Forgot to punch out, left at 5:00 PM after locking the gate." The reason is required.
4. Send it.

Nexus confirms: "Request sent to your approver - it shows on your time sheet as Not Yet Approved until they decide." The day now shows a **Not Yet Approved** tag until your approver decides.

### A Break Problem

If a break was never ended or is wrong, the row offers **Fix Break** (on a phone) or you click the break line. The box is titled **Request a Missing Break Punch** when you are asking for a break punch that is missing. Enter the right time, give a reason and send it. You can also ask to remove a break that should not be there.

### Missing Time on a Day

To ask for time that is not there at all (you worked but never punched, or you need to add approved leave):

1. Click **Add** on the day. Days still ahead have no Add.
2. Pick the **Type**: Regular, Break, Sick, Vacation or Personal.
3. Set the start and end, and give a reason.
4. Tick **Clock In**, **Clock Out** or both. If you are still at work and only the clock-in is missing, ask for just the clock-in (today starts with Clock Out unticked). Once it is approved you are clocked in, and you punch out as usual.

> [!TIP]
> Times you enter are in your own time zone. Write a reason your manager can check: what happened and the real times. "Forgot" alone is not enough; "Forgot to punch in, opened the office at 8:00 AM, see my Beginning of Day message" is.

### Following Your Requests

Every request you send this period is listed under **Change Requests This Period** on the Time Sheet tab, with its status: waiting, **Approved** or **Rejected**. To take one back while it is still waiting, click it and choose **Cancel Request**.

You can also leave a note on a day for your manager with **Add Note**, for example to explain a long day.

## Approval and Signing

```figure
{
  "kind": "screen",
  "title": "Time Sheet Review & Signature",
  "device": "computer",
  "module": "Workday",
  "tabs": [
    "Overview",
    "Time Sheet",
    "Time Off",
    "Performance"
  ],
  "tab": "Time Sheet",
  "badge": 1,
  "parts": [
    {
      "kind": "banner",
      "tone": "warn",
      "text": "Your Time Sheet for 10/16 to 10/31 is approved and waiting for your signature.",
      "buttons": [
        "Open"
      ]
    },
    {
      "kind": "card",
      "title": "Time Sheet Review & Signature",
      "note": "Time Sheets to Sign",
      "rows": [
        {
          "label": "10/16 to 10/31 · 79:40 · approved by D. Reyes on 11/02/2026",
          "value": "Approved",
          "tone": "ok"
        }
      ],
      "fields": [
        {
          "kind": "check",
          "label": "I was provided every meal and rest break California law requires.",
          "value": true,
          "n": 1
        }
      ],
      "buttons": [
        {
          "label": "Report a Missed Break",
          "n": 2
        },
        {
          "label": "Sign & Submit",
          "primary": true,
          "n": 3
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "Signing confirms the break statement. Never sign one that is not true."
    },
    {
      "n": 2,
      "text": "Hourly California staff: pick the days and Meal or Rest, then Send Back to Manager."
    },
    {
      "n": 3,
      "text": "Only you sign your Time Sheet. Your manager approves it and never signs it."
    }
  ]
}
```

```figure
{
  "kind": "steps",
  "title": "From the End of the Pay Period to Payroll",
  "items": [
    {
      "label": "The pay period ends",
      "note": "nothing to submit"
    },
    {
      "label": "Your manager reviews",
      "note": "Review & Approve, or Send Back with a note"
    },
    {
      "label": "You get a bell and an email",
      "note": "often a yellow priority bar too"
    },
    {
      "label": "You sign",
      "note": "Sign & Submit, in Nexus Sign"
    },
    {
      "label": "The period is final",
      "note": "the signed copy files to My Documents"
    }
  ],
  "caption": "Only you sign your Time Sheet. Your manager approves it and never signs it."
}
```

Here is the whole flow, start to finish:

1. **The pay period ends.** You do not have to submit anything first. (If you want your manager to look early, **Send to Manager** asks them to review before the period ends. It is optional.)
2. **Your manager reviews.** They click **Review & Approve**, or **Send Back** with a note if something needs fixing. If it comes back to you, fix what the note says (usually by sending a change request) and it goes back to them.
3. **You get a bell and an email** when it is approved, and often a yellow priority bar too.
4. **You sign.** On the **Time Sheet** tab, **Time Sheet Review & Signature** is at the top, and **Time Sheets to Sign** lists any period still waiting on you. Check the hours, click **Sign & Submit**, and sign in Nexus Sign.
5. **Your signature finalizes the period** for payroll. The signed copy is filed in **My Documents**.

**Only you sign your Time Sheet.** Your manager approves it but never signs it. Nobody else can sign it for you.

> [!WARNING]
> Do not sign a Time Sheet you think is wrong to "get it over with." Your signature says the hours are right. If something is wrong, fix it first (below). If your manager or HR asks you to sign hours you believe are wrong, raise it with HR through **Ask HR**.

### When Something Is Wrong After Approval

If you spot a problem after your manager approved, you have two choices, and both send it back to your manager:

- **Ask for a punch fix** on the day, the same way as above.
- **Decline in Nexus Sign with a reason**, for example "Thursday is missing my 2:00 PM to 5:00 PM shift."

Your manager fixes or approves the change, approves again, and you sign the corrected Time Sheet.

### When HR Corrects It

HR can correct a Time Sheet at any point. If HR changes one after you signed, you are asked to **Sign Updated Time Sheet**. Check what changed, then sign it, or decline it with what is wrong.

## Approved Time Off Is Not Punched for You

When your time off request is approved (the Schedules and Time Off lesson), Nexus does **not** add those hours to your Time Sheet by itself. To be paid for approved sick or vacation time, click **Add** on the day, pick the Type **Sick** or **Vacation**, set the hours and send it. Sick, vacation and personal time then show on their own lines.

## A Greens Scenario

On Tuesday morning, Ana at Temecula checks her Time Sheet and sees a red **Missing** cell on Monday's clock-out. She remembers: she helped a tenant with a stuck RV at closing and walked out without punching. She clicks **Missing**, enters 5:20 PM, writes "Helped tenant in RV row 3 at close, left 5:20 PM, forgot to punch out" and sends it. Monday now shows **Not Yet Approved**.

Her manager approves it that afternoon. At the end of the pay period, her manager clicks **Review & Approve**. Ana gets a bell. She opens the **Time Sheet** tab, checks every day, and notices Friday is 0:30 short: she worked through what shows as a long break. She declines in Nexus Sign with "Friday break ended at 12:30 PM, not 1:00 PM." Her manager fixes it, approves again, and Ana clicks **Sign & Submit**. The signed copy appears in **My Documents**.

## Common Mistakes

- **Waiting until signing day to check.** Check weekly; fixes are easier while you remember.
- **Punching again to fix a missing punch.** Ask for the change on the Time Sheet instead.
- **A reason with no detail.** Give the real times and what happened.
- **Expecting approved time off to appear by itself.** Add it with **Add**, Type Sick or Vacation.
- **Signing hours you know are wrong.** Decline with a reason or ask for a punch fix.

## Key Points

- Your Time Sheet is your pay record. Hours show as hours and minutes, never decimals.
- Fix problems by asking: the red **Missing** cell, **Add Clock-Out**, **Fix Break** or **Add** on a day, always with a reason. Requests show **Not Yet Approved** until your approver decides.
- **Change Requests This Period** lists your requests; **Cancel Request** takes one back.
- After the period ends, your manager clicks **Review & Approve** or **Send Back**. Then **only you** sign, with **Sign & Submit** in Nexus Sign.
- After approval, fix a problem with a punch fix request or by declining in Nexus Sign with a reason.
- Approved time off is not punched for you. Add it as Sick or Vacation.
