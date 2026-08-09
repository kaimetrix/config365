<#
.SYNOPSIS
    Creates and manages baseline security groups via Microsoft Graph API

.DESCRIPTION
    Creates baseline security groups that are deployed to all Tenant tenants.
    These groups are used for targeting Conditional Access policies and Intune configurations.
    
    The script is idempotent - it will create groups if they don't exist, or verify/update if they do.

.PARAMETER ConfigDirectory
    Path to the directory containing JSON group definition files

.PARAMETER WhatIf
    Show what would be changed without making changes

.EXAMPLE
    .\Configure-BaselineGroups.ps1 -ConfigDirectory "baseline-groups"
    
.EXAMPLE
    .\Configure-BaselineGroups.ps1 -ConfigDirectory "baseline-groups" -WhatIf

.NOTES
    Requires Microsoft.Graph.Groups module
    Requires appropriate Graph API permissions: Group.ReadWrite.All
    Each JSON file in the directory should define a single group
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$ConfigDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantBaselinePath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantRepoPath  # Path to tenant's own repo (for .baseline-ignore)
)

$ErrorActionPreference = "Stop"

# Import placeholder resolver module
$resolverPath = Join-Path $PSScriptRoot "Resolve-Placeholders.ps1"
. $resolverPath

# Import baseline ignore helpers
$ignoreHelpersPath = Join-Path $PSScriptRoot "Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

# Import shared diff helpers
$diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

Write-Host "##[section]Configuring Baseline Security Groups"

# Initialize baseline ignore patterns (TenantRepoPath is where .baseline-ignore lives)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# Load group configurations from directory
if (-not (Test-Path $ConfigDirectory)) {
    throw "Configuration directory not found: $ConfigDirectory"
}

$groupFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File |
    Where-Object { $_.Name -notlike "*.config.json" -and $_.Name -notlike "*.monitor.json" }
if ($groupFiles.Count -eq 0) {
    throw "No JSON files found in directory: $ConfigDirectory"
}

Write-Host "Found $($groupFiles.Count) group definition(s) in: $ConfigDirectory"

# Filter out ignored policies based on .baseline-ignore
# Use the baseline folder root (parent of groups/) so patterns like "groups/file.json" work correctly
$baselineRoot = if ($TenantBaselinePath) { 
    Join-Path $TenantBaselinePath "baseline" 
} else { 
    Split-Path $ConfigDirectory -Parent 
}
$groupFiles = @(Get-FilteredPolicyFiles -PolicyFiles $groupFiles -BaselineRoot $baselineRoot)
if ($groupFiles.Count -eq 0) {
    Write-Host "No group files to process after scope/ignore filtering — all files were excluded by the plan scope."
    exit 0
}
$groupFilesBeforeExclusion = @($groupFiles)
$groupFiles = @(Get-GroupExcludedFiles -Files $groupFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)

# MSP content-group exclusions apply to policy files, not Entra security groups that must
# exist for app assignments. Re-include any group whose sidecar (or default) is alwaysDeploy.
$reincluded = [System.Collections.Generic.List[string]]::new()
foreach ($file in $groupFilesBeforeExclusion) {
    if ($groupFiles -contains $file) { continue }
    $configFile = Join-Path $file.Directory.FullName ($file.BaseName + '.config.json')
    $deployBehavior = 'alwaysDeploy'
    if (Test-Path $configFile) {
        $sidecar = Get-Content $configFile -Raw | ConvertFrom-Json
        if ($sidecar.deployBehavior) { $deployBehavior = [string]$sidecar.deployBehavior }
    }
    if ($deployBehavior -ne 'deployIfNotExists') {
        $groupFiles += $file
        $reincluded.Add($file.Name)
    }
}
if ($reincluded.Count -gt 0) {
    Write-Host "Re-including $($reincluded.Count) alwaysDeploy group(s) bypassed by MSP content exclusions: $($reincluded -join ', ')"
    $groupFiles = @($groupFiles | Sort-Object FullName -Unique)
}
if ($groupFiles.Count -eq 0) {
    Write-Host "No group files to process after scope/ignore/content filtering."
    exit 0
}

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.Groups"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
# In pipeline context, uses environment variables or managed identity
# For local testing, will prompt for interactive authentication
try {
    $context = Ensure-M365GraphConnection -Scopes @("Group.ReadWrite.All")
    Write-Host "✓ Connected to tenant: $($context.TenantId)"
    Write-Host "  Account: $($context.Account)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Load all group configurations (raw, no placeholder resolution yet)
$groupRaw = @{}  # displayName -> hashtable
foreach ($file in $groupFiles) {
    Write-Host "  Loading: $($file.Name)"
    $groupConfig = Get-Content $file.FullName -Raw | ConvertFrom-Json
    $groupConfigHash = $groupConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    $displayName = ($groupConfigHash['displayName'] ?? $groupConfigHash['DisplayName'])
    if ($displayName) { $displayName = [string]$displayName.Trim() }
    if ($groupConfigHash['displayName']) { $groupConfigHash['displayName'] = $displayName }
    if ($groupConfigHash['DisplayName']) { $groupConfigHash['DisplayName'] = $displayName }

    # deployBehavior belongs exclusively in the sibling .config.json sidecar.
    # Strip it from the main JSON first (handles any legacy files not yet migrated),
    # then inject the authoritative value from the sidecar.
    $groupConfigHash.Remove('deployBehavior')
    $configFile = Join-Path $file.Directory.FullName ($file.BaseName + ".config.json")
    if (Test-Path $configFile) {
        $behaviorConfig = Get-Content $configFile -Raw | ConvertFrom-Json -AsHashtable
        if ($behaviorConfig['deployBehavior']) {
            $groupConfigHash['deployBehavior'] = $behaviorConfig['deployBehavior']
        }
    }

    # Read field-monitor config from sibling .monitor.json
    $groupMonitorCfg = Get-MonitorConfig -BaselineFilePath $file.FullName
    if ($groupMonitorCfg) {
        $groupConfigHash['_monitorConfig'] = $groupMonitorCfg
    }

    # Track source file path for plan-scoped apply
    $groupConfigHash['_SourceFile'] = $file.FullName

    $groupRaw[$displayName] = $groupConfigHash
}

# Topological sort: groups that are referenced by other groups in this baseline
# must be deployed first so their IDs can be resolved as placeholders.
function Get-BaselineGroupRefs {
    param([hashtable]$GroupHash, [hashtable]$AllGroups)
    $json = $GroupHash | ConvertTo-Json -Depth 10
    $refs = @()
    $matches = [regex]::Matches($json, '\{\{GROUP:([^}]+)\}\}')
    foreach ($m in $matches) {
        $refName = $m.Groups[1].Value
        if ($AllGroups.ContainsKey($refName)) {
            $refs += $refName
        }
    }
    return $refs
}

function Get-TopologicallySorted {
    param([hashtable]$AllGroups)
    $sorted = [System.Collections.Generic.List[string]]::new()
    $visited = @{}

    function Visit([string]$name) {
        if ($visited[$name] -eq 'visiting') {
            Write-Warning "Circular dependency detected for group: $name"
            return
        }
        if ($visited[$name] -eq 'done') { return }
        $visited[$name] = 'visiting'
        foreach ($dep in (Get-BaselineGroupRefs -GroupHash $AllGroups[$name] -AllGroups $AllGroups)) {
            Visit $dep
        }
        $visited[$name] = 'done'
        $sorted.Add($name)
    }

    foreach ($name in $AllGroups.Keys) {
        Visit $name
    }
    return $sorted
}

$sortedNames = Get-TopologicallySorted -AllGroups $groupRaw

Write-Host "Groups to process: $($sortedNames.Count) (dependency order)"
foreach ($n in $sortedNames) {
    $deps = Get-BaselineGroupRefs -GroupHash $groupRaw[$n] -AllGroups $groupRaw
    if ($deps.Count -gt 0) {
        Write-Host "  → $n  [depends on: $($deps -join ', ')]"
    }
}

function Get-GroupConfigProp {
    param(
        [object]$Config,
        [string[]]$Names
    )
    if (-not $Config) { return $null }
    foreach ($n in $Names) {
        $prop = $Config.PSObject.Properties[$n]
        if ($prop -and $null -ne $prop.Value -and "$($prop.Value)" -ne '') {
            return $prop.Value
        }
    }
    return $null
}

# Function to create or update a group
function Set-BaselineGroup {
    param(
        [Parameter(Mandatory=$true)]
        [object]$GroupConfig
    )

    $displayName = [string](Get-GroupConfigProp $GroupConfig 'DisplayName', 'displayName')
    if ([string]::IsNullOrWhiteSpace($displayName)) {
        throw "Group config is missing displayName / DisplayName"
    }
    
    Write-Host "`n##[group]Processing: $displayName"
    Write-Verbose "Group config: $($GroupConfig | ConvertTo-Json -Depth 5 -Compress)"
    
    try {
        # Check if group already exists
        Write-Verbose "Checking if group exists..."
        $existingGroup = Find-MgGroupByDisplayName -DisplayName $displayName
        
        if ($existingGroup) {
            Write-Host "Group already exists: $($existingGroup.Id)"
            
            # Check if group is protected from baseline updates via description marker
            $existingDescRaw = Get-GroupConfigProp $existingGroup 'Description', 'description'
            $existingDescText = if ($null -eq $existingDescRaw) { '' } else { [string]$existingDescRaw }
            if (Test-ResourceProtected -Description $existingDescText) {
                $marker = (Get-CONFIG365Options).protectionMarker
                Write-Host "  ⛔ Protected: Group has '$marker' marker in description - skipping"
                return [PSCustomObject]@{ Group = $existingGroup; Action = "Protected"; Details = @("Description contains protection marker") }
            }
            
            # Read per-group deploy behavior from JSON; default to alwaysDeploy
            $deployBehavior = if ($GroupConfig.deployBehavior) { $GroupConfig.deployBehavior } else { "alwaysDeploy" }

            if ($deployBehavior -eq "deployIfNotExists") {
                Write-Host "✓ Group exists (skipping - deployBehavior is deployIfNotExists)"
                return [PSCustomObject]@{ Group = $existingGroup; Action = "NoChange"; Details = @("deployBehavior: deployIfNotExists") }
            }
            
            # Build monitor config from injected _monitorConfig (if any)
            $groupMonitorConfig = $null
            if ($GroupConfig._monitorConfig) {
                $groupMonitorConfig = @{}
                if ($GroupConfig._monitorConfig.Include) { $groupMonitorConfig['Include'] = @($GroupConfig._monitorConfig.Include) }
                if ($GroupConfig._monitorConfig.Exclude) { $groupMonitorConfig['Exclude'] = @($GroupConfig._monitorConfig.Exclude) }
                if ($groupMonitorConfig.Count -eq 0) { $groupMonitorConfig = $null }
            }

            # Detect all candidate changes unconditionally, then apply monitor filter
            $candidateUpdates = @{}

            $existingDesc = $existingDescText
            $desiredDesc = [string]((Get-GroupConfigProp $GroupConfig 'Description', 'description') ?? '')
            if ($existingDesc -ne $desiredDesc -and $desiredDesc -ne "") {
                $candidateUpdates['Description'] = $desiredDesc
            }

            # ─── Membership rule + groupTypes drift detection ─────────────────────
            # Baseline can express intent three ways:
            #   1. Dynamic group: GroupTypes contains 'DynamicMembership' AND MembershipRule set
            #   2. Static group:  GroupTypes is null/empty/missing AND no MembershipRule
            #   3. Mixed (legacy): GroupTypes null but MembershipRule set — treat as dynamic
            # The tenant's live state can drift in either direction (e.g. a static baseline
            # mapping a group that the tenant later converted to dynamic, or vice versa).
            # The original implementation only set MembershipRule when baseline had a non-null
            # value, so dynamic→static drift was silently ignored.
            $existingRule  = $existingGroup.MembershipRule
            $existingTypes = @($existingGroup.GroupTypes)
            $existingIsDynamic = $existingTypes -contains 'DynamicMembership'

            $desiredRule = if ($GroupConfig.MembershipRule) { $GroupConfig.MembershipRule } elseif ($GroupConfig.membershipRule) { $GroupConfig.membershipRule } else { $null }
            $desiredTypesRaw = if ($GroupConfig.GroupTypes) { $GroupConfig.GroupTypes } elseif ($GroupConfig.groupTypes) { $GroupConfig.groupTypes } else { $null }
            $desiredTypes = @()
            if ($desiredTypesRaw -is [string]) { $desiredTypes = @($desiredTypesRaw) }
            elseif ($desiredTypesRaw -is [System.Collections.IEnumerable]) { $desiredTypes = @($desiredTypesRaw | Where-Object { $_ }) }
            $desiredIsDynamic = ($desiredTypes -contains 'DynamicMembership') -or [bool]$desiredRule

            if ($existingIsDynamic -ne $desiredIsDynamic) {
                # Type flip: include both GroupTypes and (cleared) MembershipRule so the
                # PATCH body is internally consistent for the Graph API.
                $candidateUpdates['GroupTypes'] = if ($desiredIsDynamic) { @('DynamicMembership') } else { @() }
                if ($desiredIsDynamic) {
                    if ($desiredRule) { $candidateUpdates['MembershipRule'] = $desiredRule }
                    $desiredProcState = if ($GroupConfig.MembershipRuleProcessingState) { $GroupConfig.MembershipRuleProcessingState } elseif ($GroupConfig.membershipRuleProcessingState) { $GroupConfig.membershipRuleProcessingState } else { 'On' }
                    $candidateUpdates['MembershipRuleProcessingState'] = $desiredProcState
                } else {
                    # Convert dynamic → static: explicitly clear rule + processing state
                    $candidateUpdates['MembershipRule'] = $null
                    $candidateUpdates['MembershipRuleProcessingState'] = $null
                }
            }
            elseif ($desiredIsDynamic -and $existingRule -ne $desiredRule) {
                # Both sides dynamic but rule text drifted
                $candidateUpdates['MembershipRule'] = $desiredRule
                $desiredProcState = if ($GroupConfig.MembershipRuleProcessingState) { $GroupConfig.MembershipRuleProcessingState } elseif ($GroupConfig.membershipRuleProcessingState) { $GroupConfig.membershipRuleProcessingState } else { 'On' }
                if ($existingGroup.MembershipRuleProcessingState -ne $desiredProcState) {
                    $candidateUpdates['MembershipRuleProcessingState'] = $desiredProcState
                }
            }

            # Apply monitor filter to restrict deployment to monitored fields only.
            # $candidateUpdates uses PascalCase keys; monitor config uses camelCase — convert before filtering.
            $updates = $candidateUpdates
            if ($groupMonitorConfig -and $updates.Count -gt 0) {
                $updatesLower = @{}
                foreach ($k in $updates.Keys) {
                    $lk = $k.Substring(0,1).ToLower() + $k.Substring(1)
                    $updatesLower[$lk] = $updates[$k]
                }
                $filteredLower = Apply-MonitorFilter -PolicyObject $updatesLower -MonitorConfig $groupMonitorConfig
                $updates = @{}
                foreach ($lk in $filteredLower.Keys) {
                    $pk = $lk.Substring(0,1).ToUpper() + $lk.Substring(1)
                    $updates[$pk] = $filteredLower[$lk]
                }
            }
            $needsUpdate = $updates.Count -gt 0

            # Build details from the filtered update set (so reported changes match what is deployed)
            $details = @()
            if ($updates.ContainsKey('Description')) {
                Write-Host "  Description differs - will update"
                $details += "  Description: '$existingDesc' -> '$desiredDesc'"
            }
            if ($updates.ContainsKey('GroupTypes')) {
                $fromKind = if ($existingIsDynamic) { 'Dynamic' } else { 'Static' }
                $toKind   = if ($desiredIsDynamic)  { 'Dynamic' } else { 'Static' }
                Write-Host "  GroupTypes differs - will flip $fromKind -> $toKind"
                $details += "  GroupTypes: $fromKind -> $toKind"
            }
            if ($updates.ContainsKey('MembershipRule')) {
                $shownExisting = if ($existingRule) { $existingRule } else { '(none)' }
                $shownDesired  = if ($updates['MembershipRule']) { $updates['MembershipRule'] } else { '(cleared)' }
                Write-Host "  MembershipRule differs - will update"
                Write-Host "    From: $shownExisting"
                Write-Host "    To:   $shownDesired"
                $details += "  MembershipRule:"
                $details += "    FROM: $shownExisting"
                $details += "    TO:   $shownDesired"
            }
            if ($updates.ContainsKey('MembershipRuleProcessingState')) {
                $shownExisting = if ($existingGroup.MembershipRuleProcessingState) { $existingGroup.MembershipRuleProcessingState } else { '(none)' }
                $shownDesired  = if ($updates['MembershipRuleProcessingState']) { $updates['MembershipRuleProcessingState'] } else { '(cleared)' }
                Write-Host "  MembershipRuleProcessingState differs - will update"
                $details += "  MembershipRuleProcessingState: $shownExisting -> $shownDesired"
            }
            
            if ($existingGroup.MailNickname -ne $GroupConfig.MailNickname) {
                Write-Host "  Warning: MailNickname differs but cannot be updated after creation"
                Write-Host "    Current: $($existingGroup.MailNickname)"
                Write-Host "    Desired: $($GroupConfig.MailNickname)"
                $details += "  ⚠ MailNickname cannot be updated (current: $($existingGroup.MailNickname))"
            }
            
            if ($needsUpdate) {
                foreach ($detail in $details) {
                    Write-Host "  $detail" -ForegroundColor DarkYellow
                }
                # Build Changes object for pipeline display (with ModifiedValues for long values)
                $modifiedStrings  = @($details | ForEach-Object { $_.Trim() })
                $modifiedValuesMap = @{}
                # Description: simple → parse
                if ($existingDesc -ne $desiredDesc -and $desiredDesc -ne "") {
                    $eStr = Format-PropertyValue $existingDesc
                    $dStr = Format-PropertyValue $desiredDesc
                    if ($eStr.Length -gt 60 -or $dStr.Length -gt 60) {
                        $modifiedValuesMap['Description'] = @{ Existing = $eStr; Desired = $dStr }
                    }
                }
                # MembershipRule: likely long
                if ($desiredRule -and $existingRule -ne $desiredRule) {
                    $eStr = Format-PropertyValue $existingRule
                    $dStr = Format-PropertyValue $desiredRule
                    if ($eStr.Length -gt 60 -or $dStr.Length -gt 60) {
                        $modifiedValuesMap['MembershipRule'] = @{ Existing = $eStr; Desired = $dStr }
                    }
                }
                $changesObj = @{ Modified = $modifiedStrings; ModifiedValues = $modifiedValuesMap }
                
                if ($PSCmdlet.ShouldProcess($displayName, "Update group")) {
                    Update-MgGroup -GroupId $existingGroup.Id -BodyParameter $updates
                    Write-Host "✓ Group updated successfully"
                    return [PSCustomObject]@{ Group = $existingGroup; Action = "Updated"; Details = $details; Changes = $changesObj }
                }
                else {
                    Write-Host "[WhatIf] Would update group: $displayName"
                    return [PSCustomObject]@{ Group = $existingGroup; Action = "WouldUpdate"; Details = $details; Changes = $changesObj }
                }
            }
            else {
                Write-Host "✓ Group is up to date - no changes needed"
                return [PSCustomObject]@{ Group = $existingGroup; Action = "NoChange"; Details = @() }
            }
        }
        else {
            # Create new group
            Write-Host "Group does not exist - creating new group"
            
            # Build group params, excluding null values (Graph API doesn't accept nulls)
            $groupParams = @{
                DisplayName = $displayName
                MailEnabled = [bool]((Get-GroupConfigProp $GroupConfig 'MailEnabled', 'mailEnabled') ?? $false)
                SecurityEnabled = [bool]((Get-GroupConfigProp $GroupConfig 'SecurityEnabled', 'securityEnabled') ?? $true)
                MailNickname = [string](Get-GroupConfigProp $GroupConfig 'MailNickname', 'mailNickname')
            }
            
            # Only add optional properties if they have values
            $desiredDescription = Get-GroupConfigProp $GroupConfig 'Description', 'description'
            if ($desiredDescription) {
                $groupParams['Description'] = [string]$desiredDescription
            }
            
            # Handle GroupTypes - ensure it's always an array (check both cases for JSON compatibility)
            $groupTypes = if ($GroupConfig.GroupTypes) { $GroupConfig.GroupTypes } elseif ($GroupConfig.groupTypes) { $GroupConfig.groupTypes } else { $null }
            if ($groupTypes) {
                if ($groupTypes -is [string]) {
                    # Convert single string to array
                    $groupParams['GroupTypes'] = @($groupTypes)
                } elseif ($groupTypes -is [array] -and $groupTypes.Count -gt 0) {
                    $groupParams['GroupTypes'] = @($groupTypes)
                } else {
                    $groupParams['GroupTypes'] = @()
                }
            } else {
                $groupParams['GroupTypes'] = @()
            }
            
            # Handle dynamic group membership rule (check both cases for JSON compatibility)
            $membershipRule = if ($GroupConfig.MembershipRule) { $GroupConfig.MembershipRule } elseif ($GroupConfig.membershipRule) { $GroupConfig.membershipRule } else { $null }
            if ($membershipRule) {
                $groupParams['MembershipRule'] = $membershipRule
                $processingState = if ($GroupConfig.MembershipRuleProcessingState) { $GroupConfig.MembershipRuleProcessingState } 
                                   elseif ($GroupConfig.membershipRuleProcessingState) { $GroupConfig.membershipRuleProcessingState }
                                   else { "On" }
                $groupParams['MembershipRuleProcessingState'] = $processingState
                Write-Verbose "Dynamic group with rule: $membershipRule"
            }
            
            if ($GroupConfig.Visibility) {
                $groupParams['Visibility'] = $GroupConfig.Visibility
            }
            
            Write-Verbose "Creating group with params:"
            Write-Verbose ($groupParams | ConvertTo-Json -Depth 5)
            
            if ($PSCmdlet.ShouldProcess($displayName, "Create group")) {
                $newGroup = New-MgGroup -BodyParameter $groupParams
                Write-Host "✓ Group created successfully"
                Write-Host "  Group ID: $($newGroup.Id)"
                return [PSCustomObject]@{ Group = $newGroup; Action = "Created"; Details = @() }
            }
            else {
                Write-Host "[WhatIf] Would create group: $displayName"
                return [PSCustomObject]@{ Group = $null; Action = "WouldCreate"; Details = @() }
            }
        }
    }
    catch {
        Write-Host "##[error]Failed to process group: $displayName"
        Write-Host "##[error]Error: $_"
        throw
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# Process all groups in dependency order:
# Placeholders are resolved immediately before each group is deployed so that
# groups created earlier in this run are already in the tenant and resolvable.
Write-Host "`n##[section]Creating/Updating Baseline Groups"

$results = @()
$successCount = 0
$errorCount = 0

foreach ($groupName in $sortedNames) {
    $groupConfigHash = $groupRaw[$groupName]

    # Resolve placeholders now — dependency groups are already deployed and their IDs
    # are pre-seeded in $script:GroupCache, so no Graph query is needed for them.
    $groupConfigHash = Resolve-Placeholders -ConfigObject $groupConfigHash
    $groupConfig = $groupConfigHash | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    if ($groupConfig.displayName) { $groupConfig.displayName = $groupConfig.displayName.Trim() }
    if ($groupConfig.DisplayName) { $groupConfig.DisplayName = $groupConfig.DisplayName.Trim() }

    try {
        $result = Set-BaselineGroup -GroupConfig $groupConfig
        $successCount++

        # Seed the placeholder cache with this group's real ID so any subsequent group
        # that references it via {{GROUP:...}} resolves instantly without a Graph query.
        # This avoids Entra ID replication lag for groups created moments ago.
        if ($result.Group -and $result.Group.Id) {
            $script:GroupCache[$groupName] = $result.Group.Id
        }

        # Brief pause after creation to allow Entra ID to replicate the new group
        # before any downstream Graph queries (belt-and-suspenders alongside cache seeding).
        if ($result.Action -eq 'Created') {
            Write-Host "  Waiting 5s for Entra ID replication..."
            Start-Sleep -Seconds 5
        }
        
        # Map action to display status
        $statusDisplay = switch ($result.Action) {
            "Created"     { "✓ Created" }
            "Updated"     { "✓ Updated" }
            "NoChange"    { "○ No changes" }
            "WouldCreate" { "→ Would CREATE" }
            "WouldUpdate" { "→ Would UPDATE" }
            default       { $result.Action }
        }
        
        $results += [PSCustomObject]@{
            DisplayName = $groupConfig.DisplayName
            Id = if ($result.Group) { $result.Group.Id } else { "(new)" }
            Status = $statusDisplay
            Details = if ($result.Details) { $result.Details } else { @() }
            Changes = if ($result.Changes) { $result.Changes } else { $null }
            FilePath = $groupConfig._SourceFile
        }
    }
    catch {
        $errorCount++
        $results += [PSCustomObject]@{
            DisplayName = $groupConfig.DisplayName
            Id = $null
            Status = "Failed: $_"
            Details = @()
            FilePath = $groupConfig._SourceFile
        }
    }
}

# Summary
Write-Host "`n##[section]Summary"
Write-Host "Total groups processed: $($sortedNames.Count)"

# Count by action type
$createCount = ($results | Where-Object { $_.Status -match "Created|Would CREATE" }).Count
$updateCount = ($results | Where-Object { $_.Status -match "Updated|Would UPDATE" }).Count
$noChangeCount = ($results | Where-Object { $_.Status -match "No changes" }).Count
$protectedCount = ($results | Where-Object { $_.Status -eq "Protected" }).Count

if ($WhatIfPreference) {
    Write-Host "  → Would CREATE: $createCount"
    Write-Host "  → Would UPDATE: $updateCount"
    Write-Host "  ○ No changes needed: $noChangeCount"
} else {
    Write-Host "  ✓ Created: $createCount"
    Write-Host "  ✓ Updated: $updateCount"
    Write-Host "  ○ Unchanged: $noChangeCount"
}

if ($protectedCount -gt 0) {
    Write-Host "  ⛔ Protected: $protectedCount"
}

if ($errorCount -gt 0) {
    Write-Host "  ✗ Failed: $errorCount"
}

if ($results.Count -gt 0) {
    Write-Host "`nResults:"
    foreach ($r in $results) {
        $icon = switch -Wildcard ($r.Status) {
            "✓ Created" { "✓ CREATED" }
            "✓ Updated" { "✓ UPDATED" }
            "→ Would CREATE" { "→ WOULD CREATE" }
            "→ Would UPDATE" { "→ WOULD UPDATE" }
            "○ No changes" { "○ NO CHANGE" }
            "Failed*" { "✗ FAILED" }
            default { $r.Status }
        }
        Write-Host "  $icon : $($r.DisplayName)"
    }
}

# Show detailed changes section
$resultsWithDetails = $results | Where-Object { $_.Details -and $_.Details.Count -gt 0 }
if ($resultsWithDetails.Count -gt 0) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════════════════════"
    Write-Host "DETAILED CHANGES"
    Write-Host "═══════════════════════════════════════════════════════════════════════════════"
    Write-Host ""
    
    foreach ($r in $resultsWithDetails) {
        Write-Host "┌─ [Group] $($r.DisplayName)"
        foreach ($detail in $r.Details) {
            Write-Host "│  $detail"
        }
        Write-Host "└─────────────────────────────────────────────────────────────────────────────"
        Write-Host ""
    }
}

# Output plan summary if requested
if ($OutputPath) {
    # Calculate detailed counts for the plan output
    $wouldCreateCount = ($results | Where-Object { $_.Status -match "Would CREATE" }).Count
    $wouldUpdateCount = ($results | Where-Object { $_.Status -match "Would UPDATE" }).Count
    $createdCount = ($results | Where-Object { $_.Status -match "Created" -and $_.Status -notmatch "Would" }).Count
    $updatedCount = ($results | Where-Object { $_.Status -match "Updated" -and $_.Status -notmatch "Would" }).Count
    
    $planSummary = @{
        Service = "Groups"
        Timestamp = Get-Date -Format "o"
        TotalGroups = $groupConfigs.Count
        CreatedCount = $createdCount
        UpdatedCount = $updatedCount
        NoChangeCount = $noChangeCount
        ProtectedCount = $protectedCount
        WouldCreateCount = $wouldCreateCount
        WouldUpdateCount = $wouldUpdateCount
        SuccessCount = $successCount
        ErrorCount = $errorCount
        Results = $results
    }
    
    $planSummary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nPlan summary saved to: $OutputPath"
}

if ($errorCount -gt 0) {
    Write-Host "##[error]Some groups failed to process"
    exit 1
}
else {
    Write-Host "##[command]All baseline groups configured successfully!"
}

