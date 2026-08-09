<#
.SYNOPSIS
    Creates and manages Conditional Access policies and named locations via Microsoft Graph API

.DESCRIPTION
    Creates and updates Conditional Access policies and named locations that are deployed to Tenant tenants.
    The script is idempotent - it will create resources if they don't exist, or verify/update if they do.
    
    Expected directory structure:
    ConfigDirectory/
    ├── policies/          (Conditional Access policies)
    │   └── *.json
    └── named-locations/   (Named locations - IP ranges, countries)
        └── *.json

.PARAMETER ConfigDirectory
    Path to the directory containing subdirectories for policies and named-locations

.PARAMETER WhatIf
    Show what would be changed without making changes

.PARAMETER OutputPath
    Optional path to save a JSON summary of planned changes

.EXAMPLE
    .\Configure-ConditionalAccess.ps1 -ConfigDirectory "baseline-conditional-access"
    
.EXAMPLE
    .\Configure-ConditionalAccess.ps1 -ConfigDirectory "baseline-conditional-access" -WhatIf -OutputPath "ca-plan.json"

.NOTES
    Requires Microsoft.Graph.Identity.SignIns module
    Requires appropriate Graph API permissions: Policy.Read.All, Policy.ReadWrite.ConditionalAccess
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
    [string]$TenantRepoPath,  # Path to tenant's own repo (for .baseline-ignore)
    
    [Parameter(Mandatory=$false)]
    [string]$OptionsPath  # Path to om365do-options.json for configurable behavior
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

Write-Host "##[section]Configuring Conditional Access"

#region Load Options Configuration

# Default options
$script:Options = @{
    conditionalAccess = @{
        stateSync = "preserve"  # Options: preserve, baseline, enableOnly
    }
}

# Load options from file (base options from CONFIG365)
if ($OptionsPath -and (Test-Path $OptionsPath)) {
    try {
        $optionsContent = Get-Content $OptionsPath -Raw | ConvertFrom-Json
        if ($optionsContent.conditionalAccess) {
            if ($optionsContent.conditionalAccess.stateSync) {
                $script:Options.conditionalAccess.stateSync = $optionsContent.conditionalAccess.stateSync
            }
        }
        Write-Host "Loaded base options from: $OptionsPath"
    }
    catch {
        Write-Host "##[warning]Failed to load options file: $_"
    }
}
elseif ($OptionsPath) {
    Write-Host "##[warning]Options file not found: $OptionsPath (using defaults)"
}

# Check for tenant-specific options override — config/conditional-access/config.json in tenant repo
if ($TenantRepoPath) {
    $tenantOptionsPath = Join-Path $TenantRepoPath "config" "conditional-access" "config.json"
    if (Test-Path $tenantOptionsPath) {
        try {
            $tenantOptions = Get-Content $tenantOptionsPath -Raw | ConvertFrom-Json
            if ($tenantOptions.stateSync) {
                $script:Options.conditionalAccess.stateSync = $tenantOptions.stateSync
                Write-Host "  (Overridden by tenant config)"
            }
            Write-Host "Loaded tenant CA options from: $tenantOptionsPath"
        }
        catch {
            Write-Host "##[warning]Failed to load tenant CA options: $_"
        }
    }
}

# Also check environment variable override (highest priority)
if ($env:CONFIG365_CA_STATE_SYNC) {
    $script:Options.conditionalAccess.stateSync = $env:CONFIG365_CA_STATE_SYNC
    Write-Host "  CA State Sync Mode (from env): $($script:Options.conditionalAccess.stateSync)"
}

Write-Host "  CA State Sync Mode: $($script:Options.conditionalAccess.stateSync)"

#endregion

# Initialize baseline ignore patterns (if TenantBaselinePath provided)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# Load optional applications configuration
# These are app IDs that will be validated and filtered out if their service principal doesn't exist
$script:OptionalApplications = @{}
$optionalAppsPath = Join-Path $ConfigDirectory "optional-applications.json"
if (Test-Path $optionalAppsPath) {
    try {
        $optionalAppsConfig = Get-Content $optionalAppsPath -Raw | ConvertFrom-Json
        if ($optionalAppsConfig.applications) {
            foreach ($property in $optionalAppsConfig.applications.PSObject.Properties) {
                $script:OptionalApplications[$property.Name] = $property.Value
            }
            Write-Host "Loaded $($script:OptionalApplications.Count) optional application(s) from: $optionalAppsPath"
        }
    }
    catch {
        Write-Host "##[warning]Failed to load optional applications config: $_"
    }
}
else {
    Write-Verbose "No optional-applications.json found at $optionalAppsPath"
}

# Check if configuration directory exists
if (-not (Test-Path $ConfigDirectory)) {
    throw "Configuration directory not found: $ConfigDirectory"
}

# Check for subdirectories
$policiesPath = Join-Path $ConfigDirectory "policies"
$namedLocationsPath = Join-Path $ConfigDirectory "named-locations"

$policyFiles = @()
$namedLocationFiles = @()

# Use the baseline folder root so patterns like "conditional-access/policies/file.json" work correctly
$baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }

if (Test-Path $policiesPath) {
    $policyFiles = @(Get-ChildItem -Path $policiesPath -Filter "*.json" -File |
        Where-Object { $_.Name -notlike "*.config.json" -and $_.Name -notlike "*.monitor.json" })
    # Filter out ignored policies based on .baseline-ignore and group exclusions
    $policyFiles = @(Get-FilteredPolicyFiles -PolicyFiles $policyFiles -BaselineRoot $baselineRoot)
    $policyFiles = @(Get-GroupExcludedFiles -Files $policyFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
}

if (Test-Path $namedLocationsPath) {
    $namedLocationFiles = @(Get-ChildItem -Path $namedLocationsPath -Filter "*.json" -File |
        Where-Object { $_.Name -notlike "*.config.json" -and $_.Name -notlike "*.monitor.json" })
    # Filter out ignored named locations based on .baseline-ignore and group exclusions
    $namedLocationFiles = @(Get-FilteredPolicyFiles -PolicyFiles $namedLocationFiles -BaselineRoot $baselineRoot)
    $namedLocationFiles = @(Get-GroupExcludedFiles -Files $namedLocationFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
}

if ($policyFiles.Count -eq 0 -and $namedLocationFiles.Count -eq 0) {
    Write-Host "##[warning]No JSON files found in directory: $ConfigDirectory"
    Write-Host "Skipping Conditional Access configuration"
    exit 0
}

Write-Host "Found $($policyFiles.Count) policy file(s) and $($namedLocationFiles.Count) named location file(s)"
Write-Host "Named locations will be deployed first, then policies will be loaded and deployed"

# Import required modules FIRST (before loading configs that need placeholder resolution)
$requiredModules = @(
    "Microsoft.Graph.Authentication",
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
    $context = Ensure-M365GraphConnection -Scopes @("Policy.Read.All", "Policy.ReadWrite.ConditionalAccess")
    Write-Host "Connected to tenant: $($context.TenantId)"
    Write-Host "  Account: $($context.Account)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Fail fast when Security Defaults blocks Conditional Access policy creation (apply only)
if (-not $WhatIfPreference -and $policyFiles.Count -gt 0 -and $TenantBaselinePath) {
    $securityDefaultsPath = Join-Path $TenantBaselinePath "baseline" "entra-id-device-settings" "security-defaults.json"
    $legacySettingsPath   = Join-Path $TenantBaselinePath "baseline" "entra-id-device-settings" "entra-id-settings.json"
    $settingsPath = if (Test-Path $securityDefaultsPath) { $securityDefaultsPath }
                      elseif (Test-Path $legacySettingsPath) { $legacySettingsPath }
                      else { $null }

    if ($settingsPath) {
        try {
            $entraSettings = Get-Content $settingsPath -Raw | ConvertFrom-Json
            $baselineExpectsDisabled = $false
            if ($entraSettings.PSObject.Properties.Name -contains 'isEnabled') {
                $baselineExpectsDisabled = [bool]$entraSettings.isEnabled -eq $false
            }
            elseif ($null -ne $entraSettings.SecurityDefaults) {
                $baselineExpectsDisabled = $entraSettings.SecurityDefaults.IsEnabled -eq $false
            }

            if ($baselineExpectsDisabled) {
                if (-not (Wait-ForSecurityDefaultsPropagation -ExpectedEnabled $false -MaxWaitSeconds 120)) {
                    Write-Host "##[error]Security Defaults is still enabled in this tenant. Disable Security Defaults (Apply - Entra ID Settings) before creating Conditional Access policies."
                    exit 1
                }
            }
        }
        catch {
            Write-Host "##[warning]Could not verify Security Defaults state before Conditional Access: $_"
        }
    }
}

# STEP 1: Load named location configurations FIRST (no placeholder resolution needed for locations)
Write-Host "`nLoading named location configurations..."
$namedLocationConfigs = @()
foreach ($file in $namedLocationFiles) {
    try {
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        if ($config.displayName) { $config.displayName = $config.displayName.Trim() }

        # deployBehavior belongs exclusively in the sibling .config.json sidecar.
        # Strip it from the main JSON first (handles any legacy files not yet migrated),
        # then inject the authoritative value from the sidecar.
        if ($config.PSObject.Properties['deployBehavior']) { $config.PSObject.Properties.Remove('deployBehavior') }
        $configFile = Join-Path $file.Directory.FullName ($file.BaseName + ".config.json")
        if (Test-Path $configFile) {
            $behaviorConfig = Get-Content $configFile -Raw | ConvertFrom-Json -AsHashtable
            if ($behaviorConfig['deployBehavior']) {
                $config | Add-Member -NotePropertyName 'deployBehavior' -NotePropertyValue $behaviorConfig['deployBehavior'] -Force
            }
        }

        # Read field-monitor config from sibling .monitor.json
        $namedLocMonitorCfg = Get-MonitorConfig -BaselineFilePath $file.FullName
        if ($namedLocMonitorCfg) {
            $config | Add-Member -NotePropertyName '_monitorConfig' -NotePropertyValue $namedLocMonitorCfg -Force
        }

        $config | Add-Member -NotePropertyName '_SourceFile' -NotePropertyValue $file.FullName -Force
        $namedLocationConfigs += $config
        Write-Host "  Loaded named location: $($file.Name)"
    }
    catch {
        Write-Host "##[warning]Failed to load named location $($file.Name): $_"
    }
}

Write-Host "Named locations to deploy: $($namedLocationConfigs.Count)"

# Function to convert PSObject to hashtable (for PS 5.1 compatibility)
function ConvertTo-HashtableRecursive {
    param([object]$InputObject)
    
    if ($null -eq $InputObject) { return $null }
    
    # Check for arrays FIRST - must check before IEnumerable since strings are enumerable
    if ($InputObject -is [array] -or ($InputObject -is [System.Collections.IList] -and $InputObject -isnot [string])) {
        # Keep arrays as arrays, even single-element arrays
        $result = [System.Collections.ArrayList]::new()
        foreach ($object in $InputObject) {
            [void]$result.Add((ConvertTo-HashtableRecursive -InputObject $object))
        }
        # Return as proper array
        return @($result)
    }
    elseif ($InputObject -is [System.Management.Automation.PSObject] -and $InputObject -isnot [string]) {
        $hash = @{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $hash[$property.Name] = ConvertTo-HashtableRecursive -InputObject $property.Value
        }
        return $hash
    }
    else {
        return $InputObject
    }
}

# Function to check if an application's service principal exists in the tenant
function Test-ApplicationExists {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$ApplicationId
    )
    
    try {
        $sp = Get-MgServicePrincipal -Filter "appId eq '$ApplicationId'" -ErrorAction Stop
        return ($null -ne $sp -and $sp.Count -gt 0)
    }
    catch {
        Write-Verbose "Failed to check application $ApplicationId : $_"
        return $false
    }
}

# Function to filter optional applications from policy arrays
function Remove-OptionalApplications {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [object]$ApplicationArray,
        
        [Parameter(Mandatory=$true)]
        [string]$PolicyName
    )
    
    if ($null -eq $ApplicationArray -or $ApplicationArray.Count -eq 0) {
        # Ensure we return an array (even empty) to prevent unwrapping
        return ,$ApplicationArray
    }
    
    $filtered = @()
    $removed = @()
    
    foreach ($appId in $ApplicationArray) {
        if ($script:OptionalApplications.ContainsKey($appId)) {
            # This is an optional app - check if it exists
            if (Test-ApplicationExists -ApplicationId $appId) {
                $filtered += $appId
            }
            else {
                $appName = $script:OptionalApplications[$appId]
                $removed += "$appName ($appId)"
                Write-Host "  INFO: Filtered optional app '$appName' (not available in tenant)"
            }
        }
        else {
            # Not an optional app - keep it
            $filtered += $appId
        }
    }
    
    if ($removed.Count -gt 0) {
        Write-Host "  Removed $($removed.Count) optional app(s) from policy '$PolicyName':" -ForegroundColor Cyan
        foreach ($app in $removed) {
            Write-Host "    - $app" -ForegroundColor Cyan
        }
        Write-Host "  DEBUG: Array before filtering had $($ApplicationArray.Count) item(s)" -ForegroundColor DarkGray
        Write-Host "  DEBUG: Array after filtering has $($filtered.Count) item(s)" -ForegroundColor DarkGray
        if ($filtered.Count -gt 0) {
            Write-Host "  DEBUG: Remaining apps: $($filtered -join ', ')" -ForegroundColor DarkGray
        } else {
            Write-Host "  DEBUG: Array is now EMPTY after filtering" -ForegroundColor Yellow
        }
    }
    
    # Use comma operator to prevent PowerShell from unwrapping single-element arrays
    return ,$filtered
}

# Function to recursively remove null values and empty objects
function Remove-NullProperties {
    param([object]$Object)
    
    # Properties where empty arrays have semantic meaning and should be preserved
    # builtInControls: [] means "no built-in controls" which is different from not specifying it
    # excludeApplications/Users/Groups/etc: [] means "exclude none" which clears existing exclusions
    $preserveEmptyArrays = @(
        'builtInControls',
        'excludeApplications', 'includeApplications',
        'excludeUsers', 'includeUsers',
        'excludeGroups', 'includeGroups',
        'excludeRoles', 'includeRoles',
        'excludeLocations', 'includeLocations',
        'excludePlatforms', 'includePlatforms'
    )
    
    if ($Object -is [hashtable] -or $Object -is [System.Collections.IDictionary]) {
        # Create a copy of keys to avoid "collection modified" error
        $keys = @($Object.Keys)
        $keysToRemove = @()
        
        foreach ($key in $keys) {
            $value = $Object[$key]
            
            if ($null -eq $value) {
                $keysToRemove += $key
            }
            elseif ($value -is [hashtable] -or $value -is [System.Collections.IDictionary]) {
                $cleaned = Remove-NullProperties -Object $value
                if ($cleaned.Count -eq 0) {
                    $keysToRemove += $key
                }
                else {
                    $Object[$key] = $cleaned
                }
            }
            elseif ($value -is [array]) {
                $cleanedArray = @($value | ForEach-Object { Remove-NullProperties -Object $_ } | Where-Object { $null -ne $_ })
                if ($cleanedArray.Count -eq 0 -and $key -notin $preserveEmptyArrays) {
                    $keysToRemove += $key
                }
                else {
                    $Object[$key] = $cleanedArray
                }
            }
        }
        
        foreach ($key in $keysToRemove) {
            $Object.Remove($key)
        }
    }
    
    return $Object
}

# Function to clean up named location object for Graph API
function Prepare-NamedLocationForApi {
    param([hashtable]$LocationObject)
    
    # First, flatten AdditionalProperties into the root object
    # This is needed because the Graph SDK returns some properties nested in AdditionalProperties
    if ($LocationObject.ContainsKey('AdditionalProperties') -and $LocationObject['AdditionalProperties']) {
        $additionalProps = $LocationObject['AdditionalProperties']
        if ($additionalProps -is [hashtable] -or $additionalProps -is [System.Collections.IDictionary]) {
            foreach ($key in @($additionalProps.Keys)) {
                # Only add if not already present at root level
                if (-not $LocationObject.ContainsKey($key)) {
                    $LocationObject[$key] = $additionalProps[$key]
                }
            }
        }
    }
    
    # Remove read-only properties (check both PascalCase and camelCase)
    $readOnlyProps = @('Id', 'id', 'CreatedDateTime', 'createdDateTime', 'ModifiedDateTime', 'modifiedDateTime', 'AdditionalProperties')
    foreach ($prop in $readOnlyProps) {
        if ($LocationObject.ContainsKey($prop)) {
            $LocationObject.Remove($prop)
        }
    }
    
    # Ensure @odata.type is present for named locations
    if (-not $LocationObject.ContainsKey('@odata.type')) {
        # Default to IP named location if not specified
        $LocationObject['@odata.type'] = '#microsoft.graph.ipNamedLocation'
        Write-Warning "Added default @odata.type for named location"
    }
    
    # Ensure displayName is lowercase (Graph API expects lowercase)
    if ($LocationObject.ContainsKey('DisplayName') -and -not $LocationObject.ContainsKey('displayName')) {
        $LocationObject['displayName'] = $LocationObject['DisplayName']
        $LocationObject.Remove('DisplayName')
    }
    
    # Ensure isTrusted exists for IP locations
    if ($LocationObject['@odata.type'] -eq '#microsoft.graph.ipNamedLocation') {
        if (-not $LocationObject.ContainsKey('isTrusted')) {
            $LocationObject['isTrusted'] = $false
        }
        
        # CRITICAL: Ensure ipRanges is always an array
        # Backup files may have single items as objects instead of arrays
        if ($LocationObject.ContainsKey('ipRanges')) {
            $ipRanges = $LocationObject['ipRanges']
            if ($null -ne $ipRanges -and $ipRanges -isnot [array]) {
                # Single object - wrap in array
                $LocationObject['ipRanges'] = @($ipRanges)
                Write-Host "  Converted single ipRanges object to array"
            }
        }
    }
    
    # Ensure countriesAndRegions is always an array for country named locations
    if ($LocationObject['@odata.type'] -eq '#microsoft.graph.countryNamedLocation') {
        if ($LocationObject.ContainsKey('countriesAndRegions')) {
            $countries = $LocationObject['countriesAndRegions']
            if ($null -ne $countries -and $countries -isnot [array]) {
                $LocationObject['countriesAndRegions'] = @($countries)
                Write-Host "  Converted single countriesAndRegions to array"
            }
        }
    }
    
    # Remove null values
    $LocationObject = Remove-NullProperties -Object $LocationObject
    
    return $LocationObject
}

# Function to recursively clean policy object - removes readonly props and fixes array values
function Clean-PolicyObject {
    param(
        [object]$Object,
        [string]$ParentKey = ""
    )
    
    if ($null -eq $Object) { return $null }
    
    if ($Object -is [hashtable] -or $Object -is [System.Collections.IDictionary]) {
        # Load field exclusion lists once per script invocation (script-scope cache avoids
        # re-reading files on every recursive call). Source: runner/scripts/compare-ignore-fields/.
        if (-not $script:_CAIgnorePropsCache) {
            $ignoreConfigDir = Join-Path $PSScriptRoot "..\compare-ignore-fields"
            $commonFields = @()
            $typeFields   = @()
            try { $commonFields = (Get-Content (Join-Path $ignoreConfigDir "common.json") -Raw | ConvertFrom-Json).fields } catch {}
            try { $typeFields = (Get-Content (Join-Path $ignoreConfigDir "conditional-access.json") -Raw | ConvertFrom-Json).fields } catch {}
            # Include PascalCase variants — SDK returns PSCustomObject with PascalCase keys
            $script:_CAIgnorePropsCache = @($commonFields) + @($typeFields) + @(
                'Id', 'CreatedDateTime', 'ModifiedDateTime', 'TemplateId'
            )
        }
        $propsToRemove = $script:_CAIgnorePropsCache

        # Also remove any @odata.context properties
        $keysToRemove = @()
        foreach ($key in @($Object.Keys)) {
            if ($key -in $propsToRemove -or $key -like '*@odata.context*') {
                $keysToRemove += $key
            }
        }
        foreach ($key in $keysToRemove) {
            $Object.Remove($key)
        }
        
        # Special handling for authenticationStrength
        # Built-in authentication strengths have well-known IDs that work across all tenants:
        #   00000000-0000-0000-0000-000000000002 = Multifactor authentication
        #   00000000-0000-0000-0000-000000000003 = Passwordless MFA
        #   00000000-0000-0000-0000-000000000004 = Phishing-resistant MFA
        # Custom authentication strengths have tenant-specific IDs and won't work cross-tenant
        # NOTE: ConvertFrom-Json creates PSCustomObject, not hashtable, so check for both
        if ($Object.ContainsKey('authenticationStrength') -and 
            ($Object['authenticationStrength'] -is [hashtable] -or $Object['authenticationStrength'] -is [PSCustomObject])) {
            $authStrength = $Object['authenticationStrength']
            # Handle both hashtable (['id']) and PSCustomObject (.id) access
            $authStrengthId = if ($authStrength -is [hashtable]) { $authStrength['id'] } else { $authStrength.id }
            
            # Check if this is a built-in authentication strength (IDs starting with all zeros)
            $isBuiltIn = $authStrengthId -and $authStrengthId -match '^00000000-0000-0000-0000-'
            
            if ($isBuiltIn) {
                # Keep only the id reference for built-in auth strengths
                Write-Host "  INFO: Preserving built-in authentication strength: $authStrengthId"
                
                # Create clean authenticationStrength with just the id reference
                $Object['authenticationStrength'] = @{
                    id = $authStrengthId
                }
            }
            else {
                # Custom auth strength - remove it since it won't exist in target tenant
                $Object.Remove('authenticationStrength')
                Write-Host "  WARNING: Removed custom authenticationStrength (ID: $authStrengthId) - custom auth strengths must be created separately"
                
                # If this is grantControls and there are no builtInControls, add MFA as a fallback
                # This prevents "InvalidControls" error
                if ($ParentKey -eq 'grantControls') {
                    if (-not $Object.ContainsKey('builtInControls') -or $null -eq $Object['builtInControls'] -or 
                        ($Object['builtInControls'] -is [array] -and $Object['builtInControls'].Count -eq 0)) {
                        $Object['builtInControls'] = @('mfa')
                        Write-Host "  INFO: Added MFA as fallback grant control since authenticationStrength was removed"
                    }
                }
            }
        }
        
        # If authenticationStrength is present, ensure builtInControls is empty array (not null/removed)
        # Graph API requires explicit empty array to clear existing MFA when using authenticationStrength
        if ($Object.ContainsKey('authenticationStrength') -and $Object['authenticationStrength']) {
            if (-not $Object.ContainsKey('builtInControls') -or $null -eq $Object['builtInControls']) {
                $Object['builtInControls'] = @()
                Write-Host "  INFO: Set builtInControls to empty array (authenticationStrength takes precedence)"
            }
        }
        
        # Special handling for applications object with includeUserActions
        # When includeUserActions is present (e.g., urn:user:registerdevice),
        # includeApplications and excludeApplications must NOT be present at all
        if ($ParentKey -eq 'applications' -and $Object.ContainsKey('includeUserActions') -and $Object['includeUserActions']) {
            if ($Object.ContainsKey('includeApplications')) {
                $Object.Remove('includeApplications')
                Write-Verbose "  Removed includeApplications (incompatible with includeUserActions)"
            }
            if ($Object.ContainsKey('excludeApplications')) {
                $Object.Remove('excludeApplications')
                Write-Verbose "  Removed excludeApplications (incompatible with includeUserActions)"
            }
        }
        
        # Properties that should be arrays (convert single values to arrays)
        $arrayProps = @(
            'includeApplications', 'excludeApplications',
            'includeUsers', 'excludeUsers',
            'includeGroups', 'excludeGroups',
            'includeRoles', 'excludeRoles',
            'includeLocations', 'excludeLocations',
            'includePlatforms', 'excludePlatforms',
            'clientAppTypes',
            'signInRiskLevels', 'userRiskLevels', 'servicePrincipalRiskLevels',
            'builtInControls', 'customAuthenticationFactors', 'termsOfUse',
            'includeAuthenticationContextClassReferences',
            'includeUserActions'
        )
        
        # Convert null array properties to empty arrays (Graph API ignores null but respects [])
        foreach ($arrayProp in $arrayProps) {
            if ($Object.ContainsKey($arrayProp) -and $null -eq $Object[$arrayProp]) {
                $Object[$arrayProp] = @()
            }
        }
        
        # Recursively process all values
        foreach ($key in @($Object.Keys)) {
            $value = $Object[$key]
            
            if ($null -eq $value) {
                continue
            }
            elseif ($key -eq 'authenticationStrength') {
                # Skip recursive processing for authenticationStrength - it was already handled above
                # Recursive processing would remove the 'id' key since 'id' is in propsToRemove
                continue
            }
            elseif ($key -in $arrayProps -and $value -is [string]) {
                # Convert single string to array
                $Object[$key] = @($value)
            }
            
            # Filter optional applications that don't exist in tenant
            if (($key -eq 'excludeApplications' -or $key -eq 'includeApplications') -and 
                $Object[$key] -and $Object[$key] -is [array] -and $Object[$key].Count -gt 0) {
                # Only filter if we have optional applications configured
                if ($script:OptionalApplications -and $script:OptionalApplications.Count -gt 0) {
                    $policyName = if ($ParentKey) { $ParentKey } else { "Unknown Policy" }
                    Write-Verbose "  DEBUG: Filtering $key array (current count: $($Object[$key].Count))"
                    $originalArray = @($Object[$key])
                    # Wrap in @() to ensure result is treated as array even with single element
                    $Object[$key] = @(Remove-OptionalApplications -ApplicationArray $Object[$key] -PolicyName $policyName)
                    # CRITICAL: Update $value to the filtered array so recursive processing uses the filtered version
                    $value = $Object[$key]
                    if ($originalArray.Count -ne $Object[$key].Count) {
                        Write-Host "  DEBUG: $key changed from $($originalArray.Count) to $($Object[$key].Count) items" -ForegroundColor DarkYellow
                    }
                }
            }
            
            if ($value -is [hashtable] -or $value -is [System.Collections.IDictionary]) {
                $Object[$key] = Clean-PolicyObject -Object $value -ParentKey $key
            }
            elseif ($value -is [array]) {
                $cleanedArray = @()
                foreach ($item in $value) {
                    $cleaned = Clean-PolicyObject -Object $item -ParentKey $key
                    if ($null -ne $cleaned) {
                        $cleanedArray += $cleaned
                    }
                }
                $Object[$key] = $cleanedArray
            }
        }
        
        return $Object
    }
    else {
        return $Object
    }
}

# Function to clean up policy object for Graph API
function Remove-ReadOnlyProperties {
    param([hashtable]$PolicyObject)
    
    # First, flatten AdditionalProperties into the root object (for policies)
    if ($PolicyObject.ContainsKey('AdditionalProperties') -and $PolicyObject['AdditionalProperties']) {
        $additionalProps = $PolicyObject['AdditionalProperties']
        if ($additionalProps -is [hashtable] -or $additionalProps -is [System.Collections.IDictionary]) {
            foreach ($key in @($additionalProps.Keys)) {
                if (-not $PolicyObject.ContainsKey($key)) {
                    $PolicyObject[$key] = $additionalProps[$key]
                }
            }
        }
    }
    
    # Clean the policy object (remove readonly props, fix arrays, etc.)
    $PolicyObject = Clean-PolicyObject -Object $PolicyObject
    
    # Recursively remove all null values and empty objects
    $PolicyObject = Remove-NullProperties -Object $PolicyObject
    
    return $PolicyObject
}

# Function to create or update a named location
function Compare-NamedLocationProperties {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Existing,
        [Parameter(Mandatory=$true)]
        [hashtable]$Baseline
    )
    
    $differences = @()
    $details = @()
    
    # Get the odata type to determine what properties to compare
    $odataType = $Baseline['@odata.type']
    
    if ($odataType -like '*ipNamedLocation*') {
        # Compare IP ranges
        $existingRanges = @($Existing.AdditionalProperties.ipRanges | ForEach-Object { $_.cidrAddress }) | Sort-Object
        $baselineRanges = @($Baseline.ipRanges | ForEach-Object { $_.cidrAddress }) | Sort-Object
        
        $rangesMatch = ($existingRanges -join ',') -eq ($baselineRanges -join ',')
        if (-not $rangesMatch) {
            $differences += "ipRanges"
            $added = $baselineRanges | Where-Object { $_ -notin $existingRanges }
            $removed = $existingRanges | Where-Object { $_ -notin $baselineRanges }
            if ($added.Count -gt 0) {
                $details += "  IP Ranges to ADD: $($added -join ', ')"
            }
            if ($removed.Count -gt 0) {
                $details += "  IP Ranges to REMOVE: $($removed -join ', ')"
            }
        }
        
        # Compare isTrusted
        $existingTrusted = $Existing.AdditionalProperties.isTrusted
        $baselineTrusted = $Baseline.isTrusted
        if ($existingTrusted -ne $baselineTrusted) {
            $differences += "isTrusted"
            $details += "  isTrusted: $existingTrusted → $baselineTrusted"
        }
    }
    elseif ($odataType -like '*countryNamedLocation*') {
        # Compare countries
        $existingCountries = @($Existing.AdditionalProperties.countriesAndRegions) | Sort-Object
        $baselineCountries = @($Baseline.countriesAndRegions) | Sort-Object
        
        if (($existingCountries -join ',') -ne ($baselineCountries -join ',')) {
            $differences += "countriesAndRegions"
            $added = $baselineCountries | Where-Object { $_ -notin $existingCountries }
            $removed = $existingCountries | Where-Object { $_ -notin $baselineCountries }
            if ($added.Count -gt 0) {
                $details += "  Countries to ADD: $($added -join ', ')"
            }
            if ($removed.Count -gt 0) {
                $details += "  Countries to REMOVE: $($removed -join ', ')"
            }
        }
        
        # Compare includeUnknownCountriesAndRegions
        if ($Existing.AdditionalProperties.includeUnknownCountriesAndRegions -ne $Baseline.includeUnknownCountriesAndRegions) {
            $differences += "includeUnknownCountriesAndRegions"
            $details += "  includeUnknownCountriesAndRegions: $($Existing.AdditionalProperties.includeUnknownCountriesAndRegions) → $($Baseline.includeUnknownCountriesAndRegions)"
        }
    }
    
    return @{ Differences = $differences; Details = $details }
}

function Set-NamedLocation {
    param(
        [Parameter(Mandatory=$true)]
        [object]$LocationConfig
    )
    
    Write-Host "`n##[group]Processing named location: $($LocationConfig.DisplayName)"
    
    try {
        # Check if named location already exists
        $existingLocation = Get-MgIdentityConditionalAccessNamedLocation -Filter "displayName eq '$($LocationConfig.DisplayName)'" -ErrorAction SilentlyContinue
        
        # Convert LocationConfig to hashtable and prepare for API
        $locationParams = ConvertTo-HashtableRecursive -InputObject ($LocationConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
        $locationParams = Prepare-NamedLocationForApi -LocationObject $locationParams
        
        Write-Verbose "Named location payload: $($locationParams | ConvertTo-Json -Depth 5 -Compress)"
        
        # Build monitor config from sidecar (applies to both PATCH and POST)
        $nlMonitorConfig = $null
        if ($LocationConfig._monitorConfig) {
            $nlMonitorConfig = @{}
            if ($LocationConfig._monitorConfig.Include) { $nlMonitorConfig['Include'] = @($LocationConfig._monitorConfig.Include) }
            if ($LocationConfig._monitorConfig.Exclude) { $nlMonitorConfig['Exclude'] = @($LocationConfig._monitorConfig.Exclude) }
            if ($nlMonitorConfig.Count -eq 0) { $nlMonitorConfig = $null }
        }

        # Build JSON for create — apply monitor filter so excluded fields are never written
        $createLocParams = if ($nlMonitorConfig) { Apply-MonitorFilter -PolicyObject $locationParams -MonitorConfig $nlMonitorConfig } else { $locationParams }
        $bodyJson = $createLocParams | ConvertTo-Json -Depth 10 -Compress
        
        if ($existingLocation) {
            Write-Host "Named location already exists: $($existingLocation.Id)"

            # Honor deployBehavior from sibling .config.json (injected during load)
            $deployBehavior = if ($LocationConfig.deployBehavior) { $LocationConfig.deployBehavior } else { "alwaysDeploy" }
            if ($deployBehavior -eq "deployIfNotExists") {
                Write-Host "✓ Named location exists (skipping - deployBehavior is deployIfNotExists)"
                return [PSCustomObject]@{
                    Id = $existingLocation.Id
                    DisplayName = $existingLocation.DisplayName
                    Status = "No changes"
                    Details = @("deployBehavior: deployIfNotExists")
                }
            }
            
            $compareLocParams = if ($nlMonitorConfig) { Apply-MonitorFilter -PolicyObject $locationParams -MonitorConfig $nlMonitorConfig } else { $locationParams }

            # Check if there are actual differences
            $comparison = Compare-NamedLocationProperties -Existing $existingLocation -Baseline $compareLocParams
            $differences = $comparison.Differences
            $comparisonDetails = $comparison.Details
            
            if ($differences.Count -eq 0) {
                Write-Host "✓ Named location is up to date - no changes needed"
                return [PSCustomObject]@{
                    Id = $existingLocation.Id
                    DisplayName = $existingLocation.DisplayName
                    Status = "No changes"
                    Details = @()
                }
            }
            
            Write-Host "  Changes detected in: $($differences -join ', ')"
            foreach ($detail in $comparisonDetails) {
                Write-Host "  $detail" -ForegroundColor DarkYellow
            }
            
            # For WhatIf mode, show what would be updated
            # Build Changes object for pipeline display (with ModifiedValues for long values)
            $modifiedStrings = @($comparisonDetails | ForEach-Object { $_.Trim() })
            $modifiedValuesMap = @{}
            foreach ($detailLine in $modifiedStrings) {
                if ($detailLine -match '^(.+?):\s+(.+?)\s+→\s+(.+)$') {
                    $propKey   = $Matches[1].Trim()
                    $existPart = $Matches[2].Trim()
                    $desirPart = $Matches[3].Trim()
                    if ($existPart.Length -gt 60 -or $desirPart.Length -gt 60) {
                        $modifiedValuesMap[$propKey] = @{ Existing = $existPart; Desired = $desirPart }
                    }
                }
            }
            $changesObj = @{ Modified = $modifiedStrings; ModifiedValues = $modifiedValuesMap }
            
            if ($PSCmdlet.ShouldProcess($LocationConfig.DisplayName, "Update named location")) {
                $uri = "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations/$($existingLocation.Id)"
                # If a monitor config is active, PATCH only the monitored fields
                $patchLocParams = if ($nlMonitorConfig) { Apply-MonitorFilter -PolicyObject $locationParams -MonitorConfig $nlMonitorConfig } else { $locationParams }
                $response = Invoke-MgGraphRequest -Method PATCH -Uri $uri -Body ($patchLocParams | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
                Write-Host "✓ Named location updated successfully"
                return [PSCustomObject]@{
                    Id = $existingLocation.Id
                    DisplayName = $existingLocation.DisplayName
                    Status = "Updated"
                    Details = $comparisonDetails
                    Changes = $changesObj
                }
            }
            else {
                Write-Host "[WhatIf] Would UPDATE named location: $($LocationConfig.DisplayName)"
                return [PSCustomObject]@{
                    DisplayName = $LocationConfig.DisplayName
                    Id = $existingLocation.Id
                    Status = "Would UPDATE"
                    Details = $comparisonDetails
                    Changes = $changesObj
                }
            }
        }
        else {
            # Create new named location
            Write-Host "Named location does not exist - creating new location"
            
            if ($PSCmdlet.ShouldProcess($LocationConfig.DisplayName, "Create named location")) {
                $uri = "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations"
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body $bodyJson -ContentType "application/json"
                Write-Host "✓ Named location created successfully"
                Write-Host "  Location ID: $($response.id)"
                return [PSCustomObject]@{
                    Id = $response.id
                    DisplayName = $response.displayName
                    Status = "Created"
                    Details = @()
                }
            }
            else {
                Write-Host "[WhatIf] Would CREATE named location: $($LocationConfig.DisplayName)"
                return [PSCustomObject]@{
                    DisplayName = $LocationConfig.DisplayName
                    Id = "(new)"
                    Status = "Would CREATE"
                    Details = @()
                }
            }
        }
    }
    catch {
        Write-Host "##[error]Failed to process named location: $_"
        throw
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# Helper function to get a property value with case-insensitive matching
# This handles both PowerShell cmdlet output (PascalCase) and direct API responses (camelCase)
function Get-PropertyValue {
    param(
        [object]$Object,
        [string]$PropertyName
    )
    
    if ($null -eq $Object) { return $null }
    
    # Try exact match first
    if ($Object.PSObject.Properties[$PropertyName]) {
        return $Object.$PropertyName
    }
    
    # Try camelCase version
    $camelCase = $PropertyName.Substring(0,1).ToLower() + $PropertyName.Substring(1)
    if ($Object.PSObject.Properties[$camelCase]) {
        return $Object.$camelCase
    }
    
    # Try PascalCase version
    $pascalCase = $PropertyName.Substring(0,1).ToUpper() + $PropertyName.Substring(1)
    if ($Object.PSObject.Properties[$pascalCase]) {
        return $Object.$pascalCase
    }
    
    # For hashtables, try dictionary access
    if ($Object -is [hashtable]) {
        if ($Object.ContainsKey($PropertyName)) { return $Object[$PropertyName] }
        if ($Object.ContainsKey($camelCase)) { return $Object[$camelCase] }
        if ($Object.ContainsKey($pascalCase)) { return $Object[$pascalCase] }
    }
    
    return $null
}

# Function to compare CA policy properties and detect meaningful changes
function Compare-CAPolicyProperties {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Existing,
        [Parameter(Mandatory=$true)]
        [hashtable]$Baseline
    )
    
    $differences = @()
    $details = @()
    
    # Compare state (handle both PascalCase from cmdlet and camelCase from beta API)
    $existingState = Get-PropertyValue -Object $Existing -PropertyName 'State'
    if ($existingState -ne $Baseline.state) {
        $differences += "state"
        $details += "  State: $existingState → $($Baseline.state)"
    }
    
    # Get conditions objects (handle both casings)
    $existingConditions = Get-PropertyValue -Object $Existing -PropertyName 'Conditions'
    
    # Compare conditions - users
    if ($Baseline.ContainsKey('conditions') -and $Baseline.conditions.ContainsKey('users')) {
        $existingUsers = Get-PropertyValue -Object $existingConditions -PropertyName 'Users'
        $baselineUsers = $Baseline.conditions.users
        
        # Compare includeUsers
        $existingInclude = @(Get-PropertyValue -Object $existingUsers -PropertyName 'IncludeUsers') | Sort-Object
        $baselineInclude = @($baselineUsers.includeUsers) | Sort-Object
        if (($existingInclude -join ',') -ne ($baselineInclude -join ',')) {
            $differences += "conditions.users.includeUsers"
            $details += "  Include Users: [$($existingInclude -join ', ')] → [$($baselineInclude -join ', ')]"
        }
        
        # Compare excludeUsers
        $existingExclude = @(Get-PropertyValue -Object $existingUsers -PropertyName 'ExcludeUsers') | Sort-Object
        $baselineExclude = @($baselineUsers.excludeUsers) | Sort-Object
        if (($existingExclude -join ',') -ne ($baselineExclude -join ',')) {
            $differences += "conditions.users.excludeUsers"
            $added = $baselineExclude | Where-Object { $_ -notin $existingExclude }
            $removed = $existingExclude | Where-Object { $_ -notin $baselineExclude }
            if ($added) { $details += "  Exclude Users ADD: $($added -join ', ')" }
            if ($removed) { $details += "  Exclude Users REMOVE: $($removed -join ', ')" }
        }
        
        # Compare includeGroups
        $existingIncludeGroups = @(Get-PropertyValue -Object $existingUsers -PropertyName 'IncludeGroups') | Sort-Object
        $baselineIncludeGroups = @($baselineUsers.includeGroups) | Sort-Object
        if (($existingIncludeGroups -join ',') -ne ($baselineIncludeGroups -join ',')) {
            $differences += "conditions.users.includeGroups"
            $added = $baselineIncludeGroups | Where-Object { $_ -notin $existingIncludeGroups }
            $removed = $existingIncludeGroups | Where-Object { $_ -notin $baselineIncludeGroups }
            if ($added) { $details += "  Include Groups ADD: $($added.Count) group(s)" }
            if ($removed) { $details += "  Include Groups REMOVE: $($removed.Count) group(s)" }
        }
        
        # Compare excludeGroups
        $existingExcludeGroups = @(Get-PropertyValue -Object $existingUsers -PropertyName 'ExcludeGroups') | Sort-Object
        $baselineExcludeGroups = @($baselineUsers.excludeGroups) | Sort-Object
        if (($existingExcludeGroups -join ',') -ne ($baselineExcludeGroups -join ',')) {
            $differences += "conditions.users.excludeGroups"
            $added = $baselineExcludeGroups | Where-Object { $_ -notin $existingExcludeGroups }
            $removed = $existingExcludeGroups | Where-Object { $_ -notin $baselineExcludeGroups }
            if ($added) { $details += "  Exclude Groups ADD: $($added.Count) group(s)" }
            if ($removed) { $details += "  Exclude Groups REMOVE: $($removed.Count) group(s)" }
        }
    }
    
    # Compare conditions - applications
    if ($Baseline.ContainsKey('conditions') -and $Baseline.conditions.ContainsKey('applications')) {
        $existingApps = Get-PropertyValue -Object $existingConditions -PropertyName 'Applications'
        $baselineApps = $Baseline.conditions.applications
        
        $existingIncludeApps = @(Get-PropertyValue -Object $existingApps -PropertyName 'IncludeApplications') | Sort-Object
        $baselineIncludeApps = @($baselineApps.includeApplications) | Sort-Object
        if (($existingIncludeApps -join ',') -ne ($baselineIncludeApps -join ',')) {
            $differences += "conditions.applications.includeApplications"
            $added = $baselineIncludeApps | Where-Object { $_ -notin $existingIncludeApps }
            $removed = $existingIncludeApps | Where-Object { $_ -notin $baselineIncludeApps }
            if ($added) { $details += "  Include Apps ADD: $($added -join ', ')" }
            if ($removed) { $details += "  Include Apps REMOVE: $($removed -join ', ')" }
        }
        
        $existingExcludeApps = @(Get-PropertyValue -Object $existingApps -PropertyName 'ExcludeApplications') | Sort-Object
        $baselineExcludeApps = @($baselineApps.excludeApplications) | Sort-Object
        if (($existingExcludeApps -join ',') -ne ($baselineExcludeApps -join ',')) {
            $differences += "conditions.applications.excludeApplications"
            $added = $baselineExcludeApps | Where-Object { $_ -notin $existingExcludeApps }
            $removed = $existingExcludeApps | Where-Object { $_ -notin $baselineExcludeApps }
            if ($added) { $details += "  Exclude Apps ADD: $($added -join ', ')" }
            if ($removed) { $details += "  Exclude Apps REMOVE: $($removed -join ', ')" }
        }
        
        # Compare applicationFilter
        $existingFilter = Get-PropertyValue -Object $existingApps -PropertyName 'ApplicationFilter'
        $baselineFilter = $baselineApps.applicationFilter
        if ($existingFilter -or $baselineFilter) {
            $existingRule = if ($existingFilter) { Get-PropertyValue -Object $existingFilter -PropertyName 'Rule' } else { $null }
            $baselineRule = if ($baselineFilter) { $baselineFilter.rule } else { $null }
            if ($existingRule -ne $baselineRule) {
                $differences += "conditions.applications.applicationFilter"
                $details += "  Application Filter: '$existingRule' → '$baselineRule'"
            }
        }
    }
    
    # Compare conditions - locations
    if ($Baseline.ContainsKey('conditions') -and $Baseline.conditions.ContainsKey('locations')) {
        $existingLocs = Get-PropertyValue -Object $existingConditions -PropertyName 'Locations'
        $baselineLocs = $Baseline.conditions.locations
        
        $existingIncludeLocs = @(Get-PropertyValue -Object $existingLocs -PropertyName 'IncludeLocations') | Sort-Object
        $baselineIncludeLocs = @($baselineLocs.includeLocations) | Sort-Object
        if (($existingIncludeLocs -join ',') -ne ($baselineIncludeLocs -join ',')) {
            $differences += "conditions.locations.includeLocations"
            $added = $baselineIncludeLocs | Where-Object { $_ -notin $existingIncludeLocs }
            $removed = $existingIncludeLocs | Where-Object { $_ -notin $baselineIncludeLocs }
            if ($added) { $details += "  Include Locations ADD: $($added -join ', ')" }
            if ($removed) { $details += "  Include Locations REMOVE: $($removed -join ', ')" }
        }
        
        $existingExcludeLocs = @(Get-PropertyValue -Object $existingLocs -PropertyName 'ExcludeLocations') | Sort-Object
        $baselineExcludeLocs = @($baselineLocs.excludeLocations) | Sort-Object
        if (($existingExcludeLocs -join ',') -ne ($baselineExcludeLocs -join ',')) {
            $differences += "conditions.locations.excludeLocations"
            $added = $baselineExcludeLocs | Where-Object { $_ -notin $existingExcludeLocs }
            $removed = $existingExcludeLocs | Where-Object { $_ -notin $baselineExcludeLocs }
            if ($added) { $details += "  Exclude Locations ADD: $($added -join ', ')" }
            if ($removed) { $details += "  Exclude Locations REMOVE: $($removed -join ', ')" }
        }
    }
    
    # Compare grantControls
    if ($Baseline.ContainsKey('grantControls')) {
        $existingGrant = Get-PropertyValue -Object $Existing -PropertyName 'GrantControls'
        $baselineGrant = $Baseline.grantControls
        
        if ($existingGrant -and $baselineGrant) {
            $existingBuiltIn = @(Get-PropertyValue -Object $existingGrant -PropertyName 'BuiltInControls') | Sort-Object
            $baselineBuiltIn = @($baselineGrant.builtInControls) | Sort-Object
            if (($existingBuiltIn -join ',') -ne ($baselineBuiltIn -join ',')) {
                $differences += "grantControls.builtInControls"
                $details += "  Grant Controls: [$($existingBuiltIn -join ', ')] → [$($baselineBuiltIn -join ', ')]"
            }
            
            $existingOperator = Get-PropertyValue -Object $existingGrant -PropertyName 'Operator'
            if ($existingOperator -ne $baselineGrant.operator) {
                $differences += "grantControls.operator"
                $details += "  Grant Operator: $existingOperator → $($baselineGrant.operator)"
            }
            
            # Compare authenticationStrength
            $existingAuthStrength = Get-PropertyValue -Object $existingGrant -PropertyName 'AuthenticationStrength'
            $existingAuthStrengthId = if ($existingAuthStrength) { Get-PropertyValue -Object $existingAuthStrength -PropertyName 'Id' } else { $null }
            $baselineAuthStrength = if ($baselineGrant -is [hashtable]) { $baselineGrant['authenticationStrength'] } else { $baselineGrant.authenticationStrength }
            $baselineAuthStrengthId = if ($baselineAuthStrength) { 
                if ($baselineAuthStrength -is [hashtable]) { $baselineAuthStrength['id'] } else { $baselineAuthStrength.id }
            } else { $null }
            
            if ($existingAuthStrengthId -ne $baselineAuthStrengthId) {
                $differences += "grantControls.authenticationStrength"
                $existingAuthName = if ($existingAuthStrength) { 
                    $displayName = Get-PropertyValue -Object $existingAuthStrength -PropertyName 'DisplayName'
                    if ($displayName) { $displayName } 
                    elseif ($existingAuthStrengthId) { "ID: $existingAuthStrengthId" } 
                    else { "none" }
                } else { "none" }
                $baselineAuthName = if ($baselineAuthStrength) { 
                    $displayName = if ($baselineAuthStrength -is [hashtable]) { $baselineAuthStrength['displayName'] } else { $baselineAuthStrength.displayName }
                    if ($displayName) { $displayName }
                    elseif ($baselineAuthStrengthId) { "Phishing-resistant MFA (ID: $baselineAuthStrengthId)" }
                    else { "unknown" }
                } else { "none" }
                $details += "  Authentication Strength: $existingAuthName → $baselineAuthName"
            }
        }
    }
    
    # Compare sessionControls
    if ($Baseline.ContainsKey('sessionControls') -and $Baseline.sessionControls) {
        $existingSession = Get-PropertyValue -Object $Existing -PropertyName 'SessionControls'
        $baselineSession = $Baseline.sessionControls
        
        if ($existingSession -and $baselineSession) {
            # Check signInFrequency
            if ($baselineSession.ContainsKey('signInFrequency')) {
                $existingFreq = Get-PropertyValue -Object $existingSession -PropertyName 'SignInFrequency'
                $baselineFreq = $baselineSession.signInFrequency
                $existingFreqValue = Get-PropertyValue -Object $existingFreq -PropertyName 'Value'
                $existingFreqType = Get-PropertyValue -Object $existingFreq -PropertyName 'Type'
                $existingFreqEnabled = Get-PropertyValue -Object $existingFreq -PropertyName 'IsEnabled'
                if ($existingFreqValue -ne $baselineFreq.value -or 
                    $existingFreqType -ne $baselineFreq.type -or
                    $existingFreqEnabled -ne $baselineFreq.isEnabled) {
                    $differences += "sessionControls.signInFrequency"
                    $details += "  Sign-in Frequency: $existingFreqValue $existingFreqType → $($baselineFreq.value) $($baselineFreq.type)"
                }
            }
            
            # Check persistentBrowser
            if ($baselineSession.ContainsKey('persistentBrowser')) {
                $existingPersist = Get-PropertyValue -Object $existingSession -PropertyName 'PersistentBrowser'
                $baselinePersist = $baselineSession.persistentBrowser
                $existingPersistMode = Get-PropertyValue -Object $existingPersist -PropertyName 'Mode'
                $existingPersistEnabled = Get-PropertyValue -Object $existingPersist -PropertyName 'IsEnabled'
                if ($existingPersistMode -ne $baselinePersist.mode -or
                    $existingPersistEnabled -ne $baselinePersist.isEnabled) {
                    $differences += "sessionControls.persistentBrowser"
                    $details += "  Persistent Browser: $existingPersistMode → $($baselinePersist.mode)"
                }
            }
        }
    }
    
    return @{ Differences = $differences; Details = $details }
}

# Function to create or update a Conditional Access policy
function Set-ConditionalAccessPolicy {
    param(
        [Parameter(Mandatory=$true)]
        [object]$PolicyConfig
    )
    
    Write-Host "`n##[group]Processing policy: $($PolicyConfig.DisplayName)"
    
    try {
        # Check if policy already exists using beta endpoint
        # IMPORTANT: Must use beta endpoint because v1.0 doesn't return policies with Identity Protection features
        # (userRiskLevels, signInRiskLevels, etc.) - those policies appear to not exist when queried via v1.0
        $existingPolicy = $null
        try {
            # Escape single quotes in the display name for OData filter (OData requires '' to escape single quotes)
            $escapedName = $PolicyConfig.DisplayName -replace "'", "''"
            # URL-encode the entire filter value to handle special chars like [ ] & # + in policy names
            $filterValue = "displayName eq '$escapedName'"
            $encodedFilter = [uri]::EscapeDataString($filterValue)
            $checkUri = "https://graph.microsoft.com/beta/identity/conditionalAccess/policies?`$filter=$encodedFilter"
            $response = Invoke-MgGraphRequest -Method GET -Uri $checkUri
            if ($response.value -and $response.value.Count -gt 0) {
                # Convert the response to a more PowerShell-friendly object
                $existingPolicy = $response.value[0]
                # Add State property with proper casing for comparison
                if ($existingPolicy.state) {
                    $existingPolicy | Add-Member -NotePropertyName 'State' -NotePropertyValue $existingPolicy.state -Force
                }
                if ($existingPolicy.id) {
                    $existingPolicy | Add-Member -NotePropertyName 'Id' -NotePropertyValue $existingPolicy.id -Force
                }
                if ($existingPolicy.displayName) {
                    $existingPolicy | Add-Member -NotePropertyName 'DisplayName' -NotePropertyValue $existingPolicy.displayName -Force
                }
            }
        }
        catch {
            Write-Host "  DEBUG: Error checking for existing policy: $_" -ForegroundColor DarkGray
            $existingPolicy = $null
        }
        
        # Convert PolicyConfig to hashtable and clean it up
        $policyParams = ConvertTo-HashtableRecursive -InputObject ($PolicyConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
        $policyParams = Remove-ReadOnlyProperties -PolicyObject $policyParams

        # Build monitor config from sidecar up-front — applies to both PATCH and POST (create)
        $monitorConfig = $null
        if ($PolicyConfig._monitorConfig) {
            $monitorConfig = @{}
            if ($PolicyConfig._monitorConfig.Include) { $monitorConfig['Include'] = @($PolicyConfig._monitorConfig.Include) }
            if ($PolicyConfig._monitorConfig.Exclude) { $monitorConfig['Exclude'] = @($PolicyConfig._monitorConfig.Exclude) }
            if ($monitorConfig.Count -eq 0) { $monitorConfig = $null }
        }

        # Debug: Log applications section if it was filtered
        if ($policyParams.ContainsKey('conditions') -and $policyParams.conditions.ContainsKey('applications')) {
            $apps = $policyParams.conditions.applications
            if ($apps.excludeApplications) {
                Write-Verbose "  DEBUG: excludeApplications after processing: $($apps.excludeApplications -join ', ') (count: $($apps.excludeApplications.Count))"
            }
            if ($apps.includeApplications) {
                Write-Verbose "  DEBUG: includeApplications after processing: $($apps.includeApplications -join ', ')"
            }
        }
        
        if ($existingPolicy) {
            $existingId = Get-PropertyValue -Object $existingPolicy -PropertyName 'Id'
            $existingDisplayName = Get-PropertyValue -Object $existingPolicy -PropertyName 'DisplayName'
            Write-Host "Policy already exists: $existingId"

            # Honor deployBehavior from sibling .config.json (injected during load)
            $deployBehavior = if ($PolicyConfig.deployBehavior) { $PolicyConfig.deployBehavior } else { "alwaysDeploy" }
            if ($deployBehavior -eq "deployIfNotExists") {
                Write-Host "✓ Policy exists (skipping - deployBehavior is deployIfNotExists)"
                return [PSCustomObject]@{ Policy = $existingPolicy; Action = "NoChange"; Details = @("deployBehavior: deployIfNotExists") }
            }
            
            # Handle state differences based on configured stateSync mode
            $existingState = Get-PropertyValue -Object $existingPolicy -PropertyName 'State'
            $baselineState = $policyParams.state
            $stateSyncMode = $script:Options.conditionalAccess.stateSync

            # Per-policy override: check config/conditional-access/policies/<PolicyName>.config.json in tenant repo
            if ($TenantRepoPath) {
                $policyConfigFile = Join-Path $TenantRepoPath "config" "conditional-access" "policies" "$($PolicyConfig.DisplayName).config.json"
                if (Test-Path $policyConfigFile) {
                    try {
                        $policyConfig = Get-Content $policyConfigFile -Raw | ConvertFrom-Json
                        if ($policyConfig.stateSync) {
                            $stateSyncMode = $policyConfig.stateSync
                            Write-Host "  Per-policy stateSync override: $stateSyncMode (from $policyConfigFile)"
                        }
                    }
                    catch {
                        Write-Host "##[warning]Failed to read per-policy config: $_"
                    }
                }
            }

            # Check if state differs and handle based on sync mode
            if ($existingState -ne $baselineState) {
                switch ($stateSyncMode) {
                    "preserve" {
                        # Don't change state - skip if disabled in tenant but enabled in baseline
                        if ($existingState -eq "disabled" -and $baselineState -eq "enabled") {
                            Write-Host "##[warning]Policy is DISABLED in tenant but ENABLED in baseline"
                            Write-Host "  Skipping state change (stateSync: preserve)"
                            Write-Host "  To change this behavior, set stateSync to 'baseline' in config/conditional-access/config.json or config/conditional-access/policies/$($PolicyConfig.DisplayName).config.json"
                            
                            # Override the baseline state to match existing (so we don't report state as a change)
                            $policyParams.state = $existingState
                        }
                        elseif ($existingState -eq "enabled" -and $baselineState -eq "disabled") {
                            Write-Host "##[warning]Policy is ENABLED in tenant but DISABLED in baseline"
                            Write-Host "  Skipping state change (stateSync: preserve)"
                            
                            # Override the baseline state to match existing
                            $policyParams.state = $existingState
                        }
                    }
                    "enableOnly" {
                        # Only enable policies, never disable them
                        if ($existingState -eq "enabled" -and $baselineState -eq "disabled") {
                            Write-Host "##[warning]Policy is ENABLED in tenant but DISABLED in baseline"
                            Write-Host "  Keeping enabled (stateSync: enableOnly)"
                            
                            # Override to keep enabled
                            $policyParams.state = $existingState
                        }
                        else {
                            Write-Host "  State will change: $existingState → $baselineState (stateSync: enableOnly)"
                        }
                    }
                    "baseline" {
                        # Always sync to baseline state
                        if ($existingState -ne $baselineState) {
                            Write-Host "  State will change: $existingState → $baselineState (stateSync: baseline)"
                        }
                    }
                    default {
                        Write-Host "##[warning]Unknown stateSync mode: $stateSyncMode (treating as 'preserve')"
                        $policyParams.state = $existingState
                    }
                }
            }
            
            # Apply field-monitor filter: compare only monitored fields (if sidecar present)
            $compareParams = if ($monitorConfig) { Apply-MonitorFilter -PolicyObject $policyParams -MonitorConfig $monitorConfig } else { $policyParams }

            # Check if there are actual differences
            $comparison = Compare-CAPolicyProperties -Existing $existingPolicy -Baseline $compareParams
            $differences = $comparison.Differences
            $comparisonDetails = $comparison.Details
            
            if ($differences.Count -eq 0) {
                Write-Host "✓ Policy is up to date - no changes needed"
                return [PSCustomObject]@{
                    Id = $existingId
                    DisplayName = $existingDisplayName
                    State = $existingState
                    Status = "No changes"
                    Details = @()
                }
            }
            
            Write-Host "  Changes detected in: $($differences -join ', ')"
            foreach ($detail in $comparisonDetails) {
                Write-Host "  $detail" -ForegroundColor DarkYellow
            }
            
            # Build Changes object for pipeline display (with ModifiedValues for long values)
            $modifiedStrings = @($comparisonDetails | ForEach-Object { $_.Trim() })
            $modifiedValuesMap = @{}
            foreach ($detailLine in $modifiedStrings) {
                if ($detailLine -match '^(.+?):\s+(.+?)\s+→\s+(.+)$') {
                    $propKey   = $Matches[1].Trim()
                    $existPart = $Matches[2].Trim()
                    $desirPart = $Matches[3].Trim()
                    if ($existPart.Length -gt 60 -or $desirPart.Length -gt 60) {
                        $modifiedValuesMap[$propKey] = @{ Existing = $existPart; Desired = $desirPart }
                    }
                }
            }
            $changesObj = @{ Modified = $modifiedStrings; ModifiedValues = $modifiedValuesMap }
            
            # For WhatIf mode, show what would be updated
            if ($PSCmdlet.ShouldProcess($PolicyConfig.DisplayName, "Update Conditional Access policy")) {
                # Use beta endpoint to support Identity Protection features (userRiskLevels, etc.)
                $updateUri = "https://graph.microsoft.com/beta/identity/conditionalAccess/policies/$existingId"
                # If a monitor config is active, PATCH only the monitored fields
                $patchParams = if ($monitorConfig) { Apply-MonitorFilter -PolicyObject $policyParams -MonitorConfig $monitorConfig } else { $policyParams }
                $bodyJson = $patchParams | ConvertTo-Json -Depth 20 -Compress
                Invoke-MgGraphRequest -Method PATCH -Uri $updateUri -Body $bodyJson -ContentType "application/json" | Out-Null
                Write-Host "✓ Policy updated successfully"
                return [PSCustomObject]@{
                    Id = $existingId
                    DisplayName = $existingDisplayName
                    State = $existingState
                    Status = "Updated"
                    Details = $comparisonDetails
                    Changes = $changesObj
                }
            }
            else {
                Write-Host "[WhatIf] Would UPDATE policy: $($PolicyConfig.DisplayName)"
                return [PSCustomObject]@{
                    DisplayName = $PolicyConfig.DisplayName
                    Id = $existingId
                    State = $existingState
                    Status = "Would UPDATE"
                    Details = $comparisonDetails
                    Changes = $changesObj
                }
            }
        }
        else {
            # Create new policy
            Write-Host "Policy does not exist - creating new policy"
            
            if ($PSCmdlet.ShouldProcess($PolicyConfig.DisplayName, "Create Conditional Access policy")) {
                # Use beta endpoint to support Identity Protection features (userRiskLevels, etc.)
                $createUri = "https://graph.microsoft.com/beta/identity/conditionalAccess/policies"
                # Apply monitor filter so excluded fields are not written on initial creation
                $createPolicyParams = if ($monitorConfig) { Apply-MonitorFilter -PolicyObject $policyParams -MonitorConfig $monitorConfig } else { $policyParams }
                $bodyJson = $createPolicyParams | ConvertTo-Json -Depth 20 -Compress
                
                # Debug: Output the JSON payload being sent
                Write-Host "##[debug]JSON Payload for policy '$($PolicyConfig.DisplayName)':" -ForegroundColor DarkGray
                Write-Host "##[debug]$($createPolicyParams | ConvertTo-Json -Depth 20)" -ForegroundColor DarkGray
                
                $newPolicy = Invoke-MgGraphRequest -Method POST -Uri $createUri -Body $bodyJson -ContentType "application/json"
                Write-Host "✓ Policy created successfully"
                Write-Host "  Policy ID: $($newPolicy.id)"
                return [PSCustomObject]@{
                    Id = $newPolicy.id
                    DisplayName = $newPolicy.displayName
                    State = $newPolicy.state
                    Status = "Created"
                    Details = @()
                }
            }
            else {
                Write-Host "[WhatIf] Would CREATE policy: $($PolicyConfig.DisplayName)"
                return [PSCustomObject]@{
                    DisplayName = $PolicyConfig.DisplayName
                    Id = "(new)"
                    State = $PolicyConfig.State
                    Status = "Would CREATE"
                    Details = @()
                }
            }
        }
    }
    catch {
        Write-Host "##[error]Failed to process policy: $_"
        throw
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# ============================================================================
# DUPLICATE POLICY CLEANUP
# ============================================================================
# This function detects and removes duplicate CA policies and named locations
# Duplicates are identified by displayName - keeps the oldest one (by createdDateTime)

function Remove-DuplicateCAResources {
    Write-Host "`n##[section]Checking for Duplicate CA Policies & Named Locations"
    
    $duplicatesRemoved = 0
    $duplicatesFound = @()
    
    # Check Named Locations first
    Write-Host "  Checking Named Locations..." -NoNewline
    try {
        $namedLocations = @()
        $uri = "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations"
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            $namedLocations += $response.value
            $uri = $response.'@odata.nextLink'
        } while ($uri)
        
        $grouped = $namedLocations | Group-Object -Property displayName | Where-Object { $_.Count -gt 1 }
        
        if ($grouped.Count -eq 0) {
            Write-Host " ✓ no duplicates"
        }
        else {
            Write-Host " found $($grouped.Count) duplicate(s)!"
            foreach ($group in $grouped) {
                $locationName = $group.Name
                $locations = $group.Group | Sort-Object { 
                    if ($_.createdDateTime) { [datetime]$_.createdDateTime } else { [datetime]::MaxValue }
                }
                
                $keepLocation = $locations[0]
                $deleteLocations = $locations | Select-Object -Skip 1
                
                Write-Host "    '$locationName': keeping ID $($keepLocation.id), removing $($deleteLocations.Count) duplicate(s)"
                
                foreach ($dupLocation in $deleteLocations) {
                    try {
                        $deleteUri = "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations/$($dupLocation.id)"
                        Invoke-MgGraphRequest -Method DELETE -Uri $deleteUri
                        Write-Host "      ✓ Deleted duplicate: $($dupLocation.id)" -ForegroundColor Green
                        $duplicatesRemoved++
                        $duplicatesFound += @{
                            ResourceType = "NamedLocation"
                            Name = $locationName
                            DeletedId = $dupLocation.id
                            KeptId = $keepLocation.id
                        }
                    }
                    catch {
                        Write-Host "      ✗ Failed to delete $($dupLocation.id): $_" -ForegroundColor Red
                    }
                }
            }
        }
    }
    catch {
        Write-Host " ✗ Error: $_" -ForegroundColor Red
    }
    
    # Check Conditional Access Policies
    Write-Host "  Checking Conditional Access Policies..." -NoNewline
    try {
        $caPolicies = @()
        $uri = "https://graph.microsoft.com/beta/identity/conditionalAccess/policies"
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            $caPolicies += $response.value
            $uri = $response.'@odata.nextLink'
        } while ($uri)
        
        $grouped = $caPolicies | Group-Object -Property displayName | Where-Object { $_.Count -gt 1 }
        
        if ($grouped.Count -eq 0) {
            Write-Host " ✓ no duplicates"
        }
        else {
            Write-Host " found $($grouped.Count) duplicate(s)!"
            foreach ($group in $grouped) {
                $policyName = $group.Name
                $policies = $group.Group | Sort-Object { 
                    if ($_.createdDateTime) { [datetime]$_.createdDateTime } else { [datetime]::MaxValue }
                }
                
                $keepPolicy = $policies[0]
                $deletePolicies = $policies | Select-Object -Skip 1
                
                Write-Host "    '$policyName': keeping ID $($keepPolicy.id), removing $($deletePolicies.Count) duplicate(s)"
                
                foreach ($dupPolicy in $deletePolicies) {
                    try {
                        $deleteUri = "https://graph.microsoft.com/beta/identity/conditionalAccess/policies/$($dupPolicy.id)"
                        Invoke-MgGraphRequest -Method DELETE -Uri $deleteUri
                        Write-Host "      ✓ Deleted duplicate: $($dupPolicy.id)" -ForegroundColor Green
                        $duplicatesRemoved++
                        $duplicatesFound += @{
                            ResourceType = "ConditionalAccessPolicy"
                            Name = $policyName
                            DeletedId = $dupPolicy.id
                            KeptId = $keepPolicy.id
                        }
                    }
                    catch {
                        Write-Host "      ✗ Failed to delete $($dupPolicy.id): $_" -ForegroundColor Red
                    }
                }
            }
        }
    }
    catch {
        Write-Host " ✗ Error: $_" -ForegroundColor Red
    }
    
    if ($duplicatesRemoved -gt 0) {
        Write-Host "`n##[warning]Removed $duplicatesRemoved duplicate CA resource(s)" -ForegroundColor Yellow
        Write-Host "  Duplicate cleanup complete. Proceeding with deployment..."
    }
    else {
        Write-Host "`n  ✓ No duplicate CA policies or named locations found - tenant is clean"
    }
    
    return $duplicatesFound
}

# Run duplicate cleanup before deployment
$caCleanupResults = Remove-DuplicateCAResources

# STEP 2: Deploy named locations FIRST (before policies that reference them)
Write-Host "`n##[section]Creating/Updating Named Locations"
$namedLocationResults = @()
$locCreatedCount = 0
$locUpdatedCount = 0
$locNoChangeCount = 0
$locWouldCreateCount = 0
$locWouldUpdateCount = 0
$namedLocationErrorCount = 0

foreach ($locationConfig in $namedLocationConfigs) {
    try {
        $result = Set-NamedLocation -LocationConfig $locationConfig
        $namedLocationResults += [PSCustomObject]@{
            DisplayName = $locationConfig.DisplayName
            Id = $result.Id
            Status = $result.Status
            Changes = if ($result.Changes) { $result.Changes } else { $null }
            FilePath = $locationConfig._SourceFile
        }
        
        switch ($result.Status) {
            "Created" { $locCreatedCount++ }
            "Updated" { $locUpdatedCount++ }
            "No changes" { $locNoChangeCount++ }
            "Would CREATE" { $locWouldCreateCount++ }
            "Would UPDATE" { $locWouldUpdateCount++ }
        }
    }
    catch {
        $namedLocationResults += [PSCustomObject]@{
            DisplayName = $locationConfig.DisplayName
            Id = $null
            Status = "Failed: $($_.Exception.Message)"
            FilePath = $locationConfig._SourceFile
        }
        $namedLocationErrorCount++
    }
}

# STEP 3: NOW load and resolve policy placeholders (after named locations are created)
# This ensures {{LOCATION:...}} placeholders can be resolved to actual IDs
Write-Host "`n##[section]Loading Policy Configurations"
Write-Host "Loading and resolving placeholders for policies..."

# Clear the placeholder cache to ensure newly created named locations are found
Clear-PlaceholderCache
Write-Host "  Placeholder cache cleared - will look up newly created named locations"

$policyConfigs = @()
$policyLoadErrors = @()  # Track policies that failed to load
$groupsPath = Join-Path (Split-Path $ConfigDirectory -Parent) "groups"

foreach ($file in $policyFiles) {
    try {
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $policyName = if ($config.displayName) { $config.displayName.Trim() } else { $file.BaseName }
        
        # Convert to hashtable and resolve placeholders
        # Named locations should now exist in tenant, so placeholders can be resolved
        $configHash = ConvertTo-HashtableRecursive -InputObject ($config | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
        $configHash = Resolve-Placeholders -ConfigObject $configHash -AllowMissingGroups:$WhatIfPreference -PendingGroupsPath $groupsPath

        # deployBehavior belongs exclusively in the sibling .config.json sidecar.
        # Strip it from the main JSON first (handles any legacy files not yet migrated),
        # then inject the authoritative value from the sidecar.
        $configHash.Remove('deployBehavior')
        $configFile = Join-Path $file.Directory.FullName ($file.BaseName + ".config.json")
        if (Test-Path $configFile) {
            $behaviorConfig = Get-Content $configFile -Raw | ConvertFrom-Json -AsHashtable
            if ($behaviorConfig['deployBehavior']) {
                $configHash['deployBehavior'] = $behaviorConfig['deployBehavior']
            }
        }

        # Read field-monitor config from sibling .monitor.json
        $monitorCfg = Get-MonitorConfig -BaselineFilePath $file.FullName
        if ($monitorCfg) {
            $configHash['_monitorConfig'] = $monitorCfg
            Write-Host "  Field monitoring enabled: $($file.Name) (include=$($monitorCfg.Include -join ',') exclude=$($monitorCfg.Exclude -join ','))"
        }

        # Track source file path for plan-scoped apply
        $configHash['_SourceFile'] = $file.FullName
        
        # Convert back to PSObject
        $config = $configHash | ConvertTo-Json -Depth 10 | ConvertFrom-Json
        if ($config.displayName) { $config.displayName = $config.displayName.Trim() }
        $policyConfigs += $config
        Write-Host "  Loaded policy: $($file.Name)"
    }
    catch {
        $errorMsg = $_.Exception.Message
        # Extract the missing group/location name from the error
        $missingResource = if ($errorMsg -match "Group Name: '([^']+)'") { $matches[1] } 
                          elseif ($errorMsg -match "Location Name: '([^']+)'") { $matches[1] }
                          else { "Unknown" }
        
        Write-Host "##[warning]Failed to load policy $($file.Name): $_"
        
        # Track the error for summary
        $policyLoadErrors += [PSCustomObject]@{
            FileName = $file.Name
            PolicyName = if ($policyName) { $policyName } else { $file.BaseName -replace '\.json$', '' }
            Error = $errorMsg
            MissingResource = $missingResource
        }
    }
}

Write-Host "Policies loaded: $($policyConfigs.Count)"
if ($policyLoadErrors.Count -gt 0) {
    Write-Host "##[warning]Policies with errors: $($policyLoadErrors.Count)" -ForegroundColor Yellow
}

# STEP 4: Deploy Conditional Access policies
Write-Host "`n##[section]Creating/Updating Conditional Access Policies"
$policyResults = @()
$polCreatedCount = 0
$polUpdatedCount = 0
$polNoChangeCount = 0
$polWouldCreateCount = 0
$polWouldUpdateCount = 0
$policyWarningCount = 0
$policyErrorCount = 0
$policyLicenseWarningCount = 0

foreach ($policyConfig in $policyConfigs) {
    try {
        $result = Set-ConditionalAccessPolicy -PolicyConfig $policyConfig
        
        # Check if result indicates a warning (e.g., disabled policy skipped)
        if ($result.Status -eq "Warning") {
            $policyResults += [PSCustomObject]@{
                DisplayName = $policyConfig.DisplayName
                Id = $result.Id
                State = $result.State
                Status = "Warning: $($result.Message)"
                FilePath = $policyConfig._SourceFile
            }
            $policyWarningCount++
        }
        else {
            $policyResults += [PSCustomObject]@{
                DisplayName = $policyConfig.DisplayName
                Id = $result.Id
                State = $result.State
                Status = $result.Status
                Details = if ($result.Details) { $result.Details } else { @() }
                Changes = if ($result.Changes) { $result.Changes } else { $null }
                FilePath = $policyConfig._SourceFile
            }
            
            switch ($result.Status) {
                "Created" { $polCreatedCount++ }
                "Updated" { $polUpdatedCount++ }
                "No changes" { $polNoChangeCount++ }
                "Would CREATE" { $polWouldCreateCount++ }
                "Would UPDATE" { $polWouldUpdateCount++ }
            }
        }
    }
    catch {
        $errorMessage = $_.Exception.Message
        $fullError = $_ | Out-String
        
        # Check for P2 license limitation (error code 1039)
        # The error message may span multiple lines, so check both the exception message and full error
        if ($errorMessage -match "1039" -or $fullError -match "1039" -or 
            $errorMessage -match "premium P2" -or $fullError -match "premium P2") {
            Write-Host "##[warning]Skipped (requires P2 license): $($policyConfig.DisplayName)"
            $policyResults += [PSCustomObject]@{
                DisplayName = $policyConfig.DisplayName
                Id = $null
                State = $null
                Status = "Skipped: Requires Entra ID P2 license"
                FilePath = $policyConfig._SourceFile
            }
            $policyLicenseWarningCount++
        }
        else {
            $policyResults += [PSCustomObject]@{
                DisplayName = $policyConfig.DisplayName
                Id = $null
                State = $null
                Status = "Failed: $errorMessage"
                FilePath = $policyConfig._SourceFile
            }
            $policyErrorCount++
        }
    }
}

# Display summary
Write-Host "`n##[section]Summary"

if ($namedLocationConfigs.Count -gt 0) {
    Write-Host "Named Locations: $($namedLocationConfigs.Count) processed"
    if ($WhatIfPreference) {
        Write-Host "  → Would CREATE: $locWouldCreateCount"
        Write-Host "  → Would UPDATE: $locWouldUpdateCount"
        Write-Host "  ○ No changes needed: $locNoChangeCount"
    }
    else {
        Write-Host "  ✓ Created: $locCreatedCount"
        Write-Host "  ✓ Updated: $locUpdatedCount"
        Write-Host "  ○ No changes needed: $locNoChangeCount"
    }
    if ($namedLocationErrorCount -gt 0) {
        Write-Host "  ✗ Failed: $namedLocationErrorCount"
    }
    Write-Host ""
}

if ($policyConfigs.Count -gt 0 -or $policyLoadErrors.Count -gt 0) {
    $totalPolicies = $policyConfigs.Count + $policyLoadErrors.Count
    Write-Host "Policies: $totalPolicies total ($($policyConfigs.Count) processed, $($policyLoadErrors.Count) failed to load)"
    if ($WhatIfPreference) {
        Write-Host "  → Would CREATE: $polWouldCreateCount"
        Write-Host "  → Would UPDATE: $polWouldUpdateCount"
        Write-Host "  ○ No changes needed: $polNoChangeCount"
    }
    else {
        Write-Host "  ✓ Created: $polCreatedCount"
        Write-Host "  ✓ Updated: $polUpdatedCount"
        Write-Host "  ○ No changes needed: $polNoChangeCount"
    }
    if ($policyWarningCount -gt 0) {
        Write-Host "  ⚠ Warnings: $policyWarningCount (disabled policies skipped)"
    }
    if ($policyLicenseWarningCount -gt 0) {
        Write-Host "  ⚠ Skipped: $policyLicenseWarningCount (requires P2 license)" -ForegroundColor Yellow
    }
    if ($policyErrorCount -gt 0) {
        Write-Host "  ✗ Failed: $policyErrorCount"
    }
    if ($policyLoadErrors.Count -gt 0) {
        Write-Host "  ✗ BLOCKED: $($policyLoadErrors.Count) (missing groups/locations)" -ForegroundColor Red
    }
    Write-Host ""
}

# Show blocked policies with details
if ($policyLoadErrors.Count -gt 0) {
    Write-Host "##[error]BLOCKED POLICIES - Cannot deploy due to missing dependencies:"
    foreach ($err in $policyLoadErrors) {
        Write-Host "  ✗ $($err.PolicyName)" -ForegroundColor Red
        Write-Host "    Missing: $($err.MissingResource)" -ForegroundColor Red
    }
    Write-Host ""
}

# Show results table with status indicators
if ($namedLocationResults.Count -gt 0) {
    Write-Host "Named Location Results:"
    foreach ($r in $namedLocationResults) {
        $icon = switch -Wildcard ($r.Status) {
            "Created" { "✓ CREATED" }
            "Updated" { "✓ UPDATED" }
            "Would CREATE" { "→ WOULD CREATE" }
            "Would UPDATE" { "→ WOULD UPDATE" }
            "No changes" { "○ NO CHANGE" }
            "Failed*" { "✗ FAILED" }
            default { $r.Status }
        }
        Write-Host "  $icon : $($r.DisplayName)"
    }
    Write-Host ""
}

if ($policyResults.Count -gt 0) {
    Write-Host "Policy Results:"
    foreach ($r in $policyResults) {
        $icon = switch -Wildcard ($r.Status) {
            "Created" { "✓ CREATED" }
            "Updated" { "✓ UPDATED" }
            "Would CREATE" { "→ WOULD CREATE" }
            "Would UPDATE" { "→ WOULD UPDATE" }
            "No changes" { "○ NO CHANGE" }
            "Warning*" { "⚠ WARNING" }
            "Skipped*" { "⚠ SKIPPED (P2)" }
            "Failed*" { "✗ FAILED" }
            default { $r.Status }
        }
        Write-Host "  $icon : $($r.DisplayName)"
    }
    Write-Host ""
}

# Show detailed changes section
$allResultsWithDetails = @($namedLocationResults | Where-Object { $_.Details -and $_.Details.Count -gt 0 }) + @($policyResults | Where-Object { $_.Details -and $_.Details.Count -gt 0 })
if ($allResultsWithDetails.Count -gt 0) {
    Write-Host "═══════════════════════════════════════════════════════════════════════════════"
    Write-Host "DETAILED CHANGES"
    Write-Host "═══════════════════════════════════════════════════════════════════════════════"
    Write-Host ""
    
    foreach ($r in $allResultsWithDetails) {
        $type = if ($r.State) { "Policy" } else { "Named Location" }
        Write-Host "┌─ [$type] $($r.DisplayName)"
        foreach ($detail in $r.Details) {
            Write-Host "│  $detail"
        }
        Write-Host "└─────────────────────────────────────────────────────────────────────────────"
        Write-Host ""
    }
}

# Save plan summary if OutputPath is provided
if ($OutputPath) {
    # Add blocked policies to results
    $blockedResults = @()
    foreach ($err in $policyLoadErrors) {
        $blockedResults += [PSCustomObject]@{
            DisplayName = $err.PolicyName
            Status = "BLOCKED: Missing $($err.MissingResource)"
            Details = @("Cannot deploy - missing dependency: $($err.MissingResource)")
        }
    }
    
    $planSummary = @{
        Service = "ConditionalAccess"
        TotalPolicies = $policyConfigs.Count + $namedLocationConfigs.Count + $policyLoadErrors.Count
        CreatedCount = $polCreatedCount + $locCreatedCount
        UpdatedCount = $polUpdatedCount + $locUpdatedCount
        NoChangeCount = $polNoChangeCount + $locNoChangeCount
        WouldCreateCount = $polWouldCreateCount + $locWouldCreateCount
        WouldUpdateCount = $polWouldUpdateCount + $locWouldUpdateCount
        WarningCount = $policyWarningCount
        ErrorCount = $policyErrorCount + $namedLocationErrorCount + $policyLoadErrors.Count
        LicenseSkippedCount = $policyLicenseWarningCount
        BlockedCount = $policyLoadErrors.Count
        Results = @($policyResults) + @($namedLocationResults) + @($blockedResults)
    }
    
    $planSummary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nPlan summary saved to: $OutputPath"
}

if ($policyLoadErrors.Count -gt 0) {
    Write-Host "##[error]$($policyLoadErrors.Count) policy(ies) BLOCKED due to missing groups/locations"
    Write-Host "##[error]These policies cannot be deployed until their dependencies exist"
    exit 1
}
elseif ($policyErrorCount -gt 0 -or $namedLocationErrorCount -gt 0) {
    Write-Host "##[error]Some resources failed to process"
    exit 1
}
elseif ($policyWarningCount -gt 0 -or $policyLicenseWarningCount -gt 0) {
    $warningMessages = @()
    if ($policyWarningCount -gt 0) {
        $warningMessages += "$policyWarningCount disabled policy(ies) were not updated"
    }
    if ($policyLicenseWarningCount -gt 0) {
        $warningMessages += "$policyLicenseWarningCount policy(ies) skipped (require Entra ID P2 license)"
    }
    Write-Host "##[warning]Completed with warnings - $($warningMessages -join '; ')"
    Write-Host "##[command]Conditional Access configuration completed with warnings"
    exit 0  # Don't fail the pipeline for warnings
}
else {
    Write-Host "##[command]All Conditional Access resources configured successfully!"
}
