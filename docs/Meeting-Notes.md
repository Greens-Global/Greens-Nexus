# Meeting Notes

Notes for Teams meetings, in Dashboard > Notes (Neil, 11/12/2026). Teams
records and transcribes the call; Nexus is the notebook around it. Nothing
here costs money or uses AI.

## Who has it: testers first (Neil, 11/12/2026)

Meeting Notes is off for everyone except the people listed in the
`meeting_notes.access` row of `nexus_settings` - each database has its own
(dev and production). The value is JSON:

```json
{"everyone": false, "emails": ["neil@greensglobal.com"]}
```

Add a tester by adding their work email; turn it on for the whole company
with `"everyone": true`. No row means nobody. Anyone not on the list sees no
Meetings button and every `/meetings` route answers 403. Never widen it with
a code default.

## What a person sees

1. **Meetings** in the Notes toolbar lists the day's Teams meetings from
   their own Outlook calendar (Previous / Next day). Each one has
   **Take Notes** (or **Open Notes**) and, around its start, **Join**.
2. **Take Notes** makes one note for that meeting, the first time only: the
   meeting's title, and the invite's agenda folded in a toggle. Picking it
   again opens the same note.
3. While the meeting runs (from 10 minutes before the start to 15 minutes
   after the end), each line they start writing keeps the time they wrote
   it. The time shows faintly at the line's end.
4. Under the title, the **meeting band** shows the date and time,
   **In Progress** while it runs, **Join**, **Transcript**, the people
   invited and, for the owner, **Share With Attendees** (Can Read, Nexus
   People only - outside guests are left out).
5. **Transcript** opens the Teams transcript beside the note (under the band
   on a phone): who said what, when, and how much each person spoke.
   Clicking a line's time jumps to what was being said then.
   **Recording in Teams** / **Open in Teams** opens the meeting chat, where
   Teams keeps the recording.

## Phase 2 (Neil, 11/12/2026)

6. **Highlights.** The transcript opens on a **Highlights** tab when there
   are any: **Possible Action Items** (with any deadline words, such as "by
   Friday", and a **Make a Task** button that makes the task the same way
   Make a Task does from a note line), **Decisions** and **Open Questions**.
   They are picked by wording rules in `backend/meeting_highlights.py`, not
   AI: "I'll send the quote by Friday", "Can you share the deck?", "Let's go
   with the Austin vendor", a real question of six words or more. Promises
   only count with a work verb or a deadline after them, so "I'll be honest"
   is not one. The time on a highlight jumps to it in the full transcript.
   Highlights are worked out each time the transcript is read and never
   stored.
7. **Last Time.** In a recurring series, the band shows the reader's notes
   from the previous meeting of the series (their own first, else ones
   shared with them) and the tasks made from those notes that are still
   open - each only if the reader may open that task.
8. **Transcript Ready bell (opt-in).** At the foot of the Meetings sheet,
   **Tell Me When a Transcript Is Ready** is off until the person turns it
   on (`meeting_notes.alerts:<email>` in `nexus_settings`). Once on, after a
   meeting they took notes for ends, a pass every 5 minutes asks Teams
   whether a transcript exists - the list only, never the words - and bells
   them once: "Meeting Transcript Ready", which opens the note. It looks for
   8 hours after the end, at most every 10 minutes per meeting. Opening the
   transcript yourself marks it ready, so you are never belled about one you
   already read; the band then says **Transcript Ready**.

## Phase 3: meetings outside Teams (Neil, 11/12/2026)

Neil's calls: the text lives in Nexus; consent is asked every time; Whisper
on the device, with the browser's own speech service as the fallback; testers
first.

9. **Every meeting.** The Meetings sheet lists every meeting on the calendar
   (in person, Zoom, Google Meet as well as Teams - never all-day items),
   says where it is, and Join opens a Zoom or Meet link too. **New Meeting
   Note** makes a note for a meeting that is not on the calendar (a site
   walk, a huddle), starting now.
10. **Start Transcribing** (in any meeting note, for its owner and Can Edit):
    a question first, every time - what happens to the audio, what to listen
    to, and a box to tick that everyone agreed to be transcribed (Start stays
    off until it is ticked; the server refuses a session without it and keeps
    who confirmed and when). "Transcription started at 10:02 AM - everyone
    present agreed to be transcribed." goes into the note as a line of its
    own.
    - **What it listens to:** the microphone (a meeting in the room), or on a
      computer the microphone AND a call in a browser tab (Zoom, Google Meet,
      Teams on the web - the browser asks which tab; turn on its audio). With
      both, each line says **You** or **Others** by which was louder; the
      owner can put a name on a voice ("Others" -> "Visesh").
    - **How:** Whisper runs in the browser on the device. The first time, the
      model downloads (about 40 MB on a phone or small laptop, 77 MB on a
      bigger computer) while it is already listening, so nothing said in the
      first minute is lost; after that the browser keeps it, and it works
      offline. A computer that cannot keep up switches to the smaller model
      by itself. If Whisper cannot run on the device, the browser's own
      speech service takes over for the microphone (Chrome sends the audio
      to Google, Safari to Apple, to recognize it - the consent question says
      so before it starts).
    - **While it runs:** "Transcribing" with the clock (the live accent), the
      words in the transcript panel a few seconds after they are said, the
      screen kept awake (a phone that sleeps stops the microphone), Stop.
      Lines written meanwhile get their times, like a Teams meeting's.
    - **What is kept:** only the words, sent a few lines at a time (a closed
      tab loses at most the last few seconds; a dropped connection resends).
      The audio is never saved or sent. Whoever can open the note reads the
      transcript; its owner can **Delete Transcript** (press and hold).
    - Highlights, Make a Task and the line times work on it exactly as on a
      Teams transcript. A Teams meeting can be recorded this way too - the
      panel then offers **From Teams** and **Recorded in Nexus**.
11. **Transcribe a voice note** (testers): under any voice note in a note,
    **Transcribe** turns it into text on the device and puts it underneath as
    a folded Transcript block.

### Where the speech model comes from

`frontend/functions/ml/[[path]].js` (a Cloudflare Pages Function) serves it
from Nexus's own address, so the CSP stays self-only and no CDN is added:

- the runtime (transformers.js 4.3.2 and the ONNX Runtime web build it
  embeds) from the npm packages on jsDelivr at exact versions, each file
  checked against its SHA-256 from the npm tarball before it is served or
  cached;
- the models `Xenova/whisper-tiny.en` / `Xenova/whisper-base.en` (English,
  int8) from Hugging Face, only the listed files;
- cached for a year at Cloudflare's edge and in the browser. Anything else
  is a 404.

The runtime is told to import its loader from its own URL
(`env.useWasmCache = false`) - the default turns it into a `blob:` URL,
which the CSP rightly refuses.

**Tested in a real browser** (Chromium, the production CSP, a fake
microphone playing a speech recording): live audio captured at 44.1 kHz, cut
at pauses, read by Whisper about five times faster than real time on the
small model, and a voice-note file read word for word - and the whole app
flow on an iPhone-sized screen (New Meeting Note, consent, live words, Stop,
the words saved, the consent line in the note).

## Links, never copies (Neil, 11/12/2026)

For a TEAMS meeting, the transcript and the recording stay in Teams. Nexus reads the transcript
through Microsoft Graph when someone opens it, keeps it in the API's memory
for 15 minutes, and never writes it to the database or storage. When Teams
lets a transcript or recording go, the note no longer shows it.

The notes follow the normal Notes rules (owner and the people it is shared
with). The join link and the transcript are only for the people on the
meeting's invite - sharing the notes with someone who was not invited never
shares the call.

## Setup (already done for Nexus, check if something stops working)

The GreensNexus Entra app already holds what this needs, for Nexus's
interviews and meeting files:

| Need | Permission | Used for |
|---|---|---|
| Read the person's calendar | `Calendars.ReadWrite` (application) | the Meetings list, making a note |
| Find the Teams meeting | `OnlineMeetings.Read.All` + the Teams application access policy | the transcript |
| Read the transcript | `OnlineMeetingTranscript.Read.All` (application) | the transcript |
| Count recordings | `OnlineMeetingRecording.Read.All` (application) | the Recording in Teams link |

Without calendar access the Meetings sheet says "Your calendar is not
connected yet" - never an error.

**There is only a transcript when transcription was on in the meeting.**
Someone in the call presses Start Transcription, or the organizer sets the
meeting to record and transcribe automatically. The Teams admin meeting
policy must allow transcription.

**Cost check:** Microsoft has listed the transcript API as metered
($0.0022 per minute), and later notices say that charge ended in 2025. If a
transcript ever comes back with "Payment Required", the Graph metering is on
for the app - ask Neil before turning anything on.

## Code

- `backend/routers/meetings.py` - the routes, `ready_pass` and
  `meeting_ready_loop`; the Graph lookups reuse `routers/meeting_files.py`.
- `backend/meeting_highlights.py` - the highlight rules.
- `backend/models.py` `NexusMeetingNote` (`nexus_meeting_notes`, RLS on dev
  and prod) - which note is whose notes for which meeting occurrence.
- `frontend/src/notes/meetings/` - `meetingClock.js` (the line stamps, a
  TipTap extension in every Notes schema), `MeetingsSheet.jsx`,
  `MeetingBand.jsx` (band + transcript), `meetingModel.js`.
- Tests: `backend/test_meetings.py`, `backend/test_meeting_highlights.py`,
  `frontend/src/notes/meetings/meetings.test.jsx`.

## Next phases

- **Phase 4:** a written summary, only behind the AI switch (off).
