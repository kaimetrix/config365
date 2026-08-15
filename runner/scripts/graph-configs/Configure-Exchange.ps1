<#
.SYNOPSIS
    Creates and manages Exchange Online policies via Exchange PowerShell

.DESCRIPTION
    Creates and updates Exchange Online transport rules, spam filters, and policies.
    The script is idempotent - it will create policies if they don't exist, or verify/update if they do.

.PARAMETER ConfigDirectory
    Path to the directory containing JSON Exchange policy definition files

.PARAMETER WhatIf
    Show what would be changed without making changes

.PARAMETER OutputPath
    Optional path to save a JSON summary of planned changes

.EXAMPLE
    .\Configure-Exchange.ps1 -ConfigDirectory "baseline-exchange"
    
.EXAMPLE
    .\Configure-Exchange.ps1 -ConfigDirectory "baseline-exchange" -WhatIf -OutputPath "exchange-plan.json"

.NOTES
    Requires ExchangeOnlineManagement module
    Requires certificate-based authentication for app-only access
    
    Environment Variables for Authentication:
    - AZURE_CLIENT_ID / ARM_CLIENT_ID: App registration client ID
    - AZURE_TENANT_ID / ARM_TENANT_ID: Azure AD tenant ID
    - EXCHANGE_ORG_NAME: Organization name (e.g., "contoso.onmicrosoft.com")
    
    Certificate Options (in order of preference):
    1. Azure Key Vault: Set AZURE_KEYVAULT_NAME and optionally EXCHANGE_CERT_NAME
    2. Local thumbprint: Set EXCHANGE_CERT_THUMBPRINT
    3. File path: Set EXCHANGE_CERT_PATH and optionally EXCHANGE_CERT_PASSWORD
    
    Prerequisites:
    - App registration with Exchange.ManageAsApp permission
    - Service principal assigned Exchange Administrator role
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

# Import helper modules
$connectGraphPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $connectGraphPath) { . $connectGraphPath }

$resolverPath = Join-Path $PSScriptRoot "Resolve-Placeholders.ps1"
. $resolverPath

# Import baseline ignore helpers
$ignoreHelpersPath = Join-Path $PSScriptRoot "Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

# Import shared diff helpers
$diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

#region Comparison Helpers

# Load field exclusion lists from the centralized JSON source.
# common.json applies to all policy types; exchange.json is Exchange-specific.
# Both live in runner/scripts/compare-ignore-fields/ — edit there to update everywhere.
# This mirrors the pattern used by Configure-Intune-Helpers.ps1 and Configure-ConditionalAccess.ps1.
$_ignoreDir    = Join-Path $PSScriptRoot "..\compare-ignore-fields"
$_commonFields = try { (Get-Content (Join-Path $_ignoreDir "common.json")   -Raw | ConvertFrom-Json).fields } catch { @() }
$_exchFields   = try { (Get-Content (Join-Path $_ignoreDir "exchange.json") -Raw | ConvertFrom-Json).fields } catch { @() }
$script:IgnoreProperties = @($_commonFields) + @($_exchFields)

function ConvertTo-ComparableHashtable {
    <#
    .SYNOPSIS
        Converts a policy object to a normalized hashtable for comparison
    #>
    param(
        [Parameter(Mandatory=$true)]
        $Policy,
        [string[]]$IgnoreProps = @()
    )
    
    $result = @{}
    
    # IDictionary (includes hashtable) — must be checked before PSObject; hashtables are PSObject-wrapped
    # and PSObject.Properties returns dictionary metadata (Keys, Values, Count), not the actual entries.
    if ($Policy -is [System.Collections.IDictionary]) {
        foreach ($key in $Policy.Keys) {
            if ($key -in $IgnoreProps -or $key -in $script:IgnoreProperties) { continue }
            $result[$key] = $Policy[$key]
        }
    }
    # Handle PSObject
    elseif ($null -ne $Policy.PSObject) {
        foreach ($prop in $Policy.PSObject.Properties) {
            if ($prop.MemberType -notin @('NoteProperty', 'Property')) { continue }
            if ($prop.Name -in $IgnoreProps -or $prop.Name -in $script:IgnoreProperties) { continue }
            if ($prop.Name -like 'PS*') { continue }  # Skip PowerShell internal properties
            
            $result[$prop.Name] = $prop.Value
        }
    }
    
    return $result
}

function Compare-PolicyValues {
    <#
    .SYNOPSIS
        Compares two values, handling nulls, arrays, and nested objects
    #>
    param($Value1, $Value2)
    
    # Both null/empty
    $isEmpty1 = ($null -eq $Value1) -or ($Value1 -is [string] -and [string]::IsNullOrEmpty($Value1)) -or ($Value1 -is [System.Collections.ICollection] -and $Value1.Count -eq 0)
    $isEmpty2 = ($null -eq $Value2) -or ($Value2 -is [string] -and [string]::IsNullOrEmpty($Value2)) -or ($Value2 -is [System.Collections.ICollection] -and $Value2.Count -eq 0)
    
    if ($isEmpty1 -and $isEmpty2) { return $true }
    if ($isEmpty1 -or $isEmpty2) { return $false }
    
    # Arrays
    if ($Value1 -is [System.Collections.ICollection] -and $Value2 -is [System.Collections.ICollection]) {
        $sorted1 = $Value1 | Sort-Object
        $sorted2 = $Value2 | Sort-Object
        return ($sorted1 -join '|') -eq ($sorted2 -join '|')
    }
    
    # Simple comparison
    return "$Value1" -eq "$Value2"
}

function Compare-ExchangePolicyProperties {
    <#
    .SYNOPSIS
        Compares an existing Exchange policy with the desired baseline configuration
    .DESCRIPTION
        Returns a hashtable with IsEquivalent (bool) and Differences (hashtable with Added, Removed, Modified)
    #>
    param(
        [Parameter(Mandatory=$true)]
        $ExistingPolicy,
        
        [Parameter(Mandatory=$true)]
        $DesiredPolicy,

        [Parameter(Mandatory=$false)]
        [string[]]$AdditionalIgnoreProps = @(),

        [Parameter(Mandatory=$false)]
        [switch]$DesiredKeysOnly
    )
    
    $result = @{
        IsEquivalent = $true
        Differences = @{
            Added          = @()
            Removed        = @()
            Modified       = @()
            ModifiedValues = @{}
        }
    }
    
    # Normalize both for comparison, skipping any monitor-excluded fields
    $existing = ConvertTo-ComparableHashtable -Policy $ExistingPolicy -IgnoreProps $AdditionalIgnoreProps
    $desired  = ConvertTo-ComparableHashtable -Policy $DesiredPolicy  -IgnoreProps $AdditionalIgnoreProps
    
    # Get all keys (partial mode: only compare keys present in desired baseline file)
    if ($DesiredKeysOnly) {
        $allKeys = @($desired.Keys) | Sort-Object
    }
    else {
        $allKeys = @()
        $allKeys += @($existing.Keys)
        $allKeys += @($desired.Keys)
        $allKeys = $allKeys | Select-Object -Unique | Sort-Object
    }
    
    foreach ($key in $allKeys) {
        $existsInExisting = $existing.ContainsKey($key)
        $existsInDesired = $desired.ContainsKey($key)
        
        if ($existsInDesired -and -not $existsInExisting) {
            # Property only in desired - it's an addition
            $result.Differences.Added += $key
            $result.IsEquivalent = $false
        }
        elseif ($existsInExisting -and -not $existsInDesired) {
            if ($DesiredKeysOnly) { continue }
            # Property only in existing - we'll set it to baseline value (removal from custom)
            # Only flag if the existing value is meaningful
            $existingValue = $existing[$key]
            if (-not (($null -eq $existingValue) -or ($existingValue -is [string] -and [string]::IsNullOrEmpty($existingValue)) -or ($existingValue -is [System.Collections.ICollection] -and $existingValue.Count -eq 0))) {
                $result.Differences.Removed += $key
                $result.IsEquivalent = $false
            }
        }
        else {
            # Both have it - compare values
            $existingValue = $existing[$key]
            $desiredValue = $desired[$key]
            
            if (-not (Compare-PolicyValues -Value1 $existingValue -Value2 $desiredValue)) {
                $existStr   = Format-PropertyValue $existingValue
                $desiredStr = Format-PropertyValue $desiredValue

                # Store full values for expandable frontend display
                if ($existStr.Length -gt 60 -or $desiredStr.Length -gt 60) {
                    $result.Differences.ModifiedValues[$key] = @{ Existing = $existStr; Desired = $desiredStr }
                }

                $eSummary = if ($existStr.Length   -gt 60) { $existStr.Substring(0, 57)   + "..." } else { $existStr }
                $dSummary = if ($desiredStr.Length -gt 60) { $desiredStr.Substring(0, 57) + "..." } else { $desiredStr }
                $result.Differences.Modified += "${key}: $eSummary → $dSummary"
                $result.IsEquivalent = $false
            }
        }
    }
    
    return $result
}

#endregion

Write-Host "##[section]Configuring Exchange Online Policies"

# Initialize baseline ignore patterns (if TenantBaselinePath provided)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# Load policy configurations from directory
if (-not (Test-Path $ConfigDirectory)) {
    throw "Configuration directory not found: $ConfigDirectory"
}

# Search recursively for JSON files in subdirectories (backup creates transport-rules/, anti-spam-policies/, etc.)
$policyFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File -Recurse | 
    Where-Object {
        $_.Name -notlike "*.assignment.json" -and $_.Name -notlike "*.monitor.json" -and
        $_.DirectoryName -notmatch '[\\/]irm-configuration$' -and
        $_.DirectoryName -notmatch '[\\/]ome-configuration$' -and
        $_.DirectoryName -notmatch '[\\/]aip-service$' -and
        $_.DirectoryName -notmatch '[\\/]aip-service[\\/]configuration$'
    }  # Exclude assignment/monitor sidecars and AIP/IRM/OME (Configure-ExchangeMessageEncryption.ps1)

# Filter out ignored policies based on .baseline-ignore
# Use the baseline folder root so patterns like "exchange/file.json" work correctly
$baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }
$policyFiles = @(Get-FilteredPolicyFiles -PolicyFiles $policyFiles -BaselineRoot $baselineRoot)
$policyFiles = @(Get-GroupExcludedFiles -Files $policyFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)

function Initialize-ExchangeOrgAuditRemediationFlag {
    <#
    .SYNOPSIS
        Reads organization-config/AuditDisabled.json to gate MailboxAuditRemediation.

    .DESCRIPTION
        Plan-scoped apply may include only exchange/mailbox-audit-remediation.json while
        omitting AuditDisabled.json. Remediation still requires the org audit flag, so load
        the prerequisite directly from disk (respecting .baseline-ignore, not apply scope).
    #>
    param(
        [string]$ConfigDirectory,
        [string]$BaselineRoot
    )

    $auditFile = Get-ChildItem -Path $ConfigDirectory -Filter "AuditDisabled.json" -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -match '[\\/]organization-config$' } |
        Select-Object -First 1
    if (-not $auditFile) { return }

    if ((Get-Command Test-PolicyIgnored -ErrorAction SilentlyContinue) -and
        (Test-PolicyIgnored -PolicyPath $auditFile.FullName -BaselineRoot $BaselineRoot)) {
        Write-Host "  Organization audit prerequisite ignored via .baseline-ignore"
        return
    }

    try {
        $configHash = Get-Content $auditFile.FullName -Raw | ConvertFrom-Json |
            ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
        $configHash = Resolve-Placeholders -ConfigObject $configHash
        if ($configHash.ContainsKey('AuditDisabled')) {
            $script:BaselineOrgAuditRemediationEnabled = ($configHash['AuditDisabled'] -eq $false)
            $state = if ($script:BaselineOrgAuditRemediationEnabled) { 'enabled' } else { 'disabled' }
            Write-Host "  Organization audit prerequisite (AuditDisabled=$($configHash['AuditDisabled'])) — remediation $state"
        }
    }
    catch {
        Write-Host "##[warning]Could not read organization-config/AuditDisabled.json for remediation gate: $_"
    }
}

$script:BaselineOrgAuditRemediationEnabled = $false
Initialize-ExchangeOrgAuditRemediationFlag -ConfigDirectory $ConfigDirectory -BaselineRoot $baselineRoot

if ($policyFiles.Count -eq 0) {
    Write-Host "##[warning]No JSON files found in directory or subdirectories: $ConfigDirectory"
    Write-Host "Skipping Exchange configuration"
    exit 0
}

Write-Host "Found $($policyFiles.Count) policy definition(s) in: $ConfigDirectory"
foreach ($file in $policyFiles) {
    $relativePath = $file.FullName.Replace($ConfigDirectory, "").TrimStart("\", "/")
    Write-Host "  - $relativePath"
}

# Helper function to determine policy type from file path
function Get-PolicyTypeFromPath {
    param([string]$FilePath)
    
    if ($FilePath -match "transport-rules") { return "TransportRule" }
    if ($FilePath -match "anti-spam-policies") { return "HostedContentFilterPolicy" }
    if ($FilePath -match "anti-phishing-policies") { return "AntiPhishPolicy" }
    if ($FilePath -match "malware-filter-policies") { return "MalwareFilterPolicy" }
    if ($FilePath -match "connectors[/\\]inbound") { return "InboundConnector" }
    if ($FilePath -match "connectors[/\\]outbound") { return "OutboundConnector" }
    if ($FilePath -match "organization-config[/\\]OrganizationCustomization\.json$") { return "OrganizationCustomization" }
    if ($FilePath -match "organization-config[/\\]") { return "OrganizationConfig" }
    if ($FilePath -match "owa-policies[/\\][^/\\]+[/\\]") { return "OwaMailboxPolicy" }
    if ($FilePath -match "external-in-outlook\.json$") { return "ExternalInOutlook" }
    if ($FilePath -match "mailbox-audit-remediation") { return "MailboxAuditRemediation" }
    if ($FilePath -match "mailbox-audit-status") { return "Unknown" }
    return "Unknown"
}

# Load all policy configurations
$policyConfigs    = @()
$monitorConfigMap = @{}
# BaselineOrgAuditRemediationEnabled set above via Initialize-ExchangeOrgAuditRemediationFlag
foreach ($file in $policyFiles) {
    $relativePath = $file.FullName.Replace($ConfigDirectory, "").TrimStart("\", "/")
    Write-Host "  Loading: $relativePath"
    
    $policyConfig = Get-Content $file.FullName -Raw | ConvertFrom-Json
    
    # Determine policy type from directory structure
    $policyType = Get-PolicyTypeFromPath -FilePath $file.FullName
    
    # Convert to hashtable and resolve placeholders
    $configHash = $policyConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    $configHash = Resolve-Placeholders -ConfigObject $configHash
    
    # Add type and name if not present
    if (-not $configHash.ContainsKey("_PolicyType")) {
        $configHash["_PolicyType"] = $policyType
    }
    if (-not $configHash.ContainsKey("_PolicyName")) {
        $configHash["_PolicyName"] = $file.BaseName
    }

    if ($policyType -eq 'OwaMailboxPolicy') {
        $identity = Split-Path (Split-Path $file.FullName -Parent) -Leaf
        $configHash['_PolicyName'] = $identity
        $configHash['_PolicyDisplayName'] = "$identity/$($file.BaseName)"
    }

    if ($policyType -eq 'ExternalInOutlook') {
        $configHash['_PolicyDisplayName'] = 'External in Outlook'
    }

    # Save routing metadata before the monitor filter runs — an include-only sidecar would
    # otherwise strip _PolicyName/_PolicyType from $configHash, breaking the map lookup below.
    $savedPolicyName = $configHash["_PolicyName"]
    $savedPolicyType = $configHash["_PolicyType"]

    # Apply monitor filter (include/exclude) from sidecar / folder _default.monitor.json
    $monitorConfig = Get-MonitorConfig -BaselineFilePath $file.FullName
    if ($monitorConfig) {
        $configHash = Apply-MonitorFilter -PolicyObject $configHash -MonitorConfig $monitorConfig
        # Nested exclude paths (AllowedSenders.Sender) must drop the whole cmdlet parameter
        foreach ($k in (Get-MonitorExcludeTopLevelKeys -MonitorConfig $monitorConfig)) {
            if ($configHash -is [System.Collections.IDictionary] -and $configHash.ContainsKey($k)) {
                $configHash.Remove($k) | Out-Null
            }
        }
        # Restore internal routing fields if the include filter stripped them
        if (-not $configHash.ContainsKey("_PolicyName")) { $configHash["_PolicyName"] = $savedPolicyName }
        if (-not $configHash.ContainsKey("_PolicyType")) { $configHash["_PolicyType"] = $savedPolicyType }
    }
    $monitorConfigMap[$relativePath] = $monitorConfig  # may be $null

    if ($savedPolicyType -eq 'OrganizationConfig' -and $savedPolicyName -eq 'AuditDisabled' -and $configHash.ContainsKey('AuditDisabled')) {
        $script:BaselineOrgAuditRemediationEnabled = ($configHash['AuditDisabled'] -eq $false)
    }

    # Track source file path for plan-scoped apply
    $configHash['_SourceFile'] = $file.FullName
    $configHash['_MapKey'] = $relativePath
    
    # Convert back to PSObject
    $policyConfig = $configHash | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $policyConfigs += $policyConfig
}

Write-Host "Policies to process: $($policyConfigs.Count)"
if ($script:BaselineOrgAuditRemediationEnabled) {
    Write-Host "Baseline org audit enabled (AuditDisabled=false) — per-mailbox audit remediation will run"
}
else {
    Write-Host "Baseline org audit not enabled — per-mailbox audit remediation will be skipped"
}

# Import required modules - temporarily disable WhatIf to prevent it from affecting module operations
Write-Host "`nChecking required PowerShell modules..."
$originalWhatIfPreference = $WhatIfPreference
$WhatIfPreference = $false
try {
    if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
        Write-Host "Installing module: ExchangeOnlineManagement"
        Install-Module -Name ExchangeOnlineManagement -Force -AllowClobber -Scope CurrentUser -Confirm:$false
    }
    Import-Module ExchangeOnlineManagement
    Write-Host "✓ Loaded: ExchangeOnlineManagement"
}
finally {
    $WhatIfPreference = $originalWhatIfPreference
}

# Authenticate to Exchange Online using delegated token (no certificate required)
try {
    Write-Host "`nConnecting to Exchange Online..."
    Ensure-ExchangeOnlineConnection
    $orgConfig = Get-OrganizationConfig -ErrorAction SilentlyContinue
    if ($orgConfig) {
        Write-Host "✓ Exchange org confirmed: $($orgConfig.Name)"
    }
    Write-Host "✓ Connected to Exchange Online"
}
catch {
    throw "Failed to authenticate to Exchange Online: $_"
}

function Invoke-ExchangeOrganizationCustomization {
    <#
    .SYNOPSIS
        Ensures Enable-OrganizationCustomization has run when baseline requires it.

    .DESCRIPTION
        Default EOP/anti-phish/anti-spam policy changes require organization customization.
        Loads organization-config/OrganizationCustomization.json directly from disk (not
        limited by plan-scoped apply) and runs before other Exchange policies.
    #>
    param(
        [string]$ConfigDirectory,
        [string]$BaselineRoot
    )

    $customFile = Get-ChildItem -Path $ConfigDirectory -Filter "OrganizationCustomization.json" -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -match '[\\/]organization-config$' } |
        Select-Object -First 1
    if (-not $customFile) {
        Write-Host "  No organization-config/OrganizationCustomization.json in baseline — skipping" -ForegroundColor DarkGray
        return $null
    }

    if ((Get-Command Test-PolicyIgnored -ErrorAction SilentlyContinue) -and
        (Test-PolicyIgnored -PolicyPath $customFile.FullName -BaselineRoot $BaselineRoot)) {
        Write-Host "  Organization customization ignored via .baseline-ignore"
        return $null
    }

    try {
        $configHash = Get-Content $customFile.FullName -Raw | ConvertFrom-Json |
            ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
        $configHash = Resolve-Placeholders -ConfigObject $configHash
    }
    catch {
        Write-Host "##[warning]Could not read organization-config/OrganizationCustomization.json: $_"
        return $null
    }

    $wantEnabled = $true
    if ($configHash.ContainsKey('Enabled')) { $wantEnabled = [bool]$configHash['Enabled'] }
    if (-not $wantEnabled) {
        Write-Host "  Organization customization disabled in baseline (Enabled=false) — skipping"
        return @{
            Name     = 'Organization Customization'
            Type     = 'OrganizationCustomization'
            Status   = 'Skipped'
            Changes  = $null
            FilePath = $customFile.FullName
        }
    }

    $org = Get-OrganizationConfig -ErrorAction Stop
    $isDehydrated = $false
    if ($null -ne $org.IsDehydrated) { $isDehydrated = [bool]$org.IsDehydrated }

    if (-not $isDehydrated) {
        Write-Host "✓ Organization customization already enabled"
        return @{
            Name     = 'Organization Customization'
            Type     = 'OrganizationCustomization'
            Status   = 'No changes'
            Changes  = $null
            FilePath = $customFile.FullName
        }
    }

    $changesObj = @{ Added = @(); Removed = @(); Modified = @('Enabled: False → True') }

    if ($WhatIfPreference) {
        Write-Host "[WhatIf] Would enable organization customization (Enable-OrganizationCustomization)"
        return @{
            Name     = 'Organization Customization'
            Type     = 'OrganizationCustomization'
            Status   = 'Would UPDATE'
            Changes  = $changesObj
            FilePath = $customFile.FullName
        }
    }

    Write-Host "##[section]Enabling Exchange organization customization (required for default EOP policy updates)"
    Enable-OrganizationCustomization -ErrorAction Stop
    Start-Sleep -Seconds 5
    Write-Host "✓ Organization customization enabled"
    return @{
        Name     = 'Organization Customization'
        Type     = 'OrganizationCustomization'
        Status   = 'Updated'
        Changes  = $changesObj
        FilePath = $customFile.FullName
    }
}

# Helper function to convert policy config to parameter hashtable
function ConvertTo-CmdletParameters {
    param(
        [Parameter(Mandatory=$true)]
        [object]$PolicyConfig,
        [string[]]$ExcludeProperties = @('_PolicyType', '_PolicyName', 'Name', 'Type', 'State')
    )
    
    $params = @{}
    $skippedProps = @{}
    
    foreach ($prop in $PolicyConfig.PSObject.Properties) {
        # Skip metadata and system properties
        if ($prop.Name -in $ExcludeProperties) { 
            $skippedProps[$prop.Name] = "Metadata property"
            continue 
        }
        if ($prop.Name -like 'PS*') { 
            $skippedProps[$prop.Name] = "PowerShell internal property"
            continue 
        }
        if ($prop.Name -like '_*') {
            $skippedProps[$prop.Name] = "Internal metadata property"
            continue
        }
        if ($prop.Name -in $script:IgnoreProperties) { 
            $skippedProps[$prop.Name] = "In ignore list"
            continue 
        }
        
        # Skip null or empty values
        if ($null -eq $prop.Value) { 
            $skippedProps[$prop.Name] = "Null value"
            continue 
        }
        if ($prop.Value -is [string] -and [string]::IsNullOrWhiteSpace($prop.Value)) { 
            $skippedProps[$prop.Name] = "Empty string"
            continue 
        }
        if ($prop.Value -is [array] -and $prop.Value.Count -eq 0) { 
            $skippedProps[$prop.Name] = "Empty array"
            continue 
        }
        
        # Skip complex objects that aren't simple types or arrays
        if ($prop.Value -is [PSCustomObject] -or $prop.Value -is [hashtable]) {
            $skippedProps[$prop.Name] = "Complex object (not supported)"
            continue
        }
        
        # Skip boolean false values that are likely defaults
        # (but keep important ones like Quarantine, DeleteMessage, etc if explicitly set to true)
        if ($prop.Value -is [bool] -and $prop.Value -eq $false) {
            # Only include if it's an important security-related property
            $importantBoolProps = @(
                'Quarantine', 'DeleteMessage', 'StopRuleProcessing', 'RouteMessageOutboundRequireTls',
                'AuditDisabled', 'AdditionalStorageProvidersAvailable', 'Enabled', 'AuditEnabled'
            )
            if ($prop.Name -notin $importantBoolProps) {
                $skippedProps[$prop.Name] = "False boolean (likely default)"
                continue
            }
        }
        
        $params[$prop.Name] = $prop.Value
    }
    
    # Log skipped properties at debug level
    if ($skippedProps.Count -gt 0) {
        Write-Host "##[debug]Skipped $($skippedProps.Count) properties:"
        $skippedProps.GetEnumerator() | Sort-Object Name | ForEach-Object {
            Write-Host "##[debug]  - $($_.Key): $($_.Value)"
        }
    }
    
    return $params
}

# Maps deprecated / renamed parameters to their current equivalents so that
# baseline JSON files never need to be edited when Exchange Online deprecates
# a parameter.
$script:DeprecatedParamMappings = @{
    # Policy type → @{ OldParam = @{ NewParams = [string[]]; Value = $null (inherit) } }
    'HostedContentFilterPolicy' = @{
        # ZapEnabled was split into SpamZapEnabled + PhishZapEnabled
        'ZapEnabled' = @{ NewParams = @('SpamZapEnabled', 'PhishZapEnabled') }
    }
}

function Resolve-DeprecatedParameters {
    param(
        [hashtable]$Params,
        [string]$PolicyType
    )
    $mappings = $script:DeprecatedParamMappings[$PolicyType]
    if (-not $mappings) { return $Params }

    foreach ($old in @($mappings.Keys)) {
        if (-not $Params.ContainsKey($old)) { continue }
        $oldValue = $Params[$old]
        $Params.Remove($old)
        Write-Host "##[debug]  Remapped deprecated '$old' ($oldValue) →"
        foreach ($newParam in $mappings[$old].NewParams) {
            if (-not $Params.ContainsKey($newParam)) {
                $Params[$newParam] = $oldValue
                Write-Host "##[debug]    $newParam = $oldValue"
            } else {
                Write-Host "##[debug]    $newParam already set — skipping"
            }
        }
    }
    return $Params
}

function Get-ExchangeManagedPolicy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PolicyType,
        [Parameter(Mandatory = $true)]
        [string]$PolicyName
    )

    $getCmdlet = switch ($PolicyType) {
        'MalwareFilterPolicy'       { 'Get-MalwareFilterPolicy' }
        'HostedContentFilterPolicy' { 'Get-HostedContentFilterPolicy' }
        'AntiPhishPolicy'           { 'Get-AntiPhishPolicy' }
        default { return $null }
    }
    if (-not $getCmdlet) { return $null }

    $existing = & $getCmdlet -Identity $PolicyName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "##[debug]Found $PolicyType via -Identity: $PolicyName"
        return $existing
    }

    Write-Host "##[debug]$PolicyType -Identity lookup missed for '$PolicyName'; listing policies..."
    $all = @(& $getCmdlet -ErrorAction Stop)
    $match = $all | Where-Object {
        $_.Identity -eq $PolicyName -or $_.Name -eq $PolicyName -or
        ($PolicyName -eq 'Default' -and $_.IsDefault)
    } | Select-Object -First 1

    if ($match) {
        Write-Host "##[debug]Found $PolicyType via list lookup: $($match.Identity)"
    }
    return $match
}

function Test-BuiltInDefaultExchangePolicy {
    param(
        [string]$PolicyType,
        [string]$PolicyName
    )
    return ($PolicyName -eq 'Default') -and ($PolicyType -in @('MalwareFilterPolicy', 'HostedContentFilterPolicy', 'AntiPhishPolicy'))
}

# Function to create or update Exchange policy
function Set-ExchangePolicy {
    param(
        [Parameter(Mandatory=$true)]
        [object]$PolicyConfig,

        [Parameter(Mandatory=$false)]
        [hashtable]$MonitorConfig = $null
    )
    
    # Get policy type and name from the detected metadata
    $policyType = $PolicyConfig._PolicyType
    $policyName = if ($PolicyConfig._PolicyName) { $PolicyConfig._PolicyName.Trim() } else { $PolicyConfig._PolicyName }
    
    # Fallback to legacy format if present
    if (-not $policyType -and $PolicyConfig.Type) { $policyType = $PolicyConfig.Type }
    if (-not $policyName -and $PolicyConfig.Name) { $policyName = $PolicyConfig.Name.Trim() }

    # First path segment only — ConvertTo-ComparableHashtable matches top-level keys
    $monitorExclude = @(Get-MonitorExcludeTopLevelKeys -MonitorConfig $MonitorConfig)

    $displayLabel = if ($PolicyConfig._PolicyDisplayName) { $PolicyConfig._PolicyDisplayName } else { $policyName }
    
    Write-Host "`n##[group]Processing: $displayLabel ($policyType)"
    
    try {
        # Different cmdlets based on policy type
        switch ($policyType) {
            "TransportRule" {
                Write-Host "##[debug]Checking for existing transport rule: $policyName"
                $existingRule = Get-TransportRule -Identity $policyName -ErrorAction SilentlyContinue
                
                if ($existingRule) {
                    Write-Host "##[debug]Found existing transport rule: $policyName"
                    
                    # Compare existing with desired to detect actual changes
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existingRule -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude
                    
                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ Transport rule is up to date - no changes needed"
                        return @{
                            Name = $policyName
                            Type = $policyType
                            Status = "No changes"
                            Changes = $null
                        }
                    }
                    
                    # Build changes object for plan output
                    $changesObj = @{
                        Added = $comparison.Differences.Added
                        Removed = $comparison.Differences.Removed
                        Modified = $comparison.Differences.Modified
                    }
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Update transport rule")) {
                        Write-Host "##[debug]Preparing to update transport rule: $policyName"
                        
                        # Build parameter hashtable for Set-TransportRule
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Identity'] = $policyName
                        
                        Write-Host "##[debug]Calling Set-TransportRule with parameters:"
                        $params.GetEnumerator() | ForEach-Object { 
                            $value = if ($_.Value -is [array]) { "[$($_.Value -join ', ')]" } else { $_.Value }
                            Write-Host "##[debug]  $($_.Key) = $value"
                        }
                        
                        Set-TransportRule @params -ErrorAction Stop
                        
                        # Handle State property separately using Enable/Disable cmdlets
                        if ($PolicyConfig.State -eq "Enabled") {
                            Write-Host "##[debug]Enabling transport rule"
                            Enable-TransportRule -Identity $policyName -ErrorAction Stop
                        }
                        elseif ($PolicyConfig.State -eq "Disabled") {
                            Write-Host "##[debug]Disabling transport rule"
                            Disable-TransportRule -Identity $policyName -ErrorAction Stop
                        }
                        
                        Write-Host "✓ Updated transport rule: $policyName"
                        
                        return @{
                            Name = $policyName
                            Type = $policyType
                            Status = "Updated"
                            Changes = $changesObj
                        }
                    }
                    else {
                        Write-Host "[WhatIf] Would update existing transport rule: $policyName"
                        if ($comparison.Differences.Modified.Count -gt 0) {
                            foreach ($mod in $comparison.Differences.Modified) {
                                Write-Host "  ~ $mod"
                            }
                        }
                        return @{
                            Name = $policyName
                            Type = $policyType
                            Status = "Would UPDATE"
                            Changes = $changesObj
                        }
                    }
                }
                else {
                    Write-Host "##[debug]Transport rule does not exist - will create: $policyName"
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Create transport rule")) {
                        # Build parameter hashtable for New-TransportRule
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Name'] = $policyName
                        
                        Write-Host "##[debug]Calling New-TransportRule with parameters:"
                        $params.GetEnumerator() | ForEach-Object { 
                            $value = if ($_.Value -is [array]) { "[$($_.Value -join ', ')]" } else { $_.Value }
                            Write-Host "##[debug]  $($_.Key) = $value"
                        }
                        
                        $newRule = New-TransportRule @params -ErrorAction Stop
                        Write-Host "##[debug]Transport rule created successfully with GUID: $($newRule.Guid)"
                        
                        # Handle State property separately using Enable/Disable cmdlets
                        # Note: New rules are created in Enabled state by default
                        if ($PolicyConfig.State -eq "Disabled") {
                            Write-Host "##[debug]Disabling transport rule"
                            Disable-TransportRule -Identity $policyName -ErrorAction Stop
                        }
                        
                        Write-Host "✓ Created transport rule: $policyName"
                        
                        return @{
                            Name = $policyName
                            Type = $policyType
                            Status = "Created"
                            Changes = $null
                        }
                    }
                    else {
                        Write-Host "[WhatIf] Would create new transport rule: $policyName"
                        return @{
                            Name = $policyName
                            Type = $policyType
                            Status = "Would CREATE"
                            Changes = $null
                        }
                    }
                }
            }
            
            "HostedContentFilterPolicy" {
                Write-Host "##[debug]Checking for existing anti-spam policy: $policyName"
                $existing = Get-ExchangeManagedPolicy -PolicyType 'HostedContentFilterPolicy' -PolicyName $policyName
                
                if ($existing) {
                    Write-Host "##[debug]Found existing anti-spam policy: $policyName"
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existing -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude
                    
                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ Anti-spam policy is up to date - no changes needed"
                        return @{ Name = $policyName; Type = $policyType; Status = "No changes"; Changes = $null }
                    }
                    
                    $changesObj = @{ Added = $comparison.Differences.Added; Removed = $comparison.Differences.Removed; Modified = $comparison.Differences.Modified }
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Update anti-spam policy")) {
                        Write-Host "##[debug]Preparing to update anti-spam policy: $policyName"
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params = Resolve-DeprecatedParameters -Params $params -PolicyType 'HostedContentFilterPolicy'
                        $params['Identity'] = $policyName
                        
                        Write-Host "##[debug]Calling Set-HostedContentFilterPolicy with $($params.Count) parameters"
                        Set-HostedContentFilterPolicy @params -ErrorAction Stop
                        Write-Host "✓ Updated anti-spam policy: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                    }
                    else {
                        Write-Host "[WhatIf] Would update existing anti-spam policy: $policyName"
                        foreach ($mod in $comparison.Differences.Modified) { Write-Host "  ~ $mod" }
                        return @{ Name = $policyName; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                    }
                }
                else {
                    if (Test-BuiltInDefaultExchangePolicy -PolicyType 'HostedContentFilterPolicy' -PolicyName $policyName) {
                        throw "Built-in Default HostedContentFilterPolicy not found — EXO connection or RBAC problem (Default policies cannot be created)"
                    }
                    Write-Host "##[debug]Anti-spam policy does not exist - will create: $policyName"
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Create anti-spam policy")) {
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params = Resolve-DeprecatedParameters -Params $params -PolicyType 'HostedContentFilterPolicy'
                        $params['Name'] = $policyName
                        
                        Write-Host "##[debug]Calling New-HostedContentFilterPolicy with $($params.Count) parameters"
                        $newPolicy = New-HostedContentFilterPolicy @params -ErrorAction Stop
                        Write-Host "##[debug]Anti-spam policy created successfully with GUID: $($newPolicy.Guid)"
                        Write-Host "✓ Created anti-spam policy: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Created"; Changes = $null }
                    }
                    else {
                        Write-Host "[WhatIf] Would create new anti-spam policy: $policyName"
                        return @{ Name = $policyName; Type = $policyType; Status = "Would CREATE"; Changes = $null }
                    }
                }
            }
            
            "AntiPhishPolicy" {
                Write-Host "##[debug]Checking for existing anti-phish policy: $policyName"
                $existing = Get-ExchangeManagedPolicy -PolicyType 'AntiPhishPolicy' -PolicyName $policyName
                
                if ($existing) {
                    Write-Host "##[debug]Found existing anti-phish policy: $policyName"
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existing -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude
                    
                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ Anti-phish policy is up to date - no changes needed"
                        return @{ Name = $policyName; Type = $policyType; Status = "No changes"; Changes = $null }
                    }
                    
                    $changesObj = @{ Added = $comparison.Differences.Added; Removed = $comparison.Differences.Removed; Modified = $comparison.Differences.Modified }
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Update anti-phish policy")) {
                        Write-Host "##[debug]Preparing to update anti-phish policy: $policyName"
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Identity'] = $policyName
                        
                        Write-Host "##[debug]Calling Set-AntiPhishPolicy with $($params.Count) parameters"
                        Set-AntiPhishPolicy @params -ErrorAction Stop
                        Write-Host "✓ Updated anti-phish policy: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                    }
                    else {
                        Write-Host "[WhatIf] Would update existing anti-phish policy: $policyName"
                        foreach ($mod in $comparison.Differences.Modified) { Write-Host "  ~ $mod" }
                        return @{ Name = $policyName; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                    }
                }
                else {
                    if (Test-BuiltInDefaultExchangePolicy -PolicyType 'AntiPhishPolicy' -PolicyName $policyName) {
                        throw "Built-in Default AntiPhishPolicy not found — EXO connection or RBAC problem (Default policies cannot be created)"
                    }
                    Write-Host "##[debug]Anti-phish policy does not exist - will create: $policyName"
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Create anti-phish policy")) {
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Name'] = $policyName
                        
                        Write-Host "##[debug]Calling New-AntiPhishPolicy with $($params.Count) parameters"
                        $newPolicy = New-AntiPhishPolicy @params -ErrorAction Stop
                        Write-Host "##[debug]Anti-phish policy created successfully with GUID: $($newPolicy.Guid)"
                        Write-Host "✓ Created anti-phish policy: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Created"; Changes = $null }
                    }
                    else {
                        Write-Host "[WhatIf] Would create new anti-phish policy: $policyName"
                        return @{ Name = $policyName; Type = $policyType; Status = "Would CREATE"; Changes = $null }
                    }
                }
            }
            
            "MalwareFilterPolicy" {
                Write-Host "##[debug]Checking for existing malware filter policy: $policyName"
                $existing = Get-ExchangeManagedPolicy -PolicyType 'MalwareFilterPolicy' -PolicyName $policyName
                
                if ($existing) {
                    Write-Host "##[debug]Found existing malware filter policy: $policyName"
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existing -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude
                    
                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ Malware filter policy is up to date - no changes needed"
                        return @{ Name = $policyName; Type = $policyType; Status = "No changes"; Changes = $null }
                    }
                    
                    $changesObj = @{ Added = $comparison.Differences.Added; Removed = $comparison.Differences.Removed; Modified = $comparison.Differences.Modified }
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Update malware filter policy")) {
                        Write-Host "##[debug]Preparing to update malware filter policy: $policyName"
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Identity'] = $policyName
                        
                        Write-Host "##[debug]Calling Set-MalwareFilterPolicy with $($params.Count) parameters"
                        Set-MalwareFilterPolicy @params -ErrorAction Stop
                        Write-Host "✓ Updated malware filter policy: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                    }
                    else {
                        Write-Host "[WhatIf] Would update existing malware filter policy: $policyName"
                        foreach ($mod in $comparison.Differences.Modified) { Write-Host "  ~ $mod" }
                        return @{ Name = $policyName; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                    }
                }
                else {
                    if (Test-BuiltInDefaultExchangePolicy -PolicyType 'MalwareFilterPolicy' -PolicyName $policyName) {
                        throw "Built-in Default MalwareFilterPolicy not found — EXO connection or RBAC problem (Default policies cannot be created)"
                    }
                    Write-Host "##[debug]Malware filter policy does not exist - will create: $policyName"
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Create malware filter policy")) {
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Name'] = $policyName
                        
                        Write-Host "##[debug]Calling New-MalwareFilterPolicy with $($params.Count) parameters"
                        $newPolicy = New-MalwareFilterPolicy @params -ErrorAction Stop
                        Write-Host "##[debug]Malware filter policy created successfully with GUID: $($newPolicy.Guid)"
                        Write-Host "✓ Created malware filter policy: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Created"; Changes = $null }
                    }
                    else {
                        Write-Host "[WhatIf] Would create new malware filter policy: $policyName"
                        return @{ Name = $policyName; Type = $policyType; Status = "Would CREATE"; Changes = $null }
                    }
                }
            }
            
            "InboundConnector" {
                Write-Host "##[debug]Checking for existing inbound connector: $policyName"
                $existing = Get-InboundConnector -Identity $policyName -ErrorAction SilentlyContinue
                
                if ($existing) {
                    Write-Host "##[debug]Found existing inbound connector: $policyName"
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existing -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude
                    
                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ Inbound connector is up to date - no changes needed"
                        return @{ Name = $policyName; Type = $policyType; Status = "No changes"; Changes = $null }
                    }
                    
                    $changesObj = @{ Added = $comparison.Differences.Added; Removed = $comparison.Differences.Removed; Modified = $comparison.Differences.Modified }
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Update inbound connector")) {
                        Write-Host "##[debug]Preparing to update inbound connector: $policyName"
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Identity'] = $policyName
                        
                        Write-Host "##[debug]Calling Set-InboundConnector with $($params.Count) parameters"
                        Set-InboundConnector @params -ErrorAction Stop
                        Write-Host "✓ Updated inbound connector: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                    }
                    else {
                        Write-Host "[WhatIf] Would update existing inbound connector: $policyName"
                        foreach ($mod in $comparison.Differences.Modified) { Write-Host "  ~ $mod" }
                        return @{ Name = $policyName; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                    }
                }
                else {
                    Write-Host "##[debug]Inbound connector does not exist - will create: $policyName"
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Create inbound connector")) {
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Name'] = $policyName
                        
                        Write-Host "##[debug]Calling New-InboundConnector with $($params.Count) parameters"
                        $newConnector = New-InboundConnector @params -ErrorAction Stop
                        Write-Host "##[debug]Inbound connector created successfully with GUID: $($newConnector.Guid)"
                        Write-Host "✓ Created inbound connector: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Created"; Changes = $null }
                    }
                    else {
                        Write-Host "[WhatIf] Would create new inbound connector: $policyName"
                        return @{ Name = $policyName; Type = $policyType; Status = "Would CREATE"; Changes = $null }
                    }
                }
            }
            
            "OutboundConnector" {
                Write-Host "##[debug]Checking for existing outbound connector: $policyName"
                $existing = Get-OutboundConnector -Identity $policyName -ErrorAction SilentlyContinue
                
                if ($existing) {
                    Write-Host "##[debug]Found existing outbound connector: $policyName"
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existing -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude
                    
                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ Outbound connector is up to date - no changes needed"
                        return @{ Name = $policyName; Type = $policyType; Status = "No changes"; Changes = $null }
                    }
                    
                    $changesObj = @{ Added = $comparison.Differences.Added; Removed = $comparison.Differences.Removed; Modified = $comparison.Differences.Modified }
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Update outbound connector")) {
                        Write-Host "##[debug]Preparing to update outbound connector: $policyName"
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Identity'] = $policyName
                        
                        Write-Host "##[debug]Calling Set-OutboundConnector with $($params.Count) parameters"
                        Set-OutboundConnector @params -ErrorAction Stop
                        Write-Host "✓ Updated outbound connector: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                    }
                    else {
                        Write-Host "[WhatIf] Would update existing outbound connector: $policyName"
                        foreach ($mod in $comparison.Differences.Modified) { Write-Host "  ~ $mod" }
                        return @{ Name = $policyName; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                    }
                }
                else {
                    Write-Host "##[debug]Outbound connector does not exist - will create: $policyName"
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Create outbound connector")) {
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Name'] = $policyName
                        
                        Write-Host "##[debug]Calling New-OutboundConnector with $($params.Count) parameters"
                        $newConnector = New-OutboundConnector @params -ErrorAction Stop
                        Write-Host "##[debug]Outbound connector created successfully with GUID: $($newConnector.Guid)"
                        Write-Host "✓ Created outbound connector: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Created"; Changes = $null }
                    }
                    else {
                        Write-Host "[WhatIf] Would create new outbound connector: $policyName"
                        return @{ Name = $policyName; Type = $policyType; Status = "Would CREATE"; Changes = $null }
                    }
                }
            }
            
            "OrganizationConfig" {
                Write-Host "##[debug]Retrieving organization configuration for setting: $policyName"
                $existing = Get-OrganizationConfig -ErrorAction SilentlyContinue
                
                if ($existing) {
                    Write-Host "##[debug]Found organization configuration"
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existing -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude -DesiredKeysOnly
                    
                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ Organization setting '$policyName' is up to date - no changes needed"
                        return @{ Name = $policyName; Type = $policyType; Status = "No changes"; Changes = $null }
                    }
                    
                    $changesObj = @{ Added = $comparison.Differences.Added; Removed = $comparison.Differences.Removed; Modified = $comparison.Differences.Modified }
                    
                    if ($PSCmdlet.ShouldProcess($policyName, "Update organization configuration setting")) {
                        Write-Host "##[debug]Preparing to update organization setting: $policyName"
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        
                        $paramSummary = ($params.GetEnumerator() | ForEach-Object { "-$($_.Key) $($_.Value)" }) -join ' '
                        Write-Host "##[debug]Calling Set-OrganizationConfig $paramSummary"
                        Set-OrganizationConfig @params -ErrorAction Stop
                        Write-Host "✓ Updated organization setting: $policyName"
                        
                        return @{ Name = $policyName; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                    }
                    else {
                        Write-Host "[WhatIf] Would update organization setting: $policyName"
                        foreach ($mod in $comparison.Differences.Modified) { Write-Host "  ~ $mod" }
                        foreach ($add in $comparison.Differences.Added) { Write-Host "  + $add" }
                        return @{ Name = $policyName; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                    }
                }
                else {
                    Write-Host "##[warning]Could not retrieve organization configuration"
                    return @{ Name = $policyName; Type = $policyType; Status = "Error"; Changes = $null }
                }
            }

            "OwaMailboxPolicy" {
                $settingLabel = if ($PolicyConfig._PolicyDisplayName) { $PolicyConfig._PolicyDisplayName } else { $policyName }
                Write-Host "##[debug]Checking OWA mailbox policy setting: $settingLabel"
                $existing = Get-OwaMailboxPolicy -Identity $policyName -ErrorAction SilentlyContinue

                if ($existing) {
                    Write-Host "##[debug]Found OWA mailbox policy: $policyName"
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existing -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude -DesiredKeysOnly

                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ OWA setting '$settingLabel' is up to date - no changes needed"
                        return @{ Name = $settingLabel; Type = $policyType; Status = "No changes"; Changes = $null }
                    }

                    $changesObj = @{ Added = $comparison.Differences.Added; Removed = $comparison.Differences.Removed; Modified = $comparison.Differences.Modified }

                    if ($PSCmdlet.ShouldProcess($settingLabel, "Update OWA mailbox policy setting")) {
                        Write-Host "##[debug]Preparing to update OWA setting: $settingLabel"
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig
                        $params['Identity'] = $policyName

                        $paramSummary = ($params.GetEnumerator() | Where-Object { $_.Key -ne 'Identity' } | ForEach-Object { "-$($_.Key) $($_.Value)" }) -join ' '
                        Write-Host "##[debug]Calling Set-OwaMailboxPolicy -Identity $policyName $paramSummary"
                        Set-OwaMailboxPolicy @params -ErrorAction Stop
                        Write-Host "✓ Updated OWA setting: $settingLabel"

                        return @{ Name = $settingLabel; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                    }
                    else {
                        Write-Host "[WhatIf] Would update OWA setting: $settingLabel"
                        foreach ($mod in $comparison.Differences.Modified) { Write-Host "  ~ $mod" }
                        foreach ($add in $comparison.Differences.Added) { Write-Host "  + $add" }
                        return @{ Name = $settingLabel; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                    }
                }
                else {
                    Write-Host "##[warning]OWA mailbox policy not found: $policyName — seed from tenant backup before deploying"
                    return @{ Name = $settingLabel; Type = $policyType; Status = "Skipped"; Changes = $null }
                }
            }

            "ExternalInOutlook" {
                $settingLabel = if ($PolicyConfig._PolicyDisplayName) { $PolicyConfig._PolicyDisplayName } else { 'External in Outlook' }
                Write-Host "##[debug]Retrieving ExternalInOutlook (Get-ExternalInOutlookConfiguration)"
                $config = Get-ExternalInOutlookConfiguration -RestTimeoutSec 20

                if ($config) {
                    Write-Host "##[debug]Found ExternalInOutlook configuration (via $($config.Source))"
                    $existing = @{
                        Enabled   = [bool]$config.Enabled
                        AllowList = @($config.AllowList | Where-Object { $_ })
                    }
                    $comparison = Compare-ExchangePolicyProperties -ExistingPolicy $existing -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude -DesiredKeysOnly

                    if ($comparison.IsEquivalent) {
                        Write-Host "✓ $settingLabel is up to date - no changes needed"
                        return @{ Name = $settingLabel; Type = $policyType; Status = "No changes"; Changes = $null }
                    }

                    $changesObj = @{ Added = $comparison.Differences.Added; Removed = $comparison.Differences.Removed; Modified = $comparison.Differences.Modified }

                    if ($PSCmdlet.ShouldProcess($settingLabel, "Update external sender identification (Set-ExternalInOutlook)")) {
                        Write-Host "##[debug]Preparing to update ExternalInOutlook"
                        $params = ConvertTo-CmdletParameters -PolicyConfig $PolicyConfig

                        $paramSummary = ($params.GetEnumerator() | ForEach-Object { "-$($_.Key) $($_.Value)" }) -join ' '
                        Write-Host "##[debug]Calling Set-ExternalInOutlook via adminApi InvokeCommand $paramSummary"
                        try {
                            $setResult = Set-ExternalInOutlookConfiguration -Parameters $params -RestTimeoutSec 45
                            Write-Host "✓ Set completed (via $($setResult.Source))"
                        }
                        catch {
                            Write-Host "##[warning]adminApi Set-ExternalInOutlook failed, trying cmdlet: $_"
                            Set-ExternalInOutlook @params -ErrorAction Stop
                            Write-Host "✓ Set completed (via cmdlet)"
                        }

                        # Verify the setting actually took — Exchange sometimes returns success without applying.
                        Start-Sleep -Seconds 3
                        $verifyConfig = Get-ExternalInOutlookConfiguration -RestTimeoutSec 20
                        if (-not $verifyConfig) {
                            return @{ Name = $settingLabel; Type = $policyType; Status = "Failed: Could not verify ExternalInOutlook after Set"; Changes = $changesObj }
                        }
                        $verifyExisting = @{
                            Enabled   = [bool]$verifyConfig.Enabled
                            AllowList = @($verifyConfig.AllowList | Where-Object { $_ })
                        }
                        $verifyCompare = Compare-ExchangePolicyProperties -ExistingPolicy $verifyExisting -DesiredPolicy $PolicyConfig -AdditionalIgnoreProps $monitorExclude -DesiredKeysOnly
                        if (-not $verifyCompare.IsEquivalent) {
                            $enabledNow = $verifyExisting.Enabled
                            $enabledWant = if ($params.ContainsKey('Enabled')) { $params.Enabled } else { $PolicyConfig.Enabled }
                            return @{ Name = $settingLabel; Type = $policyType; Status = "Failed: ExternalInOutlook still Enabled=$enabledNow after Set (baseline requires $enabledWant)"; Changes = $changesObj }
                        }

                        Write-Host "✓ Verified $settingLabel (Enabled=$($verifyExisting.Enabled))"
                        return @{ Name = $settingLabel; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                    }
                    else {
                        Write-Host "[WhatIf] Would update $settingLabel"
                        foreach ($mod in $comparison.Differences.Modified) { Write-Host "  ~ $mod" }
                        foreach ($add in $comparison.Differences.Added) { Write-Host "  + $add" }
                        return @{ Name = $settingLabel; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                    }
                }
                else {
                    Write-Host "##[warning]Could not retrieve ExternalInOutlook configuration (Get-ExternalInOutlook and adminApi InvokeCommand both returned no data)"
                    return @{ Name = $settingLabel; Type = $policyType; Status = "Error: Could not read ExternalInOutlook from Exchange"; Changes = $null }
                }
            }

            "MailboxAuditRemediation" {
                Write-Host "##[debug]Checking mailbox audit remediation"

                if (-not $script:BaselineOrgAuditRemediationEnabled) {
                    Write-Host "Skipping mailbox audit remediation — baseline organization-config/AuditDisabled.json does not set AuditDisabled=false"
                    return @{ Name = "MailboxAuditRemediation"; Type = $policyType; Status = "Skipped"; Changes = $null }
                }

                $includeAll = $false
                if ($null -ne $PolicyConfig.IncludeAllMailboxes) {
                    $includeAll = [bool]$PolicyConfig.IncludeAllMailboxes
                }
                $targetTypes = @($PolicyConfig.RecipientTypeDetails)
                $targetAudit = [bool]$PolicyConfig.AuditEnabled

                if (-not $includeAll -and $targetTypes.Count -eq 0) {
                    Write-Host "##[warning]No IncludeAllMailboxes or RecipientTypeDetails configured — skipping mailbox audit remediation"
                    return @{ Name = "MailboxAuditRemediation"; Type = $policyType; Status = "Skipped"; Changes = $null }
                }

                $allMailboxes = @(Get-Mailbox -ResultSize Unlimited -ErrorAction Stop)
                if ($includeAll) {
                    Write-Host "##[debug]Scanning all $($allMailboxes.Count) mailbox(es) for AuditEnabled=$targetAudit"
                    $mailboxesToFix = @($allMailboxes | Where-Object { [bool]$_.AuditEnabled -ne $targetAudit })
                }
                else {
                    Write-Host "##[debug]Scanning mailboxes of types: $($targetTypes -join ', ')"
                    $mailboxesToFix = @($allMailboxes |
                        Where-Object { $_.RecipientTypeDetails -in $targetTypes -and [bool]$_.AuditEnabled -ne $targetAudit })
                }

                if ($mailboxesToFix.Count -eq 0) {
                    $scopeLabel = if ($includeAll) { "All mailboxes" } else { "Configured mailbox types" }
                    Write-Host "✓ $scopeLabel already have AuditEnabled=$targetAudit"
                    return @{ Name = "MailboxAuditRemediation"; Type = $policyType; Status = "No changes"; Changes = $null }
                }

                $modified = @($mailboxesToFix | ForEach-Object {
                    "$($_.Name) ($($_.RecipientTypeDetails)): AuditEnabled=$($_.AuditEnabled) → $targetAudit"
                })
                $changesObj = @{ Added = @(); Removed = @(); Modified = $modified }

                if ($PSCmdlet.ShouldProcess("MailboxAuditRemediation", "Set AuditEnabled=$targetAudit on $($mailboxesToFix.Count) mailbox(es)")) {
                    foreach ($mbx in $mailboxesToFix) {
                        Write-Host "##[debug]Setting AuditEnabled=$targetAudit on mailbox: $($mbx.Name)"
                        Set-Mailbox -Identity $mbx.Identity -AuditEnabled $targetAudit -ErrorAction Stop
                    }
                    Write-Host "✓ Updated audit settings on $($mailboxesToFix.Count) mailbox(es)"
                    return @{ Name = "MailboxAuditRemediation"; Type = $policyType; Status = "Updated"; Changes = $changesObj }
                }
                else {
                    Write-Host "[WhatIf] Would set AuditEnabled=$targetAudit on $($mailboxesToFix.Count) mailbox(es):"
                    foreach ($line in $modified) { Write-Host "  ~ $line" }
                    return @{ Name = "MailboxAuditRemediation"; Type = $policyType; Status = "Would UPDATE"; Changes = $changesObj }
                }
            }
            
            default {
                Write-Host "##[warning]Unknown policy type: $policyType"
                return @{ Name = $policyName; Type = $policyType; Status = "Skipped" }
            }
        }
    }
    catch {
        Write-Host "##[error]Failed to process policy: $policyName"
        Write-Host "##[error]Error: $_"
        throw
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# Process all policies
Write-Host "`n##[section]Creating/Updating Exchange Policies"

$results = @()
$createdCount = 0
$updatedCount = 0
$noChangeCount = 0
$wouldCreateCount = 0
$wouldUpdateCount = 0
$errorCount = 0

Write-Host "`n##[section]Exchange organization customization prerequisite"
$orgCustomResult = Invoke-ExchangeOrganizationCustomization -ConfigDirectory $ConfigDirectory -BaselineRoot $baselineRoot
if ($orgCustomResult) {
    switch -Regex ($orgCustomResult.Status) {
        "^Created$" { $createdCount++ }
        "^Updated$" { $updatedCount++ }
        "^No changes$" { $noChangeCount++ }
        "^Would CREATE$" { $wouldCreateCount++ }
        "^Would UPDATE$" { $wouldUpdateCount++ }
        "^Error" { $errorCount++ }
    }
    $results += [PSCustomObject]@{
        DisplayName = $orgCustomResult.Name
        Type        = $orgCustomResult.Type
        Status      = $orgCustomResult.Status
        Changes     = if ($orgCustomResult.Changes) { $orgCustomResult.Changes } else { $null }
        FilePath    = $orgCustomResult.FilePath
    }
}

foreach ($policyConfig in $policyConfigs) {
    if ($policyConfig._PolicyType -eq 'OrganizationCustomization') { continue }
    try {
        $mapKey = if ($policyConfig._MapKey) { $policyConfig._MapKey } else { $policyConfig._PolicyName }
        $monitorConfig = $monitorConfigMap[$mapKey]
        $result = Set-ExchangePolicy -PolicyConfig $policyConfig -MonitorConfig $monitorConfig
        $policyName = $result.Name
        $policyType = $result.Type
        $status = $result.Status
        
        # Track counts based on status
        switch -Regex ($status) {
            "^Created$" { $createdCount++ }
            "^Updated$" { $updatedCount++ }
            "^No changes$" { $noChangeCount++ }
            "^Would CREATE$" { $wouldCreateCount++ }
            "^Would UPDATE$" { $wouldUpdateCount++ }
            "^Error" { $errorCount++ }
        }
        
        $results += [PSCustomObject]@{
            DisplayName = $policyName
            Type = $policyType
            Status = $status
            Changes = if ($result.Changes) { $result.Changes } else { $null }
            FilePath = $policyConfig._SourceFile
        }
    }
    catch {
        $errorCount++
        $policyName = $policyConfig._PolicyName ?? $policyConfig.Name ?? "Unknown"
        $policyType = $policyConfig._PolicyType ?? $policyConfig.Type ?? "Unknown"
        $results += [PSCustomObject]@{
            DisplayName = $policyName
            Type = $policyType
            Status = "Failed: $_"
            FilePath = $policyConfig._SourceFile
        }
    }
}

# Disconnect
Disconnect-M365Connections

# Summary
Write-Host "`n##[section]Summary"
Write-Host "Total policies processed: $($policyConfigs.Count)"
if ($WhatIfPreference) {
    Write-Host "  → Would CREATE: $wouldCreateCount"
    Write-Host "  → Would UPDATE: $wouldUpdateCount"
    Write-Host "  ○ No changes needed: $noChangeCount"
}
else {
    Write-Host "  ✓ Created: $createdCount"
    Write-Host "  ✓ Updated: $updatedCount"
    Write-Host "  ○ No changes: $noChangeCount"
}
if ($errorCount -gt 0) {
    Write-Host "  ✗ Failed: $errorCount"
}

if ($results.Count -gt 0) {
    Write-Host "`nResults:"
    $results | Format-Table -AutoSize
    $failedResults = @($results | Where-Object { $_.Status -like 'Failed:*' })
    if ($failedResults.Count -gt 0) {
        Write-Host "`nFull error details:"
        foreach ($r in $failedResults) {
            Write-Host "  $($r.DisplayName): $($r.Status)"
        }
    }
}

# Output plan summary if requested
if ($OutputPath) {
    $planSummary = @{
        Service = "Exchange"
        Timestamp = Get-Date -Format "o"
        TotalPolicies = $policyConfigs.Count
        CreatedCount = $createdCount
        UpdatedCount = $updatedCount
        NoChangeCount = $noChangeCount
        WouldCreateCount = $wouldCreateCount
        WouldUpdateCount = $wouldUpdateCount
        ErrorCount = $errorCount
        Results = $results
    }
    
    $planSummary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nPlan summary saved to: $OutputPath"
}

if ($errorCount -gt 0) {
    Write-Host "##[error]Some policies failed to process"
    exit 1
}
else {
    Write-Host "##[command]All Exchange policies configured successfully!"
}


