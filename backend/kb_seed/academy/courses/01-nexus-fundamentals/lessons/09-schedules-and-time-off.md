---
title: Schedules and Time Off
summary: Read and confirm your schedule, use shift requests when your company allows them, request time off the right way, and understand how approved time off and company holidays reach your pay.
---

## What You'll Be Able to Do

- Read your week in **My Schedule** and **Confirm** a newly shared schedule.
- Explain what **Usual Hours**, **Request Pending** and the past shift words mean.
- Use shift requests (swap, offer, release, open shifts) when your company has turned them on.
- Request time off, including a past date and a confidential request, and follow it to a decision.
- Explain why approved time off still needs to go on your Time Sheet, and how company holidays work for hourly staff.

## Your Schedule

Your schedule is on the **Workday** Overview under **My Schedule**. At the top, a line sums up the week: your shifts, paid hours, time off and your next shift. Below it are your days, one by one.

What you may see on a day:

| You see | Meaning |
|---|---|
| A shift with times | A shift your manager placed and shared. |
| **Usual Hours** | Your regular schedule, shown on days with no shared shift. |
| **Request Pending** | You asked to swap, offer or release this shift and it is waiting. |
| Time off | Approved time off on that day. |
| On Time, Late, Left Early or No-Show | On a past shift, how your punches matched the shift. Tap it to read more. |

The **My Week | Team** switch shows your whole group's week in the same card. The same view is under **Team**, then **Shifts**, where you are pinned at the top and a green dot marks who is on shift right now. As an Employee you can look but not change anything. Managers build the schedule in the **Shift Planner**.

> [!NOTE]
> Late, No-Show and early punch notices all work from your schedule. When your manager shares shifts, Nexus knows when you are expected and can tell your manager if you have not clocked in. That is one more reason to punch in and out every shift (the Punching In, Breaks and Punching Out lesson).

### Confirm a New Schedule

```figure
{
  "kind": "screen",
  "title": "A Shared Schedule to Confirm",
  "device": "phone",
  "module": "Workday",
  "badge": 1,
  "parts": [
    {
      "kind": "banner",
      "tone": "ok",
      "text": "Your schedule was shared on 11/09/2026 by your manager (3 changes) - have a look and confirm.",
      "buttons": [
        {
          "label": "Confirm",
          "primary": true,
          "n": 1
        }
      ]
    },
    {
      "kind": "card",
      "title": "My Schedule",
      "note": "5 shifts · 40 paid hours · next: Mon 9:00 AM",
      "rows": [
        {
          "label": "Mon 11/16",
          "value": "9:00 AM to 5:30 PM"
        },
        {
          "label": "Tue 11/17",
          "value": "9:00 AM to 5:30 PM"
        },
        {
          "label": "Wed 11/18",
          "value": "Usual Hours"
        },
        {
          "label": "Thu 11/19",
          "value": "11:00 AM to 7:30 PM",
          "tone": "live",
          "n": 2
        },
        {
          "label": "Fri 11/20",
          "value": "Time off"
        }
      ],
      "buttons": [
        "My Week",
        "Team",
        "Subscribe in another calendar"
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "Confirm means I have seen it. Then talk to your manager if a day does not work."
    },
    {
      "n": 2,
      "text": "A changed day."
    }
  ]
}
```

When your manager shares a new or changed schedule, you get a bell (and an email), and a banner at the top of My Schedule says: "Your schedule was shared on 11/09/2026 by your manager (3 changes) - have a look and confirm."

1. Read the days that changed.
2. Click **Confirm**.

Confirm means "I have seen it." If something on the schedule does not work for you, confirm it and then talk to your manager or use a shift request, if your company allows them. Do not just ignore the banner; your manager can see who has not confirmed.

### Your Shifts in Your Calendar

Below the week, **Subscribe in another calendar** puts your shifts in a calendar app on your phone. If your company has turned on Outlook calendar sync, your shared shifts can also show in your Outlook calendar. **My Availability** is where you tell your manager about days or times you cannot work.

## Shift Requests

Swapping, offering and releasing shifts, and asking for open shifts, are **off by default**. Each company decides whether to turn them on. If your company has not, you will not see a **Request** button under your shifts, and you handle changes by talking to your manager.

When they are on:

1. In **My Schedule**, click **Request** under one of your shifts.
2. Pick **Swap** (trade one of your shifts for a teammate's), **Offer** (give one of your shifts to a teammate) or **Release** (put it in the open pool, when allowed).
3. Pick the teammate and, for a swap, one of their shifts.
4. Send it with **Send Swap Request**, **Send Offer** or **Release Shift**. To ask for an open shift, use **Request Shift**.

Your requests and the ones sent to you are under **Workday**, **Time Off**, then **Shift Requests**. A request moves through **Waiting On Teammate** (your teammate must **Accept** or **Decline**) and **Waiting On Manager** (a manager approves it). Until it is approved, the original shift stands. Work the shift you are scheduled for until you see it approved.

## Requesting Time Off

```figure
{
  "kind": "screen",
  "title": "Request Time Off",
  "device": "computer",
  "module": "Workday",
  "tabs": [
    "Overview",
    "Time Sheet",
    "Time Off",
    "Performance"
  ],
  "tab": "Time Off",
  "parts": [
    {
      "kind": "form",
      "title": "Request Time Off",
      "fields": [
        {
          "label": "Reason",
          "kind": "select",
          "value": "Vacation"
        },
        {
          "label": "From",
          "value": "12/21/2026"
        },
        {
          "label": "To",
          "value": "12/23/2026"
        },
        {
          "kind": "check",
          "label": "All day",
          "value": true
        },
        {
          "label": "Note",
          "kind": "textarea",
          "hint": "Anything your approver should know"
        },
        {
          "kind": "check",
          "label": "Keep this confidential",
          "value": false,
          "n": 1
        }
      ],
      "text": "Counts as 3 working days. Leaves you 7 vacation days.",
      "buttons": [
        {
          "label": "Request for a Past Date",
          "n": 2
        },
        {
          "label": "Request",
          "primary": true
        }
      ]
    },
    {
      "kind": "list",
      "title": "My Requests",
      "note": "Your manager decides - you get a bell notification.",
      "items": [
        {
          "label": "Vacation · 11/27/2026",
          "note": "1 day",
          "badge": "Approved",
          "tone": "ok"
        },
        {
          "label": "Sick · 11/05/2026",
          "note": "1 day",
          "badge": "Pending",
          "tone": "warn"
        }
      ]
    }
  ],
  "callouts": [
    {
      "n": 1,
      "text": "Your team sees only that you are out, never the note."
    },
    {
      "n": 2,
      "text": "Sick yesterday and could not ask in time? Past dates are grayed out; this is the way."
    }
  ]
}
```

Open **Workday** and click the **Time Off** tab. The **Request Time Off** form has:

| Field | What to enter |
|---|---|
| **Reason** | Personal, Sick, Vacation or Medical Appointment (your company may add others). |
| **From** and **To** | The first and last day. |
| **All day** | On for whole days. Turn it off to take part of one day, then set the start and end time. |
| **Note** | Optional: anything your approver should know. |
| **Keep this confidential** | Your team sees only that you are out, never the note. |

Click **Request**. As you fill it in, the form shows what the request counts as (working days or hours), and if your company tracks leave balances, what it would leave you with.

### Past Dates

Past dates are grayed out. If you were sick yesterday and could not request it in time, click **Request for a Past Date** and ask for it.

### Following Your Request

Your requests are listed under **My Requests** with their status: Pending, Approved, Rejected or Canceled. As the screen says: "Your manager decides - you get a bell notification." If your company requires a second approval by HR, a request your manager approved reads **Awaiting HR Approval** until HR decides. You can cancel a request that is pending or approved if your plans change.

Also on the Time Off tab:

- **My Paid Time Off:** your vacation and sick balances, when your company has leave policies set up.
- **Team Leave Calendar:** a month of who is out on your team, with company holidays marked. A confidential request shows only as Out.
- **Delegate My Approvals:** for managers only, to hand approvals to someone while they are away.

> [!TIP]
> Request time off as early as you can, in Nexus, not by text. A text can be missed and leaves no record. A request in Nexus goes to the right approver and keeps its whole history.

## Approved Time Off and Your Pay

Two rules surprise new hourly team members. Learn them now:

1. **Approved time off is not punched in for you.** To be paid for approved sick or vacation time, add it on your Time Sheet: **Add** on the day, Type **Sick** or **Vacation** (the Your Time Sheet lesson).
2. **Company holidays are unpaid for hourly staff.** For hourly employees, a company holiday is a day off with the office closed and no pay. If you do work on a holiday, those hours are paid as usual. Salaried staff follow a separate rule.

## A Greens Scenario

Jordan works at a Texas site. On Sunday night he gets a bell: his schedule for next week was shared. He opens **My Schedule**, sees the banner, notices he now opens on Wednesday instead of closing, and clicks **Confirm**.

He has a dentist appointment on 11/20/2026 from 1:00 PM to 3:00 PM. He opens **Time Off**, picks **Medical Appointment**, sets From and To to 11/20/2026, turns **All day** off, sets 1:00 PM to 3:00 PM and clicks **Request**. Two days later he gets a bell: Approved. On 11/20/2026, after his appointment, he adds the two hours on his Time Sheet with **Add**, Type **Sick**, so they are paid.

His coworker asks him to swap Saturday. Jordan looks for a **Request** button under the shift and does not see one; his company has not turned shift requests on. He asks his manager instead.

## Common Mistakes

- **Ignoring the Confirm banner.** Confirm every shared schedule.
- **Assuming a swap is done when a teammate agrees.** A manager still approves it. Until then, work your original shift.
- **Texting a manager for time off.** Use **Request Time Off**.
- **Forgetting to add approved leave to the Time Sheet.** It is not added by itself.
- **Expecting holiday pay as an hourly employee.** Company holidays are unpaid days off for hourly staff.

## Key Points

- **My Schedule** on the Workday Overview shows your week. **Usual Hours** fills days with no shared shift.
- **Confirm** every newly shared schedule.
- Shift requests (swap, offer, release, open shifts) are off by default; your company decides. They wait on your teammate, then a manager.
- **Request Time Off**: Reason, From, To, All day, Note, **Keep this confidential**, then **Request**. Use **Request for a Past Date** for a day already gone.
- Approved time off is not punched for you; add it as Sick or Vacation on your Time Sheet.
- Company holidays are unpaid for hourly staff; hours worked on a holiday are paid as usual.
