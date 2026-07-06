# Greens Nexus Agent (desktop)

A tray-resident companion to the Nexus time-tracking module. While an employee
is **clocked in**, it captures **every monitor** every 5 minutes and uploads to
the same `/timeclock/screenshot` API the web app uses — so the frames land in
the same storage bucket, `time_screenshots` table, and the admin gallery
(**avatar → Admin → Screenshots**), indistinguishable from web captures.

## Why a separate app?

A web page **cannot** capture the screen without Chrome's persistent "sharing
your screen" bar — that's a browser privacy guarantee, not something Nexus can
switch off. A native desktop app using Electron's `desktopCapturer` captures
silently and sees all displays. That is the *only* way to get background,
multi-monitor capture, and it is why Hubstaff/Time Doctor ship desktop agents.

> **Consent is a legal prerequisite, not a technical one.** Silent monitoring
> carries notice/consent duties (WA, OR, and for India-based staff). Only deploy
> after employees have been given written notice and you have the consent on
> file. macOS additionally forces a one-time "Screen Recording" permission
> prompt the OS shows itself.

## How it works

- **Sign-in**: Entra public-client auth-code flow (PKCE) via the system browser.
  It reuses the **existing Nexus app registration**, so the ID token it obtains
  has `aud == clientId` and passes the backend's validation with **no backend
  changes**. The session is cached (encrypted via Electron `safeStorage`) so
  later launches are silent.
- **Gating**: it polls `/timeclock/status` every 60s and only captures while the
  last punch is not `out`. Employees can **Pause capture** from the tray menu.
- **Capture**: `desktopCapturer.getSources({types:['screen']})` → one JPEG per
  display (max 1280px, q55) → multipart upload with idle seconds
  (`powerMonitor.getSystemIdleTime()`) and a `desktop agent · screen N/M` label.

## One-time Entra setup (admin)

On the existing app registration `be6f1e37-83a8-4a29-8b46-96d20beb32f9`:

1. **Authentication → Add a platform → Mobile and desktop applications.**
2. Add redirect URI **`http://localhost`** (loopback; any port is allowed).
3. **Allow public client flows → Yes.**

No new secret, no new registration. (Override the IDs with `NEXUS_CLIENT_ID` /
`NEXUS_TENANT_ID` if you'd rather use a dedicated registration.)

## Run / build

```bash
cd desktop-agent
npm install
npm start                 # dev run (uses DEV API by default)

npm run dist:win          # build the Windows NSIS installer  → dist/
npm run dist:mac          # build the macOS dmg               → dist/
```

Point at prod at build time:

```bash
NEXUS_API_BASE=https://<prod-api-host> NEXUS_WEB_BASE=https://nexus.greensglobal.com npm run dist:win
```

## Before you ship to staff

- **Code signing**: add a Windows cert (`CSC_LINK`/`win.certificateFile`) and an
  Apple Developer ID + notarization (`mac`), or installs trip SmartScreen /
  Gatekeeper.
- **Icons**: drop `build/icon.ico` (256×256) and `build/icon.icns`, then
  uncomment the `icon:` lines in `electron-builder.yml`.
- **Auto-update**: set a `publish` feed in `electron-builder.yml` and wire
  `electron-updater` in `main.js` (left as a documented stub).

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `NEXUS_API_BASE` | dev API host | Nexus backend base URL |
| `NEXUS_WEB_BASE` | `https://dev.nexus.greensglobal.com` | "Open Time Clock" target |
| `NEXUS_CLIENT_ID` | Nexus app reg | Entra client id |
| `NEXUS_TENANT_ID` | Greens tenant | Entra tenant id |
| `NEXUS_CAPTURE_MS` | `300000` | capture interval (ms) |
