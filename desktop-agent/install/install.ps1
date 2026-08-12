<#
  Greens Nexus Agent - one-shot CLI installer (disclosed monitoring; NOT covert).

  Pointed at a source (a URL to a .zip, a local .zip, or a local build folder),
  this installs the agent and starts it. It auto-detects elevation:

    * ADMIN prompt  -> per-machine install under Program Files + registers the
      employee-proof Windows service (NexusMonitorService). The service launches
      the agent into whichever user is logged in and respawns it if killed, so it
      covers EVERY profile on the PC. A standard user cannot stop it. USE THIS on
      company PCs.

    * NORMAL prompt -> per-user install under %LOCALAPPDATA% for the current
      profile only, registered in that user's Startup. No admin, but the user owns
      it and can remove it, and it does NOT cover other profiles. Fine for a
      personal device.

  The agent stays disclosed either way: visible tray icon ("Nexus Monitoring
  Active" while capturing), real name in Task Manager / Installed Programs, plain
  log at ProgramData\Greens Nexus Agent\agent.log. It records only while the
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
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$APP = 'Greens Nexus Agent'
$EXE = "$APP.exe"

function Info($m) { Write-Host "[nexus-install] $m" }
function Die($m)  { Write-Host "[nexus-install] ERROR: $m" -ForegroundColor Red; exit 1 }

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
    Info "downloading $Source"
    $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'   # faster download
    Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $zip
    $ProgressPreference = $old
    Info "extracting"
    Expand-Archive -Path $zip -DestinationPath $stage -Force
    Remove-Item $zip -Force
    $srcRoot = $stage
  } elseif (Test-Path $Source -PathType Leaf) {
    Info "extracting $Source"
    Expand-Archive -Path $Source -DestinationPath $stage -Force
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
  if ($mode -eq 'service' -and (Get-Service -Name 'NexusMonitorService' -ErrorAction SilentlyContinue)) {
    Info "stopping existing service"
    sc.exe stop NexusMonitorService | Out-Null
    Start-Sleep -Seconds 2
  }
  Get-Process -Name $APP -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  # ── 3. Copy the bundle into place ──────────────────────────────────────────
  if ((Test-Path $installDir) -and $Force) { Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
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
    & powershell -NoProfile -ExecutionPolicy Bypass -File $svcInstall
    Info "done. The service is running and will launch the agent into each user's session."
    Info "It covers every profile on this PC and only an administrator can stop it."
  } else {
    # Per-user: the agent self-registers in Startup on first run (setLoginItemSettings).
    $agentArgs = @('--background')
    $envPairs = @{}
    if ($ApiBase) { $envPairs['NEXUS_API_BASE'] = $ApiBase }
    if ($WebBase) { $envPairs['NEXUS_WEB_BASE'] = $WebBase }
    foreach ($k in $envPairs.Keys) { [Environment]::SetEnvironmentVariable($k, $envPairs[$k], 'User') }
    Info "launching the agent (registers itself at login for '$env:USERNAME')"
    Start-Process -FilePath $agentExe -ArgumentList $agentArgs
    Info "done. The tray icon will appear; it captures only while you are clocked in."
  }
}
finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
