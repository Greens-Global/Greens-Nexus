# Installs the Nexus Monitor Service. RUN AS ADMINISTRATOR (IT).
# A Standard User cannot run this - registering/altering a service needs admin,
# which is exactly what makes the service employee-proof.
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$svc = 'NexusMonitorService'
$exe = Join-Path $PSScriptRoot 'NexusMonitorService.exe'

if (-not (Test-Path $exe)) {
  throw "NexusMonitorService.exe not found next to this script. Build it first: dotnet build -c Release, then copy bin\Release\net48\NexusMonitorService.exe here."
}

# Remove any prior copy so this is a clean (re)install.
if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
  sc.exe stop $svc | Out-Null
  Start-Sleep -Seconds 2
  sc.exe delete $svc | Out-Null
  Start-Sleep -Seconds 1
}

# Create as LocalSystem, automatic start. (Standard Users cannot stop/reconfigure
# or delete it - default service security requires administrator rights.)
sc.exe create $svc binPath= "`"$exe`"" start= auto obj= LocalSystem DisplayName= "Nexus Monitoring Service"
sc.exe description $svc "Greens Nexus - disclosed, company-managed monitoring supervisor. Launches the Nexus agent into the signed-in user's session while clocked in, and keeps it running. Managed by IT; visible and removable by an administrator."

# Normal Windows Service recovery: restart 5s after each failure; reset the failure
# counter once a day. This is standard SCM recovery, not a malware watchdog.
sc.exe failure $svc reset= 86400 actions= restart/5000/restart/5000/restart/5000
sc.exe failureflag $svc 1

# Deliver the messages the OnSessionChange handler relies on and start now.
sc.exe start $svc

Write-Host "Nexus Monitoring Service installed, set to auto-start, with restart-on-failure recovery."
Write-Host "It appears in services.msc and Task Manager. To stop/remove (admin only): service\uninstall.ps1"
