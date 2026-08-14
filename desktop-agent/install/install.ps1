<#
  Plugin - one-shot CLI installer (disclosed monitoring; NOT covert).

  Pointed at a source (a URL to a .zip, a local .zip, or a local build folder),
  this installs the agent and starts it. It auto-detects elevation:

    * ADMIN prompt  -> per-machine install under Program Files + registers the
      employee-proof Windows service (Plugin). The service launches
      the agent into whichever user is logged in and respawns it if killed, so it
      covers EVERY profile on the PC. A standard user cannot stop it. USE THIS on
      company PCs.

    * NORMAL prompt -> per-user install under %LOCALAPPDATA% for the current
      profile only, registered in that user's Startup. No admin, but the user owns
      it and can remove it, and it does NOT cover other profiles. Fine for a
      personal device.

  The agent stays disclosed either way: visible tray icon ("Nexus Monitoring
  Active" while capturing), real name in Task Manager / Installed Programs, plain
  log at ProgramData\Plugin\agent.log. It records only while the
  employee is clocked in (re-checked server-side on every upload).

  Usage (typically pasted by the portal's generated one-liner):
    install.ps1 -Source <url|zip|dir> [-Token <deviceToken>]
                [-ApiBase <url>] [-WebBase <url>] [-Force]
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Source,
  [string] $Token     = '',
  [string] $EnrollKey = '',
  [string] $ApiBase   = '',
  [string] $WebBase   = '',
  [switch] $Force,
  [switch] $Detailed          # IT troubleshooting: show the full step-by-step log
)

$ErrorActionPreference = 'Stop'
$APP = 'Plugin'
$EXE = "$APP.exe"

# Clean by default: routine step chatter (paths, service registration, firewall,
# token) is hidden so the install reads as a simple "Installing... Done" - pass
# -Detailed to see every step for troubleshooting. Real ERRORS always show, so a
# failed install is never silent. This only quiets the console; the agent stays
# fully disclosed (visible tray icon, named entry in Task Manager / Installed
# Programs, its log, and the signed monitoring policy).
function Info($m) { if ($Detailed) { Write-Host "[nexus-install] $m" } }
function Step($m) { Write-Host $m }   # always-visible short phase status (so it never looks frozen)
function Die($m)  { Write-Host "Install failed: $m" -ForegroundColor Red; exit 1 }

# Native .NET extraction - Expand-Archive is pure PowerShell and painfully slow on
# a 100 MB+ Electron zip (thousands of files); ZipFile.ExtractToDirectory is many
# times faster. Falls back to Expand-Archive if the assembly can't load.
function Expand-Zip($zip, $dest) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
  } catch {
    Expand-Archive -Path $zip -DestinationPath $dest -Force
  }
}

Write-Host "Installing $APP..."

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
  $mode      = 'service'
  $installDir = Join-Path $env:ProgramFiles $APP
  $tokenDir   = Join-Path $env:ProgramData  $APP          # machine-wide: every profile reads it
  Info "elevated -> per-machine install + employee-proof service (covers all profiles)"
} else {
  $mode      = 'user'
  $installDir = Join-Path $env:LOCALAPPDATA "Programs\$APP"
  $tokenDir   = Join-Path $env:APPDATA $APP               # this profile only (agent userData)
  Info "not elevated -> per-user install for '$env:USERNAME' only (no service). Re-run from an"
  Info "admin prompt to install machine-wide with the employee-proof service."
}

# ── 1. Fetch the bundle into a staging folder ────────────────────────────────
$stage = Join-Path $env:TEMP ("nexus-agent-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$srcRoot = $null
try {
  if ($Source -match '^https?://') {
    $zip = Join-Path $stage 'agent.zip'
    Step "Downloading the agent (about 110 MB - this can take a minute)..."
    Info "downloading $Source"
    $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'   # faster download
    Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $zip
    $ProgressPreference = $old
    Step "Extracting..."
    Expand-Zip $zip $stage
    Remove-Item $zip -Force
    $srcRoot = $stage
  } elseif (Test-Path $Source -PathType Leaf) {
    Step "Extracting..."
    Expand-Zip $Source $stage
    $srcRoot = $stage
  } elseif (Test-Path $Source -PathType Container) {
    $srcRoot = (Resolve-Path $Source).Path                 # install straight from a local build
  } else {
    Die "source not found: $Source"
  }

  # The bundle may extract to a nested folder; find the one holding the agent exe.
  if (-not (Test-Path (Join-Path $srcRoot $EXE))) {
    $hit = Get-ChildItem -Path $srcRoot -Recurse -Filter $EXE -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if (-not $hit) { Die "'$EXE' not found in the source bundle" }
    $srcRoot = $hit.Directory.FullName
  }
  Info "bundle: $srcRoot"

  # ── 2. Stop any running copy so files aren't locked ────────────────────────
  if ($mode -eq 'service' -and (Get-Service -Name 'Plugin' -ErrorAction SilentlyContinue)) {
    Info "stopping existing service"
    sc.exe stop Plugin | Out-Null
    Start-Sleep -Seconds 2
  }
  Get-Process -Name $APP -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  # ── 3. Copy the bundle into place ──────────────────────────────────────────
  if ((Test-Path $installDir) -and $Force) { Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Step "Installing files..."
  Info "installing to $installDir"
  # robocopy /MIR mirrors the tree and tolerates long paths; 0-7 are success codes.
  $rc = (Start-Process robocopy -ArgumentList @("`"$srcRoot`"", "`"$installDir`"", '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1') -Wait -PassThru -WindowStyle Hidden).ExitCode
  if ($rc -ge 8) { Die "copy failed (robocopy $rc)" }

  # ── 4. Write the device token ──────────────────────────────────────────────
  $tokenFile = Join-Path $tokenDir 'device-token.txt'
  New-Item -ItemType Directory -Force -Path $tokenDir | Out-Null
  if ($Token) {
    Set-Content -Path $tokenFile -Value $Token.Trim() -Encoding Ascii -NoNewline
    Info "device token written to $tokenFile"
  } elseif (Test-Path $tokenFile) {
    Info "keeping existing device token at $tokenFile"
  } elseif ($EnrollKey) {
    # This PC has no Nexus login, so trade the shared enrollment key for this
    # machine's own device token (once, here at install time). All profiles then
    # read this one machine-wide token = one device row per PC.
    $api = $ApiBase.TrimEnd('/')
    if (-not $api) { $api = 'https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net' }
    try {
      $mac = ((Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=1' -ErrorAction SilentlyContinue |
               Where-Object { $_.MACAddress } | Select-Object -First 1).MACAddress)
    } catch { $mac = '' }
    $payload = @{ enroll_key = $EnrollKey; hostname = $env:COMPUTERNAME; mac = $mac;
                  platform = 'windows'; device_user = $env:USERNAME } | ConvertTo-Json -Compress
    Info "enrolling this PC with Nexus"
    try {
      $resp = Invoke-RestMethod -Method Post -Uri "$api/timeclock/agent/self-enroll" `
                -ContentType 'application/json' -Body $payload -TimeoutSec 30
      Set-Content -Path $tokenFile -Value ([string]$resp.token) -Encoding Ascii -NoNewline
      Info "enrolled (device $($resp.deviceId)); token written to $tokenFile"
    } catch {
      Info "WARNING: self-enroll failed: $($_.Exception.Message)"
      Info "The agent will run but stay unauthenticated until a token lands at $tokenFile"
    }
  } else {
    Info "WARNING: no -Token/-EnrollKey given and none on disk. The agent will run"
    Info "but stay unauthenticated until a token lands at $tokenFile"
  }

  $agentExe = Join-Path $installDir $EXE

  # ── 4b. Pre-authorize in Windows Firewall ──────────────────────────────────
  # Live view (WebRTC) opens a socket, which otherwise pops the Windows "allow
  # this app to communicate on the network" prompt at the employee the first time.
  # An explicit allow rule for the agent exe means Windows never asks. Needs admin
  # (service installs have it); a per-user install without admin just skips it.
  try {
    Get-NetFirewallRule -DisplayName 'Plugin Agent' -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName 'Plugin Agent' -Direction Inbound  -Action Allow `
      -Program $agentExe -Profile Any -ErrorAction Stop | Out-Null
    New-NetFirewallRule -DisplayName 'Plugin Agent' -Direction Outbound -Action Allow `
      -Program $agentExe -Profile Any -ErrorAction SilentlyContinue | Out-Null
    Info "firewall allow-rule added - live view won't prompt the user"
  } catch {
    Info "NOTE: couldn't add a firewall rule (needs admin). Live view may show the"
    Info "Windows firewall prompt once on a per-user install; re-run elevated to avoid it."
  }

  # ── 5. Register + start ────────────────────────────────────────────────────
  if ($mode -eq 'service') {
    # Point the service at the exact installed exe (robust to a non-default dir).
    [Environment]::SetEnvironmentVariable('NEXUS_AGENT_EXE', $agentExe, 'Machine')
    # Persist API overrides machine-wide so the service-launched agent picks them up.
    if ($ApiBase) { [Environment]::SetEnvironmentVariable('NEXUS_API_BASE', $ApiBase, 'Machine') }
    if ($WebBase) { [Environment]::SetEnvironmentVariable('NEXUS_WEB_BASE', $WebBase, 'Machine') }
    $svcInstall = Join-Path $installDir 'resources\service\install.ps1'
    if (-not (Test-Path $svcInstall)) { Die "service installer missing at $svcInstall (was the service built into the bundle?)" }
    Info "registering the Windows service"
    # Swallow the child installer's console chatter (sc.exe [SC] SUCCESS lines,
    # service name/description) unless -Detailed, so the parent stays clean. Real
    # failures still surface via the exit-code check below - not hidden.
    if ($Detailed) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $svcInstall
    } else {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $svcInstall *> $null
    }
    if ($LASTEXITCODE -ne 0) { Die "service registration failed. Re-run with -Detailed to see why." }
    Info "done. The service is running and will launch the agent into each user's session."
  } else {
    # Per-user: the agent self-registers in Startup on first run (setLoginItemSettings).
    $agentArgs = @('--background')
    $envPairs = @{}
    if ($ApiBase) { $envPairs['NEXUS_API_BASE'] = $ApiBase }
    if ($WebBase) { $envPairs['NEXUS_WEB_BASE'] = $WebBase }
    foreach ($k in $envPairs.Keys) { [Environment]::SetEnvironmentVariable($k, $envPairs[$k], 'User') }
    Info "launching the agent (registers itself at login for '$env:USERNAME')"
    Start-Process -FilePath $agentExe -ArgumentList $agentArgs
  }
  Write-Host "$APP installed."
}
finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
