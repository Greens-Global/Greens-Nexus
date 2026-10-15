# Shifts on Outlook Calendars - Setup

Shifts Phase 3a (Oct 2026): every shift a manager shares with a person
becomes an event on that person's Outlook calendar, kept in step as the
schedule changes and removed when the shift is removed, cancelled by a
weather call or handed to someone else. Nothing lands until the Entra app is
allowed to write calendars. This is a one-time admin step in the Azure
portal; no code or deploy is involved.

**Off by default (Neil, Oct 15 2026).** Even with the permission granted,
nothing is written until a company turns on "Add shared shifts to people's
Outlook calendars" in Global Settings > Shifts (`outlookCalendarOn`).
Turning it off again takes the events already added back off people's
calendars on the next sync tick (`queue_switched_off`).

## What the code does

- `backend/shift_calendar.py` keeps a queue (`shift_calendar_events`, one row
  per shift per person). Publishing, approving a swap / offer / open-shift
  request, a weather call and a discard only queue work; the sync loop
  (`calendar_sync_loop`, every minute, in a thread) works up to 50 rows per
  tick through Microsoft Graph app-only:
  `POST / PATCH / DELETE /users/{id}/events` with the same client-credential
  token every other Graph feature uses (`graph_mail.access_token`).
- Only people linked to a Microsoft 365 account (`nexus_employees.m365_id`,
  set by the M365 sync) get events. The company switch (Settings > Global
  Settings > Shifts > Sharing, on by default) and each person's own switch
  (My Shifts > "In your Outlook calendar", on by default) both have to be on.
  A person who turns theirs off has every Nexus event taken off their
  calendar at the next tick, past shifts included.
- The event: subject `Shift · 7:00 AM - 3:30 PM · GSV` (the label, else the
  shift type), start and end in the shift's own time zone, shown as Free (or
  Busy, per the company setting), no reminder, a body with the team, the site
  and a link to My Shifts, category "Nexus Shift". Pay never appears.
- The event body is hashed, so an unchanged shift is never sent again. An
  event the person deleted from their own calendar (Graph 404) is made again
  at the next change.
- If Graph answers 401 / 403 the sync pauses for five minutes, remembers the
  reason, and tries again; `GET /timeclock/calendar-sync/status`
  (administrators) returns `{"enabled": false, "reason": ...}` naming this
  document. Nothing else in Shifts is affected. A token failure or a network
  error pauses the same way; a 429 or a 5xx for one minute. A row Graph
  refuses (a 4xx) or that fails five times in a row stays as `error` with
  its reason until that shift changes again - the queue never spins on it.
  A shift already in the past with no event yet is skipped, so a queue that
  waited weeks for the permission never writes old history.

## The permission to add (one time)

Entra app registration used by Nexus (the same app as the BFF / Mail.Send /
Presence.Read.All - `AZURE_CLIENT_ID` in the backend env vars).

1. Azure portal > **Microsoft Entra ID** > **App registrations** > the Nexus app.
2. **API permissions** > **Add a permission** > **Microsoft Graph** >
   **Application permissions** (NOT Delegated).
3. Search **Calendars.ReadWrite** > check it > **Add permissions**.
4. Press **Grant admin consent for Greens Global** (the button above the
   permissions table) > **Yes**. The Status column must read
   "Granted for Greens Global".

Nothing else: no new secret, no new redirect URI, no env var. The existing
client secret already covers the new permission the next time a token is
issued (the backend caches tokens for 45 minutes, so allow up to that long,
or restart the API to see it immediately). The sync's five-minute pause
after a refusal also has to lapse.

Optional, recommended: an Exchange **application access policy** limiting
the app to the mailboxes of staff (a mail-enabled security group), so the
permission cannot touch shared or executive mailboxes:

    New-ApplicationAccessPolicy -AppId <AZURE_CLIENT_ID> -PolicyScopeGroupId <group> `
      -AccessRight RestrictAccess -Description "Nexus shift calendar"

## Verify

Signed in as an administrator, open `<api>/timeclock/calendar-sync/status`:

- `{"enabled": true, "reason": "", "pending": 0, "ok": 42, "errors": 0, "skipped": 3}`
  - done; events appear within a minute of the next publish. `skipped`
  counts people with the company or personal switch off, or no Microsoft
  365 account.
- `{"enabled": false, "reason": "The Entra app lacks the Calendars.ReadWrite application permission..."}`
  - step 4 above was not completed, or consent was granted on a different
    app registration than `AZURE_CLIENT_ID`.
- `{"enabled": false, "reason": "Microsoft Graph is not configured ..."}`
  - `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` are missing
    in that environment's App Service settings.

The first tick after the table is empty backfills every shared assigned
shift from today onward, so a fresh environment fills in on its own.

## Google Calendar and phones

People who do not use Outlook subscribe instead: My Shifts > Calendar >
"Subscribe in another calendar" gives a personal link
(`GET /timeclock/my-schedule/ical-link`) that Google Calendar, the iPhone
Calendar app and the rest refresh on their own schedule (Google: every 12 to
24 hours). The link is signed and needs no login; "New Link" rotates it so an
old one stops working. It carries only that person's shared shifts, no pay
and nobody else's shifts. The feed answers with `Cache-Control: no-store`,
the route is rate limited per IP like every credential-taking route, and a
rate-limit trip logs the prefix, never the token. No portal step is needed
for this.

## Privacy note

A person's calendar only ever carries their own shifts, with the team, the
site and the times - the same things My Shifts shows them. Nexus stores the
Graph event id per shift (`shift_calendar_events`) and nothing from the
calendar itself; it never reads a calendar.
