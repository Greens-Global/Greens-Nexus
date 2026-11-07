---
title: Reviewing and Approving Time Sheets
summary: What happens after a pay period ends, how to review a Time Sheet with the attention strip, Review & Approve and Send Back, why only the employee signs, missed-break reports and premium pay, what reopens an approved period, HR's corrections and the unsigned card, and the deadline that makes payroll on time.
---

## What You'll Be Able to Do

- Review a team member's Time Sheet from the attention strip to the last day and approve it or send it back with a note.
- Explain the signing order: the manager approves, only the employee signs.
- Handle a missed-break report and know what premium pay is.
- Say what reopens an approved period and what HR may do at any point.
- Keep the review on time so payroll is.

## After the Period Ends

A pay period ends; the next morning the Time Sheets of everyone you approve for wait for you, on the Dashboard's yellow bar and in Approvals. Nobody submits anything to you first (a person may **Send to Manager** early if they want you to look before the period ends, but that is optional). The flow:

```figure
{
  "kind": "steps",
  "title": "From the Period's End to Payroll",
  "items": [
    { "label": "The period ends", "note": "the Time Sheets come to you" },
    { "label": "You review", "note": "the attention strip, every day, the requests" },
    { "label": "Review & Approve, or Send Back", "note": "with a note that says what to fix" },
    { "label": "The employee signs", "note": "in Nexus Sign; only they sign" },
    { "label": "The period is final", "note": "payroll runs from it; the PDF carries the approval log" }
  ],
  "caption": "A manager approves and never signs. HR edits at any point without approval; the employee then signs the updated card."
}
```

## Reviewing One

```figure
{
  "kind": "screen",
  "title": "Reviewing a Time Sheet",
  "device": "computer",
  "module": "Workday",
  "sub": "Team",
  "tabs": ["Overview", "Time Sheet", "Time Off", "Performance"],
  "tab": "Time Sheet",
  "actions": ["◀  Marco V. · 10/16 to 10/31  ▶"],
  "parts": [
    { "kind": "banner", "tone": "warn", "text": "Needs attention: Thu 10/22 has a clock-in and no clock-out · Wed 10/28 punched Out of Location · 1 missed-break report", "n": 1 },
    { "kind": "table", "columns": ["Day", "In", "Out", "Hours", "Where"], "rows": [
      ["Mon 10/19", "8:02 AM", "4:45 PM", "8:13", "Temecula"], ["Tue 10/20", "7:58 AM", "4:31 PM", "8:03", "Temecula"], ["Wed 10/21", "8:05 AM", "4:40 PM", "8:05", "Temecula"],
      ["Thu 10/22", "8:00 AM", "Missing", "", "Temecula"], ["Fri 10/23", "Vacation", "", "8:00", ""], ["Wed 10/28", "8:10 AM", "4:50 PM", "8:10", "Out of Location"], ["Period", "", "", "79:40", ""]] },
    { "kind": "card", "title": "Change Requests This Period", "rows": [{ "label": "Thu 10/22 · clock-out 5:00 PM · 'locked the gate at 5, see EOD'", "value": "Approve", "tone": "ok" }] },
    { "kind": "card", "title": "Missed Break Report", "rows": [{ "label": "Tue 10/27 · Meal", "value": "Add premium pay", "tone": "warn", "n": 2 }] },
    { "kind": "banner", "tone": "ok", "text": "", "buttons": [{ "label": "Send Back", "n": 3 }, { "label": "Review & Approve", "primary": true }, { "label": "Approve and Next" }] }
  ],
  "callouts": [{ "n": 1, "text": "The attention strip lists what to look at before you approve: missing punches, location words, break reports, days with nothing." }, { "n": 2, "text": "A missed meal or rest break on the California rule is paid as premium pay; add it, and the person signs the corrected card." }, { "n": 3, "text": "Send Back carries a note that says exactly what to fix. The bar at the foot keeps Review & Approve within reach, and Approve and Next steps to the next person." }]
}
```

Open a person's Time Sheet for the period. The **attention strip** at the top lists what to look at: a missing clock-out, a punch marked Out of Location or Location Off, a missed-break report, a day with no time against a scheduled shift. Then read the days: hours and minutes, each punch with where it was made, breaks on their own rows, sick and vacation on theirs, the period's total.

Decide the **change requests** first (the previous lesson), because an approved request changes the hours. Then:

- **Review & Approve** when the hours are right and complete. **Approve and Next** does the same and steps to the next person waiting.
- **Send Back** with a note when something is missing or wrong: "Thursday is missing your 2:00 PM to 5:00 PM shift; please request it." The person fixes it (usually by a change request) and it comes back to you.

Back and forth is normal; one side edits at a time.

## Only the Employee Signs

Your approval sends the period to the employee as a Nexus Sign envelope. **Only the employee signs.** Your approval is a review, not a signature, and the signed PDF carries the approval log with your name and the time. Nobody signs for anyone else, and no signing path exists around this one.

The employee's signature also confirms the **meal and rest break statement**. An hourly employee on the California rule who missed a break clicks **Report a Missed Break** instead of signing, picks the days and Meal or Rest, and the report comes to you: you add the **premium pay** (an hour at the base rate for each day a required break was missed, as the company's rule sets it) and the card goes back for signature. Never ask anyone to sign a statement that is not true.

## What Reopens a Period

| After approval | What happens |
|---|---|
| A punch fix request | The envelope is voided and the period reopens to you |
| A manager edit | The same |
| The employee declines in Nexus Sign with a reason | The same; read the reason, fix or approve, approve again |
| **HR corrects it** | HR edits at any point without approval; the employee signs the updated card |

An employee who left, or who has not signed an approved card within the waiting period, is finalized by **HR** with a reason. Never by hiding the signature step, and never by a manager.

## The Deadline

Payroll runs from signed, final Time Sheets. Every day a review waits is a day the employee cannot sign and payroll cannot run for them. The standard: **review every Time Sheet the day after the period ends**, send back what needs fixing the same day, and approve the fixes as they come in. The yellow bar will not let you forget; the point is not to need it.

## A Greens Scenario

Dana opens Marco's Time Sheet on Monday. The strip shows a missing clock-out on Thursday, an Out of Location punch on the 28th, and a missed meal break on the 27th. The Thursday request is already in with a reason and his End of Day message; she approves it and the day fills. The 28th: he punched from the office computer, Approx. Location on the way in; the Out of Location was a phone punch from the far RV row, which the site's location circle does not quite reach. Not a problem; she notes it. The missed meal break: she adds the premium pay. Review & Approve. Marco signs by lunchtime, and payroll has his card.

## Common Mistakes

- **Approving without reading the attention strip.**
- **Approving before deciding the change requests.** The hours change under you.
- **Asking someone to sign a break statement that is not true.**
- **Editing a punch yourself after approval** without expecting the period to reopen.
- **Reviewing late.** Payroll waits with you.

## Key Points

- After the period ends the Time Sheets come to you; read the attention strip, decide the requests, then Review & Approve or Send Back with a note.
- Only the employee signs; your approval is a review the PDF records.
- A missed break on the California rule comes to you as a report; add the premium pay; the person signs the corrected card.
- A punch fix, a manager edit or a decline reopens the period; HR corrects at any point; HR finalizes a card nobody can sign.
- Review the day after the period ends.
