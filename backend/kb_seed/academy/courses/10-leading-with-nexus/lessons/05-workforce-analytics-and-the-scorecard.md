---
title: Workforce Analytics and the Scorecard
summary: The Workforce Analytics tab under Team, the weekly Workforce Scorecard that compares punched hours with expected hours, what counts as expected and what excuses a day, who sees whom, the Monday email, and what a leader does with a red week.
---

## What You'll Be Able to Do

- Explain how the scorecard works out expected hours and what excuses a day.
- Read your team's week: direct reports, your reporting line or the company, by your grant.
- Say what a red week means and does not mean, and what to do with one.
- Know where the policy that governs the analytics lives and who may change it.

## What the Scorecard Measures

Every week, hourly staff are scored on **punched hours against expected hours**. The number is not a judgment; it is a comparison, and the same rule is used for everyone so the comparison is fair.

```figure
{
  "kind": "steps",
  "title": "How a Day's Expected Hours Are Decided",
  "items": [
    { "label": "A published shift", "note": "the shared schedule wins" },
    { "label": "Else the shift preset", "note": "the person's usual hours on their working days" },
    { "label": "Else the country's standard day", "note": "8 hours in the US, 9 in India, Monday to Friday, full-time only" },
    { "label": "Part-time with no shift", "note": "No Schedule: never guessed" }
  ],
  "caption": "Holidays and approved time off excuse the day; a Sick or PTO punch is leave that covers it. Only days before the person's own local today are scored."
}
```

| Rule | What it means |
|---|---|
| **Expected** | The published shift; else the usual-hours preset; else the country's standard day for a full-time person. A part-timer with no shift is No Schedule, never guessed |
| **Excused** | A company holiday (country-tagged) or approved time off; a Sick or PTO punch covers the day as leave |
| **Scored** | Only days before the person's own local today; the week is not judged before it happens |
| **The same rule everywhere** | The one expected-start rule the planner, My Team and the no-show scan read; the scorecard reads it too |

The screen and the Monday email are built by the same calculation, so what you read on Monday morning is what the screen shows.

## Who Sees Whom

```figure
{
  "kind": "screen",
  "title": "Workforce Analytics, a Week",
  "device": "computer",
  "module": "Team",
  "tabs": ["Shifts", "Shift Planner", "Directory", "Workforce Analytics"],
  "tab": "Workforce Analytics",
  "actions": ["◀  Week of 11/02/2026  ▶", "Direct Reports"],
  "parts": [
    { "kind": "table", "title": "Punched Against Expected", "columns": ["Person", "Expected", "Punched", "Gap", "Days", "Note"], "rows": [
      ["Priya N.", "40:00", "40:25", "+0:25", "5 of 5", "On schedule"],
      ["Sam O.", "40:00", "32:10", "-7:50", "4 of 5", "Thu: no punch, shift 7:30 AM to 4:00 PM"],
      ["Marco V.", "32:00", "32:05", "+0:05", "4 of 4", "Fri excused: approved time off"],
      ["Tasha R.", "No Schedule", "18:40", "", "", "Part-time, no shared shifts"]], "n": 1 },
    { "kind": "card", "note": "Viewer: your direct reports. Editor: your whole reporting line. Full: the company. The Monday email goes to every grant holder with people in scope.", "n": 2 }
  ],
  "callouts": [{ "n": 1, "text": "A gap is a fact to read with the schedule beside it: a missed day, a short day, or a schedule that was never shared." }, { "n": 2, "text": "The grant decides the scope; the default for a manager is direct reports." }]
}
```

Access is the **Workforce Scorecard** grant: **Viewer** sees direct reports (the default for a manager), **Editor** the whole reporting line, **Full** the company. The **Monday email** goes to every grant holder with people in scope. The Workforce Analytics tab under Team shows the same thing on screen, week by week, with each person's days.

## A Red Week

A gap is a fact, and the first job is to read it with the schedule beside it:

| What you see | What it usually is | What to do |
|---|---|---|
| A whole day missing against a shared shift | A no-show, a forgotten punch, or a shift that should have been changed | Check the no-show rollup for that day; if they worked, a punch fix request; if the shift was wrong, fix the planner |
| Short days against a shift | Late arrivals or early departures | Team > Shifts shows On Time, Late and Left Early by day; a pattern is a conversation |
| A gap with No Schedule | A part-timer with no shared shifts | Share their shifts, or accept that the scorecard cannot score them |
| A gap on an excused day | The excuse was not recorded | Approve the time off, or the holiday calendar is missing a date |

What a red week is not: pay. The scorecard measures attendance against expectation; the Time Sheet and payroll are a separate record. A conversation about a red week is about the schedule and the habits, with the person's own days in front of you.

## The Policy

The rule behind the analytics (what is measured, how it is used, who sees it) is the **Workforce Analytics Policy**, kept under Settings > Workforce Analytics for each company by an administrator. It is the policy your team was shown; read it before you act on a number, and send a question about it up rather than making your own rule.

## A Greens Scenario

Monday's email shows Sam at 32 of 40 hours last week, Thursday missing. Dana checks the no-show rollup: no bell that day. Team > Shifts shows Thursday's shift was shared and Sam's punches that day are empty; his Beginning of Day message that morning says "At Murrieta covering for Jorge." He worked, at another site, with no punch. She asks him for a punch fix request for Thursday with the hours and the site, approves it when it comes, and the week turns green. Then she asks the Murrieta manager to share cover shifts in the planner next time, so the scorecard reads the day as planned.

## Common Mistakes

- **Reading the scorecard as pay.** It is attendance against expectation.
- **Judging a part-timer with No Schedule.** Share their shifts first.
- **Acting on a red week without the schedule beside it.**
- **Making your own rule** when the policy answers the question.

## Key Points

- Expected hours come from the published shift, else the preset, else the country's standard day; holidays and approved time off excuse; only past days are scored; No Schedule is never guessed.
- The grant sets the scope: direct reports, the reporting line, the company; the Monday email and the screen are one calculation.
- A red week is a fact to read with the schedule: a missing day, short days, an unshared schedule or an unrecorded excuse.
- The Workforce Analytics Policy under Settings is the rule; read it before you act.
