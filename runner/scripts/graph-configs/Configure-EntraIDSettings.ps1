<#
.SYNOPSIS
    Configures Entra ID settings via Microsoft Graph API

.DESCRIPTION
    Applies Entra ID tenant settings that are not available in the Terraform provider

.PARAMETER ConfigPath
    Path to the JSON configuration file

.PARAMETER OutputPath
    Path to save the plan/results JSON file for pipeline summary

.EXAMPLE
    .\Configure-EntraIDSettings.ps1 -ConfigPath "security-defaults.json"

.EXAMPLE
    .\Configure-EntraIDSettings.ps1 -ConfigPath "security-defaults.json" -WhatIf -OutputPath "plan.json"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$ConfigPath,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantBaselinePath,

    [Parameter(Mandatory=$false)]
    [string]$TenantRepoPath
)

$ErrorActionPreference = "Stop"

$script:IntuneMobilityPolicyId = '0000000a-0000-0000-c000-000000000000'

$script:MobilityScopeConfigs = @(
    @{
        CollectionName          = 'mobileDeviceManagementPolicies'
        BaselineFile            = 'mdm-scope.json'
        DisplayName             = 'MDM Scope'
        PlanType                = 'MdmScope'
        IncludeRegistrationFlag = $true
    },
    @{
        CollectionName          = 'mobileAppManagementPolicies'
        BaselineFile            = 'mam-scope.json'
        DisplayName             = 'MAM Scope'
        PlanType                = 'MamScope'
        IncludeRegistrationFlag = $false
    }
)

function Get-EntraBaselineRoot {
    param([string]$TenantBaselinePath)
    if ($TenantBaselinePath) {
        return (Join-Path $TenantBaselinePath "baseline").Replace('\', '/')
    }
    return $null
}

function Get-EntraSettingsFilePath {
    param(
        [string]$TenantBaselinePath,
        [string]$FileName
    )
    $root = Get-EntraBaselineRoot -TenantBaselinePath $TenantBaselinePath
    if (-not $root) { return $null }
    return (Join-Path $root "entra-id-device-settings/$FileName").Replace('\', '/')
}

function Test-EntraSettingsFileActive {
    param(
        [string]$FilePath,
        [string]$BaselineRoot,
        [string]$DisplayLabel
    )

    if (-not (Test-Path $FilePath)) {
        Write-Host "  No $DisplayLabel baseline file at: $FilePath — skipping" -ForegroundColor DarkGray
        return $false
    }

    if (-not $BaselineRoot) {
        return $true
    }

    if ((Get-Command Test-PolicyIgnored -ErrorAction SilentlyContinue) -and
        (Test-PolicyIgnored -PolicyPath $FilePath -BaselineRoot $BaselineRoot)) {
        Write-Host "  $DisplayLabel ignored via .baseline-ignore — skipping"
        return $false
    }

    if (-not (Test-BaselineFileInApplyScope -FilePath $FilePath -BaselineRoot $BaselineRoot)) {
        Write-Host "  [PLAN-SCOPE] Skipping $DisplayLabel (not in approved plan)" -ForegroundColor DarkGray
        return $false
    }

    return $true
}

function Get-MobilityScopePolicyUri {
    param([string]$CollectionName)
    "https://graph.microsoft.com/beta/policies/$CollectionName/$($script:IntuneMobilityPolicyId)"
}

function Get-MobilityScopePolicyUriWithExpand {
    param([string]$CollectionName)
    "$(Get-MobilityScopePolicyUri -CollectionName $CollectionName)?`$expand=includedGroups"
}

function Get-MobilityScopeAppliesToValue {
    param([object]$Policy)
    if ($null -eq $Policy -or $null -eq $Policy.appliesTo) { return 'none' }
    return $Policy.appliesTo.ToString().ToLowerInvariant()
}

function Get-MobilityScopeRegistrationDisabled {
    param([object]$Policy)
    if ($null -eq $Policy -or $null -eq $Policy.isMdmEnrollmentDuringRegistrationDisabled) { return $false }
    return [bool]$Policy.isMdmEnrollmentDuringRegistrationDisabled
}

function Get-MobilityScopeIncludedGroupIds {
    param([object]$Policy)
    $ids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($Policy -and $Policy.includedGroups) {
        foreach ($g in @($Policy.includedGroups)) {
            if ($g.id) { [void]$ids.Add([string]$g.id) }
        }
    }
    return $ids
}

function Resolve-MobilityScopeGroupIds {
    param(
        [object[]]$DesiredGroups,
        [string]$ScopeLabel
    )

    $resolved = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($g in @($DesiredGroups)) {
        if ($g.id) {
            [void]$resolved.Add([string]$g.id)
            continue
        }
        if (-not $g.displayName) {
            throw "$ScopeLabel includedGroups entry missing both id and displayName"
        }
        $filter = [uri]::EscapeDataString("displayName eq '$($g.displayName -replace "'", "''")'")
        $found = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/groups?`$filter=$filter&`$select=id,displayName"
        if (-not $found.value -or $found.value.Count -eq 0) {
            throw "$ScopeLabel group not found in tenant: $($g.displayName)"
        }
        if ($found.value.Count -gt 1) {
            throw "Multiple groups matched displayName '$($g.displayName)' — use group id in baseline"
        }
        [void]$resolved.Add([string]$found.value[0].id)
    }
    return $resolved
}

function Get-MobilityScopeChangeLines {
    param(
        [object]$Current,
        [object]$Desired,
        [string]$ScopeLabel,
        [bool]$IncludeRegistrationFlag
    )

    $changes = @()
    $currentAppliesTo = Get-MobilityScopeAppliesToValue -Policy $Current
    $desiredAppliesTo = if ($Desired.appliesTo) { $Desired.appliesTo.ToString().ToLowerInvariant() } else { 'none' }
    if ($currentAppliesTo -ne $desiredAppliesTo) {
        $changes += "AppliesTo: $currentAppliesTo → $desiredAppliesTo"
    }

    if ($IncludeRegistrationFlag) {
        $currentReg = Get-MobilityScopeRegistrationDisabled -Policy $Current
        $desiredReg = $false
        if ($null -ne $Desired.isMdmEnrollmentDuringRegistrationDisabled) {
            $desiredReg = [bool]$Desired.isMdmEnrollmentDuringRegistrationDisabled
        }
        if ($currentReg -ne $desiredReg) {
            $changes += "MdmEnrollmentDuringRegistrationDisabled: $currentReg → $desiredReg"
        }
    }

    if ($desiredAppliesTo -eq 'selected') {
        $currentIds = Get-MobilityScopeIncludedGroupIds -Policy $Current
        $desiredIds = Resolve-MobilityScopeGroupIds -DesiredGroups @($Desired.includedGroups) -ScopeLabel $ScopeLabel
        $added = @($desiredIds | Where-Object { -not $currentIds.Contains($_) })
        $removed = @($currentIds | Where-Object { -not $desiredIds.Contains($_) })
        foreach ($id in $added) { $changes += "Add includedGroup: $id" }
        foreach ($id in $removed) { $changes += "Remove includedGroup: $id" }
    }

    return $changes
}

function Invoke-MobilityScopePolicyPatch {
    param(
        [string]$CollectionName,
        [hashtable]$Body
    )
    Invoke-MgGraphRequest -Method PATCH `
        -Uri (Get-MobilityScopePolicyUri -CollectionName $CollectionName) `
        -Body ($Body | ConvertTo-Json) `
        -ContentType "application/json"
}

function Sync-MobilityScopeIncludedGroups {
    param(
        [string]$CollectionName,
        [string]$ScopeLabel,
        [System.Collections.Generic.HashSet[string]]$DesiredGroupIds,
        [object]$CurrentPolicy
    )

    $policyUri = Get-MobilityScopePolicyUri -CollectionName $CollectionName
    $currentIds = Get-MobilityScopeIncludedGroupIds -Policy $CurrentPolicy
    $toRemove = @($currentIds | Where-Object { -not $DesiredGroupIds.Contains($_) })
    $toAdd = @($DesiredGroupIds | Where-Object { -not $currentIds.Contains($_) })

    foreach ($groupId in $toRemove) {
        $deleteUri = "$policyUri/includedGroups/$groupId/`$ref"
        Invoke-MgGraphRequest -Method DELETE -Uri $deleteUri
        Write-Host "  Removed $ScopeLabel group: $groupId" -ForegroundColor Green
    }

    foreach ($groupId in $toAdd) {
        $postUri = "$policyUri/includedGroups/`$ref"
        $body = @{
            '@odata.id' = "https://graph.microsoft.com/beta/directoryObjects/$groupId"
        } | ConvertTo-Json
        Invoke-MgGraphRequest -Method POST -Uri $postUri -Body $body -ContentType "application/json"
        Write-Host "  Added $ScopeLabel group: $groupId" -ForegroundColor Green
    }
}

function Invoke-ConfigureMobilityScope {
    param(
        [string]$ScopePath,
        [string]$CollectionName,
        [string]$DisplayName,
        [string]$PlanType,
        [bool]$IncludeRegistrationFlag
    )

    $desired = Get-Content $ScopePath -Raw | ConvertFrom-Json
    $desiredAppliesTo = if ($desired.appliesTo) { $desired.appliesTo.ToString().ToLowerInvariant() } else { 'none' }

    if ($desiredAppliesTo -eq 'selected' -and (-not $desired.includedGroups -or @($desired.includedGroups).Count -eq 0)) {
        throw "$DisplayName baseline appliesTo=selected requires at least one includedGroups entry"
    }

    $policyUri = Get-MobilityScopePolicyUriWithExpand -CollectionName $CollectionName
    $current = Invoke-MgGraphRequest -Method GET -Uri $policyUri
    $changes = @(Get-MobilityScopeChangeLines -Current $current -Desired $desired -ScopeLabel $DisplayName -IncludeRegistrationFlag:$IncludeRegistrationFlag)

    if ($changes.Count -eq 0) {
        Write-Host "✓ $DisplayName already configured correctly (appliesTo=$(Get-MobilityScopeAppliesToValue -Policy $current))" -ForegroundColor Green
        return @{
            DisplayName = $DisplayName
            Type        = $PlanType
            Status      = "No changes"
            FilePath    = $ScopePath
        }
    }

    if (-not $PSCmdlet.ShouldProcess($DisplayName, "Update")) {
        Write-Host "[WhatIf] Would update ${DisplayName}:" -ForegroundColor Yellow
        foreach ($line in $changes) { Write-Host "  - $line" -ForegroundColor Yellow }
        return @{
            DisplayName = $DisplayName
            Type        = $PlanType
            Status      = "WouldUpdate"
            FilePath    = $ScopePath
            Changes     = @{
                Modified       = $changes
                ModifiedValues = @{}
            }
        }
    }

    $currentAppliesTo = Get-MobilityScopeAppliesToValue -Policy $current
    if ($desiredAppliesTo -in @('none', 'all') -and $currentAppliesTo -ne $desiredAppliesTo) {
        Invoke-MobilityScopePolicyPatch -CollectionName $CollectionName -Body @{ appliesTo = $desiredAppliesTo }
        Write-Host "  Updated $DisplayName appliesTo → $desiredAppliesTo" -ForegroundColor Green
        $current = Invoke-MgGraphRequest -Method GET -Uri $policyUri
    }

    if ($desiredAppliesTo -eq 'selected') {
        $desiredIds = Resolve-MobilityScopeGroupIds -DesiredGroups @($desired.includedGroups) -ScopeLabel $DisplayName
        Sync-MobilityScopeIncludedGroups -CollectionName $CollectionName -ScopeLabel $DisplayName -DesiredGroupIds $desiredIds -CurrentPolicy $current
        $current = Invoke-MgGraphRequest -Method GET -Uri $policyUri
    }

    if ($IncludeRegistrationFlag) {
        $currentReg = Get-MobilityScopeRegistrationDisabled -Policy $current
        $desiredReg = $false
        if ($null -ne $desired.isMdmEnrollmentDuringRegistrationDisabled) {
            $desiredReg = [bool]$desired.isMdmEnrollmentDuringRegistrationDisabled
        }
        if ($currentReg -ne $desiredReg) {
            Invoke-MobilityScopePolicyPatch -CollectionName $CollectionName -Body @{ isMdmEnrollmentDuringRegistrationDisabled = $desiredReg }
            Write-Host "  Updated isMdmEnrollmentDuringRegistrationDisabled → $desiredReg" -ForegroundColor Green
        }
    }

    Write-Host "✓ $DisplayName updated" -ForegroundColor Green
    return @{
        DisplayName = $DisplayName
        Type        = $PlanType
        Status      = "Updated"
        FilePath    = $ScopePath
        Changes     = @{
            Modified       = $changes
            ModifiedValues = @{}
        }
    }
}

Write-Host "##[section]Configuring Entra ID Settings"

# Initialize plan tracking for summary output
$planResults = @{
    Service = "EntraIDSettings"
    Timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    WouldCreateCount = 0
    WouldUpdateCount = 0
    NoChangeCount = 0
    ErrorCount = 0
    Results = @()
}

# Helper function to save plan output
function Save-PlanOutput {
    if ($OutputPath) {
        $script:planResults | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
        Write-Host "Plan saved to: $OutputPath" -ForegroundColor DarkGray
    }
}

# Load configuration
if (-not (Test-Path $ConfigPath)) {
    throw "Configuration file not found: $ConfigPath"
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
Write-Host "Loaded configuration from: $ConfigPath"

function Get-SecurityDefaultsDesiredEnabled {
    param([object]$Config)

    if ($null -ne $Config.SecurityDefaults -and $null -ne $Config.SecurityDefaults.IsEnabled) {
        return [bool]$Config.SecurityDefaults.IsEnabled
    }
    if ($Config.PSObject.Properties.Name -contains 'isEnabled') {
        return [bool]$Config.isEnabled
    }
    return $null
}

$desiredSecurityDefaultsEnabled = Get-SecurityDefaultsDesiredEnabled -Config $config

if (-not $TenantRepoPath -and $TenantBaselinePath) {
    $TenantRepoPath = Join-Path (Split-Path $TenantBaselinePath -Parent) "tenant"
}

$ignoreHelpersPath = Join-Path $PSScriptRoot "Common-IgnoreHelpers.ps1"
if (Test-Path $ignoreHelpersPath) {
    . $ignoreHelpersPath
    Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath
}

$entraBaselineRoot = Get-EntraBaselineRoot -TenantBaselinePath $TenantBaselinePath
$securityDefaultsPath = $ConfigPath.Replace('\', '/')
$deviceRegPolicyPath = Get-EntraSettingsFilePath -TenantBaselinePath $TenantBaselinePath -FileName 'device-registration-policy.json'

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.Identity.DirectoryManagement",
    "Microsoft.Graph.Identity.SignIns"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection -Scopes @(
        "Policy.ReadWrite.All",
        "Policy.ReadWrite.MobilityManagement",
        "Policy.ReadWrite.DeviceConfiguration",
        "Directory.ReadWrite.All",
        "Group.Read.All"
    )
    Write-Host "Connected to tenant: $($context.TenantId)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Configure Security Defaults
if ($null -ne $desiredSecurityDefaultsEnabled -and
    $entraBaselineRoot -and
    (Test-EntraSettingsFileActive -FilePath $securityDefaultsPath -BaselineRoot $entraBaselineRoot -DisplayLabel 'Security Defaults')) {
    Write-Host "`n##[group]Configuring Security Defaults..."
    
    try {
        $sdUri = "https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy"
        $current = Invoke-MgGraphRequest -Method GET -Uri $sdUri
        $currentEnabled = [bool]$current.isEnabled
        $desiredEnabled = $desiredSecurityDefaultsEnabled
        
        if ($currentEnabled -ne $desiredEnabled) {
            if ($PSCmdlet.ShouldProcess("Security Defaults", "Update")) {
                $patchBody = @{ isEnabled = $desiredEnabled } | ConvertTo-Json
                Invoke-MgGraphRequest -Method PATCH -Uri $sdUri -Body $patchBody -ContentType "application/json"
                
                Write-Host "✓ Security Defaults updated to: $desiredEnabled" -ForegroundColor Green

                if (-not (Wait-ForSecurityDefaultsPropagation -ExpectedEnabled $desiredEnabled -MaxWaitSeconds 120)) {
                    throw "Security Defaults PATCH succeeded but Graph still reports isEnabled=$([bool](Invoke-MgGraphRequest -Method GET -Uri $sdUri).isEnabled) after waiting for propagation"
                }
                
                $planResults.WouldUpdateCount++
                $planResults.Results += @{
                    DisplayName = "Security Defaults"
                    Type = "Policy"
                    Status = "Updated"
                    FilePath = $securityDefaultsPath
                    Changes = @{
                        Modified       = @("IsEnabled: $currentEnabled → $desiredEnabled")
                        ModifiedValues = @{}
                    }
                }
            }
            else {
                Write-Host "[WhatIf] Would update Security Defaults to: $desiredEnabled" -ForegroundColor Yellow
                
                $planResults.WouldUpdateCount++
                $planResults.Results += @{
                    DisplayName = "Security Defaults"
                    Type = "Policy"
                    Status = "WouldUpdate"
                    FilePath = $securityDefaultsPath
                    Changes = @{
                        Modified       = @("IsEnabled: $currentEnabled → $desiredEnabled")
                        ModifiedValues = @{}
                    }
                }
            }
        }
        else {
            Write-Host "✓ Security Defaults already configured correctly" -ForegroundColor Green
            
            $planResults.NoChangeCount++
            $planResults.Results += @{
                DisplayName = "Security Defaults"
                Type = "Policy"
                Status = "No changes"
                FilePath = $securityDefaultsPath
            }
        }
    }
    catch {
        Write-Host "##[warning]Failed to configure Security Defaults: $_" -ForegroundColor Red
        
        $planResults.ErrorCount++
        $planResults.Results += @{
            DisplayName = "Security Defaults"
            Type = "Policy"
            Status = "Failed"
            FilePath = $securityDefaultsPath
            Error = $_.Exception.Message
        }
    }
    
    Write-Host "##[endgroup]"
}
elseif ($null -ne $desiredSecurityDefaultsEnabled) {
    Write-Host "Skipping Security Defaults — not in plan scope or baseline file inactive" -ForegroundColor DarkGray
}

# Configure Device Registration Policy (including LAPS)
Write-Host "`n##[group]Configuring Device Registration Policy (LAPS)..."

try {
    if ($deviceRegPolicyPath -and (Test-EntraSettingsFileActive -FilePath $deviceRegPolicyPath -BaselineRoot $entraBaselineRoot -DisplayLabel 'Device Registration Policy')) {
        $desiredPolicy = Get-Content $deviceRegPolicyPath -Raw | ConvertFrom-Json
        
        # Get current Device Registration Policy using Graph API
        $currentPolicy = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/beta/policies/deviceRegistrationPolicy"
        
        # Compare LAPS setting
        $currentLapsEnabled = $currentPolicy.localAdminPassword.isEnabled
        $desiredLapsEnabled = $desiredPolicy.localAdminPassword.isEnabled
        
        if ($currentLapsEnabled -ne $desiredLapsEnabled) {
            if ($PSCmdlet.ShouldProcess("Device Registration Policy (LAPS)", "Update")) {
                # Build body using DESIRED policy for nested objects.
                # Using $currentPolicy.azureADJoin / .azureADRegistration risks including
                # read-only fields (e.g. appliesTo) that the PUT endpoint rejects with 400.
                # The baseline JSON already contains only the writable subset.
                $body = @{
                    displayName                  = $currentPolicy.displayName
                    description                  = $currentPolicy.description
                    multiFactorAuthConfiguration = if ($desiredPolicy.multiFactorAuthConfiguration) { $desiredPolicy.multiFactorAuthConfiguration } else { $currentPolicy.multiFactorAuthConfiguration }
                    userDeviceQuota              = if ($null -ne $desiredPolicy.userDeviceQuota) { $desiredPolicy.userDeviceQuota } else { $currentPolicy.userDeviceQuota }
                    azureADRegistration          = $desiredPolicy.azureADRegistration
                    azureADJoin                  = $desiredPolicy.azureADJoin
                    localAdminPassword           = $desiredPolicy.localAdminPassword
                }

                Invoke-MgGraphRequest -Method PUT `
                    -Uri "https://graph.microsoft.com/beta/policies/deviceRegistrationPolicy" `
                    -Body ($body | ConvertTo-Json -Depth 10) `
                    -ContentType "application/json"
                Write-Host "✓ Device Registration Policy updated - LAPS enabled: $desiredLapsEnabled" -ForegroundColor Green
                
                $planResults.WouldUpdateCount++
                $planResults.Results += @{
                    DisplayName = "Device Registration Policy"
                    Type = "Policy"
                    Status = "Updated"
                    FilePath = $deviceRegPolicyPath
                    Changes = @{
                        Modified       = @("LAPS enabled: $currentLapsEnabled → $desiredLapsEnabled")
                        ModifiedValues = @{}
                    }
                }
            }
            else {
                Write-Host "[WhatIf] Would update Device Registration Policy - LAPS enabled: $desiredLapsEnabled (current: $currentLapsEnabled)" -ForegroundColor Yellow
                
                $planResults.WouldUpdateCount++
                $planResults.Results += @{
                    DisplayName = "Device Registration Policy"
                    Type = "Policy"
                    Status = "WouldUpdate"
                    FilePath = $deviceRegPolicyPath
                    Changes = @{
                        Modified       = @("LAPS enabled: $currentLapsEnabled → $desiredLapsEnabled")
                        ModifiedValues = @{}
                    }
                }
            }
        }
        else {
            Write-Host "✓ Device Registration Policy already configured correctly - LAPS enabled: $currentLapsEnabled" -ForegroundColor Green
            
            $planResults.NoChangeCount++
            $planResults.Results += @{
                DisplayName = "Device Registration Policy"
                Type = "Policy"
                Status = "No changes"
                FilePath = $deviceRegPolicyPath
            }
        }
    }
}
catch {
    # Use ##[error] so this surfaces as a hard failure in the pipeline step,
    # not just a yellow warning that gets lost with continueOnError: true.
    Write-Host "##[error]Failed to configure Device Registration Policy: $_"
    Write-Host "##[error]Exception type: $($_.Exception.GetType().FullName)"
    
    $planResults.ErrorCount++
    $planResults.Results += @{
        DisplayName = "Device Registration Policy"
        Type = "Policy"
        Status = "Failed"
        FilePath = $deviceRegPolicyPath
        Error = $_.Exception.Message
    }
}

Write-Host "##[endgroup]"

# Configure MDM/MAM Scope (Intune mobility user scope)
Write-Host "`n##[group]Configuring Mobility Scopes (MDM & MAM)..."

foreach ($scopeCfg in $script:MobilityScopeConfigs) {
    $scopePath = Get-EntraSettingsFilePath -TenantBaselinePath $TenantBaselinePath -FileName $scopeCfg.BaselineFile
    try {
        if ($scopePath -and (Test-EntraSettingsFileActive -FilePath $scopePath -BaselineRoot $entraBaselineRoot -DisplayLabel $scopeCfg.DisplayName)) {
            $scopeResult = Invoke-ConfigureMobilityScope `
                -ScopePath $scopePath `
                -CollectionName $scopeCfg.CollectionName `
                -DisplayName $scopeCfg.DisplayName `
                -PlanType $scopeCfg.PlanType `
                -IncludeRegistrationFlag:$scopeCfg.IncludeRegistrationFlag
            if ($scopeResult.Status -eq 'Updated' -or $scopeResult.Status -eq 'WouldUpdate') {
                $planResults.WouldUpdateCount++
            }
            elseif ($scopeResult.Status -eq 'No changes') {
                $planResults.NoChangeCount++
            }
            $planResults.Results += $scopeResult
        }
    }
    catch {
        Write-Host "##[error]Failed to configure $($scopeCfg.DisplayName): $_"
        $planResults.ErrorCount++
        $planResults.Results += @{
            DisplayName = $scopeCfg.DisplayName
            Type        = $scopeCfg.PlanType
            Status      = "Failed"
            FilePath    = $scopePath
            Error       = $_.Exception.Message
        }
    }
}

Write-Host "##[endgroup]"

# Export current state for backup
$exportPath = Join-Path (Split-Path $ConfigPath -Parent) "entra-id-settings-current.json"
$currentState = @{
    ExportDate = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
}

# Collect current state (always execute, even in WhatIf mode)
try {
    $currentState.SecurityDefaults = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy" `
        -ErrorAction SilentlyContinue
}
catch {
    Write-Host "##[warning]Could not export Security Defaults: $_" -ForegroundColor Yellow
}

try {
    $currentState.DeviceRegistrationPolicy = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/beta/policies/deviceRegistrationPolicy" -ErrorAction SilentlyContinue
}
catch {
    Write-Host "##[warning]Could not export Device Registration Policy: $_" -ForegroundColor Yellow
}

foreach ($scopeCfg in $script:MobilityScopeConfigs) {
    try {
        $exportKey = if ($scopeCfg.PlanType -eq 'MdmScope') { 'MdmScope' } else { 'MamScope' }
        $currentState[$exportKey] = Invoke-MgGraphRequest -Method GET `
            -Uri (Get-MobilityScopePolicyUriWithExpand -CollectionName $scopeCfg.CollectionName) `
            -ErrorAction SilentlyContinue
    }
    catch {
        Write-Host "##[warning]Could not export $($scopeCfg.DisplayName): $_" -ForegroundColor Yellow
    }
}

$currentState | ConvertTo-Json -Depth 10 | Out-File -FilePath $exportPath -Encoding UTF8 -WhatIf:$false
Write-Host "`n✓ Current state exported to: $exportPath"

# Save plan output for pipeline summary
Save-PlanOutput

Write-Host "`n##[section]Entra ID Settings Configuration Complete"

# Fail the pipeline step if any section encountered a hard error.
# NOTE: ##[error] log annotations are cosmetic only — they do not cause the step
# to fail. A non-zero exit code is what Azure DevOps uses to determine failure.
if ($planResults.ErrorCount -gt 0) {
    Write-Host "##[error]$($planResults.ErrorCount) error(s) occurred during Entra ID Settings configuration. See above for details."
    exit 1
}

