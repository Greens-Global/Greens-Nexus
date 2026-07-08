# Nexus Fields — background location tracker (Capacitor)

A small native app for on-site crews. It records the worker's location
periodically **while they are clocked in** and stops when they clock out. It
authenticates with an **admin-minted device token** (`X-Agent-Token`) — the same
"silent agent" model the desktop agent uses — so there is **no Microsoft login**
on the phone.

Backend it talks to: `backend/routers/timeclock.py` → `/timeclock/track/*`
(`config`, `consent`, `clock`, `start`, `ping`, `stop`) + manager views
(`/track/live`, `/track/path`). Spec: `docs/Field-Tracking-Spec.md`.

## How it behaves

- **Cadence:** records a point when the worker moves ~100 m **or** every ~5 min,
  whichever comes first (server sends the numbers via `/track/config`).
- **Clocked-in only:** the server rejects pings when the employee isn't clocked
  in, and closes the session at clock-out — tracking can't outlive a shift.
- **Offline-tolerant:** points buffer on device (`Preferences`) and flush in
  batches, so a dead-zone stretch uploads on reconnect. Each point keeps its
  device capture time, not receive time.
- **Transparent:** a persistent foreground notification shows while tracking.
- **Consent:** first run asks for consent; withdrawing it stops tracking
  immediately (`/track/consent {granted:false}`).

## Prerequisites (on your machine — not doable in this repo's CI)

- Node 18+, JDK 17, **Android Studio** (SDK + an emulator or a physical phone).
- iOS later needs macOS + Xcode.

## First build (Android)

```bash
cd field-agent
npm install
npm run add:android          # creates android/ (git-ignored)
npm run sync                 # copies www/ + plugins into the native project
npm run open:android         # opens Android Studio → Run on a device
# or headless:
npm run run:android
```

## Required permissions / native config

The `@capacitor-community/background-geolocation` plugin adds most of it on
`sync`, but confirm these in `android/app/src/main/AndroidManifest.xml`:

- `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` (Android 14+)
- `CAMERA` (pairing-QR scan via `startScan()`)
- The plugin's `BackgroundGeolocationService` declared with
  `foregroundServiceType="location"`.

At runtime the app requests **"Allow all the time"** — on Android 11+ the OS
routes the user to Settings to grant background location. The consent screen
explains why before that prompt.

## ⚠️ Aggressive-OEM battery killers (BYOD reality)

Stock Android / Pixel / most Samsung keep the foreground service alive. But
**Xiaomi/MIUI, Oppo, Vivo, Realme and some Samsung** kill it unless the user
manually:

1. Disables battery optimization for **Nexus Fields**, and
2. Enables **Autostart** for it.

There is **no code fix** — it's a per-device setting. Ship the walkthrough from
<https://dontkillmyapp.com> to workers on those phones. If field reliability is
poor, swap the free plugin for `@transistorsoft/capacitor-background-geolocation`
(~$300/platform, same `addWatcher` shape) which automates most of this.

## iOS build (own iPhone, free — needs a Mac)

Xcode is macOS-only, so the iOS build must be done on a Mac. Free personal
Apple ID signing works for your own device (cert expires after 7 days — just
re-run from Xcode; fine for testing, impractical for a fleet).

```bash
# on the Mac:
cd field-agent && npm install
npx cap add ios
npx cap sync ios
npx cap open ios          # Xcode → select your free Apple ID team → Run on your iPhone
```

Add to `ios/App/App/Info.plist` (Xcode → Info):
- `NSLocationAlwaysAndWhenInUseUsageDescription` + `NSLocationWhenInUseUsageDescription` (why we track)
- `NSCameraUsageDescription` (for the pairing-QR scan)
- `UIBackgroundModes` → `location`

Runtime reality: no precise background timer — tracking is reliable **while
moving**, best-effort **while stationary**. Public App Store review is strict on
background location; a fleet needs the $99/yr program. For your own test phone,
the free 7-day route above is enough.

## Enrollment (admin) — one scan, no typing

1. In Nexus (admin): **HR → Time → Live map → “+ Enrol phone”** → pick the
   worker → a **pairing QR** appears (`api.timeAgentEnroll` mints a one-time
   token; the QR encodes `{ api, code }` — server URL + token together).
2. Worker opens **Nexus Fields → “Scan pairing QR”** and points at it — the app
   reads the server URL + code and pairs itself (`@capacitor-mlkit/barcode-scanning`).
   A **“Enter manually”** fallback remains for when a camera scan isn't possible.
3. Worker consents → taps **Start shift**.

Note: the QR carries the **public** API URL, so the phone reaches the cloud
backend over mobile data from anywhere — it does NOT need the office WiFi. For a
real field test the `/track/*` backend must be deployed (dev/prod) so that URL
resolves; the local-LAN route is only for pre-deploy testing.

## Security notes / TODO

- Token is stored in Capacitor `Preferences`. For production, move it to
  `@capacitor-community/secure-storage` / Keychain-Keystore-backed storage.
- Set `apiBase` to the dev/prod API origin. Consider baking a default in and
  hiding the field so workers only paste the code.
