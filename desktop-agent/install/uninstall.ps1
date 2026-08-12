<#
  Greens Nexus Agent - uninstaller. Removes the agent from THIS PC.

  Auto-detects elevation:
    * ADMIN  -> also removes the machine-wide NexusMonitorService and the
      Program Files install (the employee-proof service install).
    * NORMAL -> removes the per-user install (LOCALAPPDATA + Startup entry).

  Safe to run either way - it cleans up whatever it finds. This is LOCAL only:
  it does not touch the server record. To also kill the device's server token,
  an admin should click Revoke in Nexus -> Admin -> Monitoring -> Company Computers.
#>
$ErrorActionPreference = 'SilentlyContinue'
$APP = 'Greens Nexus Agent'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# 1. Stop + remove the supervisor service (machine install; needs admin).
if (Get-Service -Name 'NexusMonitorService' -ErrorAction SilentlyContinue) {
  if ($isAdmin) {
    sc.exe stop NexusMonitorService | Out-Null
    Start-Sleep -Seconds 2
    sc.exe delete NexusMonitorService | Out-Null
    Write-Host "Removed the NexusMonitorService."
  } else {
    Write-Host "A machine-wide service is installed - re-run this AS ADMINISTRATOR to remove it."
  }
}

# 2. Stop the agent process (once the service is gone it won't respawn).
Get-Process -Name $APP -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

# 3. Remove the per-user Startup entry.
Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name $APP -ErrorAction SilentlyContinue

# 4. Delete install folders + local data.
$paths = @(
  (Join-Path $env:LOCALAPPDATA "Programs\$APP"),   # per-user install
  (Join-Path $env:APPDATA $APP),                    # per-user token / userData
  (Join-Path $env:ProgramData $APP)                 # machine-wide token, logs, spool
)
if ($isAdmin) { $paths += (Join-Path $env:ProgramFiles $APP) }   # per-machine install
foreach ($p in $paths) {
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "Removed $p" }
}

# 5. Clear the machine-wide agent-exe override the installer set (service mode).
if ($isAdmin) { [Environment]::SetEnvironmentVariable('NEXUS_AGENT_EXE', $null, 'Machine') }

Write-Host ""
Write-Host "Greens Nexus Agent removed from this PC."
Write-Host "(To also kill its server token, an admin should click Revoke in Nexus.)"
