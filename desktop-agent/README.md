# Greens Nexus Agent (desktop)

A **headless** background companion to the Nexus Time Clock. While an employee is
**clocked in**, per the disclosed monitoring policy it records:

- the **foreground app + window title** every few seconds → the **Activity Log**
  (`avatar → Admin → Insights / Activity`), and
- a **screenshot of every monitor** on a server-set cadence → the **Screenshots**
  gallery,

and reports an **active/idle %**. It posts to the same `/timeclock/agent/*` APIs
the system already exposes, so the data lands in the same tables/galleries the web
capture uses.

## Disclosure & scope (read this first)

This is a **disclosed, consent-gated** time-and-attendance tracker for
company-owned devices. It is **not covert**:

- It keeps its **real name** ("Greens Nexus Agent") — it appears in **Task
  Manager**, the **Startup** list, **Installed Programs**, and writes a plain-text
  log to `C:\ProgramData\Greens Nexus Agent\agent.log`.
- It does **nothing** to disguise its process, block Task Manager, or resist being
  stopped.
- It records **only while the employee is clocked in and not on break** (enforced
  server-side on every upload), and collects window titles + screenshots +
  activity % — **never keystroke content**.
- Employees are shown the monitoring notice at first clock-in **and sign a written
  disclosure agreement.** Do not deploy without that consent on file. (macOS also
  forces its own one-time "Screen Recording" permission prompt.)

## No tray, no window — how it runs

Earlier builds sat in the system tray. This build has **no tray icon and no
window**: it runs as an auto-start background process in the signed-in user's
session and registers itself in **Startup** (`app.setLoginItemSettings`) so it
comes back on every login.

### "Can it be a Windows service?"

A classic **session-0 Windows service cannot see the user's desktop** — Windows
session isolation means it can neither read the foreground window (`active-win`)
nor capture the screen (`desktopCapturer`). So the *capturing* part must run in
the **interactive user session**, which is what this login-start background
process does. If you want service-grade "always relaunch it": pair this with a
session-0 watchdog (Windows service or scheduled task) that ensures the user-
session agent is registered and running — the watchdog supervises, the
user-session process captures. The agent itself is unchanged either way.

## How it works

- **Identity**: a **per-device token** (`X-Agent-Token`), provisioned when you
  enroll the device (avatar → Admin → devices, or the install command). No
  Microsoft login, no interactive UI. Token is read from `NEXUS_AGENT_TOKEN`, then
  `C:\ProgramData\Greens Nexus Agent\device-token.txt` (machine-wide), then the
  per-user `userData` copy.
- **Heartbeat** (`POST /timeclock/agent/checkin`, every 60s): reports the machine
  + active/idle and learns whether to capture **right now** (`capture` — true only
  while clocked in, not on break, policy enabled) and the current **policy**.
- **Server-driven policy**: cadence + toggles are **not** hardcoded. Each heartbeat
  honors `enabled`, `intervalMinutes`, `randomize` (jitter ±25% so a frame can't be
  timed/gamed), `trackScreens` (screenshots), `trackWindows` (window titles),
  `trackInput` (activity %). `config.js` values are only fallbacks until the server
  answers. At shift start the first shot is prompt (not a full interval later).
- **Activity** (`POST /timeclock/agent/activity`): every heartbeat flushes seconds
  per foreground app/title + the active %. The server tags each with its admin
  productivity rating and stores it for the Activity Log / Insights.
- **Screenshots** (`POST /timeclock/agent/screenshot`): `desktopCapturer` → one
  JPEG per display (max 1920px, q85) → multipart upload with idle seconds. A `409`
  (not clocked in / screens disabled by policy) is a benign skip.

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
NEXUS_API_BASE=https://<prod-api-host> npm run dist:win
```

## Provisioning a device (token)

1. Enroll the device in Nexus to mint a device token (shared with the
   field-phone tracker — `AgentDevice`).
2. Drop the token where the agent looks first, machine-wide:
   `C:\ProgramData\Greens Nexus Agent\device-token.txt` (single line), **or** set
   the `NEXUS_AGENT_TOKEN` environment variable.
3. Launch the agent (the installer can do this post-install). It self-heals: if
   the token appears after launch, the next heartbeat picks it up.

## Before you ship to staff

- **Code signing**: add a Windows cert (`CSC_LINK`/`win.certificateFile`) and an
  Apple Developer ID + notarization, or installs trip SmartScreen / Gatekeeper.
- **Icons**: drop `build/icon.ico` (256×256) and `build/icon.icns`, then
  uncomment the `icon:` lines in `electron-builder.yml`.

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `NEXUS_API_BASE` | dev API host | Nexus backend base URL |
| `NEXUS_AGENT_TOKEN` | — | device token (overrides the file locations) |
| `NEXUS_CAPTURE_MS` | `300000` | **fallback** capture interval (ms), used only until the server policy is fetched |
