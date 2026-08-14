<#
  Plugin - silent auto-updater (runs from a hidden scheduled task; NO user UI).

  Registered by install.ps1 and run on a timer (~every 10 min):
    * service install  -> the task runs as SYSTEM, so it can write Program Files
      and restart the Windows service (which relaunches the new agent into the
      user session).
    * per-user install  -> the task runs as the user, who owns %LOCALAPPDATA% and
      relaunches the agent directly.

  It asks the backend what the current agent build is (/timeclock/agent/manifest,
  device-token auth). If that's newer than what this PC runs, it downloads the
  bundle, verifies its sha256, swaps the files, and restarts - all with no window
  and no clicks. Any failure is logged and non-fatal: the existing agent keeps
  running, and the next run tries again. It never touches the C# service binary.

  Usage (from the scheduled task):
    updater.ps1 -InstallDir <dir> -Mode <service|user> -TokenFile <path> -ApiBase <url>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $InstallDir,
  [Parameter(Mandatory = $true)] [ValidateSet('service', 'user')] [string] $Mode,
  [Parameter(Mandatory = $true)] [string] $TokenFile,
  [Parameter(Mandatory = $true)] [string] $ApiBase
)

$ErrorActionPreference = 'Stop'
$APP = 'Plugin'
$EXE = "$APP.exe"
$LogDir = Join-Path $env:PROGRAMDATA $APP
$LogFile = Join-Path $LogDir 'updater.log'
$LiveMarker = Join-Path $LogDir 'live.active'

function Log($m) {
  try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item $LogFile "$LogFile.1" -Force }
    Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date).ToString('s'), $m)
  } catch { }
}

# "0.8.4" vs "0.8.3" -> +1/-1/0. Missing components count as 0, so "0.8.4" and
# "0.8.4.0" compare equal. Non-numeric or empty inputs sort as lowest.
function Compare-Version($a, $b) {
  $pa = @(); $pb = @()
  foreach ($x in ($a -split '\.')) { $n = 0; [void][int]::TryParse($x, [ref]$n); $pa += $n }
  foreach ($x in ($b -split '\.')) { $n = 0; [void][int]::TryParse($x, [ref]$n); $pb += $n }
  $len = [Math]::Max($pa.Count, $pb.Count)
  for ($i = 0; $i -lt $len; $i++) {
    $va = if ($i -lt $pa.Count) { $pa[$i] } else { 0 }
    $vb = if ($i -lt $pb.Count) { $pb[$i] } else { 0 }
    if ($va -gt $vb) { return 1 }
    if ($va -lt $vb) { return -1 }
  }
  return 0
}

# Only one updater at a time (the timer could overlap a slow download).
$mutex = New-Object System.Threading.Mutex($false, 'Global\PluginUpdater')
if (-not $mutex.WaitOne(0)) { Log 'another updater run is active; skipping'; return }

$stage = $null
try {
  # ── Identity + current state ────────────────────────────────────────────────
  if (-not (Test-Path $TokenFile)) { Log "no token at $TokenFile; skipping"; return }
  $token = (Get-Content -Path $TokenFile -Raw).Trim()
  if (-not $token) { Log 'empty token; skipping'; return }

  $agentExe = Join-Path $InstallDir $EXE
  if (-not (Test-Path $agentExe)) { Log "installed agent not found at $agentExe; skipping"; return }
  $installed = (Get-Item $agentExe).VersionInfo.ProductVersion
  if (-not $installed) { $installed = '0.0.0' }
  $installed = ($installed -split '[^0-9.]')[0]   # trim any build suffix

  # ── Ask the backend what the target build is ────────────────────────────────
  $api = $ApiBase.TrimEnd('/')
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try {
    $m = Invoke-RestMethod -Method Get -Uri "$api/timeclock/agent/manifest" `
           -Headers @{ 'X-Agent-Token' = $token } -TimeoutSec 30
  } catch { Log "manifest fetch failed: $($_.Exception.Message)"; return }
  finally { $ProgressPreference = $old }

  $target = ([string]$m.version).Trim()
  if (-not $target) { Log 'auto-update disabled (no target version)'; return }
  if ((Compare-Version $target $installed) -le 0) { Log "up to date ($installed >= $target)"; return }
  $bundle = ([string]$m.bundleUrl).Trim()
  if (-not $bundle) { Log 'target set but no bundle URL; skipping'; return }
  $sha = ([string]$m.sha256).Trim()

  # ── Don't interrupt a live view / remote-control session ────────────────────
  if (Test-Path $LiveMarker) {
    try {
      $stampMs = [long]((Get-Content -Path $LiveMarker -Raw).Trim())
      $ageSec = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $stampMs) / 1000
      if ($ageSec -ge 0 -and $ageSec -lt 180) { Log "live session active; deferring update to $target"; return }
    } catch { }
  }

  Log "update available: $installed -> $target; downloading $bundle"

  # ── Download + verify ───────────────────────────────────────────────────────
  $stage = Join-Path $env:TEMP ("nexus-update-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $zip = Join-Path $stage 'agent.zip'
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri $bundle -OutFile $zip
  $ProgressPreference = $old
  if ($sha) {
    $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash
    if ($got -ne $sha.ToUpper()) { Log "sha256 mismatch (got $got, want $sha); aborting"; return }
    Log 'sha256 verified'
  } else {
    Log 'no sha256 in manifest; proceeding without integrity check'
  }

  # ── Extract + locate the new agent root ─────────────────────────────────────
  $ex = Join-Path $stage 'x'
  New-Item -ItemType Directory -Force -Path $ex | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $ex)
  $srcRoot = $ex
  if (-not (Test-Path (Join-Path $srcRoot $EXE))) {
    $hit = Get-ChildItem -Path $ex -Recurse -Filter $EXE -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $hit) { Log "new bundle has no $EXE; aborting"; return }
    $srcRoot = $hit.Directory.FullName
  }

  # ── Stop, swap, restart ─────────────────────────────────────────────────────
  # Stop first so no file is locked. In service mode we stop the SERVICE (which
  # kills its agent) so it won't respawn the OLD agent mid-copy; after the swap we
  # start it and it launches the NEW agent. In user mode we just kill + relaunch.
  if ($Mode -eq 'service') {
    Log 'stopping service for swap'
    & sc.exe stop $APP | Out-Null
    Start-Sleep -Seconds 3
  }
  Get-Process -Name $APP -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800

  Log "installing $target into $InstallDir"
  $rc = (Start-Process robocopy -ArgumentList @("`"$srcRoot`"", "`"$InstallDir`"", '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2') -Wait -PassThru -WindowStyle Hidden).ExitCode
  if ($rc -ge 8) { Log "robocopy failed ($rc)"; }   # fall through and still (re)start something

  if ($Mode -eq 'service') {
    & sc.exe start $APP | Out-Null
    Log 'service restarted; it will relaunch the updated agent'
  } else {
    Start-Process -FilePath (Join-Path $InstallDir $EXE) -ArgumentList @('--background')
    Log 'relaunched updated agent (per-user)'
  }
  Log "update to $target complete"
}
catch {
  Log "update error: $($_.Exception.Message)"
}
finally {
  try { if ($stage -and (Test-Path $stage)) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue } } catch { }
  try { $mutex.ReleaseMutex() | Out-Null } catch { }
  $mutex.Dispose()
}
