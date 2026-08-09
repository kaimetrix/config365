<#
.SYNOPSIS
    Shared helper functions for Intune policy configuration scripts
    
.DESCRIPTION
    Contains common functions used by all Configure-Intune-*.ps1 modules:
    - Repair-PolicyPayload: Fixes JSON schema issues for Graph API
    - ConvertTo-CleanHashtable: Removes nulls and metadata
    - Get-AllPoliciesOfType: Fetches policies from tenant (with caching)
    - Get-ExistingPolicy: Finds a specific policy by name
    - Apply-PolicyAssignments: Applies group assignments to policies
    
.NOTES
    This module should be dot-sourced by the main Configure-Intune.ps1 and individual policy modules
#>

# Cache for existing policies to avoid repeated API calls
if (-not $script:PolicyCache) {
    $script:PolicyCache = @{}
}

# ============================================================================
# REPAIR FUNCTIONS - Fix JSON schema issues for Graph API compatibility
# ============================================================================

<#
.SYNOPSIS
    Repairs a policy payload to be compatible with Graph API
.DESCRIPTION
    Fixes common schema issues in backup JSON files:
    - roleScopeTagIds as string vs array
    - settings/children as objects vs arrays  
    - null values that should be empty arrays
.PARAMETER Payload
    The policy configuration object to repair
.PARAMETER PolicyType
    The type of policy (e.g., "app-protection", "compliance-policies")
#>
function Repair-PolicyPayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload,
        [Parameter(Mandatory=$true)]
        [string]$PolicyType
    )
    
    # Convert to hashtable for easier manipulation
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata properties that shouldn't be sent to the API
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context', 'settingCount', 'creationSource',
                       '_sourceFile', '_sourcePath', '_policyType', '_assignments', '_settings',
                       'isGlobalScript', 'highestAvailableVersion', 'deviceHealthScriptType',
                       'supportsScopeTags')
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) {
            $json.Remove($prop)
        }
    }
    
    # Fix roleScopeTagIds - should always be an array of strings
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) {
            $json['roleScopeTagIds'] = @("0")
        }
        elseif ($tagIds -is [string]) {
            # Split by comma if multiple values, otherwise wrap in array
            if ($tagIds -match ',') {
                $json['roleScopeTagIds'] = @($tagIds -split ',' | ForEach-Object { $_.Trim() })
            }
            else {
                $json['roleScopeTagIds'] = @($tagIds)
            }
        }
        elseif ($tagIds -isnot [System.Collections.IList]) {
            $json['roleScopeTagIds'] = @($tagIds.ToString())
        }
    }
    
    # Generic cleanup: Fix primitive values that are incorrectly single-element arrays
    $primitiveProps = @('userExtensionOverridesAllowed', 'userExtensionsAllowed',
                        'kernelExtensionsAreUserApproved', 'systemExtensionsAreUserApproved',
                        'systemExtensionsBlockUserOverride', 'kernelExtensionsBlockUserOverride',
                        'userExtensionsBlocked', 'systemExtensionsBlocked')
    foreach ($prop in $primitiveProps) {
        if ($json.ContainsKey($prop)) {
            $value = $json[$prop]
            if ($value -is [System.Collections.IList] -and $value.Count -eq 1) {
                $json[$prop] = $value[0]
            }
        }
    }
    
    # Recursively fix all single-element arrays that contain primitives
    function Fix-PrimitiveArraysRecursive {
        param([hashtable]$Object)
        foreach ($key in @($Object.Keys)) {
            $value = $Object[$key]
            if ($value -is [System.Collections.IList] -and $value.Count -eq 1) {
                $inner = $value[0]
                if ($inner -is [bool] -or $inner -is [int] -or $inner -is [string] -or $inner -is [double]) {
                    $Object[$key] = $inner
                }
            }
            elseif ($value -is [hashtable]) {
                Fix-PrimitiveArraysRecursive -Object $value
            }
        }
    }
    Fix-PrimitiveArraysRecursive -Object $json
    
    # Final cleanup: Remove ALL remaining null values recursively
    function Remove-NullValues {
        param([hashtable]$Object)
        $keysToRemove = @()
        foreach ($key in $Object.Keys) {
            $value = $Object[$key]
            if ($null -eq $value) {
                $keysToRemove += $key
            }
            elseif ($value -is [hashtable]) {
                Remove-NullValues -Object $value
                if ($value.Count -eq 0) {
                    $keysToRemove += $key
                }
            }
        }
        foreach ($key in $keysToRemove) {
            $Object.Remove($key)
        }
    }
    Remove-NullValues -Object $json
    
    # Convert back to PSObject for API call
    return ($json | ConvertTo-Json -Depth 30 | ConvertFrom-Json)
}

<#
.SYNOPSIS
    Converts any object to a clean hashtable with nulls removed
.DESCRIPTION
    Should be called right before sending data to the Graph API.
    Removes null values, metadata properties, and ensures proper structure.
#>
function ConvertTo-CleanHashtable {
    param(
        [Parameter(Mandatory=$true)]
        [AllowNull()]
        $InputObject,
        [string[]]$ExcludeProperties = @()
    )
    
    if ($null -eq $InputObject) {
        return $null
    }
    
    # Default properties to exclude (metadata/internal fields)
    $defaultExclude = @('_sourceFile', '_policyType', '_assignments', '_settings')
    $allExclude = $defaultExclude + $ExcludeProperties
    
    $result = [ordered]@{}
    
    # Get properties based on object type
    $properties = if ($InputObject -is [hashtable]) {
        $InputObject.GetEnumerator() | ForEach-Object { [PSCustomObject]@{ Name = $_.Key; Value = $_.Value } }
    }
    elseif ($InputObject -is [System.Collections.IDictionary]) {
        $InputObject.GetEnumerator() | ForEach-Object { [PSCustomObject]@{ Name = $_.Key; Value = $_.Value } }
    }
    else {
        $InputObject.PSObject.Properties
    }
    
    foreach ($prop in $properties) {
        $name = $prop.Name
        $value = $prop.Value
        
        # Skip excluded properties
        if ($allExclude -contains $name) { continue }
        
        # Skip null values
        if ($null -eq $value) { continue }
        
        # Handle nested objects recursively
        if ($value -is [hashtable] -or ($value -is [PSCustomObject] -and $value.PSObject.Properties.Count -gt 0)) {
            $cleanedValue = ConvertTo-CleanHashtable -InputObject $value
            if ($null -ne $cleanedValue -and $cleanedValue.Count -gt 0) {
                $result[$name] = $cleanedValue
            }
        }
        elseif ($value -is [System.Collections.IList] -and $value -isnot [string] -and $value -isnot [byte[]]) {
            # Handle arrays - clean each element and filter out nulls
            $cleanedArray = [System.Collections.ArrayList]@()
            foreach ($item in $value) {
                if ($null -eq $item) { continue }
                if ($item -is [hashtable] -or $item -is [PSCustomObject]) {
                    $cleanedItem = ConvertTo-CleanHashtable -InputObject $item
                    if ($null -ne $cleanedItem -and $cleanedItem.Count -gt 0) {
                        [void]$cleanedArray.Add($cleanedItem)
                    }
                }
                else {
                    [void]$cleanedArray.Add($item)
                }
            }
            # ALWAYS preserve arrays, even empty ones - Graph API requires certain array properties
            $result[$name] = @($cleanedArray)
        }
        else {
            # Primitive value - keep as-is
            $result[$name] = $value
        }
    }
    
    return $result
}

# ============================================================================
# POLICY COMPARISON FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Normalizes a policy object for comparison by removing API-only properties
.DESCRIPTION
    Removes properties that are added by the API and shouldn't affect comparison:
    - id, createdDateTime, lastModifiedDateTime, version
    - @odata.context, @odata.type
    - settingCount, creationSource, supportsScopeTags
    - Various null values and empty arrays
#>
function Normalize-PolicyForComparison {
    param(
        [Parameter(Mandatory=$true)]
        [AllowNull()]
        $Policy,
        [string[]]$AdditionalPropsToRemove = @()
    )
    
    if ($null -eq $Policy) { return $null }
    
    # Convert to hashtable for manipulation
    $json = $Policy | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Normalize roleScopeTagIds - should always be an array for comparison
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) {
            $json['roleScopeTagIds'] = @("0")
        }
        elseif ($tagIds -is [string]) {
            if ($tagIds -match ',') {
                $json['roleScopeTagIds'] = @($tagIds -split ',' | ForEach-Object { $_.Trim() })
            }
            else {
                $json['roleScopeTagIds'] = @($tagIds)
            }
        }
    }
    
    # Load field exclusion lists from the centralized JSON source.
    # common.json applies to all policy types; intune.json is Intune-specific.
    # Both live in runner/scripts/compare-ignore-fields/ — edit there to update everywhere.
    $ignoreConfigDir = Join-Path $PSScriptRoot "..\..\compare-ignore-fields"
    $commonFields = @()
    $typeFields   = @()
    try {
        $commonFields = (Get-Content (Join-Path $ignoreConfigDir "common.json") -Raw | ConvertFrom-Json).fields
    } catch { Write-Warning "compare-ignore-fields/common.json not found — using empty common list" }
    try {
        $typeFields = (Get-Content (Join-Path $ignoreConfigDir "intune.json") -Raw | ConvertFrom-Json).fields
    } catch { Write-Warning "compare-ignore-fields/intune.json not found — using empty type list" }

    $propsToRemove = @($commonFields) + @($typeFields) + $AdditionalPropsToRemove
    
    # Recursively normalize
    function Normalize-Recursive {
        param([object]$Obj)
        
        if ($null -eq $Obj) { return $null }
        
        if ($Obj -is [hashtable]) {
            # Remove excluded properties
            foreach ($prop in $propsToRemove) {
                if ($Obj.ContainsKey($prop)) {
                    $Obj.Remove($prop)
                }
            }
            
            # Strip OData annotation keys (e.g. 'apps@odata.context', '@odata.nextLink') that
            # $expand injects as composite property names — the named list above only catches the
            # standalone '@odata.context' key, so we need a pattern sweep for the rest.
            $odataAnnotationKeys = @($Obj.Keys | Where-Object { $_ -like '*@odata.*' })
            foreach ($key in $odataAnnotationKeys) { $Obj.Remove($key) }
            
            # Remove null values, notConfigured enum defaults, and empty arrays/hashtables for cleaner comparison.
            # "notConfigured" is treated the same as null — it means "not set" and is stripped from the
            # PATCH payload by Repair-DeviceConfigurationPayload, so the comparison must be consistent.
            $keysToRemove = @()
            foreach ($key in @($Obj.Keys)) {
                $value = $Obj[$key]
                if ($null -eq $value) {
                    $keysToRemove += $key
                }
                elseif ($value -is [string] -and $value -ieq 'notConfigured') {
                    $keysToRemove += $key
                }
                elseif ($value -is [string] -and $value -match '^0+([-.]0+)+$') {
                    # Multi-segment all-zero strings (e.g. "0000-00-00", "0.0.0") are Graph API
                    # sentinel "not configured" values — treat them the same as null for comparison.
                    # Plain "0" is intentionally excluded. Deploy payloads are not affected.
                    $keysToRemove += $key
                }
                elseif ($value -is [System.Collections.IList] -and $value.Count -eq 0) {
                    $keysToRemove += $key
                }
                elseif ($value -is [hashtable]) {
                    $Obj[$key] = Normalize-Recursive -Obj $value
                    if ($null -eq $Obj[$key] -or ($Obj[$key] -is [hashtable] -and $Obj[$key].Count -eq 0)) {
                        $keysToRemove += $key
                    }
                }
                elseif ($value -is [System.Collections.IList]) {
                    for ($i = 0; $i -lt $value.Count; $i++) {
                        $value[$i] = Normalize-Recursive -Obj $value[$i]
                    }
                }
                elseif ($value -is [string] -and $key -in @('scriptContent', 'detectionScriptContent', 'remediationScriptContent')) {
                    # Normalize line endings in base64-encoded script content so CRLF vs LF
                    # differences in the tenant don't trigger false-positive updates
                    try {
                        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($value))
                        $normalized = $decoded -replace "`r`n", "`n"
                        $Obj[$key] = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($normalized))
                    } catch {}
                }
            }
            foreach ($key in $keysToRemove) {
                $Obj.Remove($key)
            }
        }
        elseif ($Obj -is [System.Collections.IList]) {
            for ($i = 0; $i -lt $Obj.Count; $i++) {
                $Obj[$i] = Normalize-Recursive -Obj $Obj[$i]
            }
        }
        
        return $Obj
    }
    
    return Normalize-Recursive -Obj $json
}

<#
.SYNOPSIS
    Compares two policy configurations to determine if they're equivalent
.DESCRIPTION
    Normalizes both policies and compares their JSON representations.
    Can return just a boolean or detailed differences.
.PARAMETER ReturnDetails
    If true, returns a hashtable with IsEquivalent and Differences properties
.RETURNS
    Boolean if ReturnDetails is false, otherwise hashtable with differences
#>
function Compare-PolicyConfigurations {
    param(
        [Parameter(Mandatory=$true)]
        [AllowNull()]
        $ExistingPolicy,
        
        [Parameter(Mandatory=$true)]
        [AllowNull()]
        $DesiredPolicy,
        
        [string[]]$CompareProperties = @(),
        [string[]]$IgnoreProperties = @(),
        [switch]$ReturnDetails,
        [switch]$CompareOnlyDesiredKeys  # Only compare keys from desired config (for policies with verbose API defaults)
    )
    
    $result = @{
        IsEquivalent = $true
        Differences = @{
            Added = @()
            Removed = @()
            Modified = @()
            ModifiedValues = @{}
        }
    }
    
    if ($null -eq $ExistingPolicy -and $null -eq $DesiredPolicy) { 
        return $(if ($ReturnDetails) { $result } else { $true })
    }
    if ($null -eq $ExistingPolicy -or $null -eq $DesiredPolicy) { 
        $result.IsEquivalent = $false
        return $(if ($ReturnDetails) { $result } else { $false })
    }

    # Apply field-monitor filter from _monitorConfig metadata if present.
    # The filter is applied to BOTH sides so that excluded fields are removed from the
    # existing (API) response as well — otherwise they land in Differences.Removed and
    # cause a spurious WouldUpdate even though the field is intentionally ignored.
    $effectiveDesired  = $DesiredPolicy
    $effectiveExisting = $ExistingPolicy
    if ($DesiredPolicy -and $null -ne $DesiredPolicy._monitorConfig) {
        try {
            $mc = @{}
            if ($DesiredPolicy._monitorConfig.Include) { $mc['Include'] = @($DesiredPolicy._monitorConfig.Include) }
            if ($DesiredPolicy._monitorConfig.Exclude) { $mc['Exclude'] = @($DesiredPolicy._monitorConfig.Exclude) }
            if ($mc.Count -gt 0) {
                $effectiveDesired  = Apply-MonitorFilter -PolicyObject $DesiredPolicy  -MonitorConfig $mc
                if ($ExistingPolicy) {
                    $effectiveExisting = Apply-MonitorFilter -PolicyObject $ExistingPolicy -MonitorConfig $mc
                }
            }
        }
        catch { <# Apply-MonitorFilter not available — skip silently #> }
    }
    
    # Normalize both for comparison
    $normalizedExisting = Normalize-PolicyForComparison -Policy $effectiveExisting -AdditionalPropsToRemove $IgnoreProperties
    $normalizedDesired  = Normalize-PolicyForComparison -Policy $effectiveDesired  -AdditionalPropsToRemove $IgnoreProperties
    
    # If specific properties are specified, only compare those
    if ($CompareProperties.Count -gt 0) {
        $existingSubset = @{}
        $desiredSubset = @{}
        foreach ($prop in ($CompareProperties | Sort-Object)) {
            if ($normalizedExisting -and $normalizedExisting.ContainsKey($prop)) {
                $existingSubset[$prop] = $normalizedExisting[$prop]
            }
            if ($normalizedDesired -and $normalizedDesired.ContainsKey($prop)) {
                $desiredSubset[$prop] = $normalizedDesired[$prop]
            }
        }
        $normalizedExisting = $existingSubset
        $normalizedDesired = $desiredSubset
    }
    
    # If CompareOnlyDesiredKeys, filter to only compare properties from baseline
    # This prevents false positives from API-returned default values
    if ($CompareOnlyDesiredKeys -and $normalizedDesired) {
        $filteredExisting = @{}
        foreach ($key in $normalizedDesired.Keys) {
            if ($normalizedExisting -and $normalizedExisting.ContainsKey($key)) {
                $filteredExisting[$key] = $normalizedExisting[$key]
            }
        }
        $normalizedExisting = $filteredExisting
    }
    
    # Sort hashtables by keys for consistent comparison (property order shouldn't matter)
    $existingJson = ConvertTo-SortedJson -InputObject $normalizedExisting
    $desiredJson = ConvertTo-SortedJson -InputObject $normalizedDesired
    
    $isEquivalent = $existingJson -ieq $desiredJson
    
    if (-not $ReturnDetails) {
        return $isEquivalent
    }
    
    $result.IsEquivalent = $isEquivalent
    
    # If not equivalent and details requested, find the differences
    if (-not $isEquivalent) {
        # If CompareOnlyDesiredKeys, only compare properties from the baseline (desired) config
        # This is used for policies like windows10GeneralConfiguration that return many default values
        $allKeys = if ($CompareOnlyDesiredKeys -and $normalizedDesired) {
            @($normalizedDesired.Keys) | Sort-Object
        } else {
            $combinedKeys = @()
            if ($normalizedExisting) { $combinedKeys += @($normalizedExisting.Keys) }
            if ($normalizedDesired) { $combinedKeys += @($normalizedDesired.Keys) }
            $combinedKeys | Select-Object -Unique | Sort-Object
        }
        
        foreach ($key in $allKeys) {
            $existsInExisting = $normalizedExisting -and $normalizedExisting.ContainsKey($key)
            $existsInDesired = $normalizedDesired -and $normalizedDesired.ContainsKey($key)
            
            if ($existsInDesired -and -not $existsInExisting) {
                $result.Differences.Added += $key
            }
            elseif ($existsInExisting -and -not $existsInDesired) {
                $result.Differences.Removed += $key
            }
            elseif ($existsInExisting -and $existsInDesired) {
                $existingRaw = $normalizedExisting[$key]
                $desiredRaw = $normalizedDesired[$key]
                $existVal = ConvertTo-SortedJson -InputObject $existingRaw
                $desVal = ConvertTo-SortedJson -InputObject $desiredRaw
                if ($existVal -ine $desVal) {
                    # Special handling for script content fields - decode base64 and show actual script diff
                    $scriptContentKeys = @('scriptContent', 'detectionScriptContent', 'remediationScriptContent')
                    if ($key -in $scriptContentKeys -and $existingRaw -is [string] -and $desiredRaw -is [string]) {
                        try {
                            $existingScript = ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($existingRaw))) -replace "`r`n", "`n"
                            $desiredScript = ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($desiredRaw))) -replace "`r`n", "`n"
                            
                            # Split into lines and find the actual differences
                            $existingLines = $existingScript -split "`n"
                            $desiredLines = $desiredScript -split "`n"
                            
                            # Find changed lines (simple diff)
                            $changedLines = @()
                            $maxLines = [Math]::Max($existingLines.Count, $desiredLines.Count)
                            $diffCount = 0
                            for ($lineIdx = 0; $lineIdx -lt $maxLines; $lineIdx++) {
                                $existLine = if ($lineIdx -lt $existingLines.Count) { $existingLines[$lineIdx] } else { $null }
                                $desiredLine = if ($lineIdx -lt $desiredLines.Count) { $desiredLines[$lineIdx] } else { $null }
                                if ($existLine -ne $desiredLine) {
                                    $diffCount++
                                    if ($changedLines.Count -lt 8) {
                                        $lineNum = $lineIdx + 1
                                        if ($null -eq $existLine) {
                                            $addedDisplay = if ($desiredLine.Length -gt 60) { $desiredLine.Substring(0, 57) + "..." } else { $desiredLine }
                                            $changedLines += "L$lineNum + $addedDisplay"
                                        }
                                        elseif ($null -eq $desiredLine) {
                                            $removedDisplay = if ($existLine.Length -gt 60) { $existLine.Substring(0, 57) + "..." } else { $existLine }
                                            $changedLines += "L$lineNum - $removedDisplay"
                                        }
                                        else {
                                            $existLineDisplay = if ($existLine.Length -gt 40) { $existLine.Substring(0, 37) + "..." } else { $existLine }
                                            $desiredLineDisplay = if ($desiredLine.Length -gt 40) { $desiredLine.Substring(0, 37) + "..." } else { $desiredLine }
                                            $changedLines += "L${lineNum}: '$existLineDisplay' → '$desiredLineDisplay'"
                                        }
                                    }
                                }
                            }
                            
                            if ($changedLines.Count -gt 0) {
                                $result.Differences.Modified += "${key}: Script modified ($($existingLines.Count) → $($desiredLines.Count) lines, $diffCount changes)"
                                foreach ($change in $changedLines) {
                                    $result.Differences.Modified += "  $change"
                                }
                                if ($diffCount -gt 8) {
                                    $result.Differences.Modified += "  ... and $($diffCount - 8) more line changes"
                                }
                            }
                            else {
                                # Lines match after normalization but base64 still differs (encoding anomaly)
                                $result.Differences.Modified += "${key}: (content differs - encoding mismatch)"
                            }
                            # Store decoded text in ModifiedValues so the portal can render a readable line diff
                            $result.Differences.ModifiedValues[$key] = @{
                                Existing = $existingScript
                                Desired  = $desiredScript
                            }
                        }
                        catch {
                            # Fall back to showing base64 if decode fails
                            $result.Differences.Modified += "${key}: (base64 content differs)"
                        }
                    }
                    else {
                        # Format the values for display
                        $existDisplay = $existingRaw
                        $desiredDisplay = $desiredRaw
                        
                        # Convert complex objects to readable strings
                        if ($existingRaw -is [hashtable] -or $existingRaw -is [System.Collections.IList]) {
                            $existDisplay = ($existingRaw | ConvertTo-Json -Depth 5 -Compress)
                        }
                        if ($desiredRaw -is [hashtable] -or $desiredRaw -is [System.Collections.IList]) {
                            $desiredDisplay = ($desiredRaw | ConvertTo-Json -Depth 5 -Compress)
                        }
                        
                        $existStr = if ($existDisplay) { $existDisplay.ToString() } else { "(null)" }
                        $desiredStr = if ($desiredDisplay) { $desiredDisplay.ToString() } else { "(null)" }
                        
                        # Store full values for expandable frontend display
                        if ($existStr.Length -gt 60 -or $desiredStr.Length -gt 60) {
                            $result.Differences.ModifiedValues[$key] = @{
                                Existing = $existStr
                                Desired  = $desiredStr
                            }
                        }
                        
                        # Truncate summary line for the compact display
                        $existSummary = if ($existStr.Length -gt 60) { $existStr.Substring(0, 57) + "..." } else { $existStr }
                        $desiredSummary = if ($desiredStr.Length -gt 60) { $desiredStr.Substring(0, 57) + "..." } else { $desiredStr }
                        
                        $result.Differences.Modified += "${key}: '$existSummary' → '$desiredSummary'"
                    }
                }
            }
        }
    }
    
    return $result
}

<#
.SYNOPSIS
    Converts an object to JSON with recursively sorted keys for consistent comparison
#>
function ConvertTo-SortedJson {
    param($InputObject)
    
    function Sort-ObjectRecursively {
        param($Obj)
        
        if ($null -eq $Obj) { return $null }
        
        if ($Obj -is [hashtable] -or $Obj -is [System.Collections.Specialized.OrderedDictionary]) {
            $sorted = [ordered]@{}
            foreach ($key in ($Obj.Keys | Sort-Object)) {
                $sorted[$key] = Sort-ObjectRecursively -Obj $Obj[$key]
            }
            return $sorted
        }
        elseif ($Obj -is [System.Collections.IList] -and $Obj -isnot [string]) {
            $sortedArray = @()
            foreach ($item in $Obj) {
                $sortedArray += Sort-ObjectRecursively -Obj $item
            }
            return $sortedArray
        }
        
        return $Obj
    }
    
    $sorted = Sort-ObjectRecursively -Obj $InputObject
    return ($sorted | ConvertTo-Json -Depth 30 -Compress)
}

# ============================================================================
# POLICY LOOKUP FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Fetches all policies of a specific type from the tenant
.DESCRIPTION
    Results are cached to avoid repeated API calls
#>
function Get-AllPoliciesOfType {
    param([string]$PolicyType)
    
    if ($script:PolicyCache.ContainsKey($PolicyType)) {
        return $script:PolicyCache[$PolicyType]
    }
    
    Write-Verbose "  Fetching all $PolicyType policies from tenant..."
    
    $allPolicies = @()
    try {
        $uri = switch ($PolicyType) {
            "settings-catalog" { "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies" }
            "device-configurations" { "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations" }
            "compliance-policies" { "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies" }
            "endpoint-security" { "https://graph.microsoft.com/beta/deviceManagement/intents" }
            "autopilot" { "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles" }
            "platform-scripts-powershell" { "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts" }
            "platform-scripts-bash" { "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts" }
            "remediations" { "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts" }
            "mobile-apps" { "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps" }
            "windows-updates" { "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations?`$filter=isof('microsoft.graph.windowsUpdateForBusinessConfiguration')" }
            "windows-feature-updates" { "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles" }
            "windows-quality-updates" { "https://graph.microsoft.com/beta/deviceManagement/windowsQualityUpdateProfiles" }
            "windows-driver-updates" { "https://graph.microsoft.com/beta/deviceManagement/windowsDriverUpdateProfiles" }
            "app-protection-android" { "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections" }
            "app-protection-ios" { "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections" }
            "admx-files" { "https://graph.microsoft.com/beta/deviceManagement/groupPolicyUploadedDefinitionFiles" }
            "group-policy-configurations" { "https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations" }
            default { $null }
        }
        
        if ($uri) {
            do {
                $response = Invoke-MgGraphRequest -Method GET -Uri $uri
                $allPolicies += $response.value
                $uri = $response.'@odata.nextLink'
            } while ($uri)
        }
    }
    catch {
        Write-Verbose "  Failed to fetch $PolicyType policies: $_"
    }
    
    $script:PolicyCache[$PolicyType] = $allPolicies
    Write-Verbose "  Found $($allPolicies.Count) $PolicyType policies in tenant"
    return $allPolicies
}

<#
.SYNOPSIS
    Clears the policy cache (call before processing to ensure fresh data)
#>
function Clear-PolicyCache {
    $script:PolicyCache = @{}
}

# ============================================================================
# ASSIGNMENT FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Applies group assignments to a policy
.DESCRIPTION
    Handles the complex assignment structure required by different policy types
#>
function Apply-PolicyAssignments {
    param(
        [Parameter(Mandatory=$true)]
        [string]$PolicyId,
        [Parameter(Mandatory=$true)]
        [string]$PolicyType,
        [Parameter(Mandatory=$true)]
        [array]$Assignments,
        [string]$DisplayName = ""
    )
    
    if ($Assignments.Count -eq 0) {
        return $true
    }
    
    # Build clean assignment structure
    $cleanAssignments = @()
    foreach ($assignment in $Assignments) {
        $cleanAssignment = @{}
        
        # Handle target
        if ($assignment.target) {
            $target = @{}
            if ($assignment.target.'@odata.type') {
                $target['@odata.type'] = $assignment.target.'@odata.type'
            }
            if ($assignment.target.groupId) {
                $target['groupId'] = $assignment.target.groupId
            }
            if ($assignment.target.deviceAndAppManagementAssignmentFilterId) {
                $target['deviceAndAppManagementAssignmentFilterId'] = $assignment.target.deviceAndAppManagementAssignmentFilterId
            }
            if ($assignment.target.deviceAndAppManagementAssignmentFilterType) {
                $target['deviceAndAppManagementAssignmentFilterType'] = $assignment.target.deviceAndAppManagementAssignmentFilterType
            }
            $cleanAssignment['target'] = $target
        }
        
        # Handle intent (required for mobile apps and other resources)
        if ($assignment.intent) {
            $cleanAssignment['intent'] = $assignment.intent
        }
        
        # Handle settings (for mobile apps assignment settings)
        if ($assignment.settings) {
            $cleanAssignment['settings'] = $assignment.settings
        }
        
        $cleanAssignments += $cleanAssignment
    }
    
    # Determine the assignment endpoint and body structure based on policy type
    $assignUri = $null
    $assignBody = $null
    
    switch ($PolicyType) {
        "settings-catalog" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "device-configurations" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "compliance-policies" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "endpoint-security" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/intents/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "autopilot" {
            # The /assign action only accepts deviceIds (for direct device assignment).
            # Group assignments must be managed via the /assignments CRUD collection:
            #   DELETE /assignments/{id}  — remove each existing assignment
            #   POST   /assignments       — create each desired assignment
            $baseUri = "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles/$PolicyId/assignments"

            # 1. Fetch existing assignments to get their IDs for deletion
            $existingResp = Invoke-MgGraphRequest -Method GET -Uri $baseUri
            $existingIds  = @($existingResp.value | ForEach-Object { $_.id } | Where-Object { $_ })

            # 2. Delete all existing group assignments
            foreach ($existingId in $existingIds) {
                Invoke-GraphApiWrite -Method DELETE -Uri "$baseUri/$existingId"
                Write-Host "    - Removed existing assignment: $existingId"
            }

            # 3. Create each desired assignment individually
            foreach ($cleanAssignment in $cleanAssignments) {
                $assignmentBody = @{
                    '@odata.type' = '#microsoft.graph.windowsAutopilotDeploymentProfileAssignment'
                    target        = $cleanAssignment.target
                }
                Invoke-GraphApiWrite -Method POST -Uri $baseUri `
                    -Body ($assignmentBody | ConvertTo-Json -Depth 10)
                Write-Host "    + Added assignment: groupId=$($cleanAssignment.target.groupId)"
            }

            Write-Host "    ✓ Applied $($cleanAssignments.Count) assignment(s)"
            return $true
        }
        "platform-scripts-powershell" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts/$PolicyId/assign"
            $assignBody = @{ deviceManagementScriptAssignments = @($cleanAssignments) }
        }
        "platform-scripts-bash" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts/$PolicyId/assign"
            $assignBody = @{ deviceManagementScriptAssignments = @($cleanAssignments) }
        }
        "app-protection-android" {
            $assignUri = "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "app-protection-ios" {
            $assignUri = "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "windows-updates" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "windows-feature-updates" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "windows-quality-updates" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/windowsQualityUpdateProfiles/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "windows-driver-updates" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/windowsDriverUpdateProfiles/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        "mobile-apps" {
            $assignUri = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$PolicyId/assign"
            $assignBody = @{ mobileAppAssignments = @($cleanAssignments) }
        }
        "group-policy-configurations" {
            $assignUri = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations/$PolicyId/assign"
            $assignBody = @{ assignments = @($cleanAssignments) }
        }
        default {
            Write-Warning "  Unknown policy type for assignments: $PolicyType"
            return $false
        }
    }
    
    try {
        Invoke-MgGraphRequest -Method POST -Uri $assignUri -Body ($assignBody | ConvertTo-Json -Depth 10) -ContentType "application/json"
        Write-Host "    ✓ Applied $($cleanAssignments.Count) assignment(s)"
        return $true
    }
    catch {
        $errStr = $_.ToString()

        # Not a code bug — re-throw so the caller can decide whether to treat as warning vs error.
        Write-Host "##[error]Failed to apply assignments for '$DisplayName': $errStr"
        Write-Host "##[error]  URI: $assignUri"
        Write-Host "##[error]  Exception: $($_.Exception.GetType().FullName)"
        throw
    }
}

# ============================================================================
# JSON SERIALIZATION HELPERS
# ============================================================================

<#
.SYNOPSIS
    Safely converts an object to JSON, ensuring arrays remain arrays
.DESCRIPTION
    PowerShell's ConvertTo-Json can flatten single-element arrays to primitives.
    This function ensures proper array serialization.
#>
function ConvertTo-SafeJson {
    param(
        [Parameter(Mandatory=$true)]
        $InputObject,
        [int]$Depth = 30
    )
    
    # PowerShell's ConvertTo-Json collapses single-element arrays to objects
    # We need to ensure arrays stay as arrays, especially for "settings"
    
    # Clone and ensure arrays are properly formatted
    $prepared = ConvertTo-ArraySafeObject -InputObject $InputObject
    
    $json = $prepared | ConvertTo-Json -Depth $Depth -Compress:$false
    return $json
}

function ConvertTo-ArraySafeObject {
    param($InputObject)
    
    if ($null -eq $InputObject) { return $null }
    
    if ($InputObject -is [hashtable] -or $InputObject -is [System.Collections.Specialized.OrderedDictionary]) {
        $result = [ordered]@{}
        foreach ($key in $InputObject.Keys) {
            $value = $InputObject[$key]
            
            # SAFETY NET: Skip 'notConfigured' string values - API rejects these for enum properties
            # The proper fix is in Repair-DeviceConfigurationPayload, but this catches any we miss
            if ($value -is [string] -and $value -ieq 'notConfigured') {
                continue
            }
            
            # These properties MUST be arrays for the Graph API
            # ONLY include properties that are ALWAYS arrays, never strings or enums
            $arrayProperties = @(
                # Core/common
                'settings', 'children', 'roleScopeTagIds', 'scheduledActionsForRule', 'assignments',
                # Settings Catalog
                'simpleSettingCollectionValue', 'groupSettingCollectionValue', 'choiceSettingCollectionValue',
                # Device Configuration
                'customKeyValueData', 'customData', 'customUpdateTimeWindows', 'omaSettings',
                'firewallRules', 'vpnOnDemandRules', 'onDemandRules',
                # VPN Configuration - collections that require non-null arrays
                'excludedDomains', 'associatedDomains', 'safariDomains',
                # VPN onDemandRules nested collections
                'dnsSearchDomains', 'ssids', 'domains', 'dnsServerAddressMatch',
                # Compliance Policies
                'scheduledActionConfigurations', 'notificationMessageCCList',
                # App Protection - collections that are ALWAYS arrays
                'apps', 'targetedMobileApps', 'excludedApps', 'payloadIds',
                'exemptedAppPackages', 'approvedKeyboards', 'allowedAndroidDeviceModels',
                'exemptedAppProtocols', 'exemptedUniversalLinks', 'managedUniversalLinks',
                'allowedDataIngestionLocations', 'allowedIosDeviceModels', 'allowedDataStorageLocations'
            )
            
            # Properties that cannot be null - must be empty array instead
            # Note: Only include properties from the arrayProperties list above
            $nonNullableArrayProperties = @(
                'allowedDataStorageLocations', 'allowedDataIngestionLocations', 'notificationMessageCCList',
                # VPN Configuration - these MUST be empty arrays, never null
                'excludedDomains', 'associatedDomains', 'safariDomains',
                # VPN onDemandRules nested collections
                'dnsSearchDomains', 'ssids', 'domains', 'dnsServerAddressMatch',
                # Used by both VPN and App Protection
                'targetedMobileApps'
            )
            
            if ($key -in $arrayProperties) {
                if ($null -eq $value) {
                    # Non-nullable array properties must be empty array, not null
                    if ($key -in $nonNullableArrayProperties) {
                        $result[$key] = @()
                    }
                    # else: skip null values for nullable array properties
                }
                elseif ($value -is [System.Collections.IList]) {
                    $result[$key] = @(foreach ($item in $value) { ConvertTo-ArraySafeObject -InputObject $item })
                }
                elseif ($value -is [hashtable]) {
                    # Single object where array expected - wrap it
                    $result[$key] = @(ConvertTo-ArraySafeObject -InputObject $value)
                }
                else {
                    $result[$key] = @(ConvertTo-ArraySafeObject -InputObject $value)
                }
            } else {
                $result[$key] = ConvertTo-ArraySafeObject -InputObject $value
            }
        }
        return $result
    }
    elseif ($InputObject -is [System.Collections.IList] -and $InputObject -isnot [string]) {
        return @(foreach ($item in $InputObject) { ConvertTo-ArraySafeObject -InputObject $item })
    }
    
    return $InputObject
}

# ============================================================================
# ASSIGNMENT SYNC HELPERS
# ============================================================================

<#
.SYNOPSIS
    Returns the Graph API URI for fetching the assignments of a given policy
#>
function Get-PolicyAssignmentsUri {
    param(
        [Parameter(Mandatory=$true)]
        [string]$PolicyId,
        [Parameter(Mandatory=$true)]
        [string]$PolicyType
    )

    switch ($PolicyType) {
        "settings-catalog"            { return "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/$PolicyId/assignments" }
        "device-configurations"       { return "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$PolicyId/assignments" }
        "compliance-policies"         { return "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies/$PolicyId/assignments" }
        "endpoint-security"           { return "https://graph.microsoft.com/beta/deviceManagement/intents/$PolicyId/assignments" }
        "autopilot"                   { return "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles/$PolicyId/assignments" }
        "platform-scripts-powershell" { return "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts/$PolicyId/assignments" }
        "platform-scripts-bash"       { return "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts/$PolicyId/groupAssignments" }
        "app-protection-android"      { return "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections/$PolicyId/assignments" }
        "app-protection-ios"          { return "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections/$PolicyId/assignments" }
        "windows-updates"             { return "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$PolicyId/assignments" }
        "windows-feature-updates"     { return "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles/$PolicyId/assignments" }
        "windows-quality-updates"     { return "https://graph.microsoft.com/beta/deviceManagement/windowsQualityUpdateProfiles/$PolicyId/assignments" }
        "windows-driver-updates"      { return "https://graph.microsoft.com/beta/deviceManagement/windowsDriverUpdateProfiles/$PolicyId/assignments" }
        "mobile-apps"                 { return "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$PolicyId/assignments" }
        "remediations"                { return "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts/$PolicyId/assignments" }
        "group-policy-configurations" { return "https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations/$PolicyId/assignments" }
        default                       { return $null }
    }
}

<#
.SYNOPSIS
    Produces a canonical string key for a single assignment used in comparison
#>
function Get-NormalizedAssignmentKey {
    param($Assignment)

    $target = if ($Assignment -is [hashtable]) { $Assignment['target'] } else { $Assignment.target }
    if (-not $target) { return $null }

    $intent     = if ($Assignment -is [hashtable]) { $Assignment['intent'] } else { $Assignment.intent }
    $odataType  = if ($target -is [hashtable])     { $target['@odata.type'] } else { $target.'@odata.type' }
    $groupId    = if ($target -is [hashtable])     { $target['groupId'] }     else { $target.groupId }
    $filterId   = if ($target -is [hashtable])     { $target['deviceAndAppManagementAssignmentFilterId'] } else { $target.deviceAndAppManagementAssignmentFilterId }
    $filterType = if ($target -is [hashtable])     { $target['deviceAndAppManagementAssignmentFilterType'] } else { $target.deviceAndAppManagementAssignmentFilterType }

    $intent     = if ($intent)     { $intent }     else { "required" }
    $odataType  = if ($odataType)  { $odataType }  else { "unknown" }
    $groupId    = if ($groupId)    { $groupId }    else { "" }
    $filterId   = if ($filterId)   { $filterId }   else { "" }
    $filterType = if ($filterType) { $filterType } else { "none" }

    return "$intent|$odataType|$groupId|$filterId|$filterType"
}

<#
.SYNOPSIS
    Compares two flat lists of assignments and returns a diff summary
#>
function Compare-AssignmentLists {
    param(
        [array]$BaselineAssignments,
        [array]$ExistingAssignments
    )

    $baselineKeys = @($BaselineAssignments | Where-Object { $_ } | ForEach-Object { Get-NormalizedAssignmentKey $_ } | Where-Object { $_ })
    $existingKeys = @($ExistingAssignments | Where-Object { $_ } | ForEach-Object { Get-NormalizedAssignmentKey $_ } | Where-Object { $_ })

    $added   = @($baselineKeys | Where-Object { $existingKeys -notcontains $_ })
    $removed = @($existingKeys | Where-Object { $baselineKeys -notcontains $_ })

    return @{
        HasChanges = ($added.Count -gt 0 -or $removed.Count -gt 0)
        Added      = $added
        Removed    = $removed
    }
}

<#
.SYNOPSIS
    Wrapper around Invoke-MgGraphRequest for write operations (POST, PATCH, DELETE).
.DESCRIPTION
    Logs the method, URI, and a preview of the request body before executing the call,
    then logs the outcome. Returns the response object (may be null for PATCH/DELETE).
#>
function Invoke-GraphApiWrite {
    param(
        [Parameter(Mandatory=$true)]
        [ValidateSet('POST','PATCH','DELETE')]
        [string]$Method,

        [Parameter(Mandatory=$true)]
        [string]$Uri,

        [string]$Body = $null,
        [string]$ContentType = "application/json"
    )

    $bodyPreview = if ($Body -and $Body.Length -gt 1500) { $Body.Substring(0, 1500) + "... [truncated]" } else { $Body }
    Write-Host "  [GRAPH $Method] $Uri" -ForegroundColor Cyan
    if ($bodyPreview) { Write-Host "  Body: $bodyPreview" -ForegroundColor Gray }

    $params = @{ Method = $Method; Uri = $Uri }
    if ($Body) {
        $params['Body'] = $Body
        $params['ContentType'] = $ContentType
    }

    $response = Invoke-MgGraphRequest @params

    $responseId = if ($response -and $response.id) { " -> id: $($response.id)" } else { "" }
    Write-Host "  [GRAPH $Method] done$responseId" -ForegroundColor Green

    return $response
}

<#
.SYNOPSIS
    Compares baseline assignments against the live policy and optionally applies them.
.DESCRIPTION
    Call this for every existing policy regardless of whether the main content changed.
    Returns a hashtable with HasChanges (bool) and Synced (bool).
    In WhatIf mode it only prints the diff; in deploy mode it calls Apply-PolicyAssignments.
#>
function Invoke-AssignmentSync {
    param(
        [Parameter(Mandatory=$true)]
        [string]$PolicyId,
        [Parameter(Mandatory=$true)]
        [string]$PolicyType,
        [Parameter(Mandatory=$false)]
        [array]$BaselineAssignments,
        [Parameter(Mandatory=$false)]
        [string]$DisplayName = "",
        [Parameter(Mandatory=$false)]
        [switch]$WhatIf
    )

    # No baseline assignments defined – nothing to sync
    if (-not $BaselineAssignments -or $BaselineAssignments.Count -eq 0) {
        Write-Host "  📌 Assignments: none defined in baseline" -ForegroundColor DarkGray
        return @{ HasChanges = $false; Synced = $false }
    }

    $assignUri = Get-PolicyAssignmentsUri -PolicyId $PolicyId -PolicyType $PolicyType
    if (-not $assignUri) {
        Write-Host "  ⚠ Assignments: unknown URI for policy type '$PolicyType'" -ForegroundColor Yellow
        return @{ HasChanges = $false; Synced = $false }
    }

    # Fetch existing live assignments
    $existingAssignments = @()
    try {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $assignUri
        $existingAssignments = @($resp.value)
    }
    catch {
        Write-Host "  ⚠ Assignments: could not fetch live assignments – $_" -ForegroundColor Yellow
        return @{ HasChanges = $false; Synced = $false }
    }

    # Compare
    $diff = Compare-AssignmentLists -BaselineAssignments $BaselineAssignments -ExistingAssignments $existingAssignments

    if (-not $diff.HasChanges) {
        Write-Host "  📌 Assignments: up to date ($($existingAssignments.Count) assignment(s))" -ForegroundColor DarkGray
        return @{ HasChanges = $false; Synced = $false }
    }

    # Report differences
    Write-Host "  📌 Assignments: $($diff.Added.Count) to add, $($diff.Removed.Count) to remove" -ForegroundColor Cyan
    foreach ($a in $diff.Added)   { Write-Host "     + $a" -ForegroundColor DarkCyan }
    foreach ($r in $diff.Removed) { Write-Host "     - $r" -ForegroundColor DarkYellow }

    # Build human-readable change labels for the JSON artifact
    if (-not (Get-Variable -Name 'GroupNameCache' -Scope Script -ErrorAction SilentlyContinue)) {
        $script:GroupNameCache = @{}
    }
    $formatKey = {
        param($key)
        $parts = $key -split '\|'
        $intent     = $parts[0]
        $odataType  = $parts[1] -replace '#microsoft\.graph\.', ''
        $groupId    = $parts[2]
        $filterId   = $parts[3]
        $filterType = $parts[4]
        # Resolve a group ID to a display name (shared by include + exclude branches)
        $resolveGroupId = {
            param($id)
            if ($id -match '^\{\{GROUP:(.+)\}\}$') { return $Matches[1] }
            if (-not $script:GroupNameCache.ContainsKey($id)) {
                $resolved = $null
                try {
                    $grp = Invoke-MgGraphRequest -Method GET `
                        -Uri "https://graph.microsoft.com/v1.0/groups/$id" `
                        -ErrorAction Stop
                    $resolved = $grp.displayName
                } catch { }
                if (-not $resolved) {
                    try {
                        $grp = Get-MgGroup -GroupId $id -Property DisplayName -ErrorAction Stop
                        $resolved = $grp.DisplayName
                    } catch { }
                }
                $script:GroupNameCache[$id] = if ($resolved) { $resolved } else { $id }
            }
            return $script:GroupNameCache[$id]
        }

        $target = switch ($odataType) {
            'allDevicesAssignmentTarget'       { 'All Devices' }
            'allLicensedUsersAssignmentTarget'  { 'All Users' }
            'groupAssignmentTarget' {
                if ($groupId) { "Include: $(& $resolveGroupId $groupId)" } else { 'Include Group' }
            }
            'exclusionGroupAssignmentTarget' {
                if ($groupId) { "Exclude: $(& $resolveGroupId $groupId)" } else { 'Exclude Group' }
            }
            default { $odataType }
        }
        $suffix = @()
        if ($intent -and $intent -ne 'required') { $suffix += $intent }
        if ($filterId) { $suffix += "filter:$filterId($filterType)" }
        if ($suffix.Count -gt 0) { "$target [$($suffix -join ', ')]" } else { $target }
    }
    $addedLabels   = @($diff.Added   | ForEach-Object { & $formatKey $_ })
    $removedLabels = @($diff.Removed | ForEach-Object { & $formatKey $_ })
    $assignChanges = @{ Added = $addedLabels; Removed = $removedLabels }

    if ($WhatIf) {
        Write-Host "  [WhatIf] Would sync assignments for: $DisplayName" -ForegroundColor Cyan
        return @{ HasChanges = $true; Synced = $false; Changes = $assignChanges }
    }

    # Apply-PolicyAssignments now throws on failure, so any API error propagates up.
    Apply-PolicyAssignments -PolicyId $PolicyId -PolicyType $PolicyType -Assignments $BaselineAssignments -DisplayName $DisplayName
    return @{ HasChanges = $true; Synced = $true; Changes = $assignChanges }
}

<#
.SYNOPSIS
    Returns the PATCH body for an Intune policy, applying the field-monitor filter when a
    .monitor.json sidecar is present (via the _monitorConfig metadata property).

.DESCRIPTION
    If the policy has a _monitorConfig metadata property (injected by Configure-Intune.ps1),
    Apply-MonitorFilter is called to restrict the PATCH body to only the monitored fields.
    Otherwise the full policy config is returned unchanged.

.PARAMETER PolicyConfig
    The full policy PSObject (as loaded from the baseline JSON).

.PARAMETER ExcludeProperties
    Additional properties to strip from the body before returning (e.g. internal metadata).
#>
function Get-IntuneMonitoredPatchBody {
    param(
        [Parameter(Mandatory=$true)]
        $PolicyConfig,
        [string[]]$ExcludeProperties = @('_sourceFile','_sourcePath','_policyType','_monitorConfig','_assignments')
    )

    $mc = $null
    if ($null -ne $PolicyConfig._monitorConfig) {
        try {
            $mc = @{}
            if ($PolicyConfig._monitorConfig.Include) { $mc['Include'] = @($PolicyConfig._monitorConfig.Include) }
            if ($PolicyConfig._monitorConfig.Exclude) { $mc['Exclude'] = @($PolicyConfig._monitorConfig.Exclude) }
            if ($mc.Count -eq 0) { $mc = $null }
        }
        catch { $mc = $null }
    }

    $body = if ($mc) {
        try { Apply-MonitorFilter -PolicyObject $PolicyConfig -MonitorConfig $mc } catch { $PolicyConfig }
    } else { $PolicyConfig }

    # Strip internal metadata properties
    if ($body -is [System.Collections.IDictionary]) {
        foreach ($prop in $ExcludeProperties) { $body.Remove($prop) | Out-Null }
    } elseif ($body -is [PSCustomObject]) {
        foreach ($prop in $ExcludeProperties) {
            if ($body.PSObject.Properties[$prop]) { $body.PSObject.Properties.Remove($prop) }
        }
    }
    return $body
}

Write-Verbose "Configure-Intune-Helpers.ps1 loaded successfully"

