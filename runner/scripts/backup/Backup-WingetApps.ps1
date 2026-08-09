<#
.SYNOPSIS
    Backs up Intune Win32 LOB apps that were deployed via the WinGet app pipeline.

.DESCRIPTION
    Queries the Graph API for Win32 LOB apps whose displayName starts with "WinGet - "
    (the prefix applied by Configure-WingetApps.ps1) and exports each app's configuration
    and group assignments to the backup folder under intune/apps/winget/.

.PARAMETER BackupPath
    The base path where backup files will be stored.

.PARAMETER DebugMode
    Enable verbose output.

.EXAMPLE
    .\Backup-WingetApps.ps1 -BackupPath "C:\backups"
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

# Standalone execution: connect and initialize logging/dirs if not already done
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

Write-Log "=== Starting WinGet Apps Backup ===" "INFO"

$results = @{
    WingetApps = @{ BackedUp = 0; Failed = 0 }
}

#region WinGet Apps
try {
    Write-Log "Backing up WinGet Apps (Win32 LOB apps with 'WinGet - ' prefix)..." "INFO"

    $allApps = Get-AllGraphResults `
        -Uri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?`$filter=startswith(displayName,'WinGet - ')" `
        -Description "WinGet Win32 apps"

    $apps = $allApps | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.win32LobApp' }

    Write-Log "Found $($apps.Count) WinGet app(s)" "INFO"

    foreach ($app in $apps) {
        try {
            $fileName = Get-SafeFileName -Name $app.displayName

            $fullApp = Invoke-GraphRequestWithDebug `
                -Uri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$($app.id)" `
                -Method GET

            Save-PolicyWithAssignments -Policy $fullApp `
                -OutputFolder "intune/apps/winget" `
                -FileName $fileName `
                -AssignmentsUri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$($app.id)/assignments" `
                -PolicyType "WinGet Win32 app"

            $results.WingetApps.BackedUp++
            Write-Log "Saved WinGet app: $($app.displayName)" "DEBUG"
        }
        catch {
            $results.WingetApps.Failed++
            Write-Log "Failed to backup WinGet app '$($app.displayName)': $_" "WARN"
        }
    }

    Write-Log "WinGet Apps: $($results.WingetApps.BackedUp) backed up, $($results.WingetApps.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup WinGet Apps: $_" "ERROR"
}
#endregion

Write-Log "=== WinGet Apps Backup Complete ===" "INFO"

$totalBackedUp = $results.WingetApps.BackedUp
$totalFailed   = $results.WingetApps.Failed

Write-Log "Total WinGet apps: $totalBackedUp backed up, $totalFailed failed" "INFO"

return @{
    Type          = "WingetApps"
    Success       = $totalFailed -eq 0
    TotalBackedUp = $totalBackedUp
    TotalFailed   = $totalFailed
    Details       = $results
}
