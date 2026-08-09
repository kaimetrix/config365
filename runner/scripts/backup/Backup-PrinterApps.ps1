<#
.SYNOPSIS
    Backs up Intune Win32 LOB apps that were deployed via the Printer app pipeline.

.DESCRIPTION
    Queries the Graph API for Win32 LOB apps whose displayName starts with "Printer - "
    (the prefix applied by Configure-PrinterApps.ps1) and exports each app's configuration
    and group assignments to the backup folder under intune/apps/printer/.

.PARAMETER BackupPath
    The base path where backup files will be stored.

.PARAMETER DebugMode
    Enable verbose output.

.EXAMPLE
    .\Backup-PrinterApps.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,

    [Parameter(Mandatory=$false)]
    [switch]$DebugMode
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Get-Command "Write-Log" -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode  = $DebugMode
}

if (-not $script:LogFile) {
    Initialize-BackupLogging    -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw "Failed to connect to Microsoft Graph — aborting backup" }
}

if (-not $script:GroupCache -or $script:GroupCache.Count -eq 0) {
    Initialize-GroupCache | Out-Null
}

Write-Log "=== Starting Printer Apps Backup ===" "INFO"

$results = @{
    PrinterApps = @{ BackedUp = 0; Failed = 0 }
}

#region Printer Apps
try {
    Write-Log "Backing up Printer Apps (Win32 LOB apps with 'Printer - ' prefix)..." "INFO"

    $allApps = Get-AllGraphResults `
        -Uri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?`$filter=startswith(displayName,'Printer - ')" `
        -Description "Printer Win32 apps"

    $apps = $allApps | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.win32LobApp' }

    Write-Log "Found $($apps.Count) Printer app(s)" "INFO"

    foreach ($app in $apps) {
        try {
            $fileName = Get-SafeFileName -Name $app.displayName

            $fullApp = Invoke-GraphRequestWithDebug `
                -Uri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$($app.id)" `
                -Method GET

            Save-PolicyWithAssignments -Policy $fullApp `
                -OutputFolder "intune/apps/printer" `
                -FileName $fileName `
                -AssignmentsUri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$($app.id)/assignments" `
                -PolicyType "Printer Win32 app"

            $results.PrinterApps.BackedUp++
            Write-Log "Saved Printer app: $($app.displayName)" "DEBUG"
        }
        catch {
            $results.PrinterApps.Failed++
            Write-Log "Failed to backup Printer app '$($app.displayName)': $_" "WARN"
        }
    }

    Write-Log "Printer Apps: $($results.PrinterApps.BackedUp) backed up, $($results.PrinterApps.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Printer Apps: $_" "ERROR"
}
#endregion

Write-Log "=== Printer Apps Backup Complete ===" "INFO"

$totalBackedUp = $results.PrinterApps.BackedUp
$totalFailed   = $results.PrinterApps.Failed

Write-Log "Total Printer apps: $totalBackedUp backed up, $totalFailed failed" "INFO"

return @{
    Type          = "PrinterApps"
    Success       = $totalFailed -eq 0
    TotalBackedUp = $totalBackedUp
    TotalFailed   = $totalFailed
    Details       = $results
}
