<#
.SYNOPSIS
    Configures Authentication Methods Policy via Microsoft Graph API

.DESCRIPTION
    Applies authentication methods configuration from individual JSON files.
    Supports: FIDO2 (Passkeys), Temporary Access Pass, SMS, Voice, Email OTP,
    Microsoft Authenticator, Software OATH tokens, Hardware OATH tokens (x509)

.PARAMETER ConfigDirectory
    Path to the directory containing individual authentication method JSON files

.PARAMETER ConfigPath
    (Legacy) Path to a single JSON configuration file containing all methods

.PARAMETER OutputPath
    Path to save the plan/results JSON file for pipeline summary

.EXAMPLE
    .\Configure-AuthenticationMethods.ps1 -ConfigDirectory "baseline/authentication-policies"

.EXAMPLE
    .\Configure-AuthenticationMethods.ps1 -ConfigPath "auth-methods.json" -WhatIf -OutputPath "plan.json"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$false)]
    [string]$ConfigDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$ConfigPath,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantBaselinePath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantRepoPath  # Path to tenant's own repo (for .baseline-ignore)
)

$ErrorActionPreference = "Stop"

# Import baseline ignore helpers
$ignoreHelpersPath = Join-Path $PSScriptRoot "Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

# Import shared diff helpers
$diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

Write-Host "##[section]Configuring Authentication Methods Policy"

# Initialize baseline ignore patterns (if TenantBaselinePath provided)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# Validate parameters - need at least one
if (-not $ConfigDirectory -and -not $ConfigPath) {
    throw "Either -ConfigDirectory or -ConfigPath must be specified"
}

# Initialize plan tracking for summary output
$planResults = @{
    Service = "AuthenticationPolicies"
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
        Write-Host "Plan saved to: $OutputPath"
    }
}

# Import required modules
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
    $context = Ensure-M365GraphConnection -Scopes @("Policy.ReadWrite.AuthenticationMethod")
    Write-Host "Connected to tenant: $($context.TenantId)"
    
    # DIAGNOSTIC: Verify permissions
    Write-Host "[DIAGNOSTIC] Checking Graph API permissions..."
    Write-Host "  Auth Type: $($context.AuthType)"
    Write-Host "  App ID: $($context.ClientId)"
    Write-Host "  Scopes: $($context.Scopes -join ', ')"
    
    # For app-only authentication, list the granted permissions
    if ($context.AuthType -eq "AppOnly" -and $context.ClientId) {
        try {
            $spUri = "https://graph.microsoft.com/v1.0/servicePrincipals(appId='$($context.ClientId)')"
            $sp = Invoke-MgGraphRequest -Uri $spUri -Method GET
            
            if ($sp.appRoles) {
                Write-Host "  [DIAGNOSTIC] App has $($sp.appRoles.Count) role(s) defined"
            }
            
            # Check for required permission
            $hasRequiredPermission = $false
            if ($context.Scopes) {
                $hasRequiredPermission = $context.Scopes -contains "Policy.ReadWrite.AuthenticationMethod"
            }
            
            if ($hasRequiredPermission) {
                Write-Host "  ✓ Has Policy.ReadWrite.AuthenticationMethod permission" -ForegroundColor Green
            }
            else {
                Write-Host "  ⚠️  Policy.ReadWrite.AuthenticationMethod not found in scopes" -ForegroundColor Yellow
                Write-Host "     This may cause some properties to be read-only" -ForegroundColor Yellow
            }
        }
        catch {
            Write-Verbose "Could not query service principal details: $_"
        }
    }
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Define authentication method mappings (file name to API method and cmdlet)
# ApiVersion mirrors Backup-AuthenticationPolicies.ps1: v1.0 for most methods, beta for fido2.
# ApiName must match the Graph URL path segment (camelCase), not the resource id field.
$authMethodMappings = @{
    "passkeys-fido2" = @{
        DisplayName = "FIDO2 (Passkeys)"
        ApiName = "fido2"
        ApiNameFallback = "Fido2"
        ApiVersion = "beta"
        OdataType = "#microsoft.graph.fido2AuthenticationMethodConfiguration"
        UpdateCmdlet = "Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration"
    }
    "temporary-access-pass" = @{
        DisplayName = "Temporary Access Pass"
        ApiName = "temporaryAccessPass"
        ApiVersion = "v1.0"
        OdataType = "#microsoft.graph.temporaryAccessPassAuthenticationMethodConfiguration"
        UpdateCmdlet = "Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration"
    }
    "sms" = @{
        DisplayName = "SMS"
        ApiName = "sms"
        ApiVersion = "v1.0"
        OdataType = "#microsoft.graph.smsAuthenticationMethodConfiguration"
        UpdateCmdlet = "Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration"
    }
    "voice" = @{
        DisplayName = "Voice"
        ApiName = "voice"
        ApiVersion = "v1.0"
        OdataType = "#microsoft.graph.voiceAuthenticationMethodConfiguration"
        UpdateCmdlet = "Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration"
    }
    "email-otp" = @{
        DisplayName = "Email OTP"
        ApiName = "email"
        ApiVersion = "v1.0"
        OdataType = "#microsoft.graph.emailAuthenticationMethodConfiguration"
        UpdateCmdlet = "Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration"
    }
    "microsoft-authenticator" = @{
        DisplayName = "Microsoft Authenticator"
        ApiName = "microsoftAuthenticator"
        ApiNameFallback = "MicrosoftAuthenticator"
        ApiVersion = "v1.0"
        OdataType = "#microsoft.graph.microsoftAuthenticatorAuthenticationMethodConfiguration"
        UpdateCmdlet = "Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration"
    }
    "software-oath-tokens" = @{
        DisplayName = "Software OATH Tokens"
        ApiName = "softwareOath"
        ApiVersion = "v1.0"
        OdataType = "#microsoft.graph.softwareOathAuthenticationMethodConfiguration"
        UpdateCmdlet = "Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration"
    }
    "hardware-oath-tokens" = @{
        DisplayName = "Hardware OATH Tokens (x509)"
        ApiName = "x509Certificate"
        ApiVersion = "v1.0"
        OdataType = "#microsoft.graph.x509CertificateAuthenticationMethodConfiguration"
        UpdateCmdlet = "Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration"
    }
}

function Get-AuthenticationMethodConfigurationUri {
    param(
        [string]$ApiVersion,
        [string]$ApiName
    )
    return "https://graph.microsoft.com/$ApiVersion/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/$ApiName"
}

function Get-AuthenticationMethodConfiguration {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Mapping
    )

    $apiVersion = if ($Mapping.ApiVersion) { $Mapping.ApiVersion } else { 'v1.0' }
    $namesToTry = @($Mapping.ApiName)
    if ($Mapping.ApiNameFallback) { $namesToTry += $Mapping.ApiNameFallback }

    $lastError = $null
    foreach ($apiName in $namesToTry) {
        $uri = Get-AuthenticationMethodConfigurationUri -ApiVersion $apiVersion -ApiName $apiName
        try {
            $config = Invoke-MgGraphRequest -Uri $uri -Method GET
            if ($config) {
                Write-Host "  [INFO] GET $apiVersion/$apiName succeeded" -ForegroundColor Cyan
                return @{ Config = $config; Uri = $uri }
            }
        }
        catch {
            $lastError = $_
            Write-Host "  [WARN] GET $apiVersion/$apiName failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    if ($lastError) { throw $lastError }
    throw "Authentication method configuration not returned by Graph API"
}

function Normalize-AuthenticationMethodConfigHash {
    param([object]$Config)

    if ($null -eq $Config) { return $null }

    $hash = $Config | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    if (-not $hash) { return $null }

    foreach ($key in @($hash.Keys)) {
        if ($key -like '*@odata.context*' -or $key -like '_*') {
            $hash.Remove($key)
        }
    }

    if ($hash.ContainsKey('includeTargets') -and $hash['includeTargets'] -is [System.Collections.IDictionary]) {
        $hash['includeTargets'] = @($hash['includeTargets'])
    }

    if ($hash.ContainsKey('excludeTargets') -and $null -eq $hash['excludeTargets']) {
        $hash['excludeTargets'] = @()
    }

    return $hash
}

# Function to configure an auth method from a config object
function Set-AuthenticationMethod {
    param(
        [string]$MethodName,
        [object]$Config
    )
    
    $mapping = $authMethodMappings[$MethodName]
    if (-not $mapping) {
        Write-Host "##[warning]Unknown authentication method: $MethodName"
        return
    }

    # Top-level properties the API reports but silently ignores on PATCH for each method.
    # This knowledge belongs here in the script — NOT in baseline files.
    $readOnlyByMethod = @{}
    # Nested sub-properties to strip from within a top-level object for each method.
    # Key = top-level property, Value = array of sub-property names to remove.
    $readOnlyNestedByMethod = @{}
    $methodReadOnly       = if ($readOnlyByMethod.ContainsKey($MethodName))       { $readOnlyByMethod[$MethodName] }       else { @() }
    $methodReadOnlyNested = if ($readOnlyNestedByMethod.ContainsKey($MethodName)) { $readOnlyNestedByMethod[$MethodName] } else { @{} }

    # Writable fields that have stale null values in the exported baseline — not yet baselined.
    # These are NOT API read-only; they are configurable but the baseline predates their use.
    # Strip from $configHash only when the baseline value is null so they are never compared
    # or PATCHed to null. Once the baseline is updated with real values, remove entries here.
    $skipWhenNullByMethod = @{
        'passkeys-fido2' = @('defaultPasskeyProfile')
    }
    $methodSkipWhenNull = if ($skipWhenNullByMethod.ContainsKey($MethodName)) { $skipWhenNullByMethod[$MethodName] } else { @() }

    Write-Host "`n##[group]Configuring $($mapping.DisplayName)..."
    
    $result = @{
        DisplayName = $mapping.DisplayName
        Type = "AuthenticationMethod"
        Status = ""
        Changes = @{}
        FilePath = if ($Config._SourceFile) { $Config._SourceFile } else { $null }
    }
    
    try {
        # Fetch current tenant config (v1.0 for most methods; beta for fido2 — matches backup script)
        $currentUri = $null
        $currentConfig = $null
        try {
            $getResult     = Get-AuthenticationMethodConfiguration -Mapping $mapping
            $currentConfig = $getResult.Config
            $currentUri    = $getResult.Uri
        }
        catch {
            $errMsg = if ($_.Exception.Message) { $_.Exception.Message } else { "$_" }
            Write-Host "##[error]Could not retrieve current settings for $($mapping.DisplayName): $errMsg" -ForegroundColor Red
            $result.Status = "Failed: Could not read current configuration from Graph"
            $result.Error  = $errMsg
            $script:planResults.ErrorCount++
            $script:planResults.Results += $result
            Write-Host "##[endgroup]"
            return
        }
        
        # DEBUG: Log original config before processing
        Write-Host "  [DEBUG] Original config from file:"
        Write-Host "  $($Config | ConvertTo-Json -Depth 10 -Compress)" -ForegroundColor Gray
        
        # Remove metadata properties that shouldn't be sent in the update
        $configHash = $Config | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable

        # Microsoft Graph requires `@odata.type` in the PATCH body for every
        # authenticationMethodConfiguration resource. Without it, Graph treats
        # the body as the abstract base type `authenticationMethodConfiguration`
        # and silently drops type-specific fields — most notably
        # `includeTargets[].authenticationMode` (which is defined on the derived
        # `microsoftAuthenticatorAuthenticationMethodTarget` type), causing PATCHes
        # to return 204 but never actually update the value. Always keep the
        # baseline's @odata.type, and inject the correct one if missing.
        # Refs:
        #   https://learn.microsoft.com/en-us/graph/api/microsoftauthenticatorauthenticationmethodconfiguration-update
        #   https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-mfa-additional-context
        $removedProps = @()
        $keysToCheck = @($configHash.Keys)  # Create array copy to avoid modification during iteration
        foreach ($key in $keysToCheck) {
            # Always keep id and @odata.type — required by all auth-methods PATCH endpoints
            if ($key -eq 'id' -or $key -eq '@odata.type') {
                continue
            }
            if ($key -like '*@odata.context*' -or $key -like '_*') {
                # Strip @odata.context (read-only) and underscore-prefixed comment/sidecar keys.
                $removedProps += $key
                $configHash.Remove($key)
            }
        }
        if ($removedProps.Count -gt 0) {
            Write-Host "  [DEBUG] Removed metadata properties: $($removedProps -join ', ')" -ForegroundColor Gray
        }

        # Inject the canonical @odata.type if the baseline doesn't have one.
        if (-not $configHash.ContainsKey('@odata.type') -and $mapping.OdataType) {
            $configHash['@odata.type'] = $mapping.OdataType
            Write-Host "  [DEBUG] Injected @odata.type='$($mapping.OdataType)' (required by Graph API)" -ForegroundColor Cyan
        }
        elseif ($configHash.ContainsKey('@odata.type')) {
            Write-Host "  [DEBUG] Keeping @odata.type='$($configHash['@odata.type'])' (required by Graph API)" -ForegroundColor Cyan
        }
        
        # Fix includeTargets format - API expects an array, not an object
        if ($configHash.ContainsKey('includeTargets') -and $configHash['includeTargets'] -is [System.Collections.IDictionary]) {
            Write-Host "  [DEBUG] Converting includeTargets from object to array (API requirement)" -ForegroundColor Cyan
            $configHash['includeTargets'] = @($configHash['includeTargets'])
        }
        
        # Fix excludeTargets - convert null to empty array
        if ($configHash.ContainsKey('excludeTargets') -and $null -eq $configHash['excludeTargets']) {
            Write-Host "  [DEBUG] Converting excludeTargets from null to empty array (API requirement)" -ForegroundColor Cyan
            $configHash['excludeTargets'] = @()
        }

        # Defensive normalizations for files backed up before the ConvertFrom-Json round-trip fix.
        # The backup now preserves arrays correctly; these handle any existing baseline files that
        # were written in the wrong format.

        # passkeyProfiles: old backup stored a single-element array as an object — API requires array
        if ($MethodName -eq 'passkeys-fido2' -and
            $configHash.ContainsKey('passkeyProfiles') -and
            $configHash['passkeyProfiles'] -is [System.Collections.IDictionary]) {
            Write-Host "  [DEBUG] Normalizing passkeyProfiles object→array (legacy backup format)" -ForegroundColor Cyan
            $configHash['passkeyProfiles'] = @($configHash['passkeyProfiles'])
        }

        # aaGuids: null → [] within each passkeyProfile's keyRestrictions (API rejects null)
        if ($MethodName -eq 'passkeys-fido2' -and
            $configHash.ContainsKey('passkeyProfiles') -and
            $configHash['passkeyProfiles'] -is [System.Collections.IList]) {
            foreach ($profile in $configHash['passkeyProfiles']) {
                $p = if ($profile -is [System.Collections.IDictionary]) { $profile } else {
                    $profile | ConvertTo-Json -Depth 5 | ConvertFrom-Json -AsHashtable
                }
                if ($p.ContainsKey('keyRestrictions') -and
                    $p['keyRestrictions'] -is [System.Collections.IDictionary] -and
                    $p['keyRestrictions'].ContainsKey('aaGuids') -and
                    $null -eq $p['keyRestrictions']['aaGuids']) {
                    $p['keyRestrictions']['aaGuids'] = @()
                    Write-Host "  [DEBUG] Normalized passkeyProfiles[].keyRestrictions.aaGuids null→[]" -ForegroundColor Cyan
                }
            }
        }

        # aaGuids: null → [] at the top-level keyRestrictions (API rejects null; backup stored null)
        if ($MethodName -eq 'passkeys-fido2' -and
            $configHash.ContainsKey('keyRestrictions') -and
            $configHash['keyRestrictions'] -is [System.Collections.IDictionary] -and
            $configHash['keyRestrictions'].ContainsKey('aaGuids') -and
            $null -eq $configHash['keyRestrictions']['aaGuids']) {
            $configHash['keyRestrictions']['aaGuids'] = @()
            Write-Host "  [DEBUG] Normalized top-level keyRestrictions.aaGuids null→[]" -ForegroundColor Cyan
        }

        # allowedPasskeyProfiles: old backup stored a single-element array as a string — API returns/expects array
        if ($MethodName -eq 'passkeys-fido2' -and
            $configHash.ContainsKey('includeTargets') -and
            $configHash['includeTargets'] -is [System.Collections.IList]) {
            $configHash['includeTargets'] = @($configHash['includeTargets'] | ForEach-Object {
                $item = if ($_ -is [System.Collections.IDictionary]) { $_ } else {
                    $_ | ConvertTo-Json -Depth 5 | ConvertFrom-Json -AsHashtable
                }
                if ($item.ContainsKey('allowedPasskeyProfiles') -and
                    $item['allowedPasskeyProfiles'] -is [string]) {
                    $item['allowedPasskeyProfiles'] = @($item['allowedPasskeyProfiles'])
                    Write-Host "  [DEBUG] Normalized includeTargets[].allowedPasskeyProfiles string→array" -ForegroundColor Cyan
                }
                $item
            })
        }

        # Strip read-only top-level properties — the API accepts them in PATCH but silently
        # ignores them, causing a false-positive change detection on every run.
        foreach ($roProp in $methodReadOnly) {
            if ($configHash.ContainsKey($roProp)) {
                $configHash.Remove($roProp)
                Write-Host "  [DEBUG] Excluded read-only property '$roProp' (API silently ignores writes)" -ForegroundColor DarkGray
            }
        }

        # Strip read-only sub-properties from within nested objects.
        # e.g. featureSettings.state is always "default" on MicrosoftAuthenticator regardless of what is sent.
        foreach ($parentKey in $methodReadOnlyNested.Keys) {
            if ($configHash.ContainsKey($parentKey) -and $configHash[$parentKey] -is [System.Collections.IDictionary]) {
                $parentObj = $configHash[$parentKey]
                foreach ($childKey in $parentObj.Keys) {
                    $subObj = $parentObj[$childKey]
                    if ($subObj -is [System.Collections.IDictionary]) {
                        foreach ($roProp in $methodReadOnlyNested[$parentKey]) {
                            if ($subObj.ContainsKey($roProp)) {
                                $subObj.Remove($roProp)
                                Write-Host "  [DEBUG] Excluded read-only sub-property '$parentKey.$childKey.$roProp' (API silently ignores writes)" -ForegroundColor DarkGray
                            }
                        }
                    }
                }
            }
        }

        # Strip stale-null baseline fields — writable by the API but the baseline predates their
        # use and has null placeholders. Only strip when the baseline value is null; once the
        # baseline is updated with real values these will be compared and applied normally.
        foreach ($prop in $methodSkipWhenNull) {
            if ($configHash.ContainsKey($prop) -and $null -eq $configHash[$prop]) {
                $configHash.Remove($prop)
                Write-Host "  [DEBUG] Skipped stale-null baseline field '$prop' (not yet baselined)" -ForegroundColor DarkGray
            }
        }

        # Strip stale-null allowedPasskeyProfiles from each includeTargets item.
        if ($MethodName -eq 'passkeys-fido2' -and $configHash.ContainsKey('includeTargets') -and
            $configHash['includeTargets'] -is [System.Collections.IList]) {
            $configHash['includeTargets'] = @($configHash['includeTargets'] | ForEach-Object {
                $item = if ($_ -is [System.Collections.IDictionary]) { $_ } else {
                    $_ | ConvertTo-Json -Depth 5 | ConvertFrom-Json -AsHashtable
                }
                if ($item.ContainsKey('allowedPasskeyProfiles') -and $null -eq $item['allowedPasskeyProfiles']) {
                    $item.Remove('allowedPasskeyProfiles')
                    Write-Host "  [DEBUG] Skipped stale-null includeTargets.allowedPasskeyProfiles (not yet baselined)" -ForegroundColor DarkGray
                }
                $item
            })
        }

        # DEBUG: Log current and desired configurations for comparison
        Write-Host "  [DEBUG] Current config from API:"
        Write-Host "  $($currentConfig | ConvertTo-Json -Depth 10 -Compress)" -ForegroundColor Cyan
        Write-Host "  [DEBUG] Desired config (after cleanup):"
        Write-Host "  $($configHash | ConvertTo-Json -Depth 10 -Compress)" -ForegroundColor Cyan
        
        # Apply field-monitor filter if sidecar is present
        $authMonitorConfig = $null
        if ($Config._monitorConfig) {
            $authMonitorConfig = @{}
            if ($Config._monitorConfig.Include) { $authMonitorConfig['Include'] = @($Config._monitorConfig.Include) }
            if ($Config._monitorConfig.Exclude) { $authMonitorConfig['Exclude'] = @($Config._monitorConfig.Exclude) }
            if ($authMonitorConfig.Count -eq 0) { $authMonitorConfig = $null }
        }
        $compareConfigHash = if ($authMonitorConfig) { Apply-MonitorFilter -PolicyObject $configHash -MonitorConfig $authMonitorConfig } else { $configHash }
        $currentCompareHash = Normalize-AuthenticationMethodConfigHash -Config $currentConfig

        # Compare settings to detect changes
        $hasChanges = $false
        $changesObj = @{ Modified = @(); ModifiedValues = @{} }
        if ($currentCompareHash) {
            # DEBUG: log per-property comparison results
            foreach ($key in $compareConfigHash.Keys) {
                $currentValue = if ($currentCompareHash.ContainsKey($key)) { $currentCompareHash[$key] } else { $null }
                $newValue     = $compareConfigHash[$key]
                $match = Compare-PropertyValues -Current $currentValue -New $newValue
                Write-Host "  [DEBUG] Comparing property '$key': $(if ($match) { 'match' } else { 'CHANGED' })" -ForegroundColor $(if ($match) { 'Green' } else { 'Yellow' })
                if (-not $match) {
                    Write-Host "    Current: $($currentValue | ConvertTo-Json -Compress)" -ForegroundColor Yellow
                    Write-Host "    Desired: $($newValue     | ConvertTo-Json -Compress)" -ForegroundColor Yellow
                }
            }
            $changesObj = New-ChangesObject -Existing $currentCompareHash -Desired $compareConfigHash
            $hasChanges = $changesObj.Modified.Count -gt 0
        }
        else {
            Write-Host "##[error]Current configuration could not be normalized for comparison" -ForegroundColor Red
            $result.Status = "Failed: Could not normalize current configuration for comparison"
            $result.Error  = "Normalize-AuthenticationMethodConfigHash returned null"
            $script:planResults.ErrorCount++
            $script:planResults.Results += $result
            Write-Host "##[endgroup]"
            return
        }
        
        if ($hasChanges) {
            if ($PSCmdlet.ShouldProcess($mapping.DisplayName, "Update")) {
                # Use Graph API directly for more control
                $patchConfigHash = if ($authMonitorConfig) { Apply-MonitorFilter -PolicyObject $configHash -MonitorConfig $authMonitorConfig } else { $configHash }

                # Re-assert @odata.type after the monitor filter — Graph requires it on every
                # PATCH and an Include-style monitor filter will otherwise strip it. Without
                # @odata.type, derived-type properties (e.g. includeTargets[].authenticationMode)
                # are silently dropped and the PATCH returns 204 with no actual change applied.
                if ($mapping.OdataType -and (-not ($patchConfigHash -is [System.Collections.IDictionary]) -or -not $patchConfigHash.ContainsKey('@odata.type'))) {
                    if ($patchConfigHash -isnot [System.Collections.IDictionary]) {
                        $patchConfigHash = [ordered]@{}
                    }
                    $patchConfigHash['@odata.type'] = $mapping.OdataType
                    Write-Host "  [DEBUG] Re-asserted @odata.type='$($mapping.OdataType)' on PATCH body" -ForegroundColor Cyan
                }

                Write-Host "  [DEBUG] Sending PATCH request with body:"
                Write-Host "  $($patchConfigHash | ConvertTo-Json -Depth 10 -Compress)" -ForegroundColor Magenta
                
                # DIAGNOSTIC: Capture the full response including status code
                try {
                    $patchResponse = Invoke-MgGraphRequest -Uri $currentUri -Method PATCH -Body ($patchConfigHash | ConvertTo-Json -Depth 10) -ContentType "application/json" -OutputType Json
                    Write-Host "  [DEBUG] PATCH response received (HTTP 204 or 200 expected)"
                    if ($patchResponse) {
                        Write-Host "  [DEBUG] Response body: $patchResponse" -ForegroundColor Cyan
                    }
                    Write-Host "✓ $($mapping.DisplayName) configured"
                }
                catch {
                    Write-Host "  [ERROR] PATCH request failed: $($_.Exception.Message)" -ForegroundColor Red
                    if ($_.ErrorDetails) {
                        Write-Host "  [ERROR] Error details: $($_.ErrorDetails)" -ForegroundColor Red
                    }
                    
                    # Try alternate approach: Full configuration with all current values
                    Write-Host "  [RETRY] Attempting full configuration update (including unchanged properties)..." -ForegroundColor Yellow
                    try {
                        # Merge current config with desired changes
                        $fullConfigHash = @{}
                        foreach ($key in $currentConfig.PSObject.Properties.Name) {
                            if ($key -notmatch '@odata') {
                                $fullConfigHash[$key] = $currentConfig.$key
                            }
                        }
                        # Override with our desired values
                        foreach ($key in $configHash.Keys) {
                            $fullConfigHash[$key] = $configHash[$key]
                        }
                        
                        Write-Host "  [DEBUG] Sending full configuration update..."
                        # Apply monitor filter to the merged retry body — excluded fields must not be written
                        $retryPatchHash = if ($authMonitorConfig) { Apply-MonitorFilter -PolicyObject $fullConfigHash -MonitorConfig $authMonitorConfig } else { $fullConfigHash }

                        # Re-assert @odata.type — see note above on the primary PATCH path.
                        if ($mapping.OdataType -and ($retryPatchHash -is [System.Collections.IDictionary]) -and -not $retryPatchHash.ContainsKey('@odata.type')) {
                            $retryPatchHash['@odata.type'] = $mapping.OdataType
                            Write-Host "  [DEBUG] Re-asserted @odata.type on retry PATCH body" -ForegroundColor Cyan
                        }

                        $retryResponse = Invoke-MgGraphRequest -Uri $currentUri -Method PATCH -Body ($retryPatchHash | ConvertTo-Json -Depth 10) -ContentType "application/json"
                        Write-Host "  ✓ Retry successful with full configuration" -ForegroundColor Green
                    }
                    catch {
                        Write-Host "  [ERROR] Retry also failed: $($_.Exception.Message)" -ForegroundColor Red
                        throw
                    }
                }
                
                # VERIFICATION: Read back the configuration to verify the update was applied
                Write-Host "  [VERIFY] Reading back configuration to verify update..." -ForegroundColor Cyan
                Start-Sleep -Seconds 2  # Brief delay to allow propagation
                
                try {
                    $verifyConfig = Invoke-MgGraphRequest -Uri $currentUri -Method GET
                    Write-Host "  [VERIFY] Post-update config from API:"
                    Write-Host "  $($verifyConfig | ConvertTo-Json -Depth 10 -Compress)" -ForegroundColor Cyan
                    
                    # Check if the update actually took effect
                    $verifyFailed = $false
                    $verifyFailures = @()
                    foreach ($key in $configHash.Keys) {
                        $verifyValue = $verifyConfig.$key
                        $expectedValue = $configHash[$key]
                        
                        if (-not (Compare-PropertyValues -Current $verifyValue -New $expectedValue)) {
                            $verifyFailed = $true
                            $verifyFailures += "Property '$key' still doesn't match after update!"
                            Write-Host "  [VERIFY] ❌ Property '$key' verification FAILED" -ForegroundColor Red
                            Write-Host "    Expected: $($expectedValue | ConvertTo-Json -Compress)" -ForegroundColor Red
                            Write-Host "    Got: $($verifyValue | ConvertTo-Json -Compress)" -ForegroundColor Red
                        }
                        else {
                            Write-Host "  [VERIFY] ✓ Property '$key' verified successfully" -ForegroundColor Green
                        }
                    }
                    
                    if ($verifyFailed) {
                        Write-Host "  [VERIFY] ⚠️ UPDATE MAY NOT HAVE BEEN APPLIED CORRECTLY" -ForegroundColor Red
                        $result.VerificationStatus = "Failed"
                        $result.VerificationFailures = $verifyFailures
                        
                        # Add specific diagnostics for known problematic properties
                        foreach ($failure in $verifyFailures) {
                            if ($failure -match "isAttestationEnforced" -and $MethodName -eq "passkeys-fido2") {
                                Write-Host "`n  [DIAGNOSTIC] FIDO2 Attestation Enforcement Issue Detected:" -ForegroundColor Yellow
                                Write-Host "    This property requires one of the following:" -ForegroundColor Yellow
                                Write-Host "      1. Azure AD Premium P1 or P2 licensing" -ForegroundColor Yellow
                                Write-Host "      2. Specific tenant-level feature enablement" -ForegroundColor Yellow
                                Write-Host "      3. May only be configurable via Azure Portal in some tenants" -ForegroundColor Yellow
                                Write-Host "    Verify:" -ForegroundColor Cyan
                                Write-Host "      - Tenant has appropriate licensing (check Azure AD P1/P2)" -ForegroundColor Cyan
                                Write-Host "      - Service Principal has admin consent granted" -ForegroundColor Cyan
                                Write-Host "      - Try configuring manually in: Entra Portal > Protection >" -ForegroundColor Cyan
                                Write-Host "        Authentication methods > Passkey (FIDO2) > Configure" -ForegroundColor Cyan
                            }
                            elseif ($failure -match "featureSettings" -and $MethodName -eq "microsoft-authenticator") {
                                Write-Host "`n  [DIAGNOSTIC] Microsoft Authenticator Feature Settings Issue:" -ForegroundColor Yellow
                                Write-Host "    The 'state' property in featureSettings may be read-only via API" -ForegroundColor Yellow
                                Write-Host "    Consider using 'default' instead of 'enabled' in your baseline config" -ForegroundColor Yellow
                            }
                            elseif ($failure -match "authenticationMode" -and $MethodName -eq "microsoft-authenticator") {
                                Write-Host "`n  [DIAGNOSTIC] Microsoft Authenticator Mode Issue:" -ForegroundColor Yellow
                                Write-Host "    The authenticationMode may be controlled by other Authenticator policies" -ForegroundColor Yellow
                                Write-Host "    Check if there are conflicting settings in the tenant" -ForegroundColor Yellow
                            }
                        }
                    }
                    else {
                        Write-Host "  [VERIFY] ✓ All properties verified successfully" -ForegroundColor Green
                        $result.VerificationStatus = "Passed"
                    }
                }
                catch {
                    Write-Host "  [VERIFY] ⚠️ Could not verify update: $_" -ForegroundColor Yellow
                    $result.VerificationStatus = "Error: $_"
                }
                
                $result.Status = "Updated"
                $script:planResults.WouldUpdateCount++
            }
            else {
                Write-Host "[WhatIf] Would update $($mapping.DisplayName)"
                foreach ($change in $changesObj.Modified) { Write-Host "  - $change" }
                $result.Status  = "WouldUpdate"
                $result.Changes = $changesObj
                $script:planResults.WouldUpdateCount++
            }
        }
        else {
            Write-Host "○ $($mapping.DisplayName) - no changes needed"
            $result.Status = "No changes"
            $script:planResults.NoChangeCount++
        }
    }
    catch {
        Write-Host "##[warning]Failed to configure $($mapping.DisplayName): $_"
        $result.Status = "Failed: $_"
        $script:planResults.ErrorCount++
    }
    
    $script:planResults.Results += $result
    Write-Host "##[endgroup]"
}

# Process configuration based on input type
if ($ConfigDirectory) {
    # New mode: Process individual JSON files from directory
    if (-not (Test-Path $ConfigDirectory)) {
        Write-Host "##[warning]Configuration directory not found: $ConfigDirectory"
        Save-PlanOutput
        exit 0
    }
    
    $configFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File
    
    # Filter out ignored files based on .baseline-ignore
    # Use the baseline folder root so patterns like "authentication-methods/file.json" work correctly
    $baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }
    $configFiles = @(Get-FilteredPolicyFiles -PolicyFiles $configFiles -BaselineRoot $baselineRoot)
    $configFiles = @(Get-GroupExcludedFiles -Files $configFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
    
    if ($configFiles.Count -eq 0) {
        Write-Host "##[warning]No JSON files found in directory: $ConfigDirectory"
        Save-PlanOutput
        exit 0
    }
    
    Write-Host "Found $($configFiles.Count) authentication method configuration(s)"
    
    foreach ($file in $configFiles) {
        $methodName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
        Write-Host "Processing: $($file.Name)"
        
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $authMonitorCfg = Get-MonitorConfig -BaselineFilePath $file.FullName
        if ($authMonitorCfg) {
            $config | Add-Member -NotePropertyName '_monitorConfig' -NotePropertyValue $authMonitorCfg -Force
        }
        $config | Add-Member -NotePropertyName '_SourceFile' -NotePropertyValue $file.FullName -Force
        Set-AuthenticationMethod -MethodName $methodName -Config $config
    }
}
elseif ($ConfigPath) {
    # Legacy mode: Process single JSON file with all methods
    if (-not (Test-Path $ConfigPath)) {
        throw "Configuration file not found: $ConfigPath"
    }
    
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    Write-Host "Loaded configuration from: $ConfigPath"
    
    # Map old property names to new method names
    $legacyMappings = @{
        "SmsAuthentication" = "sms"
        "EmailOtp" = "email-otp"
        "Fido2" = "passkeys-fido2"
        "MicrosoftAuthenticator" = "microsoft-authenticator"
        "TemporaryAccessPass" = "temporary-access-pass"
        "Voice" = "voice"
        "SoftwareOath" = "software-oath-tokens"
        "X509Certificate" = "hardware-oath-tokens"
    }
    
    foreach ($legacyProp in $legacyMappings.Keys) {
        if ($config.PSObject.Properties.Name -contains $legacyProp) {
            $methodName = $legacyMappings[$legacyProp]
            Set-AuthenticationMethod -MethodName $methodName -Config $config.$legacyProp
        }
    }
}

# Stamp FilePath on legacy-mode results that don't have one yet
if ($ConfigPath) {
    foreach ($r in $planResults.Results) {
        if (-not $r['FilePath']) { $r['FilePath'] = $ConfigPath }
    }
}

# Output plan summary
Save-PlanOutput

# Report verification failures
$verificationFailures = $planResults.Results | Where-Object { $_.VerificationStatus -eq "Failed" }
if ($verificationFailures.Count -gt 0) {
    Write-Host "`n##[warning]⚠️ VERIFICATION FAILURES DETECTED" -ForegroundColor Red
    Write-Host "The following authentication methods were updated but verification checks failed:" -ForegroundColor Red
    foreach ($failure in $verificationFailures) {
        Write-Host "  - $($failure.DisplayName)" -ForegroundColor Red
        if ($failure.VerificationFailures) {
            foreach ($vf in $failure.VerificationFailures) {
                Write-Host "    • $vf" -ForegroundColor Red
            }
        }
    }
    Write-Host "`nThis may indicate:" -ForegroundColor Yellow
    Write-Host "  1. The API is not accepting the update (check permissions or API limitations)" -ForegroundColor Yellow
    Write-Host "  2. The property is read-only or requires additional configuration" -ForegroundColor Yellow
    Write-Host "  3. There's a type mismatch or format issue with the value" -ForegroundColor Yellow
    Write-Host "`nPlease review the debug output above for more details." -ForegroundColor Yellow

    Write-Host "`n##[section]Authentication Methods Configuration Complete (with $($verificationFailures.Count) verification failure(s))"
    # Surface the failure to the Gitea Actions step so the deploy job goes red.
    # The pipeline gatekeeper at deploy-pipeline.yml:1336 only inspects step
    # outcomes (success/failure), not log content — emitting a Write-Host
    # warning is not enough to fail the run. Exiting non-zero here makes the
    # step outcome `failure` so `Check Step Failures` can flip the job red.
    exit 1
}

Write-Host "`n##[section]Authentication Methods Configuration Complete"
