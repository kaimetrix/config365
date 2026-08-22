<#
.SYNOPSIS
    Backs up security group membership (user and device members).

.DESCRIPTION
    For every security group backed up by Backup-Groups.ps1, fetches user and
    device members and writes one JSON file per group under:
        backups/group-membership/{safeGroupName}.json

    Format per file:
        {
          "groupDisplayName": "...",
          "groupId": "...",
          "backedUpAt": "ISO-8601",
          "memberCount": 0,
          "members": [
            { "id": "uuid", "userPrincipalName": "user@domain", "displayName": "..." }
          ],
          "deviceMemberCount": 0,
          "deviceMembers": [
            { "id": "object-id", "deviceId": "aad-device-id", "displayName": "..." }
          ]
        }

    Nested group and service-principal members are skipped.
    Dynamic groups are included — their resolved members are backed up just like static groups.

.PARAMETER BackupPath
    Base path where backup files are stored (must already exist).
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
if (-not (Get-Command 'Write-Log' -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode  = $DebugMode
}

if (-not $BackupPath) { throw "BackupPath is required." }

if (-not $script:LogFile) {
    Initialize-BackupLogging    -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw "Failed to connect to Microsoft Graph" }
}

Write-Log "=== Starting Group Membership Backup ===" "INFO"

$outputFolder = "group-membership"
$backedUp     = 0
$failed       = 0

try {
    # Enumerate security groups (only groups with securityEnabled=true)
    $groups = Get-AllGraphResults `
        -Uri         "https://graph.microsoft.com/v1.0/groups?`$filter=securityEnabled eq true&`$select=id,displayName" `
        -Description "security groups for membership backup"

    Write-Log "Found $($groups.Count) security groups to process" "INFO"

    foreach ($group in $groups) {
        try {
            $safeFileName = Get-SafeFileName -Name $group.displayName

            # Fetch direct user members — use $select to get only needed fields and
            # filter to microsoft.graph.user to skip device/group/SP members.
            $memberUri = "https://graph.microsoft.com/v1.0/groups/$($group.id)/members/microsoft.graph.user?`$select=id,userPrincipalName,displayName"
            $members   = Get-AllGraphResults -Uri $memberUri -Description "user members of $($group.displayName)"

            $memberList = @($members | ForEach-Object {
                [ordered]@{
                    id                = [string]$_.id
                    userPrincipalName = [string]$_.userPrincipalName
                    displayName       = [string]$_.displayName
                }
            })

            $deviceUri  = "https://graph.microsoft.com/v1.0/groups/$($group.id)/members/microsoft.graph.device?`$select=id,deviceId,displayName"
            $devices    = Get-AllGraphResults -Uri $deviceUri -Description "device members of $($group.displayName)"

            $deviceList = @($devices | ForEach-Object {
                [ordered]@{
                    id          = [string]$_.id
                    deviceId    = [string]$_.deviceId
                    displayName = [string]$_.displayName
                }
            })

            $data = [ordered]@{
                groupDisplayName  = $group.displayName
                groupId           = $group.id
                backedUpAt        = (Get-Date -Format 'o')
                memberCount       = $memberList.Count
                members           = $memberList
                deviceMemberCount = $deviceList.Count
                deviceMembers     = $deviceList
            }

            Save-BackupFile -Content $data -RelativePath "$outputFolder/$safeFileName.json"
            $backedUp++
            Write-Log "Group '$($group.displayName)': $($memberList.Count) users, $($deviceList.Count) devices" "DEBUG"
        }
        catch {
            $failed++
            Write-Log "Failed to backup membership for '$($group.displayName)': $_" "WARN"
        }
    }

    Write-Log "=== Group Membership Backup Complete — backed up: $backedUp, failed: $failed ===" "INFO"
}
catch {
    Write-Log "Group membership backup failed: $_" "ERROR"
    throw
}

return @{
    Type     = "GroupMembership"
    Success  = ($failed -eq 0)
    BackedUp = $backedUp
    Failed   = $failed
}
