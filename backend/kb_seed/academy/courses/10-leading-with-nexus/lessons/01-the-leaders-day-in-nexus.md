---
title: The Leader's Day in Nexus
summary: How a manager's Nexus differs from an employee's, the decisions that come to you and where they wait, the team widgets on the Dashboard, the two things to look at every morning and the habits that keep a team running on the record.
---

## What You'll Be Able to Do

- Say what changes in Nexus when you lead people: the Approvals tab, the Team widgets, the team views inside each module.
- Build a Dashboard that shows your team at a glance.
- Name the two things to look at every morning and the one rule for everything you decide.
- Explain why a leader who acts outside Nexus leaves the team without a record.

## What Changes When You Lead

Nexus Fundamentals taught Nexus as an employee uses it: your clock, your Time Sheet, your requests. A leader keeps all of that and gains three things:

| Gain | Where | What it holds |
|---|---|---|
| **Decisions** | Dashboard > Approvals, and the bell | Time off, punch fixes, Time Sheets, shift requests, reimbursements, purchase requests and more, each waiting on you |
| **Your team's view** | Team > Shifts and the Shift Planner; the Team widgets; My Team | Who is on the clock, who is late, who is out, what is due |
| **Reach inside modules** | The desk side of Tickets, Compliance under Training, the People module, Asset Management | The same modules, with the manager's screens open |

Your tier (Manager, Administrator, Super Administrator) and your grants decide how far each reaches. A Manager approves for their team; an Administrator runs a company inside its walls; only a Super Administrator crosses them. The Access, Settings and the Record lesson comes back to this.

## The Dashboard, Built for a Leader

```figure
{
  "kind": "screen",
  "title": "A Leader's Dashboard",
  "device": "computer",
  "module": "Dashboard",
  "tabs": ["Dashboard", "Approvals", "Notes", "Links"],
  "tab": "Dashboard",
  "actions": ["Customize"],
  "badge": 6,
  "parts": [
    { "kind": "banner", "tone": "warn", "text": "3 Time Sheets are waiting for your review.", "buttons": ["Open"], "n": 1 },
    { "kind": "tiles", "items": [{ "label": "Team Attendance", "value": "7 of 9 in" }, { "label": "Team Approvals", "value": "5", "n": 2 }, { "label": "Time Exceptions", "value": "2" }, { "label": "Out Today", "value": "1" }] },
    { "kind": "card", "title": "Pending Approvals", "rows": [{ "label": "Time off · Priya N. · 12/21 to 12/23", "value": "Recommended: Approve", "tone": "ok" }, { "label": "Punch fix · Sam O. · Wed 11/04 clock-out 5:00 PM", "value": "Decide" }, { "label": "Time Sheet · Marco V. · 10/16 to 10/31", "value": "Review & Approve" }], "n": 3 },
    { "kind": "card", "title": "Who Has What", "rows": [{ "label": "Pressure washer PW-02", "value": "Sam O. · due back 11/12" }, { "label": "Site keys, ring B", "value": "Priya N. · assigned" }] },
    { "kind": "card", "title": "Ticket Queue", "rows": [{ "label": "Needs Reply", "value": "2", "tone": "warn" }, { "label": "Unassigned", "value": "1" }, { "label": "Waiting for Vendor", "value": "3" }] }
  ],
  "callouts": [{ "n": 1, "text": "The yellow priority bar is for leaders too: a Time Sheet to review holds up someone's pay." }, { "n": 2, "text": "The Team widgets (Team Attendance, Team Approvals, Pending Approvals, Who Has What, Team Time, Ticket Queue, Time Exceptions, Out Today, Pending Purchases, My Team) are in Add Widget under Team, for managers and above." }, { "n": 3, "text": "Decisions wait here and on the Approvals tab; every one opens to the record it is about." }]
}
```

Open **Customize**, **Add Widget**, and the **Team** category holds the leader's widgets. Build the view once: attendance and exceptions at the top, approvals and the ticket queue under them, Who Has What and Out Today where you can see them. Save it as your default. A leader's Dashboard is a control room, not a greeting.

## The Two Things Every Morning

1. **Who is here.** Team Attendance and Time Exceptions: who clocked in, who is late against their shift, who has an open break, who is off. A No-Show you learn about at 8:15 AM is a schedule problem; one you learn about at noon is a customer problem.
2. **What is waiting on you.** The Approvals tab and the bell. A time off request answered in a day keeps a schedule honest; a punch fix answered in a day keeps a Time Sheet signable; a Time Sheet reviewed on time keeps payroll on time.

Everything else in a leader's week (the planner, the desk, the people records, the training) builds on those two.

## The One Rule

```figure
{
  "kind": "cycle",
  "title": "Decide in Nexus, Every Time",
  "items": [
    { "label": "It comes to you", "note": "a request, a Time Sheet, a ticket, a bell" },
    { "label": "You read the record", "note": "the request, the reasons, the history" },
    { "label": "You decide in Nexus", "note": "approve, send back, reply, assign" },
    { "label": "The person is told", "note": "a bell, an email, the yellow bar" },
    { "label": "The record stands", "note": "who decided what, when, and why" }
  ],
  "caption": "A decision made by text or in the hallway leaves the person without a record and leaves you defending it later from memory."
}
```

Everything a leader decides about a person's time, pay, schedule or request is decided in Nexus. The approval you give in the hallway is not an approval until it is in Nexus; the shift you promised by text does not exist until it is in the planner; the ticket you closed verbally is still open. The reasons are not bureaucratic: a decision in Nexus notifies the person, protects you both with a record, and keeps the next step (payroll, the schedule, the vendor) moving without a phone call.

## A Greens Scenario

Dana, site manager at Temecula, opens Nexus at 7:55 AM on a Monday. The yellow bar says three Time Sheets wait for her review (the period ended Sunday). Team Attendance shows seven of nine in, one on approved time off and one not yet clocked in against an 8:00 AM shift. Pending Approvals holds a time off request marked Recommended: Approve and a punch fix with a clear reason. By 8:20 she has approved both, reviewed the three Time Sheets (one sent back with a note about a missing Thursday shift), and messaged the late teammate on Teams from the My Team widget. Nothing left her desk by text.

## Common Mistakes

- **Keeping the employee's Home layout** and missing the Team widgets.
- **Deciding in the hallway** and forgetting to record it; the person never hears, and payroll waits.
- **Reading the bell as noise.** Every notice a leader gets is a decision or a fact about the team.

## Key Points

- A leader gains decisions (Approvals, the bell), the team's view (widgets, Team > Shifts, My Team) and the manager's screens inside each module, as far as their tier and grants reach.
- Build the Dashboard from the Team widgets and make it your default.
- Every morning: who is here, and what is waiting on you.
- Decide in Nexus, every time: the person is told, the record stands, the next step moves.
