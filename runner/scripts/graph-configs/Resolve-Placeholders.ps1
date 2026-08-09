<#
.SYNOPSIS
    Converts tenant-specific IDs to/from placeholders for cross-tenant deployments

.DESCRIPTION
    This module provides functions to:
    1. Convert GUIDs to placeholders during backup (Convert-IdsToPlaceholders)
    2. Resolve placeholders to actual IDs during deployment (Resolve-Placeholders)
    
    Supported placeholders:
    - {{TENANTID}} - Tenant ID
    - {{GROUP:displayname}} - Azure AD Group (resolved by DisplayName)
    - {{LOCATION:displayname}} - Named Location (resolved by DisplayName)
    - {{FILTER:displayname}} - Assignment Filter (resolved by DisplayName)
    - {{exchangeOrgName}} - Exchange Online organization name (e.g. contoso.onmicrosoft.com)
    - {{VAR:Name}} - MSP-defined variable (resolved from baseline/tenant variables.json)

.NOTES
    This module is dot-sourced by backup and deployment scripts.

    All functions in this file are deliberately simple functions (no [CmdletBinding()]).
    Advanced functions participate in PS7's WhatIf propagation: when the calling script
    runs with -WhatIf, PS7 tries to explicitly pass -WhatIf:$true to every advanced-
    function call inside it. Simple functions are completely exempt from this — PS7 will
    not attempt to bind -WhatIf to them at all.
#>

# Cache for lookups to avoid repeated API calls
$script:GroupCache = @{}
$script:GroupIdCache = @{}
$script:LocationCache = @{}
$script:LocationIdCache = @{}
$script:FilterCache = @{}
$script:FilterIdCache = @{}
$script:AllFilters = @()
$script:AllFiltersLoaded = $false
$script:TenantVariables = @{}
$script:TenantVariablesInitialized = $false

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
if (Test-Path $moduleHelpersPath) { . $moduleHelpersPath }

<#
.SYNOPSIS
    Converts GUIDs in a configuration object to placeholders

.DESCRIPTION
    Recursively scans configuration object for GUID-formatted strings.
    Attempts to resolve each GUID to determine its type:
    - If matches source tenant ID → {{TENANTID}}
    - If resolves to a group → {{GROUP:displayname}}
    - Otherwise → leaves as-is

.PARAMETER ConfigObject
    The configuration object (hashtable) to process

.PARAMETER SourceTenantId
    The source tenant ID to detect and replace

.EXAMPLE
    $config = Convert-IdsToPlaceholders -ConfigObject $config -SourceTenantId $tenantId
#>
function Convert-IdsToPlaceholders {
    param(
        [object]$ConfigObject,
        [string]$SourceTenantId
    )
    
    # GUID regex pattern (without anchors to match GUIDs within strings)
    $guidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    
    # Recursive function to process objects
    function Process-Object {
        param([object]$obj)
        
        if ($obj -is [string]) {
            $originalString = $obj
            $modifiedString = $obj
            
            # Find all GUID patterns in the string (including partial matches)
            $guidMatches = [regex]::Matches($obj, $guidPattern)
            
            if ($guidMatches.Count -gt 0) {
                foreach ($match in $guidMatches) {
                    $guid = $match.Value
                    $replacement = $null
                    
                    # Check if it's the tenant ID
                    if ($guid -eq $SourceTenantId) {
                        $replacement = '{{TENANTID}}'
                        Write-Host "[DEBUG] Converted tenant ID: $guid → $replacement" -ForegroundColor Yellow
                    }
                    # Check if we've already looked up this GUID
                    elseif ($script:GroupIdCache.ContainsKey($guid)) {
                        $replacement = $script:GroupIdCache[$guid]
                        if ($replacement -ne $guid) {
                            Write-Host "[DEBUG] Using cached conversion: $guid → $replacement" -ForegroundColor DarkCyan
                        }
                    }
                    else {
                        # Try to resolve as a group
                        try {
                            $group = Get-MgGroup -GroupId $guid -ErrorAction Stop
                            if ($group) {
                                $replacement = "{{GROUP:$($group.DisplayName)}}"
                                Write-Host "[DEBUG] Converted group: $guid → $replacement (displayName: $($group.DisplayName))" -ForegroundColor Cyan
                                $script:GroupIdCache[$guid] = $replacement
                            }
                            else {
                                Write-Host "[DEBUG] Group lookup returned null for GUID: $guid" -ForegroundColor Yellow
                            }
                        }
                        catch {
                            # Not a group, try named location
                            if ($_.Exception.Message -match "does not exist" -or $_.Exception.Message -match "not found") {
                                Write-Host "[DEBUG] Group does not exist: $guid" -ForegroundColor DarkYellow
                            }
                            elseif ($_.Exception.Message -match "Forbidden" -or $_.Exception.Message -match "Unauthorized") {
                                Write-Host "[DEBUG] No permission to read group: $guid" -ForegroundColor DarkYellow
                            }
                            else {
                                Write-Host "[DEBUG] Group lookup failed for $guid : $($_.Exception.Message)" -ForegroundColor DarkGray
                            }
                        }
                        
                        # Try to resolve as a named location if not resolved yet
                        if (-not $replacement) {
                            try {
                                $location = Get-MgIdentityConditionalAccessNamedLocation -NamedLocationId $guid -ErrorAction Stop
                                if ($location) {
                                    $replacement = "{{LOCATION:$($location.DisplayName)}}"
                                    Write-Host "[DEBUG] Converted location: $guid → $replacement (displayName: $($location.DisplayName))" -ForegroundColor Magenta
                                    $script:LocationIdCache[$guid] = $replacement
                                }
                                else {
                                    Write-Host "[DEBUG] Location lookup returned null for GUID: $guid" -ForegroundColor Yellow
                                }
                            }
                            catch {
                                # Not a named location either
                                if ($_.Exception.Message -match "does not exist" -or $_.Exception.Message -match "not found") {
                                    Write-Host "[DEBUG] Named location does not exist: $guid" -ForegroundColor DarkYellow
                                }
                                else {
                                    Write-Host "[DEBUG] Location lookup failed for $guid : $($_.Exception.Message)" -ForegroundColor DarkGray
                                }
                            }
                        }
                        
                        # Cache the result (even if not resolved)
                        if (-not $replacement) {
                            Write-Host "[DEBUG] ❌ Unresolved GUID (not a group or location): $guid" -ForegroundColor Gray
                            $script:GroupIdCache[$guid] = $guid
                            $script:LocationIdCache[$guid] = $guid
                        }
                    }
                    
                    # Replace the GUID in the string if we found a replacement
                    if ($replacement -and $replacement -ne $guid) {
                        $modifiedString = $modifiedString.Replace($guid, $replacement)
                    }
                }
                
                if ($modifiedString -ne $originalString) {
                    Write-Host "[DEBUG] String transformation: '$originalString' → '$modifiedString'" -ForegroundColor Green
                }
                
                return $modifiedString
            }
            
            return $obj
        }
        elseif ($obj -is [hashtable] -or $obj -is [System.Collections.IDictionary]) {
            $keys = @($obj.Keys)
            foreach ($key in $keys) {
                $obj[$key] = Process-Object -obj $obj[$key]
            }
            return $obj
        }
        elseif ($obj -is [array]) {
            for ($i = 0; $i -lt $obj.Count; $i++) {
                $obj[$i] = Process-Object -obj $obj[$i]
            }
            return $obj
        }
        else {
            return $obj
        }
    }
    
    return Process-Object -obj $ConfigObject
}

function Initialize-TenantVariables {
    if ($script:TenantVariablesInitialized) { return }
    $script:TenantVariablesInitialized = $true
    $script:TenantVariables = @{}

    if ($env:PLAN_DIR) {
        $cachePath = Join-Path $env:PLAN_DIR 'tenant-variables-resolved.json'
        if (Test-Path $cachePath) {
            try {
                $cached = Get-Content $cachePath -Raw | ConvertFrom-Json
                if ($cached.Variables) {
                    foreach ($name in $cached.Variables.PSObject.Properties.Name) {
                        $value = $cached.Variables.$name
                        if ($null -ne $value -and [string]$value.Trim() -ne '') {
                            $script:TenantVariables[$name] = [string]$value
                        }
                    }
                    Write-Verbose "Loaded $($script:TenantVariables.Count) tenant variable(s) from $cachePath"
                    return
                }
            }
            catch {
                Write-Verbose "Initialize-TenantVariables: Could not read '$cachePath': $_"
            }
        }
    }

    $commonVarsPath = Join-Path $PSScriptRoot '..\common\Common-Variables.ps1'
    if (-not (Test-Path $commonVarsPath)) { return }

    $baselinePath = $env:BASELINE_PATH
    $tenantRepoPath = $env:TENANT_REPO_PATH
    if (-not $baselinePath -or -not $tenantRepoPath) {
        $cwd = (Get-Location).Path
        $candidateBaseline = Join-Path $cwd 'baseline'
        $candidateTenant = Join-Path $cwd 'tenant'
        if ((Test-Path $candidateBaseline) -and ((Test-Path (Join-Path $candidateBaseline 'groups-config.json')) -or (Test-Path (Join-Path $candidateBaseline 'variables.json')))) {
            $baselinePath = $candidateBaseline
        }
        if (Test-Path $candidateTenant) {
            $tenantRepoPath = $candidateTenant
        }
    }

    if (-not $baselinePath -or -not $tenantRepoPath) { return }

    . $commonVarsPath
    $resolved = Get-TenantVariables -BaselinePath $baselinePath -TenantRepoPath $tenantRepoPath -TenantSlug $env:TENANT_SLUG -Quiet
    foreach ($key in $resolved.Keys) {
        $script:TenantVariables[$key] = $resolved[$key]
    }
    if ($script:TenantVariables.Count -gt 0) {
        Write-Verbose "Loaded $($script:TenantVariables.Count) tenant variable(s) from baseline/tenant repos"
    }
}

<#
.SYNOPSIS
    Resolves placeholders in a configuration object to actual tenant-specific IDs

.DESCRIPTION
    Recursively scans configuration object for placeholder tokens and replaces them:
    - {{TENANTID}} → Current tenant ID from environment
    - {{GROUP:displayname}} → Actual group ID from current tenant

.PARAMETER ConfigObject
    The configuration object (hashtable) to process

.PARAMETER TenantId
    Optional tenant ID to use for {{TENANTID}} replacement. 
    If not provided, uses $env:AZURE_TENANT_ID

.EXAMPLE
    $config = Resolve-Placeholders -ConfigObject $config
    
.EXAMPLE
    # In WhatIf mode with pending groups from baseline
    $config = Resolve-Placeholders -ConfigObject $config -AllowMissingGroups -PendingGroupsPath "baseline/groups"
#>
function Resolve-Placeholders {
    param(
        [object]$ConfigObject,
        [string]$TenantId,
        [switch]$AllowMissingGroups,
        [string]$PendingGroupsPath
    )
    
    # Auto-detect WhatIf mode from global preference
    $allowMissing = $AllowMissingGroups -or $WhatIfPreference
    
    # Load pending groups from baseline config (groups that will be created)
    $script:PendingGroups = @{}
    if ($PendingGroupsPath -and (Test-Path $PendingGroupsPath)) {
        $groupFiles = Get-ChildItem -Path $PendingGroupsPath -Filter "*.json" -File -ErrorAction SilentlyContinue
        foreach ($file in $groupFiles) {
            try {
                $groupDef = Get-Content $file.FullName -Raw | ConvertFrom-Json
                $displayName = $groupDef.DisplayName
                if ($displayName) {
                    $script:PendingGroups[$displayName.ToLower()] = $true
                    # Also add case-sensitive version
                    $script:PendingGroups[$displayName] = $true
                }
            }
            catch {
                Write-Verbose "Could not load group definition from $($file.Name): $_"
            }
        }
        if ($script:PendingGroups.Count -gt 0) {
            Write-Verbose "Loaded $($script:PendingGroups.Count) pending group definitions from baseline"
        }
    }
    
    # Get tenant ID from parameter or environment
    if (-not $TenantId) {
        $TenantId = $env:AZURE_TENANT_ID
        if (-not $TenantId) {
            throw "Tenant ID not provided and AZURE_TENANT_ID environment variable not set"
        }
    }

    Initialize-TenantVariables
    
    # Recursive function to process objects
    function Process-Object {
        param([object]$obj)
        
        if ($obj -is [string]) {
            $originalString = $obj
            $modifiedString = $obj
            
            # Replace {{TENANTID}} placeholder (can be partial match)
            if ($modifiedString -match '{{TENANTID}}') {
                $modifiedString = $modifiedString.Replace('{{TENANTID}}', $TenantId)
                Write-Verbose "Resolved placeholder: {{TENANTID}} → $TenantId"
            }
            
            # Find and replace all {{GROUP:*}} placeholders
            $groupMatches = [regex]::Matches($modifiedString, '{{GROUP:([^}]+)}}')
            foreach ($match in $groupMatches) {
                $fullPlaceholder = $match.Value
                $groupDisplayName = $match.Groups[1].Value
                $groupId = $null
                
                # Check cache first
                if ($script:GroupCache.ContainsKey($groupDisplayName)) {
                    $groupId = $script:GroupCache[$groupDisplayName]
                    Write-Verbose "Resolved placeholder from cache: $fullPlaceholder → $groupId"
                }
                else {
                    # Look up group in current tenant
                    try {
                        $group = Find-MgGroupByDisplayName -DisplayName $groupDisplayName
                        
                        if (-not $group) {
                            if ($allowMissing) {
                                # Check if group is in pending groups (will be created during deployment)
                                $isPending = $script:PendingGroups.ContainsKey($groupDisplayName) -or 
                                             $script:PendingGroups.ContainsKey($groupDisplayName.ToLower())
                                
                                if ($isPending) {
                                    Write-Host "  [PENDING] Group '$groupDisplayName' will be created during Groups deployment"
                                }
                                else {
                                    Write-Warning "Group '$groupDisplayName' not found and NOT in baseline groups config!"
                                    Write-Warning "  This group must be created manually or added to baseline/groups/"
                                }
                                # Keep original placeholder - skip replacement
                                continue
                            }
                            else {
                                $errorMsg = @"
DEPLOYMENT FAILED: Required group not found in target tenant

Group Name: '$groupDisplayName'
Placeholder: $fullPlaceholder

This group is referenced in the baseline configuration but does not exist in the target tenant.

ACTION REQUIRED:
1. Ensure groups are deployed before this configuration, OR
2. Create the group '$groupDisplayName' in the target tenant, OR
3. Remove configurations that reference this group from the baseline

Deployment cannot continue without this group.
"@
                                Write-Error $errorMsg
                                throw $errorMsg
                            }
                        }
                        
                        if ($group -is [array] -and $group.Count -gt 1) {
                            Write-Warning "Multiple groups found with DisplayName '$groupDisplayName'. Using first match: $($group[0].Id)"
                            $groupId = $group[0].Id
                        }
                        else {
                            $groupId = $group.Id
                        }
                        
                        # Cache the result
                        $script:GroupCache[$groupDisplayName] = $groupId
                        
                        Write-Verbose "Resolved placeholder: $fullPlaceholder -> $groupId"
                    }
                    catch {
                        if ($allowMissing) {
                            # In WhatIf mode, just warn and keep placeholder
                            Write-Warning "Could not resolve group '$groupDisplayName': $_ - will be resolved during deployment"
                            continue
                        }
                        else {
                            $errorMsg = "Failed to resolve group placeholder '$fullPlaceholder': $_"
                            Write-Error $errorMsg
                            throw $errorMsg
                        }
                    }
                }
                
                if ($groupId) {
                    $modifiedString = $modifiedString.Replace($fullPlaceholder, $groupId)
                }
            }
            
            # Find and replace all {{LOCATION:*}} placeholders
            $locationMatches = [regex]::Matches($modifiedString, '{{LOCATION:([^}]+)}}')
            foreach ($match in $locationMatches) {
                $fullPlaceholder = $match.Value
                $locationDisplayName = $match.Groups[1].Value
                $locationId = $null
                
                # Check cache first
                if ($script:LocationCache.ContainsKey($locationDisplayName)) {
                    $locationId = $script:LocationCache[$locationDisplayName]
                    Write-Verbose "Resolved placeholder from cache: $fullPlaceholder → $locationId"
                }
                else {
                    # Look up named location in current tenant
                    try {
                        $location = Get-MgIdentityConditionalAccessNamedLocation -Filter "displayName eq '$locationDisplayName'" -ErrorAction Stop
                        
                        if (-not $location) {
                            if ($allowMissing) {
                                # In WhatIf mode or AllowMissingGroups, keep the placeholder
                                Write-Warning "Named location '$locationDisplayName' not found - will be created during deployment"
                                continue
                            }
                            else {
                                $errorMsg = @"
DEPLOYMENT FAILED: Required named location not found in target tenant

Location Name: '$locationDisplayName'
Placeholder: $fullPlaceholder

This named location is referenced in the baseline configuration but does not exist in the target tenant.

ACTION REQUIRED:
1. Ensure named locations are deployed before this configuration, OR
2. Create the named location '$locationDisplayName' in the target tenant, OR
3. Remove configurations that reference this location from the baseline

Deployment cannot continue without this named location.
"@
                                Write-Error $errorMsg
                                throw $errorMsg
                            }
                        }
                        
                        if ($location -is [array] -and $location.Count -gt 1) {
                            Write-Warning "Multiple named locations found with DisplayName '$locationDisplayName'. Using first match: $($location[0].Id)"
                            $locationId = $location[0].Id
                        }
                        else {
                            $locationId = $location.Id
                        }
                        
                        # Cache the result
                        $script:LocationCache[$locationDisplayName] = $locationId
                        
                        Write-Verbose "Resolved placeholder: $fullPlaceholder -> $locationId"
                    }
                    catch {
                        if ($allowMissing) {
                            Write-Warning "Could not resolve named location '$locationDisplayName': $_ - will be resolved during deployment"
                            continue
                        }
                        else {
                            $errorMsg = "Failed to resolve named location placeholder '$fullPlaceholder': $_"
                            Write-Error $errorMsg
                            throw $errorMsg
                        }
                    }
                }
                
                if ($locationId) {
                    $modifiedString = $modifiedString.Replace($fullPlaceholder, $locationId)
                }
            }
            
            # Find and replace all {{FILTER:*}} placeholders (Assignment Filters)
            $filterMatches = [regex]::Matches($modifiedString, '{{FILTER:([^}]+)}}')
            foreach ($match in $filterMatches) {
                $fullPlaceholder = $match.Value
                $filterDisplayName = $match.Groups[1].Value
                $filterId = $null
                
                # Check cache first
                if ($script:FilterCache.ContainsKey($filterDisplayName)) {
                    $filterId = $script:FilterCache[$filterDisplayName]
                    Write-Verbose "Resolved placeholder from cache: $fullPlaceholder → $filterId"
                }
                else {
                    # Look up assignment filter in current tenant
                    # Note: Assignment Filters API doesn't support $filter by displayName, so we fetch all and search
                    try {
                        # Fetch all filters if not already cached
                        if (-not $script:AllFiltersLoaded) {
                            $allFiltersResponse = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/beta/deviceManagement/assignmentFilters" -ErrorAction Stop
                            $script:AllFilters = $allFiltersResponse.value
                            $script:AllFiltersLoaded = $true
                            
                            # Pre-populate cache with all filters
                            foreach ($f in $script:AllFilters) {
                                if ($f.displayName -and $f.id) {
                                    $script:FilterCache[$f.displayName] = $f.id
                                }
                            }
                        }
                        
                        # Check cache again after loading all filters
                        if ($script:FilterCache.ContainsKey($filterDisplayName)) {
                            $filterId = $script:FilterCache[$filterDisplayName]
                            Write-Verbose "Resolved placeholder: $fullPlaceholder -> $filterId"
                        }
                        else {
                            if ($allowMissing) {
                                # In WhatIf mode or AllowMissingGroups, keep the placeholder
                                Write-Warning "Assignment filter '$filterDisplayName' not found - will be created during deployment"
                                continue
                            }
                            else {
                                $errorMsg = @"
DEPLOYMENT FAILED: Required assignment filter not found in target tenant

Filter Name: '$filterDisplayName'
Placeholder: $fullPlaceholder

This assignment filter is referenced in the baseline configuration but does not exist in the target tenant.

ACTION REQUIRED:
1. Ensure filters are deployed before policies, OR
2. Create the filter '$filterDisplayName' in the target tenant, OR
3. Remove the filter reference from the assignment

Deployment cannot continue without this filter.
"@
                                Write-Error $errorMsg
                                throw $errorMsg
                            }
                        }
                    }
                    catch {
                        if ($allowMissing) {
                            Write-Warning "Could not resolve assignment filter '$filterDisplayName': $_ - will be resolved during deployment"
                            continue
                        }
                        else {
                            $errorMsg = "Failed to resolve assignment filter placeholder '$fullPlaceholder': $_"
                            Write-Error $errorMsg
                            throw $errorMsg
                        }
                    }
                }
                
                if ($filterId) {
                    $modifiedString = $modifiedString.Replace($fullPlaceholder, $filterId)
                }
            }
            
            # Replace {{exchangeOrgName}} with the tenant's Exchange org name
            if ($modifiedString -match '\{\{exchangeOrgName\}\}') {
                $orgName = $env:EXCHANGE_ORG_NAME
                if ($orgName) {
                    $modifiedString = $modifiedString.Replace('{{exchangeOrgName}}', $orgName)
                    Write-Verbose "Resolved placeholder: {{exchangeOrgName}} → $orgName"
                }
                else {
                    Write-Warning "Placeholder {{exchangeOrgName}} found but EXCHANGE_ORG_NAME env var is not set"
                }
            }

            # Replace {{VAR:Name}} with MSP-defined tenant/group variables
            $varMatches = [regex]::Matches($modifiedString, '\{\{VAR:([^}]+)\}\}')
            foreach ($match in $varMatches) {
                $fullPlaceholder = $match.Value
                $varName = $match.Groups[1].Value.Trim()
                if ($script:TenantVariables.ContainsKey($varName)) {
                    $modifiedString = $modifiedString.Replace($fullPlaceholder, [string]$script:TenantVariables[$varName])
                    Write-Verbose "Resolved placeholder: $fullPlaceholder → $($script:TenantVariables[$varName])"
                }
                elseif ($allowMissing) {
                    Write-Warning "Variable placeholder '$fullPlaceholder' could not be resolved (WhatIf mode — keeping token)"
                }
                else {
                    $errorMsg = "Unresolved variable placeholder: $fullPlaceholder"
                    Write-Error $errorMsg
                    throw $errorMsg
                }
            }

            if ($modifiedString -ne $originalString) {
                Write-Verbose "String transformation: '$originalString' → '$modifiedString'"
            }
            
            return $modifiedString
        }
        elseif ($obj -is [hashtable] -or $obj -is [System.Collections.IDictionary]) {
            $keys = @($obj.Keys)
            foreach ($key in $keys) {
                $obj[$key] = Process-Object -obj $obj[$key]
            }
            return $obj
        }
        elseif ($obj -is [array]) {
            for ($i = 0; $i -lt $obj.Count; $i++) {
                $obj[$i] = Process-Object -obj $obj[$i]
            }
            return $obj
        }
        else {
            return $obj
        }
    }
    
    return Process-Object -obj $ConfigObject
}

<#
.SYNOPSIS
    Clears the group lookup cache

.DESCRIPTION
    Clears cached group lookups. Useful when switching between tenants or
    when group changes have been made.

.EXAMPLE
    Clear-PlaceholderCache
#>
function Clear-PlaceholderCache {
    $script:GroupCache = @{}
    $script:GroupIdCache = @{}
    $script:LocationCache = @{}
    $script:LocationIdCache = @{}
    $script:FilterCache = @{}
    $script:FilterIdCache = @{}
    $script:AllFilters = @()
    $script:AllFiltersLoaded = $false
    $script:TenantVariables = @{}
    $script:TenantVariablesInitialized = $false
    Write-Verbose "Placeholder cache cleared"
}

# Note: Functions are available when dot-sourced (no Export-ModuleMember needed)

