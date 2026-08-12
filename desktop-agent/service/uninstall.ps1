# Stops and removes the Nexus Monitor Service. RUN AS ADMINISTRATOR (IT).
# This is the legitimate, supported way for IT to stop or remove Nexus monitoring.
# A Standard User cannot run it - deleting a service requires admin rights.
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Continue'
$svc = 'NexusMonitorService'

if (-not (Get-Service -Name $svc -ErrorAction SilentlyContinue)) {
  Write-Host "Service '$svc' is not installed - nothing to do."
  return
}

sc.exe stop $svc | Out-Null      # stopping the service also stops the agent it launched
Start-Sleep -Seconds 2
sc.exe delete $svc | Out-Null

Write-Host "Nexus Monitoring Service stopped and removed. (Uninstall the agent app itself from Apps & features / the MSI.)"
