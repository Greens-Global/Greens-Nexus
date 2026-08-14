# Plugin (desktop)

A background companion to the Nexus Time Clock with a **visible system-tray
indicator**. While an employee is **clocked in**, per the disclosed monitoring
policy it records:

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

- It shows a **system-tray icon whenever it runs**, which turns **green with the
  tooltip "Nexus Monitoring Active"** the moment it is actually capturing. The
  employee can always see whether monitoring is on.
- It keeps its **real name** ("Plugin") — it appears in **Task
  Manager**, the **Startup** list, **Installed Programs**, and writes a plain-text
  log to `C:\ProgramData\Plugin\agent.log`.
- It does **nothing** to disguise its process, block Task Manager, hide the tray
  icon, or resist being stopped by an admin.
- It records **only while the employee is clocked in and not on break** (enforced
  server-side on every upload), and collects window titles + screenshots +
  activity % — **never keystroke content**.
- Employees are shown the monitoring notice at first clock-in **and sign a written
  disclosure agreement.** Do not deploy without that consent on file. (macOS also
  forces its own one-time "Screen Recording" permission prompt.)

## How it runs (tray, resilience, session)

- **Visible tray indicator**: a tray icon is present whenever the agent runs —
  **green + "Nexus Monitoring Active"** while capturing, gray/"off shift"
  otherwise. Its menu opens the Time Clock and the local log and states it is a
  company-managed application. This is the disclosed, always-visible signal.
- **Auto-start**: on company PCs the **Windows Service** (see below) launches and
  supervises it. Run standalone/dev without `--service-managed` and it instead
  registers itself in **Startup** (`app.setLoginItemSettings`).
- **Crash auto-restart**: an unhandled fault relaunches the agent so a live shift
  keeps reporting, with a **1-per-minute back-off** so a persistent fault surfaces
  honestly as "agent offline" on the dashboard instead of thrashing.
- **Offline queue + resume**: if the network drops, captured frames spool to
  `C:\ProgramData\Plugin\spool\` and upload on a later heartbeat
  (bounded to 500 frames / 24h). Note the server re-gates uploads on the *current*
  clock state, so a queued frame lands only if flushed while the employee is still
  clocked in — the queue covers mid-shift blips, not outages spanning clock-out.

## Windows Service model (company PCs, no MDM) — `service/`

For company-owned PCs that are **not** Intune/MDM-managed, where you need
monitoring an employee cannot switch off, use the **Nexus Monitor Service**
(`service/NexusMonitorService.cs`). This is the disclosed, non-malware way to get
"only IT can stop it", using nothing but normal Windows service permissions.

**Why a service *and* a session process.** A session-0 Windows service cannot see
a user's desktop — session isolation means it can neither read the foreground
window (`active-win`) nor capture the screen (`desktopCapturer`). So the service
**launches the agent into the interactive user session** (`WTSQueryUserToken` +
`CreateProcessAsUser` onto `winsta0\default`) and **respawns it if it exits**. The
service is the protected, always-present part; the agent is what captures.

**What enforces "only IT can stop it" (normal Windows permissions):**

- The service runs as **LocalSystem, automatic start**. Registering, stopping,
  reconfiguring, or deleting a service **requires administrator rights** — a
  **Standard User account** simply cannot (`sc stop` / `services.msc` return access
  denied). Employees run as Standard Users; IT holds the admin account.
- The **tray has no Exit / Quit / Pause / Stop** item, and closing the tray does
  **not** stop capture (capture runs in the heartbeat loop). If an employee ends
  the agent process in Task Manager, the service **relaunches it** within ~12s and
  the Nexus **heartbeat** flags the gap as offline in the meantime.
- **Recovery**: `install.ps1` sets standard SCM restart-on-failure, so the service
  itself comes back after a crash.

**What it deliberately does NOT do** (so it stays legitimate, not stalkerware): no
process hiding, no Task Manager blocking, no antivirus evasion, no boot/WMI/
mutual-respawn persistence tricks. Both the service and the agent are **visible and
named** in Task Manager and services.msc, and an **IT admin can always stop or
uninstall** them the normal way (`uninstall.ps1`). It only holds on **company-owned
devices** where employees lack admin — not personal machines.

**Build + install (IT admin, once per image):**

```powershell
# 1. Build the service (needs the .NET SDK; net48 runtime is already on Win10/11)
dotnet build service -c Release
copy service\bin\Release\net48\NexusMonitorService.exe service\

# 2. Build + install the agent MSI (per-machine, Program Files) as before
npm run dist:win                       # ships service\ into resources\service\

# 3. Register the service (elevated)
powershell -ExecutionPolicy Bypass -File "<install-dir>\resources\service\install.ps1"
```

Uninstall (IT admin): `resources\service\uninstall.ps1`, then remove the agent from
Apps &amp; features. `NOTE:` the service is native Win32 session-launch code — build
and test it on a real Windows PC before rolling out.

## How it works

- **Identity**: a **per-device token** (`X-Agent-Token`), provisioned when you
  enroll the device (avatar → Admin → devices, or the install command). No
  Microsoft login, no interactive UI. Token is read from `NEXUS_AGENT_TOKEN`, then
  `C:\ProgramData\Plugin\device-token.txt` (machine-wide), then the
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

npm run dist:win          # build the Windows per-machine MSI  → dist/
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
   `C:\ProgramData\Plugin\device-token.txt` (single line), **or** set
   the `NEXUS_AGENT_TOKEN` environment variable.
3. Launch the agent (the installer can do this post-install). It self-heals: if
   the token appears after launch, the next heartbeat picks it up.

## Deploy as a managed app (why standard users can't uninstall it)

The "employees can't turn it off or remove it" requirement is satisfied by
**device management, not by the app fighting the user** — the app never hides or
resists being stopped. The mechanism:

1. Devices are **company-owned and enrolled in Intune** (or another MDM). The
   employee signs in with a **standard (non-admin)** account.
2. Ship the **per-machine MSI** (`npm run dist:win`) as a **required** app in
   Intune, assigned to the device group. It installs under `Program Files`.
3. A per-machine MSI can only be removed by an administrator, and Intune re-installs
   it if it's tampered with. A standard user therefore **cannot uninstall or
   modify it** — enforced by the OS + MDM, on hardware the company owns.
4. Push the **device token** via an Intune configuration/script (or bake per-device
   provisioning into your enrollment step) to
   `C:\ProgramData\Plugin\device-token.txt`.

This only holds on **company-owned, managed** machines. On a personal device the
employee has admin and none of this applies — do not deploy there. Keep the
signed monitoring disclosure on file for every enrolled employee, and clear
cross-border monitoring with HR/legal for staff outside the US.

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
