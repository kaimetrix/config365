<#
.SYNOPSIS
    Renames Intune-enrolled devices based on Entra group membership using the format {PREFIX}-{USER5}{RAND2}.

.DESCRIPTION
    Reads an intune-device-rename configuration from the baseline repo and/or tenant repo. For each
    configured rule, the script:
      1. Resolves members of the specified Entra group via Microsoft Graph.
      2. For each device member, locates the corresponding Intune managed device.
      3. Skips devices whose name already matches the expected format.
      4. Renames the device via the Graph setDeviceName API.

    Naming format: {PREFIX}-{USER5}{RAND2}
      PREFIX : 1–3 uppercase alphanumeric chars (configured per rule)
      USER5  : first 5 alphanumeric chars of the primary user's displayName, uppercased,
               right-padded with X if fewer than 5 chars are available
      RAND2  : 2 random uppercase alphanumeric chars (A-Z, 0-9)
    Example: SON-RICHA4F

    A device is skipped when its current name already matches ^{PREFIX}-[A-Z0-9]{7}$ (case-insensitive).

    Tenant rules override baseline rules that share the same id. Supports -WhatIfMode to
    preview changes without calling the rename API.

.PARAMETER BaselineConfigDir
    Path to the directory containing baseline/intune-device-rename.json (the maintenance/ folder
    checked out from the baseline repo).

.PARAMETER TenantConfigDir
    Path to the directory containing config/maintenance/intune-device-rename.json in the tenant repo.
    Tenant entries with the same id as a baseline entry take precedence.

.PARAMETER TenantName
    Tenant name used in log messages.

.PARAMETER OutputPath
    Optional path to write a JSON summary of planned/applied changes.

.PARAMETER WhatIfMode
    Show intended renames without calling the setDeviceName API.

.EXAMPLE
    .\Invoke-IntuneDeviceRename.ps1 `
        -BaselineConfigDir "baseline/maintenance" `
        -TenantConfigDir   "Tenant-repo/config/maintenance" `
        -TenantName        "contoso" `
        -WhatIfMode

.NOTES
    Required permissions (application):
      GroupMember.Read.All                              — resolve Entra group members
      Device.Read.All                                   — read Entra device objects
      DeviceManagementManagedDevices.ReadWrite.All      — read Intune managed device records
      DeviceManagementManagedDevices.PrivilegedOperations.All — required by the beta setDeviceName action
                                                              (rename is a privileged operation in Intune)
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $false)]
    [string]$BaselineConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantName = '',

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIfMode
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

# ============================================================================
# IMPORT DEPENDENCIES
# ============================================================================

$commonScriptPath = Join-Path $scriptRoot '..\common\Connect-M365Graph.ps1'
if (Test-Path $commonScriptPath) { . $commonScriptPath }

# ============================================================================
# GRAPH HELPERS
# ============================================================================

function Invoke-GraphRequest {
    param(
        [string]$Method = 'GET',
        [string]$Uri,
        [object]$Body,
        [string]$ContentType = 'application/json'
    )
    # Use the SDK's own request cmdlet rather than manually extracting a bearer token.
    # (Get-MgContext).AuthContext.AccessToken / Get-MgAccessToken are NOT reliable ways to
    # get a raw token in current Microsoft.Graph.Authentication versions — Get-MgContext
    # does not expose an AuthContext/AccessToken property and Get-MgAccessToken is not
    # exported at all in the installed SDK version. Invoke-MgGraphRequest uses the SDK's
    # internal auth provider (populated by Connect-MgGraph) directly, so no token
    # extraction is needed.
    $params = @{ Uri = $Uri; Method = $Method; ErrorAction = 'Stop' }
    if ($Body) {
        $params.Body = $Body
        $params.ContentType = $ContentType
    }
    return Invoke-MgGraphRequest @params
}

function Get-AllPages {
    param([string]$Uri)
    $results = [System.Collections.Generic.List[object]]::new()
    $next    = $Uri
    while ($next) {
        $page = Invoke-GraphRequest -Uri $next
        if ($page.value) { $results.AddRange($page.value) }
        $next = $page.'@odata.nextLink'
    }
    return $results
}

# ============================================================================
# NAMING HELPERS
# ============================================================================

function Get-UserPart {
    param([string]$DisplayName)
    $clean = ($DisplayName -replace '[^A-Za-z0-9]', '').ToUpper()
    if ($clean.Length -lt 5) { $clean = $clean.PadRight(5, 'X') }
    return $clean.Substring(0, 5)
}

function Get-RandomSuffix {
    $chars = ([char[]]('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'))
    return -join ($chars | Get-Random -Count 2)
}

function Test-AlreadyRenamed {
    param([string]$DeviceName, [string]$Prefix)
    $escaped = [regex]::Escape($Prefix.ToUpper())
    return $DeviceName -imatch "^$escaped-[A-Z0-9]{7}$"
}

# ============================================================================
# LOAD AND MERGE CONFIGURATION
# ============================================================================

Write-Host "`n##[section]Loading Intune device rename configuration"

function Read-RenameConfigFile {
    param([string]$Dir)
    if (-not $Dir -or -not (Test-Path $Dir)) { return @() }
    $path = Join-Path $Dir 'intune-device-rename.json'
    if (-not (Test-Path $path)) {
        Write-Host "  No intune-device-rename.json found in: $Dir" -ForegroundColor DarkGray
        return @()
    }
    try {
        $parsed = Get-Content $path -Raw | ConvertFrom-Json
        $rules  = @($parsed.renameRules)
        Write-Host "  Loaded $($rules.Count) rule(s) from: $path"
        return $rules
    } catch {
        Write-Host "  Warning: Failed to parse $path — $_" -ForegroundColor Yellow
        return @()
    }
}

$baselineRules = Read-RenameConfigFile -Dir $BaselineConfigDir
$tenantRules   = Read-RenameConfigFile -Dir $TenantConfigDir

$ruleMap = [ordered]@{}
foreach ($r in $baselineRules) { if ($r.id) { $ruleMap[$r.id] = $r } }
foreach ($r in $tenantRules)   { if ($r.id) { $ruleMap[$r.id] = $r } }

$allRules = @($ruleMap.Values)

if ($OutputPath) {
    $outputDir = Split-Path -Path $OutputPath -Parent
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
}

if ($allRules.Count -eq 0) {
    Write-Host "No Intune rename rules found. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        @{ Service = 'IntuneDeviceRename'; Timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); WhatIfMode = [bool]$WhatIfMode; Results = @() } |
            ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

Write-Host "Total rename rules to process: $($allRules.Count)"

# ============================================================================
# GRAPH AUTHENTICATION
# ============================================================================

Write-Host "`nChecking required PowerShell modules..."
$requiredModules = @('Microsoft.Graph.Authentication')
foreach ($module in $requiredModules) {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        Write-Host "  Installing module: $module"
        Install-Module -Name $module -Force -AllowClobber -Scope CurrentUser
    }
    Import-Module $module -ErrorAction SilentlyContinue
    Write-Host "  Loaded: $module"
}

try {
    $context = Ensure-M365GraphConnection
    Write-Host "  Connected to Graph tenant: $($context.TenantId)"
} catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# ============================================================================
# PROCESS RULES
# ============================================================================

Write-Host "`n##[section]Processing Intune device rename rules"

$GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
$allResults = [System.Collections.Generic.List[object]]::new()

foreach ($rule in $allRules) {
    $ruleId   = $rule.id
    $ruleName = if ($rule.displayName) { $rule.displayName.Trim() } else { $ruleId }
    $prefix   = ($rule.prefix -replace '[^A-Za-z0-9]', '').ToUpper()

    if ($prefix.Length -eq 0 -or $prefix.Length -gt 3) {
        Write-Host "  ERROR: Prefix '$($rule.prefix)' is invalid (must be 1–3 alphanumeric chars) — skipping." -ForegroundColor Red
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'Error'; Error = 'Invalid prefix'; Renamed = 0; Skipped = 0; Errors = 0 })
        continue
    }

    Write-Host "`n--- Rule: $ruleName ---" -ForegroundColor Cyan
    Write-Host "  Prefix: $prefix"

    if (-not $rule.groupId -and -not $rule.groupName) {
        Write-Host "  ERROR: No groupId or groupName configured — skipping." -ForegroundColor Red
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'Error'; Error = 'No group configured'; Renamed = 0; Skipped = 0; Errors = 0 })
        continue
    }

    # ── Resolve group ─────────────────────────────────────────────────────────
    $groupId = $rule.groupId
    if ($rule.groupName) { $rule.groupName = $rule.groupName.Trim() }
    if (-not $groupId -and $rule.groupName) {
        Write-Host "  Resolving group by name: $($rule.groupName)"
        try {
            $encoded = [Uri]::EscapeDataString("displayName eq '$($rule.groupName)'")
            $found   = Invoke-GraphRequest -Uri "$GRAPH_BASE/groups?`$filter=$encoded&`$select=id,displayName"
            $groupId = $found.value | Select-Object -First 1 -ExpandProperty id
        } catch {
            Write-Host "  ERROR: Failed to resolve group '$($rule.groupName)': $_" -ForegroundColor Red
        }
    }

    if (-not $groupId) {
        Write-Host "  ERROR: Could not resolve group — skipping." -ForegroundColor Red
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'Error'; Error = "Group not found: $($rule.groupName)"; Renamed = 0; Skipped = 0; Errors = 0 })
        continue
    }

    Write-Host "  Group ID: $groupId"

    # ── Resolve exclusion groups (optional, supports multiple) ────────────────
    $excludedDeviceIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $excludeGroups = @()
    if ($rule.PSObject.Properties['excludeGroups'] -and $null -ne $rule.excludeGroups) {
        $excludeGroups = @($rule.excludeGroups)
    }

    foreach ($eg in $excludeGroups) {
        $egId   = $eg.PSObject.Properties['groupId']   ? $eg.groupId   : $null
        $egName = $eg.PSObject.Properties['groupName'] ? $eg.groupName.Trim() : $null

        if (-not $egId -and $egName) {
            Write-Host "  Resolving exclusion group by name: $egName"
            try {
                $encoded = [Uri]::EscapeDataString("displayName eq '$egName'")
                $found   = Invoke-GraphRequest -Uri "$GRAPH_BASE/groups?`$filter=$encoded&`$select=id,displayName"
                $egId    = $found.value | Select-Object -First 1 -ExpandProperty id
            } catch {
                Write-Host "  Warning: Failed to resolve exclusion group '$egName' — skipping this exclusion." -ForegroundColor Yellow
                continue
            }
        }

        if ($egId) {
            Write-Host "  Exclusion group ID: $egId ($egName)"
            try {
                $excludedMembers = @(Get-AllPages -Uri "$GRAPH_BASE/groups/$egId/members?`$select=id,deviceId&`$top=999")
                foreach ($em in $excludedMembers) {
                    if ($em.deviceId) { $excludedDeviceIds.Add($em.deviceId) | Out-Null }
                    if ($em.id)       { $excludedDeviceIds.Add($em.id)       | Out-Null }
                }
            } catch {
                Write-Host "  Warning: Failed to retrieve members of exclusion group '$egName' — skipping this exclusion." -ForegroundColor Yellow
            }
        }
    }

    if ($excludedDeviceIds.Count -gt 0) {
        Write-Host "  Total devices excluded across all exclusion groups: $($excludedDeviceIds.Count)"
    }

    # ── Get group members (devices only) ──────────────────────────────────────
    $members = @()
    try {
        $members = @(Get-AllPages -Uri "$GRAPH_BASE/groups/$groupId/members?`$select=id,displayName,deviceId&`$top=999")
    } catch {
        Write-Host "  ERROR: Failed to retrieve group members: $_" -ForegroundColor Red
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'Error'; Error = "Failed to get members: $_"; Renamed = 0; Skipped = 0; Errors = 0 })
        continue
    }

    $deviceMembers = @($members | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.device' -and $_.deviceId })
    Write-Host "  Device members in group: $($deviceMembers.Count)"

    if ($deviceMembers.Count -eq 0) {
        Write-Host "  No device members found — skipping." -ForegroundColor DarkGray
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'NoDevices'; Renamed = 0; Skipped = 0; Errors = 0 })
        continue
    }

    # ── Process each device ───────────────────────────────────────────────────
    $renamed              = 0
    $skipped              = 0
    $errored              = 0
    $skippedNotInIntune   = 0
    $skippedNotMDM        = 0
    $skippedExcluded      = 0
    $skippedAlreadyCorrect = 0
    $skippedPendingRename = 0
    $skippedWrongOS       = 0

    foreach ($device in $deviceMembers) {
        $azureDeviceId = $device.deviceId

        # Look up the Intune managed device by azureADDeviceId
        $managedDevice = $null
        try {
            $encoded       = [Uri]::EscapeDataString("azureADDeviceId eq '$azureDeviceId'")
            $mdResult      = Invoke-GraphRequest -Uri "$GRAPH_BASE/deviceManagement/managedDevices?`$filter=$encoded&`$select=id,deviceName,userDisplayName,managementAgent,operatingSystem&`$top=1"
            $managedDevice = $mdResult.value | Select-Object -First 1
        } catch {
            Write-Host "    Warning: Failed to look up Intune device for azureADDeviceId=$azureDeviceId : $_" -ForegroundColor Yellow
            $errored++
            continue
        }

        if (-not $managedDevice) {
            Write-Host "    SKIP '$($device.displayName)' — not found in Intune (not enrolled or unenrolled)." -ForegroundColor DarkGray
            $skipped++
            $skippedNotInIntune++
            continue
        }

        # Skip devices not managed by Intune MDM (e.g. msSense, eas, jamf, configurationManagerClient)
        if ($managedDevice.managementAgent -notmatch 'mdm|intune') {
            Write-Host "    SKIP '$($managedDevice.deviceName)' — managementAgent='$($managedDevice.managementAgent)' is not Intune MDM." -ForegroundColor DarkGray
            $skipped++
            $skippedNotMDM++
            continue
        }

        # Skip if device is in the exclusion group
        if ($excludedDeviceIds.Count -gt 0 -and ($excludedDeviceIds.Contains($azureDeviceId) -or $excludedDeviceIds.Contains($device.id))) {
            Write-Host "    SKIP '$($managedDevice.deviceName)' — in exclusion group." -ForegroundColor DarkGray
            $skipped++
            $skippedExcluded++
            continue
        }

        # Skip non-Windows devices
        if ($managedDevice.operatingSystem -ne 'Windows') {
            Write-Host "    SKIP '$($managedDevice.deviceName)' — operatingSystem='$($managedDevice.operatingSystem)' (Windows only)." -ForegroundColor DarkGray
            $skipped++
            $skippedWrongOS++
            continue
        }

        $currentName = $managedDevice.deviceName
        $userDisplay = $managedDevice.userDisplayName

        # Skip if already in correct format
        if (Test-AlreadyRenamed -DeviceName $currentName -Prefix $prefix) {
            Write-Host "    SKIP '$currentName' — already matches $prefix-XXXXXXX format." -ForegroundColor DarkGray
            $skipped++
            $skippedAlreadyCorrect++
            continue
        }

        # Check for a pending rename action via direct GET (deviceActionResults is not
        # returned by the $filter endpoint — it requires a direct /managedDevices/{id} call)
        try {
            $actionData    = Invoke-GraphRequest -Uri "$GRAPH_BASE/deviceManagement/managedDevices/$($managedDevice.id)?`$select=deviceActionResults"
            $existingRename = @($actionData.deviceActionResults) |
                Where-Object { $_.actionName -eq 'setDeviceName' -and $_.actionState -notin @('failed', 'canceled') } |
                Select-Object -First 1
            if ($existingRename) {
                $pendingTarget = $existingRename.passcode  # Intune stores the target name in this field
                if (Test-AlreadyRenamed -DeviceName $pendingTarget -Prefix $prefix) {
                    Write-Host "    SKIP '$currentName' — rename to '$pendingTarget' already queued (awaiting reboot)." -ForegroundColor DarkGray
                    $skipped++
                    $skippedPendingRename++
                    continue
                }
            }
        } catch {
            Write-Host "    Warning: Could not check pending actions for '$currentName' — proceeding with rename." -ForegroundColor Yellow
        }

        # Build new name
        $userPart = if ($userDisplay) { Get-UserPart -DisplayName $userDisplay } else { 'XXXXX' }
        $rand     = Get-RandomSuffix
        $newName  = "$prefix-$userPart$rand"

        if ($WhatIfMode) {
            Write-Host "    WouldRename: '$currentName' → '$newName' (user: $userDisplay)" -ForegroundColor Yellow
            $renamed++
            continue
        }

        try {
            Invoke-GraphRequest `
                -Method POST `
                -Uri    "https://graph.microsoft.com/beta/deviceManagement/managedDevices/$($managedDevice.id)/setDeviceName" `
                -Body   @{ deviceName = $newName }
            Write-Host "    Renamed: '$currentName' → '$newName'" -ForegroundColor Green
            $renamed++
        } catch {
            Write-Host "    Warning: Failed to rename '$currentName': $_" -ForegroundColor Yellow
            $errored++
        }
    }

    $status = if ($WhatIfMode) { 'WouldRename' } else { 'Processed' }

    $skipBreakdownParts = @()
    if ($skippedAlreadyCorrect -gt 0) { $skipBreakdownParts += "$skippedAlreadyCorrect already correct" }
    if ($skippedExcluded       -gt 0) { $skipBreakdownParts += "$skippedExcluded excluded" }
    if ($skippedPendingRename  -gt 0) { $skipBreakdownParts += "$skippedPendingRename pending reboot" }
    if ($skippedNotInIntune    -gt 0) { $skipBreakdownParts += "$skippedNotInIntune not in Intune" }
    if ($skippedNotMDM         -gt 0) { $skipBreakdownParts += "$skippedNotMDM not MDM" }
    if ($skippedWrongOS        -gt 0) { $skipBreakdownParts += "$skippedWrongOS wrong OS" }
    $skipBreakdown = if ($skipBreakdownParts.Count -gt 0) { " ($($skipBreakdownParts -join ', '))" } else { '' }

    Write-Host "  Done: $renamed renamed, $skipped skipped$skipBreakdown, $errored errors" -ForegroundColor $(if ($errored -gt 0) { 'Yellow' } else { 'Green' })

    $allResults.Add([PSCustomObject]@{
        RuleId                = $ruleId
        RuleName              = $ruleName
        Status                = $status
        Renamed               = $renamed
        Skipped               = $skipped
        SkippedAlreadyCorrect = $skippedAlreadyCorrect
        SkippedExcluded       = $skippedExcluded
        SkippedPendingRename  = $skippedPendingRename
        SkippedNotInIntune    = $skippedNotInIntune
        SkippedNotMDM         = $skippedNotMDM
        SkippedWrongOS        = $skippedWrongOS
        Errors                = $errored
    })
}

# ============================================================================
# SUMMARY
# ============================================================================

Write-Host "`n##[section]Intune Device Rename Summary"

$totalRenamed  = ($allResults | Measure-Object -Property Renamed  -Sum).Sum
$totalSkipped  = ($allResults | Measure-Object -Property Skipped  -Sum).Sum
$totalErrors   = ($allResults | Measure-Object -Property Errors   -Sum).Sum
$ruleErrors    = @($allResults | Where-Object { $_.Status -eq 'Error' }).Count

if ($WhatIfMode) {
    Write-Host "  WouldRename : $totalRenamed"
} else {
    Write-Host "  Renamed     : $totalRenamed"
}
Write-Host "  Skipped     : $totalSkipped"
Write-Host "  Errors      : $($totalErrors + $ruleErrors)"

if ($ruleErrors -gt 0) {
    $allResults | Where-Object { $_.Status -eq 'Error' } | ForEach-Object {
        Write-Host "  Failed rule: $($_.RuleName) - $($_.Error)" -ForegroundColor Red
    }
}

# ============================================================================
# OUTPUT JSON
# ============================================================================

if ($OutputPath) {
    $summary = @{
        Service    = 'IntuneDeviceRename'
        Timestamp  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        TenantName = $TenantName
        WhatIfMode = [bool]$WhatIfMode
        Results    = @($allResults | ForEach-Object {
            @{
                RuleId                = $_.RuleId
                RuleName              = $_.RuleName
                Status                = $_.Status
                Renamed               = $_.Renamed
                Skipped               = $_.Skipped
                SkippedAlreadyCorrect = $_.SkippedAlreadyCorrect
                SkippedExcluded       = $_.SkippedExcluded
                SkippedPendingRename  = $_.SkippedPendingRename
                SkippedNotInIntune    = $_.SkippedNotInIntune
                SkippedNotMDM         = $_.SkippedNotMDM
                SkippedWrongOS        = $_.SkippedWrongOS
                Errors                = $_.Errors
                Error                 = $_.Error
            }
        })
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "Summary saved to: $OutputPath"
}

if ($ruleErrors -gt 0 -or $totalErrors -gt 0) { exit 1 }
