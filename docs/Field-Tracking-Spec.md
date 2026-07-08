# Field-Worker Location Tracking — Spec & Compliance Brief

**Status:** in build (branch `feat/field-tracking`) · **Date:** 2026-07-08 · **Owner:** Visesh
**Sign-off needed before rollout:** HR/compliance (Charmi, Neil)

## 1. Why

Construction/field workers are mostly on-site and move between locations
through the day. The existing Time Clock only stamps GPS at the *moment* of a
punch (in/out/break). This feature adds **periodic location pings across the
whole shift** so a manager can see where the crew is and confirm on-site
presence — without a surveillance-grade continuous trace.

A browser page cannot do this: browser geolocation stops the moment the phone
locks or the worker switches apps. So the client is a **native app** (Capacitor
wrapper around the existing `frontend/`), which can keep a location service
alive in the background.

## 2. What we are (and are NOT) building

| | |
|---|---|
| **Cadence** | One ping every **~5 min OR ~100 m moved**, whichever comes first. Config value (`TRACK_INTERVAL_SEC`, `TRACK_DISTANCE_M`). |
| **When** | **Only while clocked in.** The tracking session *is* the shift. Clock out → session ends, native service stops. Enforced server-side, not just client-side. |
| **Fidelity** | Periodic breadcrumb path (map replay), NOT a continuous high-accuracy trail. ~96 pings/day/worker. |
| **Devices** | BYOD — workers' personal phones. Android-first; iOS later. |
| **Enrollment** | Admin-minted device token (reuses the existing silent-agent model). No Microsoft login on the phone. |
| **NOT** | No tracking outside a shift. No always-on background tracking. No continuous high-rate GPS trail. No covert capture — a persistent notification is always visible while tracking. |

## 3. Platform reality (important, no code fixes around these)

- **Android (stock/Pixel/most Samsung):** runs a **foreground service** with a
  permanent "Nexus is tracking your location" notification. Exempt from Doze, so
  it survives lock/background. GPS wakes on the 5-min interval. Reliable. ✅
- **Android (Xiaomi/MIUI, Oppo, Vivo, Realme, some Samsung):** these OEMs kill
  even foreground services unless the user manually disables battery
  optimization / enables autostart. **No code fix** — per-device setup walkthrough
  ([dontkillmyapp.com](https://dontkillmyapp.com)). Support burden on BYOD.
- **iOS:** no precise background timer is allowed. With "Always" permission +
  background location mode, tracking is **reliable while moving**, **best-effort
  while stationary** (iOS may stretch the gap and wake on significant movement).
  Acceptable because field workers are mobile by definition.

Plugin: `@capacitor-community/background-geolocation` (free, MIT). Escape hatch
if BYOD-Android reliability is poor in the field: swap to
`@transistorsoft/capacitor-background-geolocation` (~$300/platform, similar API).

## 4. Data model (backend)

New tables (created by `create_all`; no migration lines needed):

- **`track_consent`** — standing, revocable consent record per employee
  (`granted`, `granted_at`, `revoked_at`, `text_version`, `ip`, `user_agent`).
- **`track_sessions`** — one per shift's tracking run
  (`employee_email`, `device_id`, `consent_id`, `started_at`, `ended_at`,
  `ended_reason` = clock_out|idle|manual|expired).
- **`track_pings`** — one per location sample
  (`session_id`, `employee_email`, `at` = device time, `received_at`,
  `local_date`, `lat`, `lng`, `accuracy_m`, `geo_status`, `work_site_id`,
  `work_site_name`, `distance_m`, `battery_pct`, `source='mobile'`).
  Each ping is tagged in/out of the nearest work-site geofence by the existing
  `_geofence()`.

Enrollment reuses the existing **`agent_devices`** table + `X-Agent-Token`.

## 5. Endpoints (all in `backend/routers/timeclock.py`)

Device (phone) — authed by `X-Agent-Token` (existing `get_agent_device`):
- `POST /timeclock/track/consent` — record/revoke standing consent.
- `POST /timeclock/track/start` — begin a session (403 if not clocked in / no consent).
- `POST /timeclock/track/ping` — batched `[{lat,lng,accuracy,at,battery}]`; buffers offline, uploads on reconnect. Rejected (409) if not clocked in.
- `POST /timeclock/track/stop` — end the session.

Manager/HR — scoped via existing `_visible_emails` + `require_team_read`:
- `GET /timeclock/track/live` — latest ping per clocked-in team member (crew map).
- `GET /timeclock/track/path?email=&date=` — ordered pings for one person/day (replay).

## 6. Legal guardrails (must ship with the feature)

1. **Clocked-in only** — server rejects pings when the employee isn't clocked
   in; the session token dies at clock-out. Provable, not policy.
2. **Explicit recorded consent** — one-time in-app screen; stored with timestamp
   + text version; revocable. `/track/start` refuses without a live consent row.
3. **Always visible** — the Android foreground-service notification is the live
   "you are being tracked" indicator. Same transparency principle already used
   for screen capture (`timeclock.py`, screenshot section).
4. **Retention** — raw pings auto-purged after **90 days** (daily job); keep a
   daily summary only. `TRACK_RETENTION_DAYS` config.
5. **Access scope** — live map / path only visible to managers in the viewer's
   team scope (`_visible_emails`) or HR-module grant holders.
6. **BYOD note** — tracking a personal device is the highest-scrutiny path; this
   doc is the brief for HR/compliance sign-off before real-worker rollout.

## 7. Build order

1. ✅ Spec (this doc)
2. Backend models + endpoints + retention purge
3. `frontend/src/api.js` endpoints
4. Capacitor Android scaffold + bg-geo plugin + tracking/consent screen
5. Live crew map + path replay on the HR Time tab
6. iOS build + BYOD consent review with Charmi/Neil, then pilot

## 9. Deployment cost (no-fee constraint)

Requirement: **spend $0 on app distribution.**

- **Android — achievable at $0.** We self-sign the APK (free `keytool`) and
  **sideload** it: direct download link, email, or push via **Intune** (already
  covered by the M365 licence — no app-specific fee). No Google Play account
  needed. Workers enable "install unknown apps" once. This is our path.
- **iOS — NOT possible for $0.** Apple requires the **Developer Program
  ($99/year)** to put an app on *any* real device for more than 7 days. The free
  personal-Apple-ID signing expires after 7 days and only on a cable-connected
  phone — useless for field crews. TestFlight/App Store/Ad-hoc/Enterprise all
  sit behind that paid program. There is no engineering workaround, and a PWA
  can't background-track on iOS.

**Decision:** ship **Android-only** while the no-fee rule stands. iOS is parked
until someone approves the $99/year. Everything built (backend, the
`field-agent` app) already targets Android-first, so nothing is wasted.

## 8. Open questions for Charmi/Neil

- Retention window — is 90 days right for the jurisdiction(s) involved?
- Consent wording + is a signed BYOD acknowledgement (e-sign) required first?
- Any workers/regions to exclude?
- Interval — 5 min acceptable, or do they want coarser (e.g. 10 min) to further minimize?
