---
title: Punching In, Breaks and Punching Out
summary: Use the Time Clock every shift - the four buttons, the start, break and end of day messages, location at the punch, early clock-in, breaks, a forgotten punch out, a punch with no signal, and the meal and rest break statement.
teaches: Time Clock
---

Sam reaches the Fairfield office at 7:45 AM; his shift starts at 8:00 AM. At 4:45 PM he will punch out from the far RV row with no signal. Both moments have a right answer on the Time Clock, and a wrong one that costs him a fix later.

## The Four Buttons

The Time Clock sits at the top of the **Workday** Overview, at the foot of the left menu on a computer, and in a small pill on a phone. It only shows the buttons that make sense right now:

| You are | You see | What it does |
|---|---|---|
| Off the clock | **Punch In** | Starts your shift. |
| On the clock | **Start Break**, **Punch Out** | Start Break pauses paid time. Punch Out ends your day. |
| On a break | **End Break** | Puts you back on the clock. |

After a punch the clock says what happened, such as "Punched in at 8:02 AM."

> [!WARNING]
> Punch for yourself only, and only when you really start, pause or end work. Never punch for a coworker or let anyone punch for you. Your Time Sheet is a pay record you sign.

## The Message Boxes

At most Greens sites each punch asks for a short message that posts to your team's Teams chat as you, marked "Sent by Nexus":

| Punch | Box | What to write | Button |
|---|---|---|---|
| Punch In | **Beginning of Day** | What you plan to work on today | **Send & start the day** |
| Start Break | **Going on break** | A short reason, such as Lunch (required) | **Start break & notify** |
| End Break | **Resuming work** | An optional note | **End break & notify** |
| Punch Out | **End of Day** | What you finished and what is pending | **Send & clock out** |

If you already sent your message another way, tick "I already sent my login (BOD) message" (or the logout one) and the punch goes through without posting again. Some field roles skip the boxes entirely. Otherwise the punch waits for your message, so write one or two lines, or dictate them.

## Location at the Punch

Nexus checks where you are **at the moment of the punch only**. It never tracks you between punches, and a punch never waits for your location or is blocked by it. Your Time Sheet shows one of these for each punch:

| Shows | Meaning |
|---|---|
| The site name | Made at one of your company's locations. |
| **Out of Location** | Made away from every company location; flagged for review. |
| **Approx. Location** | The device gave only a rough location (common on a computer). |
| **Location Off** | Location was turned off. |
| **No Location** | No location came through. |

If you clock in with location off, a red **Needs Attention** bar offers **Turn On** (adds your location to that clock-in) and **Skip** (keeps it as Location Off and lets your manager know). Punch from your phone, on site, with location allowed, and nobody has to ask you about it later.

## Clocking In Early

```figure
{"kind": "screen", "title": "The Early Clock-In Question", "device": "phone", "module": "Workday", "parts": [{"kind": "clock", "state": "out", "value": "0h 00m", "label": "Off the clock · shift at 8:00 AM", "buttons": [{"label": "Punch In", "primary": true}]}, {"kind": "dialog", "title": "Early Clock-In", "text": "Your shift starts at 8:00 AM, about 15 minutes from now. Clock in anyway?", "buttons": [{"label": "Not Yet", "n": 1}, {"label": "Clock In Anyway", "primary": true, "n": 2}]}], "callouts": [{"n": 1, "text": "Come back at your start time."}, {"n": 2, "text": "Records it; your manager is told."}]}
```

Press **Punch In** well before your shift and Nexus asks first. **Not Yet** cancels. **Clock In Anyway** records the punch; Nexus never blocks an early punch, but your manager gets a notice. Start early only when your manager asked you to.

## Breaks

Press **Start Break** when you step away and **End Break** when you are back. The clock counts down your allowance, for example "25 min left of your 1h daily break," and says so if you go over. A break left open for 60 minutes (the default) brings a **Still on Break?** notice to your bell; left open twice as long, your manager is told. It almost always means a forgotten End Break: press it now and fix the time on your Time Sheet.

## A Forgotten Punch Out

After a long stretch on the clock an amber banner asks whether you are still working. **I'm Still Working** hides it; **Fix My Punch Out** takes you to your Time Sheet to ask for the real clock-out time. A clock-in left open more than 16 hours shows as **Missing**, with a red bar and the same **Fix My Punch Out** button. Ask for the real time, then punch in normally for today.

> [!WARNING]
> Never punch in and out now to "fix" yesterday. That creates a second, wrong shift. Use Fix My Punch Out; your manager approves the real time.

## When a Punch Does Not Record

```figure
{"kind": "screen", "title": "Your Punch Did Not Record", "device": "phone", "module": "Workday", "parts": [{"kind": "dialog", "title": "Your Punch Did Not Record", "text": "No signal. Your punch out is saved on this phone at 4:45 PM, the time you pressed it. Nexus keeps trying.", "buttons": [{"label": "Retry Now", "n": 1}, {"label": "OK, Keep Trying", "primary": true, "n": 2}]}], "callouts": [{"n": 1, "text": "Once you have signal."}, {"n": 2, "text": "Walk on. Never punch again."}]}
```

If the phone saved your punch but could not reach Nexus, this box says so. The punch goes in at the time you pressed the button, not when it finally gets through. Tap **OK, Keep Trying**, or **Retry Now** once you have signal. A red line on the clock reminds you the punch is still sending and says "Don't punch out to fix it." If the box says nothing was saved, retry from a phone with signal, or ask for the punch from your Time Sheet.

## The Meal and Rest Break Statement

There is no break question at clock-in. When you sign your Time Sheet, the signing screen carries the statement "I was provided every meal and rest break California law requires," and signing confirms it. Hourly staff on the California rule who missed a break click **Report a Missed Break** instead of signing, pick the days and Meal or Rest, and click **Send Back to Manager**; the manager adds the premium pay and it comes back to sign. Anyone else whose statement is not true for them does not sign: tell your manager, and if it is still not true, decline in Nexus Sign with a reason. Never sign a statement that is not true.

## At Greens

Sam taps **Not Yet** at 7:45 AM, opens up, and punches in at 8:00 AM with "Opening, gate check, two move-ins at 10." At 4:45 PM in the RV row, **Your Punch Did Not Record** appears. He taps **OK, Keep Trying** and walks back; the punch lands at 4:45 PM by itself.

## Common Mistakes

- **Punching again to fix a punch.** Fix it on the Time Sheet.
- **Clocking in early without being asked.** Choose Not Yet.
- **Forgetting End Break.** Watch for Still on Break? in the bell.
- **Punching from the office computer.** You get Approx. Location.

## Key Points

- Only the valid buttons show: **Punch In**, **Start Break**, **End Break**, **Punch Out**.
- Most roles write a short message at each punch; tick the box if you already sent it.
- Location is checked only at the punch and never blocks it.
- **Not Yet** unless your manager asked you to start early.
- **Fix My Punch Out** fixes a forgotten punch out. A punch saved on the phone sends itself at the time you pressed.
- Signing confirms the meal and rest break statement; **Report a Missed Break** when a break was missed.
