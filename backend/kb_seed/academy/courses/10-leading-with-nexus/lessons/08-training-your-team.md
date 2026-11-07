---
title: Training Your Team
summary: Assigning courses and building paths by role and department, due dates and the escalation that reaches you, the Compliance screen, a course's report and its hardest questions, in-person sign-offs, Read and Sign policies, the Refresher, and keeping a course current when Nexus changes.
---

## What You'll Be Able to Do

- Assign a course or a path to a person, a role or a department with the right due mode.
- Read the Compliance screen and your team's training status, and act on an escalation.
- Read a course's report: who is where, who is locked, which questions people miss.
- Sign someone off in person, and know what Read and Sign and the Refresher do.
- Keep a course current: the review flag, Mark Reviewed, and a course that teaches a screen.

## Paths by Role and Department

Training in Nexus is **learning paths**: the onboarding path (the six Academy courses), **role paths** for a job title, **department training** for a department, and custom paths. A path is stages of courses and policies; a person is assigned the path and sees their ladder. Under Knowledge Base & Training > Manage > Learning Paths, every job title and department in People that has no path is suggested one.

```figure
{
  "kind": "steps",
  "title": "How a Course Reaches a Person",
  "items": [
    { "label": "By rule", "note": "a path or rule for their role, department or company; new hires only, or everyone" },
    { "label": "By hand", "note": "you assign it, with a date or the course's default days" },
    { "label": "By enrollment", "note": "they start it from the Catalog themselves" },
    { "label": "By renewal", "note": "a certificate that renews puts the course back 30 days before it expires" }
  ]
}
```

A rule or path is due either **within so many days of the person's start date** or **by one date for everyone** (a company-wide deadline), with the days as the grace for someone who joins after that date. A rule marked new hires only is the onboarding track.

## Due Dates and Escalation

Every assignment has a due date. Reminders go to the learner; when a course is still not done some days after its due date, the **escalation** comes to you, once and then weekly, until it is done. It is a nudge to a conversation, not a mark on the person: ask what is in the way (time on the schedule, a locked quiz, a course that is not loading), and fix that.

## The Compliance Screen

```figure
{
  "kind": "screen",
  "title": "Training, Compliance, Your Team",
  "device": "computer",
  "module": "Knowledge Base & Training",
  "sub": "Help Center",
  "tabs": ["Library", "Training", "Manage"],
  "tab": "Training",
  "actions": ["My Learning", "Catalog", { "label": "Compliance", "primary": true }],
  "parts": [
    { "kind": "table", "title": "Temecula team", "columns": ["Person", "Course or policy", "Status", "Due", "Valid through"], "rows": [
      ["Priya N.", "New Hire: Facility Team (path)", "4 of 6 done", "12/04/2026", ""],
      ["Priya N.", "Site Hours and Access Policy v2", "Signed", "", ""],
      ["Sam O.", "Property & Vendor Management", "Overdue 6 days", "11/01/2026", ""],
      ["Sam O.", "Hands-On Check", "Completed In Person", "", "11/2027"],
      ["Marco V.", "Nexus Fundamentals", "Completed", "", "No expiry"],
      ["Marco V.", "Customer Service & Sales", "Locked: 3 tries used", "", ""]], "n": 1 },
    { "kind": "banner", "tone": "warn", "text": "1 overdue · 1 locked quiz · 2 escalated to you", "buttons": ["Export"], "n": 2 }
  ],
  "callouts": [{ "n": 1, "text": "Red first: overdue, then locked, then in progress. A locked quiz is a person waiting for you to unlock another round." }, { "n": 2, "text": "The export is the record an auditor or an insurer asks for." }]
}
```

**Compliance** shows your people's training: each course and policy, its status (Not Started, In Progress, Completed, Overdue, Expired), due dates, validity, and who is locked out of a quiz after their tries. Your scope is your team; HR and administrators see further. Two things to act on weekly: anyone **Overdue**, and anyone **Locked** (a manager unlocks another round from the course report, after a conversation about what to reread).

## A Course's Report

A course you own, or any course if you manage the Knowledge Base, has a **Report**: who is assigned, who is where, scores, tries used, who is locked, and the **hardest questions**, the ones people miss most. A hard question is a lesson that did not land or a question that is wrong; either way it is the author's next edit. The report also carries the course's **feedback**: the star ratings and comments learners left, without their names.

## In-Person Sign-Off, Read and Sign, the Refresher

- **In-person courses** (the Hands-On Check) are completed when you, or a trainer, watch the person do the work and sign them off in Nexus, in a **session** or one by one. The course shows Completed In Person. Nothing is signed off that was not seen.
- **Read and Sign** policies are pages the person must read and sign; a new version asks for a new signature, a small fix does not. The Compliance screen shows who has not.
- The **Refresher** asks every person three questions a day from the courses they passed, on a widening schedule. It is theirs, not a score and not yours to chase; what you will notice is a team that remembers what it was taught.

## Keeping a Course Current

```figure
{
  "kind": "screen",
  "title": "A Course Flagged for Review",
  "device": "computer",
  "module": "Knowledge Base & Training",
  "sub": "Training",
  "tabs": ["Library", "Training", "Manage"],
  "tab": "Training",
  "parts": [
    { "kind": "banner", "tone": "warn", "text": "Nexus changed since this course was reviewed. Workday: Time Sheet shows breaks on their own row (11/05/2026). Read the lessons that teach Workday, then publish your edits or Mark Reviewed.", "buttons": [{ "label": "Mark Reviewed", "n": 1 }] },
    { "kind": "card", "title": "Nexus Fundamentals · v3 live", "rows": [{ "label": "Teaches", "value": "Dashboard, Workday, Time Clock, Time Sheet, Tickets, Forms, Training", "n": 2 }, { "label": "Reviewed", "value": "10/30/2026" }, { "label": "Learners", "value": "41 · 36 completed" }] }
  ],
  "callouts": [{ "n": 1, "text": "The author reads the changed lessons against the new screen and either edits and publishes, or says it is still right." }, { "n": 2, "text": "A course says which Nexus modules it teaches. When What's New releases a change to one of them, the course is flagged, and the Help panel offers the course on that screen." }]
}
```

A course that teaches Nexus goes stale the day Nexus changes. So every course says which modules it **teaches**, and when What's New releases a change to one of them, the course is **flagged** for its owner with the entries that changed, and the owner is belled once. The owner reads the lessons that teach that module against the new screen and either edits and publishes (a publish is a review) or clicks **Mark Reviewed**. Learners see the course's reviewed date on its home page, and the Help panel's **Learn This Screen** card offers the course on the screen it teaches. The same tag is why the Academy's own content can be refreshed from the repository into courses nobody edited: the courses follow the product.

## A Greens Scenario

Dana's Compliance screen shows Sam six days overdue on Property & Vendor Management and Marco locked on the Customer Service quiz after three tries. She asks Sam on Teams; he has had no office hours on the schedule, so she puts two hours of training time on Thursday's shift in the planner. She opens the Customer Service course report: Marco's misses are all in the Collections With Respect lesson, which is also the course's hardest. She talks it through with him, unlocks another round, and tells the course owner the lesson may need a clearer example.

## Common Mistakes

- **Assigning a course with no path or role behind it**, so the next hire in that job gets nothing.
- **Reading an escalation as a mark on the person** instead of a schedule problem.
- **Unlocking a quiz without the conversation.**
- **Signing someone off in person** for work you did not see.
- **Ignoring a review flag.** A course that teaches the old screen teaches the wrong thing.

## Key Points

- Training is paths by role and department; a course reaches a person by rule, by hand, by enrollment or by renewal, due within days of start or by one date.
- Escalations come to you once, then weekly; Compliance shows your team; act on Overdue and Locked weekly.
- A course's report shows who is where and the hardest questions; in-person sign-off is only for work seen; Read and Sign and the Refresher run on their own.
- A course says what it teaches; What's New flags it when that changes; the owner publishes or marks it reviewed; the Help panel offers it on its screen.
