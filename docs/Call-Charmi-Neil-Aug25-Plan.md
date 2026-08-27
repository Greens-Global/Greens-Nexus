# Calls with Charmi + Neil - Aug 25 (Time Clock)

Two asks from two calls, planned together and shipped together.

## 1. Charmi - payroll must show EVERY hourly employee (not just people with missing punches)

> Charmi: "I only see people whose punches are missing... there's an employee
> Vicky I don't see at all, and search doesn't find her. When I run payroll,
> how do I get everyone's hours?" Visesh (agreed on the call): "I'll pull in
> every employee in the timesheet. If someone hasn't punched, their punch data
> would be N.A."

**Root cause:** `_team_rows` (backend/routers/timeclock.py:615) builds the team
timesheet keyed off `TimePunch` rows, so an employee with zero punches in the
period produces no row and never appears in the list, the PayrollTimecard
sidebar, or search. `/team` and `team_exceptions` both build on it.

**Fix:** `_team_rows` unions the punch-derived rows with the set of VISIBLE
HOURLY employees, emitting a zero row (`workedMin=0, days={}`) for anyone with
no punches.
- Visible set = `_visible_emails(db, user)` (respects level/HR-company scope);
  when it returns None, enumerate all non-deleted `NexusEmployee`.
- Hourly = NOT `pay_type=="fixed"` and NOT `time_tracking_exempt` (bulk-load
  `PayrollRate`, mirroring the existing `_rules`/`names` loads). No rate row =
  hourly (include).
- Empty `days` is already safe (`_day_summaries([]) == {}`; the timecard card
  renders a valid $0 period). Frontend polish: show "N.A." / 0h for zero rows
  in the sidebar + row builder (PayrollTimecard.jsx).
- Do NOT touch `/exceptions` (770) or the Missing-punches tab - deliberately
  punch-only.

## 2. Neil - billable time per location (split shifts across rental properties)

> Neil: "If a construction worker is at location A half their time and location
> B the other half, if it's billable you can extract that timing. We have ~15
> rental properties we actively manage; maintenance is billable." Visesh: "I've
> added the geolocation thing already." (= the per-person geofence shipped Aug
> 25, plus the existing work-site geofences + mobile tracking pings.)

**What exists:** each in->out segment is already attributed to one work site
(the in-punch's geofenced `HrWorkSite`); `_compute_timecard` already rolls
worked-minutes + pay per `category` (`byCategory`, timeclock.py:4632). Mobile
`TrackPing` rows carry a `work_site_id` per 5-min ping (dense enough to segment
A->B automatically) but nothing aggregates them. QuickBooks IIF export leaves
the `JOB` column empty.

**Build (anchor = work site; Neil registers each rental as a geofenced work
site, which the Work Sites UI already supports):**
1. `byLocation` rollup in `_compute_timecard` - mirror `byCategory`, keyed on
   `seg.workSiteId`/`workSiteName`. Reliable baseline; covers workers who clock
   out at A / in at B (separate segments).
2. Ping-based automatic segmentation: a `_geofence_site` helper (the site-only
   branch of `_geofence`, ignoring personal geofences) + an aggregation over
   `TrackPing` grouped by nearest work site, giving minutes-per-site even within
   a single clock-in when the mobile app is running. New endpoint
   `GET /timeclock/billable-by-location?start&end` (team-scoped via
   `_visible_emails`), returns per-employee per-work-site hours (punch-segment
   hours always; ping-verified minutes when pings exist).
3. "By location" report tab in `TimeAdmin.jsx` (tab array :376) showing, for the
   range, each employee's hours split by work site - the "extract the timing"
   deliverable. Reuses the range picker + the byCategory/TimeInsights layout.
4. IIF export (`/export.iif`, timeclock.py:1339): iterate SEGMENTS, populate the
   empty `JOB` column with the segment's work-site name, set `BILLINGSTATUS`
   billable when a job is present - so billable-per-property flows to QuickBooks.

Property<->work-site linkage (a `property_id` on `HrWorkSite` tying to the real
~24 `property_assets` slugs) is a clean follow-up; MVP uses the work-site name
as the location/property label.

## Release
Build both, test (backend suite + `npm run build`), push dev, verify deploy,
then dev->prod. Also merge the two genuinely-recent open PR branches
(`feature/nexus-sagar` = Postgres attribute-slot outage fix; and
`feature/global-modal-unsaved-guard`) into dev and carry them to prod; do NOT
merge the stale June/July branches (superseded Task/Asset ports, already-merged
Asana hotfix). Pre-apply any new columns on dev+prod; run get_advisors after.
