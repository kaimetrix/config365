<#
.SYNOPSIS
    Backs up Microsoft Intune configurations

.DESCRIPTION
    This script backs up all Intune configurations including:
    - Device Configurations
    - Compliance Policies
    - Settings Catalog Policies
    - App Protection Policies
    - Windows Update Rings
    - Windows Feature Update Profiles
    - Windows Quality Update Profiles
    - Windows Driver Update Profiles
    - Autopilot Profiles
    - Endpoint Security Policies (Antivirus, Firewall, BitLocker, LAPS, ASR)
    - Platform Scripts
    - Remediations
    - Uploaded ADMX Definition Files (custom ADMX + ADML companion files)
    - Group Policy Configurations (Administrative Templates / Imported Administrative Templates)

    Each category fetches the full item list in one paged call, then exports
    individual items in parallel batches (Invoke-ParallelBatch / ForEach-Object -Parallel).
    This replaces the prior sequential per-item loop and cuts wall time proportionally
    to the number of parallel batches (default ThrottleLimit = 5).

.NOTES
    Group Policy Configurations — presentationValues capture:
      Microsoft Graph rejects $expand paths with depth > 1 (HTTP 400 "MaxExpansionDepth=1"),
      so we CANNOT use ?$expand=definition,presentationValues($expand=presentation).
      In addition, $expand=presentationValues at depth 1 returns an empty array for
      admxIngested policies even when PVs exist (Graph quirk). The portal works around
      this by issuing a SEPARATE GET per definitionValue:
        /groupPolicyConfigurations/{gpc}/definitionValues/{dv}/presentationValues?$expand=presentation
      This script does the same — see the "Group Policy Configurations" region. Do not
      "optimise" it back to the inline $expand without re-probing Graph's behaviour.

.PARAMETER BackupPath
    The base path where backup files will be stored

.PARAMETER ParallelThrottle
    Maximum number of concurrent export batches per section (default: 5).
    Override via env var BACKUP_PARALLEL_JOBS.

.EXAMPLE
    .\Backup-Intune.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,

    [Parameter(Mandatory=$false)]
    [switch]$DebugMode,

    [Parameter(Mandatory=$false)]
    [int]$ParallelThrottle = $(
        if ($env:BACKUP_PARALLEL_JOBS) { [int]$env:BACKUP_PARALLEL_JOBS } else { 5 }
    )
)

# Load common module if not already loaded
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Get-Command "Write-Log" -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

# Initialize if needed
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
    if (-not $connected) { throw "Failed to connect to Microsoft Graph" }
}

if (-not $script:GroupCache -or $script:GroupCache.Count -eq 0) {
    Initialize-GroupCache | Out-Null
}
if (-not $script:NamedLocationCache) {
    $script:NamedLocationCache = @{}
}

Write-Log "=== Starting Intune Backup (ParallelThrottle=$ParallelThrottle) ===" "INFO"

# Results tracking
$results = @{
    AssignmentFilters          = @{ BackedUp = 0; Failed = 0 }
    DeviceConfigurations       = @{ BackedUp = 0; Failed = 0 }
    CompliancePolicies         = @{ BackedUp = 0; Failed = 0 }
    SettingsCatalog            = @{ BackedUp = 0; Failed = 0 }
    AppProtection              = @{ BackedUp = 0; Failed = 0 }
    WindowsUpdates             = @{ BackedUp = 0; Failed = 0 }
    FeatureUpdates             = @{ BackedUp = 0; Failed = 0 }
    QualityUpdates             = @{ BackedUp = 0; Failed = 0 }
    DriverUpdates              = @{ BackedUp = 0; Failed = 0 }
    Autopilot                  = @{ BackedUp = 0; Failed = 0 }
    EndpointSecurity           = @{ BackedUp = 0; Failed = 0 }
    PlatformScripts            = @{ BackedUp = 0; Failed = 0 }
    Remediations               = @{ BackedUp = 0; Failed = 0 }
    MobileApps                 = @{ BackedUp = 0; Failed = 0 }
    ADMXFiles                  = @{ BackedUp = 0; Failed = 0 }
    GroupPolicyConfigurations  = @{ BackedUp = 0; Failed = 0 }
}

# Cache for filters (needed for placeholder conversion in assignments)
$script:FilterCache = @{}

# ---------------------------------------------------------------------------
# Helper: aggregate parallel batch results into the $results hashtable
# ---------------------------------------------------------------------------
function Add-BatchResults {
    param(
        [object[]]$BatchOutput,
        [hashtable]$Target,    # e.g. $results.DeviceConfigurations

        # When provided, failed items are protected against looking like a
        # deletion in git (see Add-BackupItemFailure in Backup-Common.ps1):
        # the file(s) each failed item would have written are computed as
        # "<OutputFolder>/<FileNamePrefix><Get-SafeFileName Name>.<ext>" for
        # every entry in $Extensions, and reported so the pipeline can
        # restore them from the previous commit if they're now missing.
        [Parameter(Mandatory=$false)]
        [string]$OutputFolder,

        [Parameter(Mandatory=$false)]
        [string]$FileNamePrefix = "",

        [Parameter(Mandatory=$false)]
        [string[]]$Extensions = @('.json', '.assignment.json')
    )
    $succeeded = @($BatchOutput | Where-Object { $_ -and $_.Success })
    $failed    = @($BatchOutput | Where-Object { $_ -and -not $_.Success })
    $Target.BackedUp += $succeeded.Count
    $Target.Failed   += $failed.Count
    foreach ($f in $failed) {
        Write-Log "  Failed: $($f.Name) — $($f.Error)" "WARN"
        if ($OutputFolder -and $f.Name) {
            # Prefer an explicit FileName from the failure object (needed when it can't be
            # derived purely from Get-SafeFileName(Name) — e.g. ADMX files keyed by fileName
            # rather than displayName). Falls back to recomputing it the normal way.
            $itemFileName = if ($f.PSObject.Properties['FileName'] -and $f.FileName) { $f.FileName } else { "$FileNamePrefix$(Get-SafeFileName -Name $f.Name)" }
            foreach ($ext in $Extensions) {
                Add-BackupItemFailure -RelativePath "$OutputFolder/$itemFileName$ext" -Reason "$($f.Error)"
            }
        }
    }
}

#region Assignment Filters
# Runs sequentially first: the full list already contains all needed data
# AND it populates $script:FilterCache which is then passed to all parallel batches.
try {
    Write-Log "Backing up Assignment Filters..." "INFO"

    $filters = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/assignmentFilters" -Description "assignment filters"

    Write-Log "Found $($filters.Count) assignment filters" "INFO"

    foreach ($filter in $filters) {
        try {
            $fileName = Get-SafeFileName -Name $filter.displayName

            # Cache the filter for later placeholder conversion
            $script:FilterCache[$filter.id] = $filter.displayName

            Save-BackupFile -Content $filter -RelativePath "intune/filters/$fileName.json"

            $results.AssignmentFilters.BackedUp++
            Write-Log "Saved assignment filter: $($filter.displayName)" "DEBUG"
        }
        catch {
            $results.AssignmentFilters.Failed++
            Write-Log "Failed to backup assignment filter '$($filter.displayName)': $_" "WARN"
            $failedFileName = if ($fileName) { $fileName } else { Get-SafeFileName -Name $filter.displayName }
            Add-BackupItemFailure -RelativePath "intune/filters/$failedFileName.json" -Reason "$_"
        }
    }

    Write-Log "Assignment Filters: $($results.AssignmentFilters.BackedUp) backed up, $($results.AssignmentFilters.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Assignment Filters: $_" "ERROR"
}
#endregion

# ---------------------------------------------------------------------------
# Common shared state snapshot — built after Assignment Filters so that
# FilterCache is fully populated before being passed to parallel batches.
# Every section's Process block starts by restoring these into $script: vars.
# ---------------------------------------------------------------------------
$SharedVars = @{
    ScriptDir           = $scriptDir
    BackupPath          = $script:BackupPath
    DebugMode           = [bool]$script:DebugMode
    TenantId            = "$script:CurrentTenantId"
    LogFile             = "$script:LogFile"
    GroupCache          = $script:GroupCache.Clone()
    FilterCache         = $script:FilterCache.Clone()
    NamedLocationCache  = $script:NamedLocationCache.Clone()
}

# ---------------------------------------------------------------------------
# Reusable preamble snippet used inside every Process script block.
# Restores $script: state and authenticates to Graph (one call per batch).
# ---------------------------------------------------------------------------
$BatchPreamble = {
    $sv = $using:SharedVars
    . "$($sv.ScriptDir)\Backup-Common.ps1"
    $script:BackupPath         = $sv.BackupPath
    $script:DebugMode          = $sv.DebugMode
    $script:CurrentTenantId    = $sv.TenantId
    $script:LogFile            = $sv.LogFile
    $script:GroupCache         = $sv.GroupCache
    $script:FilterCache        = $sv.FilterCache
    $script:NamedLocationCache = $sv.NamedLocationCache
    Connect-M365Backup | Out-Null
}

#region Device Configurations
try {
    Write-Log "Backing up Device Configurations..." "INFO"

    $configs = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations" -Description "device configurations"
    Write-Log "Found $($configs.Count) device configurations" "INFO"

    $batchOut = Invoke-ParallelBatch -Items @($configs) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($config in $batch) {
            try {
                $fileName   = Get-SafeFileName -Name $config.displayName
                $fullConfig = Invoke-GraphRequestWithDebug -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$($config.id)" -Method GET

                if ($fullConfig.'@odata.type' -eq '#microsoft.graph.windows10CustomConfiguration' -and $fullConfig.omaSettings) {
                    $omaSettings = @($fullConfig.omaSettings)
                    foreach ($setting in $omaSettings) {
                        if ($setting.isEncrypted -eq $true -and $setting.secretReferenceValueId) {
                            try {
                                $ptUri = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$($config.id)/getOmaSettingPlainTextValue(secretReferenceValueId='$($setting.secretReferenceValueId)')"
                                $ptResp = Invoke-GraphRequestWithDebug -Uri $ptUri -Method GET
                                if ($ptResp -and $ptResp.value) {
                                    $setting.value = $ptResp.value
                                    $setting.PSObject.Properties.Remove('isEncrypted')
                                    $setting.PSObject.Properties.Remove('secretReferenceValueId')
                                    Write-Log "  Decrypted OMA setting: $($setting.displayName)" "DEBUG"
                                }
                            }
                            catch { Write-Log "  Could not decrypt OMA setting '$($setting.displayName)': $_" "WARN" }
                        }
                    }
                }

                Save-PolicyWithAssignments -Policy $fullConfig `
                    -OutputFolder "intune/device-configurations" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$($config.id)/assignments" `
                    -PolicyType "device configuration"

                Write-Log "Saved device configuration: $($config.displayName)" "DEBUG"
                [PSCustomObject]@{ Success = $true; Name = $config.displayName }
            }
            catch {
                Write-Log "Failed to backup device configuration '$($config.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $config.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.DeviceConfigurations -OutputFolder "intune/device-configurations"
    Write-Log "Device Configurations: $($results.DeviceConfigurations.BackedUp) backed up, $($results.DeviceConfigurations.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Device Configurations: $_" "ERROR"
}
#endregion

#region Compliance Policies
try {
    Write-Log "Backing up Compliance Policies..." "INFO"

    $policies = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies" -Description "compliance policies"
    Write-Log "Found $($policies.Count) compliance policies" "INFO"

    $batchOut = Invoke-ParallelBatch -Items @($policies) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($policy in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $policy.displayName
                Save-PolicyWithAssignments -Policy $policy `
                    -OutputFolder "intune/compliance-policies" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies/$($policy.id)/assignments" `
                    -PolicyType "compliance policy"
                Write-Log "Saved compliance policy: $($policy.displayName)" "DEBUG"
                [PSCustomObject]@{ Success = $true; Name = $policy.displayName }
            }
            catch {
                Write-Log "Failed to backup compliance policy '$($policy.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $policy.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.CompliancePolicies -OutputFolder "intune/compliance-policies"
    Write-Log "Compliance Policies: $($results.CompliancePolicies.BackedUp) backed up, $($results.CompliancePolicies.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Compliance Policies: $_" "ERROR"
}
#endregion

#region Settings Catalog Policies
try {
    Write-Log "Backing up Settings Catalog Policies..." "INFO"

    $policies = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies" -Description "settings catalog policies"
    Write-Log "Found $($policies.Count) Settings Catalog policies" "INFO"

    if ($script:DebugMode) {
        Write-Log "=== All Settings Catalog Policies ===" "DEBUG"
        $idx = 0
        foreach ($p in $policies) {
            $pName = if ($p.name) { $p.name } else { $p.displayName }
            Write-Log "  [$idx] $pName (ID: $($p.id))" "DEBUG"
            $idx++
        }
        Write-Log "=== End of List ===" "DEBUG"
    }

    # Preserve for any downstream consumers
    $script:AllConfigurationPolicies = $policies

    $batchOut = Invoke-ParallelBatch -Items @($policies) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($policy in $batch) {
            try {
                $policyName = if ($policy.name) { $policy.name } else { $policy.displayName }
                $fileName   = Get-SafeFileName -Name $policyName
                Write-Log "Processing Settings Catalog: $policyName" "DEBUG"

                $fullPolicy = Invoke-GraphRequestWithDebug -Uri "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/$($policy.id)" -Method GET
                $settings   = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/$($policy.id)/settings" -Description "settings"
                if ($fullPolicy -is [hashtable]) { $fullPolicy['settings'] = $settings }
                else { $fullPolicy | Add-Member -NotePropertyName "settings" -NotePropertyValue $settings -Force }

                Save-PolicyWithAssignments -Policy $fullPolicy `
                    -OutputFolder "intune/settings-catalog" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/$($policy.id)/assignments" `
                    -PolicyType "settings catalog policy"

                Write-Log "Saved Settings Catalog policy: $policyName" "DEBUG"
                [PSCustomObject]@{ Success = $true; Name = $policyName }
            }
            catch {
                $pName = if ($policy.name) { $policy.name } else { $policy.displayName }
                Write-Log "Failed to backup Settings Catalog policy '$pName': $_" "ERROR"
                [PSCustomObject]@{ Success = $false; Name = $pName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.SettingsCatalog -OutputFolder "intune/settings-catalog"
    Write-Log "Settings Catalog: $($results.SettingsCatalog.BackedUp) backed up, $($results.SettingsCatalog.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Settings Catalog Policies: $_" "ERROR"
}
#endregion

#region App Protection Policies
try {
    Write-Log "Backing up App Protection Policies..." "INFO"

    # iOS App Protection
    try {
        $iosPolicies = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections" -Description "iOS app protection policies"
        $batchOut = Invoke-ParallelBatch -Items @($iosPolicies) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
            $batch = $_
            $sv = $using:SharedVars
            . "$($sv.ScriptDir)\Backup-Common.ps1"
            $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
            $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
            $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
            $script:NamedLocationCache = $sv.NamedLocationCache
            Connect-M365Backup | Out-Null

            foreach ($policy in $batch) {
                try {
                    $appList = @()
                    try {
                        $appList = @(Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections/$($policy.id)/apps" -Description "iOS app protection apps for '$($policy.displayName)'")
                    }
                    catch { Write-Log "Could not retrieve apps for iOS app protection '$($policy.displayName)': $_" "DEBUG" }

                    if ($policy -is [hashtable]) { $policy['apps'] = $appList }
                    else { $policy | Add-Member -NotePropertyName 'apps' -NotePropertyValue $appList -Force }

                    if ($policy.appGroupType -eq 'selectedPublicApps' -and $appList.Count -eq 0) {
                        Write-Log "iOS app protection '$($policy.displayName)' is selectedPublicApps but apps list is empty — check permissions or API" "WARN"
                    }

                    $fileName = "iOS_$(Get-SafeFileName -Name $policy.displayName)"
                    Save-PolicyWithAssignments -Policy $policy `
                        -OutputFolder "intune/app-protection" -FileName $fileName `
                        -AssignmentsUri "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections/$($policy.id)/assignments" `
                        -PolicyType "iOS app protection"

                    [PSCustomObject]@{ Success = $true; Name = $policy.displayName }
                }
                catch {
                    Write-Log "Failed to backup iOS app protection '$($policy.displayName)': $_" "WARN"
                    [PSCustomObject]@{ Success = $false; Name = $policy.displayName; Error = "$_" }
                }
            }
        }
        Add-BatchResults -BatchOutput @($batchOut) -Target $results.AppProtection -OutputFolder "intune/app-protection" -FileNamePrefix "iOS_"
    }
    catch { Write-Log "Failed to get iOS App Protection policies: $_" "WARN" }

    # Android App Protection
    try {
        $androidPolicies = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections" -Description "Android app protection policies"
        $batchOut = Invoke-ParallelBatch -Items @($androidPolicies) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
            $batch = $_
            $sv = $using:SharedVars
            . "$($sv.ScriptDir)\Backup-Common.ps1"
            $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
            $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
            $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
            $script:NamedLocationCache = $sv.NamedLocationCache
            Connect-M365Backup | Out-Null

            foreach ($policy in $batch) {
                try {
                    $appList = @()
                    try {
                        $appList = @(Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections/$($policy.id)/apps" -Description "Android app protection apps for '$($policy.displayName)'")
                    }
                    catch { Write-Log "Could not retrieve apps for Android app protection '$($policy.displayName)': $_" "DEBUG" }

                    if ($policy -is [hashtable]) { $policy['apps'] = $appList }
                    else { $policy | Add-Member -NotePropertyName 'apps' -NotePropertyValue $appList -Force }

                    if ($policy.appGroupType -eq 'selectedPublicApps' -and $appList.Count -eq 0) {
                        Write-Log "Android app protection '$($policy.displayName)' is selectedPublicApps but apps list is empty — check permissions or API" "WARN"
                    }

                    $fileName = "Android_$(Get-SafeFileName -Name $policy.displayName)"
                    Save-PolicyWithAssignments -Policy $policy `
                        -OutputFolder "intune/app-protection" -FileName $fileName `
                        -AssignmentsUri "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections/$($policy.id)/assignments" `
                        -PolicyType "Android app protection"

                    [PSCustomObject]@{ Success = $true; Name = $policy.displayName }
                }
                catch {
                    Write-Log "Failed to backup Android app protection '$($policy.displayName)': $_" "WARN"
                    [PSCustomObject]@{ Success = $false; Name = $policy.displayName; Error = "$_" }
                }
            }
        }
        Add-BatchResults -BatchOutput @($batchOut) -Target $results.AppProtection -OutputFolder "intune/app-protection" -FileNamePrefix "Android_"
    }
    catch { Write-Log "Failed to get Android App Protection policies: $_" "WARN" }

    # Windows App Protection (list response has full data, no per-item GET needed)
    try {
        $windowsPolicies = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/windowsInformationProtectionPolicies" -Description "Windows app protection policies"
        $batchOut = Invoke-ParallelBatch -Items @($windowsPolicies) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
            $batch = $_
            $sv = $using:SharedVars
            . "$($sv.ScriptDir)\Backup-Common.ps1"
            $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
            $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
            $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
            $script:NamedLocationCache = $sv.NamedLocationCache
            Connect-M365Backup | Out-Null

            foreach ($policy in $batch) {
                try {
                    $fileName = "Windows_$(Get-SafeFileName -Name $policy.displayName)"
                    Save-BackupFile -Content $policy -RelativePath "intune/app-protection/$fileName.json"
                    [PSCustomObject]@{ Success = $true; Name = $policy.displayName }
                }
                catch {
                    Write-Log "Failed to backup Windows app protection '$($policy.displayName)': $_" "WARN"
                    [PSCustomObject]@{ Success = $false; Name = $policy.displayName; Error = "$_" }
                }
            }
        }
        Add-BatchResults -BatchOutput @($batchOut) -Target $results.AppProtection -OutputFolder "intune/app-protection" -FileNamePrefix "Windows_" -Extensions @('.json')
    }
    catch { Write-Log "Failed to get Windows App Protection policies: $_" "WARN" }

    Write-Log "App Protection: $($results.AppProtection.BackedUp) backed up, $($results.AppProtection.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup App Protection Policies: $_" "ERROR"
}
#endregion

#region Windows Update Rings
try {
    Write-Log "Backing up Windows Update Rings..." "INFO"

    $updateRings = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations?`$filter=isof('microsoft.graph.windowsUpdateForBusinessConfiguration')" -Description "Windows Update rings"

    $batchOut = Invoke-ParallelBatch -Items @($updateRings) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($ring in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $ring.displayName
                Save-PolicyWithAssignments -Policy $ring `
                    -OutputFolder "intune/windows-updates" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$($ring.id)/assignments" `
                    -PolicyType "Windows Update ring"
                [PSCustomObject]@{ Success = $true; Name = $ring.displayName }
            }
            catch {
                Write-Log "Failed to backup Windows Update ring '$($ring.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $ring.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.WindowsUpdates -OutputFolder "intune/windows-updates"
    Write-Log "Windows Update Rings: $($results.WindowsUpdates.BackedUp) backed up, $($results.WindowsUpdates.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Windows Update Rings: $_" "ERROR"
}
#endregion

#region Windows Feature Update Profiles
try {
    Write-Log "Backing up Windows Feature Update Profiles..." "INFO"

    # Note: This endpoint has a max $top of 200 (not 999)
    $featureUpdates = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles" -Description "Windows Feature Update profiles" -PageSize 200
    Write-Log "Found $($featureUpdates.Count) Windows Feature Update profiles" "INFO"

    $batchOut = Invoke-ParallelBatch -Items @($featureUpdates) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($profile in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $profile.displayName
                Save-PolicyWithAssignments -Policy $profile `
                    -OutputFolder "intune/windows-feature-updates" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles/$($profile.id)/assignments" `
                    -PolicyType "Windows Feature Update profile"
                [PSCustomObject]@{ Success = $true; Name = $profile.displayName }
            }
            catch {
                Write-Log "Failed to backup Windows Feature Update profile '$($profile.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $profile.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.FeatureUpdates -OutputFolder "intune/windows-feature-updates"
    Write-Log "Windows Feature Updates: $($results.FeatureUpdates.BackedUp) backed up, $($results.FeatureUpdates.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Windows Feature Update Profiles: $_" "ERROR"
}
#endregion

#region Windows Quality Update Profiles
try {
    Write-Log "Backing up Windows Quality Update Profiles..." "INFO"

    # Note: This endpoint has a max $top of 200 (not 999)
    $qualityUpdates = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/windowsQualityUpdateProfiles" -Description "Windows Quality Update profiles" -PageSize 200
    Write-Log "Found $($qualityUpdates.Count) Windows Quality Update profiles" "INFO"

    $batchOut = Invoke-ParallelBatch -Items @($qualityUpdates) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($profile in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $profile.displayName
                Save-PolicyWithAssignments -Policy $profile `
                    -OutputFolder "intune/windows-quality-updates" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/windowsQualityUpdateProfiles/$($profile.id)/assignments" `
                    -PolicyType "Windows Quality Update profile"
                [PSCustomObject]@{ Success = $true; Name = $profile.displayName }
            }
            catch {
                Write-Log "Failed to backup Windows Quality Update profile '$($profile.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $profile.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.QualityUpdates -OutputFolder "intune/windows-quality-updates"
    Write-Log "Windows Quality Updates: $($results.QualityUpdates.BackedUp) backed up, $($results.QualityUpdates.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Windows Quality Update Profiles: $_" "ERROR"
}
#endregion

#region Windows Driver Update Profiles
try {
    Write-Log "Backing up Windows Driver Update Profiles..." "INFO"

    # Note: This endpoint has a max $top of 200 (not 999)
    $driverUpdates = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/windowsDriverUpdateProfiles" -Description "Windows Driver Update profiles" -PageSize 200
    Write-Log "Found $($driverUpdates.Count) Windows Driver Update profiles" "INFO"

    $batchOut = Invoke-ParallelBatch -Items @($driverUpdates) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($profile in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $profile.displayName
                Save-PolicyWithAssignments -Policy $profile `
                    -OutputFolder "intune/windows-driver-updates" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/windowsDriverUpdateProfiles/$($profile.id)/assignments" `
                    -PolicyType "Windows Driver Update profile"
                [PSCustomObject]@{ Success = $true; Name = $profile.displayName }
            }
            catch {
                Write-Log "Failed to backup Windows Driver Update profile '$($profile.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $profile.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.DriverUpdates -OutputFolder "intune/windows-driver-updates"
    Write-Log "Windows Driver Updates: $($results.DriverUpdates.BackedUp) backed up, $($results.DriverUpdates.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Windows Driver Update Profiles: $_" "ERROR"
}
#endregion

#region Autopilot Profiles
try {
    Write-Log "Backing up Autopilot Profiles..." "INFO"

    $profiles = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles" -Description "Autopilot profiles"

    $batchOut = Invoke-ParallelBatch -Items @($profiles) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($profile in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $profile.displayName
                Save-PolicyWithAssignments -Policy $profile `
                    -OutputFolder "intune/autopilot" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles/$($profile.id)/assignments" `
                    -PolicyType "Autopilot profile"
                [PSCustomObject]@{ Success = $true; Name = $profile.displayName }
            }
            catch {
                Write-Log "Failed to backup Autopilot profile '$($profile.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $profile.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.Autopilot -OutputFolder "intune/autopilot"
    Write-Log "Autopilot: $($results.Autopilot.BackedUp) backed up, $($results.Autopilot.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Autopilot Profiles: $_" "ERROR"
}
#endregion

#region Endpoint Security Policies (Intents-based)
try {
    Write-Log "Backing up Endpoint Security Policies..." "INFO"

    # Fetch template names first (sequential, lightweight)
    $templates = @{}
    try {
        $allTemplates = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/templates" -Description "endpoint security templates"
        foreach ($t in $allTemplates) { $templates[$t.id] = $t.displayName }
        Write-Log "Found $($templates.Count) endpoint security templates" "DEBUG"
    }
    catch { Write-Log "Could not retrieve templates: $_" "WARN" }

    $intents = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/intents" -Description "endpoint security policies"
    Write-Log "Found $($intents.Count) endpoint security policies" "INFO"

    # Templates dict passed alongside SharedVars
    $epSharedVars = $SharedVars.Clone()
    $epSharedVars['Templates'] = $templates

    $batchOut = Invoke-ParallelBatch -Items @($intents) -ThrottleLimit $ParallelThrottle -SharedVars $epSharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        $localTemplates = $sv.Templates
        Connect-M365Backup | Out-Null

        foreach ($intent in $batch) {
            try {
                $fileName     = Get-SafeFileName -Name $intent.displayName
                $templateName = if ($localTemplates.ContainsKey($intent.templateId)) { $localTemplates[$intent.templateId] } else { "Unknown" }

                $settings = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/intents/$($intent.id)/settings" -Description "settings"
                if ($intent -is [hashtable]) { $intent['settings'] = $settings; $intent['templateName'] = $templateName }
                else {
                    $intent | Add-Member -NotePropertyName "settings"     -NotePropertyValue $settings     -Force
                    $intent | Add-Member -NotePropertyName "templateName" -NotePropertyValue $templateName -Force
                }

                Save-PolicyWithAssignments -Policy $intent `
                    -OutputFolder "intune/endpoint-security" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/intents/$($intent.id)/assignments" `
                    -PolicyType "endpoint security policy"

                Write-Log "Saved endpoint security: $($intent.displayName) (Template: $templateName)" "DEBUG"
                [PSCustomObject]@{ Success = $true; Name = $intent.displayName }
            }
            catch {
                Write-Log "Failed to backup endpoint security '$($intent.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $intent.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.EndpointSecurity -OutputFolder "intune/endpoint-security"
    Write-Log "Endpoint Security: $($results.EndpointSecurity.BackedUp) backed up, $($results.EndpointSecurity.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Endpoint Security Policies: $_" "ERROR"
}
#endregion

#region Platform Scripts
try {
    Write-Log "Backing up Platform Scripts..." "INFO"

    # PowerShell Scripts
    try {
        $psScripts = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts" -Description "PowerShell scripts"

        $batchOut = Invoke-ParallelBatch -Items @($psScripts) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
            $batch = $_
            $sv = $using:SharedVars
            . "$($sv.ScriptDir)\Backup-Common.ps1"
            $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
            $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
            $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
            $script:NamedLocationCache = $sv.NamedLocationCache
            Connect-M365Backup | Out-Null

            foreach ($psScript in $batch) {
                try {
                    $fileName   = Get-SafeFileName -Name $psScript.displayName
                    $fullScript = Invoke-GraphRequestWithDebug -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts/$($psScript.id)" -Method GET

                    if ($fullScript.scriptContent) {
                        $scriptBytes    = [System.Convert]::FromBase64String($fullScript.scriptContent)
                        $scriptText     = [System.Text.Encoding]::UTF8.GetString($scriptBytes)
                        $scriptFilePath = Join-Path $script:BackupPath "intune/platform-scripts-powershell/$fileName.ps1"
                        $dir = Split-Path $scriptFilePath -Parent
                        if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
                        [System.IO.File]::WriteAllText($scriptFilePath, $scriptText, [System.Text.Encoding]::UTF8)
                        if ($fullScript -is [hashtable]) { $fullScript.Remove('scriptContent') }
                        else { $fullScript.PSObject.Properties.Remove('scriptContent') }
                        Write-Log "Saved script content: $fileName.ps1" "DEBUG"
                    }

                    Save-PolicyWithAssignments -Policy $fullScript `
                        -OutputFolder "intune/platform-scripts-powershell" -FileName $fileName `
                        -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts/$($psScript.id)/assignments" `
                        -PolicyType "PowerShell script"

                    [PSCustomObject]@{ Success = $true; Name = $psScript.displayName }
                }
                catch {
                    Write-Log "Failed to backup PowerShell script '$($psScript.displayName)': $_" "WARN"
                    [PSCustomObject]@{ Success = $false; Name = $psScript.displayName; Error = "$_" }
                }
            }
        }
        Add-BatchResults -BatchOutput @($batchOut) -Target $results.PlatformScripts -OutputFolder "intune/platform-scripts-powershell" -Extensions @('.json', '.assignment.json', '.ps1')
    }
    catch { Write-Log "Failed to get PowerShell scripts (may require DeviceManagementScripts.Read.All): $_" "WARN" }

    # Shell Scripts (macOS/Linux)
    try {
        $shellScripts = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts" -Description "Shell scripts"

        $batchOut = Invoke-ParallelBatch -Items @($shellScripts) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
            $batch = $_
            $sv = $using:SharedVars
            . "$($sv.ScriptDir)\Backup-Common.ps1"
            $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
            $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
            $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
            $script:NamedLocationCache = $sv.NamedLocationCache
            Connect-M365Backup | Out-Null

            foreach ($shellScript in $batch) {
                try {
                    $fileName   = Get-SafeFileName -Name $shellScript.displayName
                    $fullScript = Invoke-GraphRequestWithDebug -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts/$($shellScript.id)" -Method GET

                    if ($fullScript.scriptContent) {
                        $scriptBytes    = [System.Convert]::FromBase64String($fullScript.scriptContent)
                        $scriptText     = [System.Text.Encoding]::UTF8.GetString($scriptBytes)
                        $scriptFilePath = Join-Path $script:BackupPath "intune/platform-scripts-bash/$fileName.sh"
                        $dir = Split-Path $scriptFilePath -Parent
                        if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
                        [System.IO.File]::WriteAllText($scriptFilePath, $scriptText, [System.Text.Encoding]::UTF8)
                        if ($fullScript -is [hashtable]) { $fullScript.Remove('scriptContent') }
                        else { $fullScript.PSObject.Properties.Remove('scriptContent') }
                        Write-Log "Saved script content: $fileName.sh" "DEBUG"
                    }

                    Save-PolicyWithAssignments -Policy $fullScript `
                        -OutputFolder "intune/platform-scripts-bash" -FileName $fileName `
                        -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts/$($shellScript.id)/groupAssignments" `
                        -PolicyType "Shell script"

                    [PSCustomObject]@{ Success = $true; Name = $shellScript.displayName }
                }
                catch {
                    Write-Log "Failed to backup Shell script '$($shellScript.displayName)': $_" "WARN"
                    [PSCustomObject]@{ Success = $false; Name = $shellScript.displayName; Error = "$_" }
                }
            }
        }
        Add-BatchResults -BatchOutput @($batchOut) -Target $results.PlatformScripts -OutputFolder "intune/platform-scripts-bash" -Extensions @('.json', '.assignment.json', '.sh')
    }
    catch { Write-Log "Failed to get Shell scripts: $_" "WARN" }

    Write-Log "Platform Scripts: $($results.PlatformScripts.BackedUp) backed up, $($results.PlatformScripts.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Platform Scripts: $_" "ERROR"
}
#endregion

#region Remediations (Proactive Remediations)
try {
    Write-Log "Backing up Remediations..." "INFO"

    $remediations = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts" -Description "remediations"

    $batchOut = Invoke-ParallelBatch -Items @($remediations) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($remediation in $batch) {
            try {
                $fileName        = Get-SafeFileName -Name $remediation.displayName
                $fullRemediation = Invoke-GraphRequestWithDebug -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts/$($remediation.id)" -Method GET

                if ($fullRemediation.detectionScriptContent) {
                    $detectionBytes = [System.Convert]::FromBase64String($fullRemediation.detectionScriptContent)
                    $detectionText  = [System.Text.Encoding]::UTF8.GetString($detectionBytes)
                    $detectionPath  = Join-Path $script:BackupPath "intune/remediations/$fileName.detection.ps1"
                    $dir = Split-Path $detectionPath -Parent
                    if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
                    [System.IO.File]::WriteAllText($detectionPath, $detectionText, [System.Text.Encoding]::UTF8)
                    if ($fullRemediation -is [hashtable]) { $fullRemediation.Remove('detectionScriptContent') }
                    else { $fullRemediation.PSObject.Properties.Remove('detectionScriptContent') }
                    Write-Log "Saved detection script: $fileName.detection.ps1" "DEBUG"
                }

                if ($fullRemediation.remediationScriptContent) {
                    $remediationBytes = [System.Convert]::FromBase64String($fullRemediation.remediationScriptContent)
                    $remediationText  = [System.Text.Encoding]::UTF8.GetString($remediationBytes)
                    $remediationPath  = Join-Path $script:BackupPath "intune/remediations/$fileName.remediation.ps1"
                    $dir = Split-Path $remediationPath -Parent
                    if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
                    [System.IO.File]::WriteAllText($remediationPath, $remediationText, [System.Text.Encoding]::UTF8)
                    if ($fullRemediation -is [hashtable]) { $fullRemediation.Remove('remediationScriptContent') }
                    else { $fullRemediation.PSObject.Properties.Remove('remediationScriptContent') }
                    Write-Log "Saved remediation script: $fileName.remediation.ps1" "DEBUG"
                }

                Save-PolicyWithAssignments -Policy $fullRemediation `
                    -OutputFolder "intune/remediations" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts/$($remediation.id)/assignments" `
                    -PolicyType "remediation"

                [PSCustomObject]@{ Success = $true; Name = $remediation.displayName }
            }
            catch {
                Write-Log "Failed to backup remediation '$($remediation.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $remediation.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.Remediations -OutputFolder "intune/remediations" -Extensions @('.json', '.assignment.json', '.detection.ps1', '.remediation.ps1')
    Write-Log "Remediations: $($results.Remediations.BackedUp) backed up, $($results.Remediations.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Remediations (may require DeviceManagementScripts.Read.All): $_" "WARN"
}
#endregion

#region Mobile Apps
try {
    Write-Log "Backing up Mobile Apps..." "INFO"

    $supportedTypes = @(
        '#microsoft.graph.winGetApp',
        '#microsoft.graph.iosStoreApp',
        '#microsoft.graph.androidManagedStoreApp',
        '#microsoft.graph.webApp',
        '#microsoft.graph.officeSuiteApp',
        '#microsoft.graph.macOSOfficeSuiteApp',
        '#microsoft.graph.macOSMicrosoftDefenderApp',
        '#microsoft.graph.iosVppApp',
        '#microsoft.graph.androidManagedStoreWebApp'
    )

    $allApps = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps" -Description "mobile apps"
    Write-Log "Found $($allApps.Count) total mobile apps" "INFO"

    $apps = $allApps | Where-Object { $supportedTypes -contains $_.'@odata.type' }
    Write-Log "Found $($apps.Count) supported mobile apps (excluding MSI and LOB apps)" "INFO"

    $batchOut = Invoke-ParallelBatch -Items @($apps) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($app in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $app.displayName
                $fullApp  = Invoke-GraphRequestWithDebug -Uri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$($app.id)" -Method GET

                Save-PolicyWithAssignments -Policy $fullApp `
                    -OutputFolder "intune/mobile-apps" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$($app.id)/assignments" `
                    -PolicyType "mobile app"

                Write-Log "Saved mobile app: $($app.displayName) ($($app.'@odata.type'))" "DEBUG"
                [PSCustomObject]@{ Success = $true; Name = $app.displayName }
            }
            catch {
                Write-Log "Failed to backup mobile app '$($app.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $app.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.MobileApps -OutputFolder "intune/mobile-apps"
    Write-Log "Mobile Apps: $($results.MobileApps.BackedUp) backed up, $($results.MobileApps.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Mobile Apps: $_" "ERROR"
}
#endregion

#region Uploaded ADMX Definition Files
try {
    Write-Log "Backing up Uploaded ADMX Definition Files..." "INFO"

    $admxFiles = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyUploadedDefinitionFiles" -Description "uploaded ADMX definition files"
    Write-Log "Found $($admxFiles.Count) uploaded ADMX definition file(s)" "INFO"

    $batchOut = Invoke-ParallelBatch -Items @($admxFiles) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($admxFile in $batch) {
            try {
                $effectiveName = if ($admxFile.displayName) { $admxFile.displayName }
                                 elseif ($admxFile.fileName) { [System.IO.Path]::GetFileNameWithoutExtension($admxFile.fileName) }
                                 else { $admxFile.id }
                $admxBaseName  = if ($admxFile.fileName) { [System.IO.Path]::GetFileNameWithoutExtension($admxFile.fileName) } else { $effectiveName }
                $fileName      = Get-SafeFileName -Name $effectiveName

                $fullFile = Invoke-GraphRequestWithDebug -Uri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyUploadedDefinitionFiles/$($admxFile.id)" -Method GET

                # Ensure revision is present in backup JSON (tenant API counter, e.g. "1.04" / "1.6").
                # Deploy uses this field for drift detection against local .admx XML revision.
                if (-not $fullFile.revision -and $admxFile.revision) {
                    if ($fullFile -is [hashtable]) { $fullFile['revision'] = $admxFile.revision }
                    else { $fullFile | Add-Member -NotePropertyName revision -NotePropertyValue $admxFile.revision -Force }
                }

                if ($fullFile.content) {
                    try {
                        $admxBytes    = [System.Convert]::FromBase64String($fullFile.content)
                        $admxText     = [System.Text.Encoding]::UTF8.GetString($admxBytes)
                        $admxFilePath = Join-Path $script:BackupPath "intune/admx-files/$admxBaseName.admx"
                        $dir = Split-Path $admxFilePath -Parent
                        if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
                        [System.IO.File]::WriteAllText($admxFilePath, $admxText, [System.Text.Encoding]::UTF8)
                        Write-Log "Saved ADMX content: $admxBaseName.admx" "DEBUG"
                    }
                    catch { Write-Log "  Could not save ADMX content for '$effectiveName': $_" "WARN" }
                }
                else {
                    Write-Log "  ADMX content not available (policyType=$($fullFile.policyType)) — metadata-only backup for: $effectiveName" "DEBUG"
                }

                $langFilesSource = if ($fullFile -is [hashtable]) { $fullFile['groupPolicyUploadedLanguageFiles'] } else { $fullFile.groupPolicyUploadedLanguageFiles }
                if ($langFilesSource) {
                    foreach ($langFile in $langFilesSource) {
                        try {
                            $langFileName = if ($langFile -is [hashtable]) { $langFile['fileName'] } else { $langFile.fileName }
                            if (-not $langFileName) { continue }
                            $admlFilePath = Join-Path $script:BackupPath "intune/admx-files/$langFileName"
                            $admlDir = Split-Path $admlFilePath -Parent
                            if (-not (Test-Path $admlDir)) { New-Item -Path $admlDir -ItemType Directory -Force | Out-Null }
                            $langContent = if ($langFile -is [hashtable]) { $langFile['content'] } else { $langFile.content }
                            if ($langContent) {
                                $admlBytes = [System.Convert]::FromBase64String($langContent)
                                $admlText  = [System.Text.Encoding]::UTF8.GetString($admlBytes)
                                [System.IO.File]::WriteAllText($admlFilePath, $admlText, [System.Text.Encoding]::UTF8)
                                Write-Log "Saved ADML: $langFileName" "DEBUG"
                            }
                        }
                        catch {
                            $lf = if ($langFile -is [hashtable]) { $langFile['fileName'] } else { $langFile.fileName }
                            Write-Log "  Could not save ADML '$lf': $_" "WARN"
                        }
                    }
                }

                if ($fullFile -is [hashtable]) {
                    $fullFile.Remove('content')
                    $fullFile.Remove('groupPolicyUploadedLanguageFiles')
                    if (-not $fullFile['displayName']) { $fullFile['displayName'] = $effectiveName }
                }
                else {
                    if ($fullFile.PSObject.Properties['content'])                          { $fullFile.PSObject.Properties.Remove('content') }
                    if ($fullFile.PSObject.Properties['groupPolicyUploadedLanguageFiles']) { $fullFile.PSObject.Properties.Remove('groupPolicyUploadedLanguageFiles') }
                    if (-not $fullFile.displayName) { $fullFile | Add-Member -NotePropertyName 'displayName' -NotePropertyValue $effectiveName -Force }
                }

                Save-BackupFile -Content $fullFile -RelativePath "intune/admx-files/$fileName.json"
                Write-Log "Saved ADMX definition file: $effectiveName ($($admxFile.policyType))" "DEBUG"
                [PSCustomObject]@{ Success = $true; Name = $effectiveName }
            }
            catch {
                Write-Log "Failed to backup ADMX definition file '$($admxFile.fileName)': $_" "WARN"
                # ADMX backup files are named from the sanitized displayName/fileName (see
                # $fileName above), not from $admxFile.fileName directly — pass it explicitly
                # so Add-BatchResults doesn't have to (mis-)recompute it from Name.
                [PSCustomObject]@{ Success = $false; Name = $admxFile.fileName; FileName = $fileName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.ADMXFiles -OutputFolder "intune/admx-files" -Extensions @('.json')
    Write-Log "ADMX Definition Files: $($results.ADMXFiles.BackedUp) backed up, $($results.ADMXFiles.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Uploaded ADMX Definition Files: $_" "ERROR"
}
#endregion

#region Group Policy Configurations (Administrative Templates)
try {
    Write-Log "Backing up Group Policy Configurations (Administrative Templates)..." "INFO"

    # Build a definitionId → {policyName, admxFileName} lookup from every uploaded ADMX.
    # The Graph API's $expand=definition does not return policyName or definitionFile for
    # admxIngested policies, so we must cross-reference here to produce portable backups
    # that the deploy side can resolve via admxFileName + policyName (strategy 1) rather
    # than falling back to raw GUIDs that are only valid in the originating tenant.
    $admxDefinitionCache = @{}   # key: definitionId (GUID)  value: {policyName, admxFileName}
    try {
        $uploadedFiles = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyUploadedDefinitionFiles" -Description "uploaded ADMX files for GPC enrichment"
        Write-Log "Building ADMX definition lookup from $($uploadedFiles.Count) uploaded file(s)..." "INFO"
        foreach ($uf in $uploadedFiles) {
            if (-not $uf.id -or -not $uf.fileName) { continue }
            try {
                $defs = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyUploadedDefinitionFiles/$($uf.id)/groupPolicyDefinitions" -Description "definitions for '$($uf.fileName)'"
                foreach ($d in $defs) {
                    if ($d.id) {
                        $admxDefinitionCache[$d.id] = @{ policyName = $d.policyName; admxFileName = $uf.fileName }
                    }
                }
                Write-Log "  Cached $($defs.Count) definition(s) from '$($uf.fileName)'" "DEBUG"
            }
            catch {
                Write-Log "  Failed to fetch definitions for '$($uf.fileName)' (id: $($uf.id)) — skipping enrichment for this ADMX: $_" "WARN"
            }
        }
        Write-Log "ADMX definition cache ready: $($admxDefinitionCache.Count) definition(s) total" "INFO"
    }
    catch {
        Write-Log "Failed to build ADMX definition cache — policyName/admxFileName will not be enriched: $_" "WARN"
    }

    $gpConfigs = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations" -Description "group policy configurations"
    Write-Log "Found $($gpConfigs.Count) Group Policy Configuration(s)" "INFO"

    $gpcSharedVars = $SharedVars.Clone()
    $gpcSharedVars['AdmxDefinitionCache'] = $admxDefinitionCache

    $batchOut = Invoke-ParallelBatch -Items @($gpConfigs) -ThrottleLimit $ParallelThrottle -SharedVars $gpcSharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars   # resolved from thread-job's $SharedVars param (receives $gpcSharedVars)
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath = $sv.BackupPath; $script:DebugMode = $sv.DebugMode
        $script:CurrentTenantId = $sv.TenantId; $script:LogFile = $sv.LogFile
        $script:GroupCache = $sv.GroupCache; $script:FilterCache = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        $admxDefCache = $sv.AdmxDefinitionCache  # definitionId → {policyName, admxFileName}

        foreach ($gpConfig in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $gpConfig.displayName

                # CRITICAL: $expand=presentationValues at depth 1 returns empty arrays for
                # admxIngested policies (Graph quirk), and $expand=presentationValues($expand=presentation)
                # is rejected by Graph with HTTP 400 "MaxExpansionDepth=1". The portal works around this
                # by listing definitionValues with $expand=definition only, then making a SEPARATE GET to
                # /definitionValues/{dvId}/presentationValues?$expand=presentation for each. We mirror
                # that pattern below — the per-DV fetch is the only way to retrieve real PV data.
                $definitionValues = Get-AllGraphResults `
                    -Uri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations/$($gpConfig.id)/definitionValues?`$expand=definition" `
                    -Description "definition values for '$($gpConfig.displayName)'"

                $enrichedValues = @()
                foreach ($dv in $definitionValues) {
                    $def = $dv.definition

                    $defId          = if ($def -is [hashtable]) { $def['id']          } else { $def.id          }
                    $defPolicyName  = if ($def -is [hashtable]) { $def['policyName']  } else { $def.policyName  }
                    $defClassType   = if ($def -is [hashtable]) { $def['classType']   } else { $def.classType   }
                    $defCatPath     = if ($def -is [hashtable]) { $def['categoryPath']} else { $def.categoryPath}
                    $defDisplayName = if ($def -is [hashtable]) { $def['displayName'] } else { $def.displayName }
                    $defPolicyType  = if ($def -is [hashtable]) { $def['policyType']  } else { $def.policyType  }

                    # Enrich policyName and admxFileName from the ADMX definition cache when
                    # the API expansion doesn't return them (which is the case for admxIngested).
                    if ($defId -and $admxDefCache -and $admxDefCache.ContainsKey($defId)) {
                        $cached = $admxDefCache[$defId]
                        if (-not $defPolicyName  -and $cached.policyName)  { $defPolicyName  = $cached.policyName  }
                    }

                    $stableDefinition = @{
                        id           = $defId
                        policyName   = $defPolicyName
                        classType    = $defClassType
                        categoryPath = $defCatPath
                        displayName  = $defDisplayName
                        policyType   = $defPolicyType
                    }

                    # admxFileName: prefer the cache (which cross-references the actual upload)
                    # over definition.definitionFile which is not returned by $expand=definition.
                    $admxFileName = $null
                    if ($defId -and $admxDefCache -and $admxDefCache.ContainsKey($defId)) {
                        $admxFileName = $admxDefCache[$defId].admxFileName
                    }
                    if (-not $admxFileName) {
                        $defFile = if ($def -is [hashtable]) { $def['definitionFile'] } else { $def.definitionFile }
                        if ($defFile) {
                            $admxFileName = if ($defFile -is [hashtable]) { $defFile['fileName'] } else { $defFile.fileName }
                        }
                    }
                    if ($admxFileName) { $stableDefinition['admxFileName'] = $admxFileName }

                    # Fetch PVs via the dedicated per-DV endpoint (see comment near the
                    # definitionValues GET above for why $expand can't carry them inline).
                    # Always assigned an array — even when zero PVs — so the resulting
                    # baseline shows [] for "setting has no presentation" rather than null,
                    # which is indistinguishable from "we forgot to capture".
                    $cleanPresentationValues = @()
                    $dvId = if ($dv -is [hashtable]) { $dv['id'] } else { $dv.id }
                    if ($dvId) {
                        try {
                            $pvList = @(Get-AllGraphResults `
                                -Uri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations/$($gpConfig.id)/definitionValues/$dvId/presentationValues?`$expand=presentation" `
                                -Description "presentationValues for dv $dvId in '$($gpConfig.displayName)'")
                        } catch {
                            Write-Log "Failed to fetch presentationValues for dv $dvId in '$($gpConfig.displayName)': $_" "WARN"
                            $pvList = @()
                        }
                        foreach ($pv in $pvList) {
                            $pvProps = if ($pv -is [hashtable]) { $pv.Keys } else { $pv.PSObject.Properties.Name }
                            $cleanPV = @{}
                            foreach ($key in $pvProps) {
                                # 'presentation' is the nested object — we collapse it into
                                # the @odata.bind URL below. The other transient/server-set
                                # fields aren't portable across tenants.
                                if ($key -in @('id', 'createdDateTime', 'lastModifiedDateTime', 'version', 'definitionValue', 'presentation')) { continue }
                                $cleanPV[$key] = if ($pv -is [hashtable]) { $pv[$key] } else { $pv.$key }
                            }
                            $pvPresentation = if ($pv -is [hashtable]) { $pv['presentation'] } else { $pv.presentation }
                            $presId = if ($pvPresentation -is [hashtable]) { $pvPresentation['id'] } elseif ($pvPresentation) { $pvPresentation.id }
                            if ($presId -and $defId) {
                                # The deploy side rewrites this @odata.bind URL using positional matching against
                                # the target tenant's definition presentations; what matters here is preserving
                                # the index/order so the deploy can map source presId -> target presId.
                                $cleanPV['presentation@odata.bind'] = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions('$defId')/presentations('$presId')"
                            }
                            $cleanPresentationValues += $cleanPV
                        }
                    }

                    $enrichedValues += @{
                        enabled            = $dv.enabled
                        definition         = $stableDefinition
                        presentationValues = $cleanPresentationValues
                    }
                }

                if ($gpConfig -is [hashtable]) { $gpConfig['definitionValues'] = $enrichedValues }
                else { $gpConfig | Add-Member -NotePropertyName "definitionValues" -NotePropertyValue $enrichedValues -Force }

                Save-PolicyWithAssignments -Policy $gpConfig `
                    -OutputFolder "intune/group-policy-configurations" -FileName $fileName `
                    -AssignmentsUri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations/$($gpConfig.id)/assignments" `
                    -PolicyType "group policy configuration"

                Write-Log "Saved Group Policy Configuration: $($gpConfig.displayName) ($($enrichedValues.Count) setting(s))" "DEBUG"
                [PSCustomObject]@{ Success = $true; Name = $gpConfig.displayName }
            }
            catch {
                Write-Log "Failed to backup Group Policy Configuration '$($gpConfig.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $gpConfig.displayName; Error = "$_" }
            }
        }
    }
    Add-BatchResults -BatchOutput @($batchOut) -Target $results.GroupPolicyConfigurations -OutputFolder "intune/group-policy-configurations"
    Write-Log "Group Policy Configurations: $($results.GroupPolicyConfigurations.BackedUp) backed up, $($results.GroupPolicyConfigurations.Failed) failed" "INFO"
}
catch {
    Write-Log "Failed to backup Group Policy Configurations: $_" "ERROR"
}
#endregion

#region Intune Managed Device Inventory (device compliance portal)
try {
    Write-Log 'Exporting Intune managed device inventory...' 'INFO'
    . "$scriptDir/Backup-IntuneDevices.ps1" -BackupPath $BackupPath -DebugMode:$DebugMode
}
catch {
    Write-Log "Intune managed device inventory export failed (device compliance page may be incomplete): $_" 'WARN'
}
#endregion

Write-Log "=== Intune Backup Complete ===" "INFO"

# Calculate totals
$totalBackedUp = 0
$totalFailed   = 0
foreach ($category in $results.Keys) {
    $totalBackedUp += $results[$category].BackedUp
    $totalFailed   += $results[$category].Failed
}

Write-Log "Total Intune items: $totalBackedUp backed up, $totalFailed failed" "INFO"

# Return summary
return @{
    Type          = "Intune"
    Success       = $totalFailed -eq 0
    TotalBackedUp = $totalBackedUp
    TotalFailed   = $totalFailed
    Details       = $results
}
