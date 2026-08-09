<#
.SYNOPSIS
    Creates and manages Intune policies via Microsoft Graph API
    
.DESCRIPTION
    Orchestrates the creation and management of Intune policies by calling modular scripts
    for each policy type. This design allows easier debugging and maintenance.
    
    Policy types supported:
    - App Protection (Android/iOS)
    - Compliance Policies
    - Device Configurations
    - Settings Catalog
    - Endpoint Security
    - Platform Scripts
    - Windows Updates (Rings, Feature, Quality, Driver)
    - Autopilot Profiles
    
.PARAMETER ConfigDirectory
    Path to the directory containing JSON Intune policy definition files
    
.PARAMETER WhatIf
    Show what would be changed without making changes
    
.PARAMETER OutputPath
    Optional path to save a JSON summary of planned changes
    
.PARAMETER ExtraConfigPaths
    Deprecated — group-scoped folders are included via Get-GroupExcludedFiles membership resolution.

.PARAMETER ExtraFiles
    Deprecated — group-scoped files are included via Get-GroupExcludedFiles membership resolution.
    
.EXAMPLE
    .\Configure-Intune.ps1 -ConfigDirectory "baseline-intune"
    
.EXAMPLE
    .\Configure-Intune.ps1 -ConfigDirectory "baseline-intune" -WhatIf -OutputPath "intune-plan.json"
    
.NOTES
    Requires Microsoft.Graph.DeviceManagement module
    Requires appropriate Graph API permissions: DeviceManagementConfiguration.ReadWrite.All
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$ConfigDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath,
    
    [Parameter(Mandatory=$false)]
    [string[]]$ExtraConfigPaths = @(),

    [Parameter(Mandatory=$false)]
    [string[]]$ExtraFiles = @(),
    
    [Parameter(Mandatory=$false)]
    [string]$TenantBaselinePath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantRepoPath  # Path to tenant's own repo (for .baseline-ignore)
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot

# Import modules directory path
$modulesPath = Join-Path $scriptRoot "intune"

Write-Host "##[section]Configuring Intune Policies"

# ============================================================================
# IMPORT DEPENDENCIES
# ============================================================================

# Import placeholder resolver module
$resolverPath = Join-Path $scriptRoot "Resolve-Placeholders.ps1"
. $resolverPath

# Import baseline ignore helpers
$ignoreHelpersPath = Join-Path $scriptRoot "Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

# Import diff helpers (provides Get-MonitorConfig and Apply-MonitorFilter)
$diffHelpersPath = Join-Path $scriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

$moduleHelpersPath = Join-Path $scriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

# Import shared helpers
$helpersPath = Join-Path $modulesPath "Configure-Intune-Helpers.ps1"
. $helpersPath

# Initialize baseline ignore patterns (if TenantBaselinePath provided)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# ============================================================================
# LOAD POLICY CONFIGURATIONS
# ============================================================================

if (-not (Test-Path $ConfigDirectory)) {
    throw "Configuration directory not found: $ConfigDirectory"
}

# Search for JSON files (excluding assignment files and monitor sidecar files)
$policyFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File -Recurse | 
    Where-Object { $_.Name -notlike "*.assignment.json" -and $_.Name -notlike "*.monitor.json" }

# Filter out ignored policies based on .baseline-ignore
# Use the baseline folder root so patterns like "intune/file.json" work correctly
$baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }
$policyFiles = @(Get-FilteredPolicyFiles -PolicyFiles $policyFiles -BaselineRoot $baselineRoot)
$policyFiles = @(Get-GroupExcludedFiles -Files $policyFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)

if ($policyFiles.Count -eq 0) {
    Write-Host "##[warning]No JSON files found in directory: $ConfigDirectory"
    exit 0
}

# Group files by subfolder
$filesByType = $policyFiles | Group-Object { $_.Directory.Name }
Write-Host "Found $($policyFiles.Count) policy definition(s) in: $ConfigDirectory"
foreach ($group in $filesByType) {
    Write-Host "  $($group.Name): $($group.Count) policies"
}

# ============================================================================
# AUTHENTICATE TO MICROSOFT GRAPH
# ============================================================================

$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.DeviceManagement",
    "Microsoft.Graph.Groups"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection
    Write-Host "✓ Connected to tenant: $($context.TenantId)"
    Write-Host "  Account: $($context.Account)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# ============================================================================
# LOAD AND CLASSIFY POLICIES
# ============================================================================

# Helper: load a list of policy files into a configs array.
# $AllowMissingPlaceholders controls whether unresolved {{FILTER:...}} / {{GROUP:...}}
# references are warnings (true) or hard errors (false).
function Invoke-LoadPolicyFiles {
    param(
        [Parameter(Mandatory=$true)]
        [object[]]$Files,
        [Parameter(Mandatory=$true)]
        [string]$GroupsPath,
        [bool]$AllowMissingPlaceholders = $false
    )

    $configs = @()
    $errors  = @()

    foreach ($file in $Files) {
        $folderName = $file.Directory.Name

        try {
            $policyConfig = Get-Content $file.FullName -Raw | ConvertFrom-Json

            # Auto-detect policy type
            $policyType = $null

            if ($policyConfig.platform -and $policyConfig.rule -and $folderName -eq "filters") {
                $policyType = "filters"
            }
            elseif ($policyConfig.'@odata.context' -like "*configurationPolicies*") {
                $policyType = "settings-catalog"
            }
            elseif ($policyConfig.templateId -and -not $policyConfig.templateReference) {
                $policyType = "endpoint-security"
            }
            elseif ($policyConfig.'@odata.type') {
                $odataType = $policyConfig.'@odata.type'
                if ($odataType -like "*windowsUpdateForBusinessConfiguration*") { $policyType = "windows-updates" }
                elseif ($odataType -like "*windowsFeatureUpdateProfile*") { $policyType = "windows-feature-updates" }
                elseif ($odataType -like "*windowsQualityUpdateProfile*") { $policyType = "windows-quality-updates" }
                elseif ($odataType -like "*windowsDriverUpdateProfile*") { $policyType = "windows-driver-updates" }
                elseif ($odataType -like "*deviceAndAppManagementAssignmentFilter*") { $policyType = "filters" }
                elseif ($odataType -like "*CustomConfiguration*" -or $odataType -like "*deviceConfiguration*") { $policyType = "device-configurations" }
            }

            if (-not $policyType) { $policyType = $folderName }

            if ($policyType -ne $folderName) {
                Write-Host "  Auto-detected type '$policyType' (folder was '$folderName')" -ForegroundColor Cyan
            }

            # Add metadata
            $policyConfig | Add-Member -NotePropertyName "_sourceFile"  -NotePropertyValue $file.Name     -Force
            $policyConfig | Add-Member -NotePropertyName "_sourcePath"  -NotePropertyValue $file.FullName -Force
            $policyConfig | Add-Member -NotePropertyName "_policyType"  -NotePropertyValue $policyType    -Force

            # Load field-monitor config from sibling .monitor.json (if present)
            $intuneMonitorCfg = Get-MonitorConfig -BaselineFilePath $file.FullName
            if ($intuneMonitorCfg) {
                $policyConfig | Add-Member -NotePropertyName "_monitorConfig" -NotePropertyValue $intuneMonitorCfg -Force
            }

            # Load assignments
            $assignmentFile = $file.FullName -replace "\.json$", ".assignment.json"
            if (Test-Path $assignmentFile) {
                $assignments = Get-Content $assignmentFile -Raw | ConvertFrom-Json
                $policyConfig | Add-Member -NotePropertyName "_assignments" -NotePropertyValue $assignments -Force
            }

            # Resolve placeholders.
            # Filter configs use {{FILTER:self}} in their 'id' field so that other policies can
            # reference them by name before they are deployed.  That placeholder cannot resolve
            # until the filter itself exists in the tenant, so we always allow missing references
            # during the filter-load phase.  The 'id' field is stripped by Repair-FilterPayload
            # before any API call, so the unresolved value is never sent to the Graph API.
            $allowMissing = $AllowMissingPlaceholders
            $configHash = $policyConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
            $configHash = Resolve-Placeholders -ConfigObject $configHash -AllowMissingGroups:$allowMissing -PendingGroupsPath $GroupsPath

            # Ensure roleScopeTagIds stays as an array
            if ($configHash.ContainsKey('roleScopeTagIds') -and $configHash['roleScopeTagIds'] -isnot [System.Collections.IList]) {
                $configHash['roleScopeTagIds'] = @($configHash['roleScopeTagIds'])
            }

            $policyConfig = $configHash | ConvertTo-Json -Depth 20 | ConvertFrom-Json
            if ($policyConfig.displayName) { $policyConfig.displayName = $policyConfig.displayName.Trim() }
            if ($policyConfig.name)        { $policyConfig.name        = $policyConfig.name.Trim() }
            # Re-attach _monitorConfig as the original hashtable — ConvertFrom-Json without
            # -AsHashtable converts nested objects to PSCustomObject, which breaks Apply-MonitorFilter.
            if ($configHash.ContainsKey('_monitorConfig') -and $null -ne $configHash['_monitorConfig']) {
                $policyConfig | Add-Member -NotePropertyName '_monitorConfig' -NotePropertyValue $configHash['_monitorConfig'] -Force
            }

            $configs += $policyConfig
            Write-Host "  ✓ Loaded [$policyType]: $($file.Name)"
        }
        catch {
            Write-Host "##[warning]Failed to load $($file.Name): $_"
            $errors += [PSCustomObject]@{
                FileName   = $file.Name
                PolicyType = $folderName
                Error      = $_.Exception.Message
            }
        }
    }

    return @{ Configs = $configs; Errors = $errors }
}

# Split file list into filters and everything else so filters can be deployed
# first and their IDs made available to placeholder resolution for other policies.
$groupsPath      = Join-Path (Split-Path $ConfigDirectory -Parent) "groups"
$filterFiles     = @($policyFiles | Where-Object { $_.Directory.Name -eq "filters" })
$nonFilterFiles  = @($policyFiles | Where-Object { $_.Directory.Name -ne "filters" })

# ── Phase 1: load and deploy filters ─────────────────────────────────────────
Write-Host "`nLoading policy configurations..."
$policyLoadErrors = @()
$policyConfigs    = @()

if ($filterFiles.Count -gt 0) {
    Write-Host "`n  [Phase 1] Loading $($filterFiles.Count) filter file(s)..."
    # Allow missing placeholders: filter JSONs store their own ID as {{FILTER:name}}
    # which cannot be resolved before the filter exists in the tenant.
    $filterLoad = Invoke-LoadPolicyFiles -Files $filterFiles -GroupsPath $groupsPath -AllowMissingPlaceholders $true
    $policyLoadErrors += $filterLoad.Errors
    $filterConfigs = @($filterLoad.Configs)
}
else {
    $filterConfigs = @()
}

# ============================================================================
# CLEAR POLICY CACHE
# ============================================================================

Clear-PolicyCache

# ============================================================================
# PROCESS POLICIES BY TYPE (CALL INDIVIDUAL MODULES)
# ============================================================================

$allResults = @()

# Define module mapping
$moduleMap = @{
    "filters" = "Configure-Intune-Filters.ps1"
    "admx-files" = "Configure-Intune-ADMXFiles.ps1"
    "app-protection" = "Configure-Intune-AppProtection.ps1"
    "compliance-policies" = "Configure-Intune-CompliancePolicies.ps1"
    "device-configurations" = "Configure-Intune-DeviceConfigurations.ps1"
    "settings-catalog" = "Configure-Intune-SettingsCatalog.ps1"
    "endpoint-security" = "Configure-Intune-EndpointSecurity.ps1"
    "platform-scripts-powershell" = "Configure-Intune-PlatformScripts.ps1"
    "platform-scripts-bash"       = "Configure-Intune-PlatformScripts.ps1"
    "autopilot" = "Configure-Intune-Autopilot.ps1"
    "mobile-apps" = "Configure-Intune-MobileApps.ps1"
    "windows-updates" = "Configure-Intune-WindowsUpdates.ps1"
    "windows-feature-updates" = "Configure-Intune-WindowsUpdates.ps1"
    "windows-quality-updates" = "Configure-Intune-WindowsUpdates.ps1"
    "windows-driver-updates" = "Configure-Intune-WindowsUpdates.ps1"
    "group-policy-configurations" = "Configure-Intune-GroupPolicyConfigurations.ps1"
}

# Helper: invoke a single policy-type module and collect results
function Invoke-PolicyModule {
    param(
        [string]$PolicyType,
        [object[]]$TypePolicies
    )
    $moduleName = $moduleMap[$PolicyType]
    if (-not $moduleName) {
        Write-Host "##[warning]No module found for policy type: $PolicyType"
        return @()
    }
    $modulePath = Join-Path $modulesPath $moduleName
    if (-not (Test-Path $modulePath)) {
        Write-Host "##[warning]Module not found: $modulePath"
        return @()
    }
    try {
        if ($PolicyType -eq 'admx-files') {
            return & $modulePath -PolicyConfigs $TypePolicies -AllPolicyConfigs $script:AllPolicyConfigsForAdmx -WhatIfMode:$WhatIfPreference
        }
        return & $modulePath -PolicyConfigs $TypePolicies -WhatIfMode:$WhatIfPreference
    }
    catch {
        Write-Host "##[error]Failed to process $PolicyType policies: $_"
        return $TypePolicies | ForEach-Object {
            $dn = if ($_.displayName) { $_.displayName } else { $_.name }
            @{ DisplayName = $dn; PolicyType = $PolicyType; Status = "Failed"; Error = $_.ToString() }
        }
    }
}

# ── Phase 1: deploy filters ───────────────────────────────────────────────────
# Filters must be created before other policies can reference them via
# {{FILTER:...}} placeholders in their assignment files.
if ($filterConfigs.Count -gt 0) {
    Write-Host "`n  [Phase 1] Deploying $($filterConfigs.Count) filter(s)..."
    $allResults += Invoke-PolicyModule -PolicyType "filters" -TypePolicies $filterConfigs

    # Invalidate the placeholder cache so newly created filter IDs are picked up
    # when resolving {{FILTER:...}} placeholders in non-filter policy assignments.
    Clear-PlaceholderCache
    Write-Host "  [Phase 1] Filter placeholder cache cleared - newly created filter IDs are now available"
}

# ── Phase 2: load remaining policy files ─────────────────────────────────────
# Now that filters exist in the tenant, {{FILTER:...}} placeholders in assignment
# files will resolve to real GUIDs.
if ($nonFilterFiles.Count -gt 0) {
    Write-Host "`n  [Phase 2] Loading $($nonFilterFiles.Count) non-filter policy file(s)..."
    $nonFilterLoad = Invoke-LoadPolicyFiles -Files $nonFilterFiles -GroupsPath $groupsPath -AllowMissingPlaceholders $WhatIfPreference
    $policyLoadErrors += $nonFilterLoad.Errors
    $policyConfigs    += @($nonFilterLoad.Configs)
}

Write-Host "Policies to process: $($policyConfigs.Count)"

# ADMX strict-replace coordination (see Configure-Intune-ADMXFiles.ps1 / GPC module).
# Use $global: so flags are visible across &-invoked policy modules in the same run.
$global:AdmxReplacementRequired  = $false
$global:AdmxReplacementSucceeded = $false
$global:AdmxReplacementFailed    = $false
$script:AllPolicyConfigsForAdmx   = @($policyConfigs)

# ── Phase 2: deploy remaining policy types ───────────────────────────────────
# Define processing order (filters already handled above):
#   1. admx-files      - ADMX definition files must be uploaded before group-policy-configurations
#   2. everything else - order within this group is not critical
$processingOrder = @(
    "admx-files",
    "app-protection",
    "compliance-policies",
    "device-configurations",
    "settings-catalog",
    "endpoint-security",
    "platform-scripts-powershell",
    "platform-scripts-bash",
    "autopilot",
    "mobile-apps",
    "windows-updates",
    "windows-feature-updates",
    "windows-quality-updates",
    "windows-driver-updates",
    "group-policy-configurations"
)

foreach ($policyType in $processingOrder) {
    $typePolicies = @($policyConfigs | Where-Object { $_._policyType -eq $policyType })
    if ($typePolicies.Count -eq 0) { continue }
    $allResults += Invoke-PolicyModule -PolicyType $policyType -TypePolicies $typePolicies
}

# ============================================================================
# GENERATE SUMMARY
# ============================================================================

Write-Host "`n##[section]Summary"

# Build a displayName → filePath map from all loaded configs so results can be stamped.
# Settings catalog policies use 'name', other types use 'displayName' — index both.
$intuneFilePathMap = @{}
foreach ($pc in (@($filterConfigs) + @($policyConfigs))) {
    if ($pc._sourcePath) {
        $key = if ($pc.displayName) { $pc.displayName } elseif ($pc.name) { $pc.name } else { $null }
        if ($key) { $intuneFilePathMap[$key] = $pc._sourcePath }
    }
}
# Stamp FilePath on all results
foreach ($r in ($allResults | Where-Object { $_ -ne $null })) {
    if (-not $r['FilePath'] -and $r['DisplayName'] -and $intuneFilePathMap.ContainsKey($r['DisplayName'])) {
        $r['FilePath'] = $intuneFilePathMap[$r['DisplayName']]
    }
}

# Count results - handle both WhatIf and actual deployment statuses
$created = @($allResults | Where-Object { $_.Status -eq "Created" -or $_.Status -eq "WouldCreate" }).Count
$updated = @($allResults | Where-Object { $_.Status -eq "Updated" -or $_.Status -eq "WouldUpdate" }).Count
$failed = @($allResults | Where-Object { $_.Status -eq "Failed" }).Count
$unchanged = @($allResults | Where-Object { $_.Status -eq "No changes" }).Count
$protected = @($allResults | Where-Object { $_.Status -eq "Protected" }).Count
$assignmentsSynced = @($allResults | Where-Object { $_.Status -eq "AssignmentsSynced" -or $_.Status -eq "WouldSyncAssignments" }).Count

$totalPolicies = $filterConfigs.Count + $policyConfigs.Count
Write-Host "Total policies: $totalPolicies"
Write-Host ""

if ($WhatIfPreference) {
    Write-Host "  → Would CREATE: $created"
    Write-Host "  → Would UPDATE: $updated"
    Write-Host "  → Would SYNC assignments only: $assignmentsSynced"
    Write-Host "  ○ No changes: $unchanged"
}
else {
    Write-Host "  ✓ Created: $created"
    Write-Host "  ✓ Updated: $updated"
    if ($assignmentsSynced -gt 0) { Write-Host "  📌 Assignments synced only: $assignmentsSynced" }
    Write-Host "  ○ No changes: $unchanged"
}
if ($protected -gt 0) {
    Write-Host "  ⛔ Protected: $protected"
}
Write-Host "  ✗ Failed: $failed"

if ($failed -gt 0) {
    Write-Host "`nFailed policies:" -ForegroundColor Red
    $allResults | Where-Object { $_.Status -eq "Failed" } | ForEach-Object {
        Write-Host "  ✗ $($_.DisplayName): $($_.Error)" -ForegroundColor Red
    }
}

# ============================================================================
# SAVE RESULTS
# ============================================================================

if ($OutputPath) {
    $summary = @{
        Service = "Intune"
        Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        TenantId = (Get-MgContext).TenantId
        TotalPolicies = $totalPolicies
        WhatIfMode = $WhatIfPreference
        # Use Count suffix for compatibility with pipeline summary
        WouldCreateCount = if ($WhatIfPreference) { $created } else { 0 }
        WouldUpdateCount = if ($WhatIfPreference) { $updated } else { 0 }
        WouldSyncAssignmentsCount = if ($WhatIfPreference) { $assignmentsSynced } else { 0 }
        CreatedCount = if (-not $WhatIfPreference) { $created } else { 0 }
        UpdatedCount = if (-not $WhatIfPreference) { $updated } else { 0 }
        AssignmentsSyncedCount = if (-not $WhatIfPreference) { $assignmentsSynced } else { 0 }
        ErrorCount = $failed
        NoChangeCount = $unchanged
        ProtectedCount = $protected
        Results = $allResults
        LoadErrors = $policyLoadErrors
    }
    
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nPlan summary saved to: $OutputPath"
}

# Exit with error if any policies failed
if ($failed -gt 0) {
    Write-Host "##[error]Some policies failed to process"
    exit 1
}

