<#
.SYNOPSIS
    Common functions and utilities for M365 backup scripts

.DESCRIPTION
    This module provides shared functionality for all backup scripts including:
    - Logging functions
    - Graph API helpers
    - Placeholder conversion
    - Caching for groups and named locations
    - File naming utilities

.NOTES
    This module should be dot-sourced by other backup scripts
#>

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Script-level caches (shared across all backup modules)
# Only initialize if not already set (to preserve caller's values when dot-sourced)
if (-not $script:GroupCache) { $script:GroupCache = @{} }
if (-not $script:NamedLocationCache) { $script:NamedLocationCache = @{} }
# GUIDs confirmed not to be groups (role template IDs, app IDs, SP IDs, etc.) — skip live lookup retry
if (-not $script:NonGroupCache) { $script:NonGroupCache = @{} }
# Note: CurrentTenantId, LogFile, DebugMode, and BackupPath are set by their respective functions

# Named mutex used to serialise log-file writes across parallel runspaces.
# Each runspace dot-sources this file and gets its own handle to the same OS-level mutex.
if (-not $script:LogMutex) {
    $script:LogMutex = [System.Threading.Mutex]::new($false, 'M365BackupLogMutex')
}

#region Logging Functions

function Initialize-BackupLogging {
    param(
        [Parameter(Mandatory=$true)]
        [string]$BackupPath,
        
        [Parameter(Mandatory=$false)]
        [switch]$DebugMode
    )
    
    $script:BackupPath = $BackupPath
    $script:DebugMode = $DebugMode
    
    # Create logs directory
    $logsDir = Join-Path $BackupPath "logs"
    if (-not (Test-Path $logsDir)) {
        New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    }
    
    # Initialize log file
    $script:LogFile = Join-Path $logsDir "backup-$(Get-Date -Format 'yyyy-MM-dd_HHmmss').log"
    
    Write-Log "Backup logging initialized" "INFO"
    Write-Log "Log file: $script:LogFile" "INFO"
    Write-Log "Debug mode: $script:DebugMode" "INFO"
}

function Write-Log {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        
        [Parameter(Mandatory=$false)]
        [ValidateSet("INFO", "WARN", "ERROR", "DEBUG")]
        [string]$Level = "INFO"
    )
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] [$Level] $Message"
    
    # Console output with colors
    $color = switch ($Level) {
        "INFO"  { "White" }
        "WARN"  { "Yellow" }
        "ERROR" { "Red" }
        "DEBUG" { "Cyan" }
        default { "White" }
    }
    
    # Skip DEBUG messages if not in debug mode (unless writing to file)
    if ($Level -eq "DEBUG" -and -not $script:DebugMode) {
        # Still write to log file, just don't show on console
        if ($script:LogFile) {
            $logDir = Split-Path $script:LogFile -Parent -ErrorAction SilentlyContinue
            if ($logDir -and (Test-Path $logDir)) {
                try {
                    $acquired = $script:LogMutex.WaitOne(2000)
                    $logMessage | Out-File -FilePath $script:LogFile -Append -Encoding UTF8 -ErrorAction SilentlyContinue
                } catch { }
                finally { if ($acquired) { $script:LogMutex.ReleaseMutex() } }
            }
        }
        return
    }
    
    Write-Host $logMessage -ForegroundColor $color
    
    # Write to log file (mutex ensures no interleaving from parallel runspaces)
    if ($script:LogFile) {
        try {
            $acquired = $script:LogMutex.WaitOne(2000)
            $logMessage | Out-File -FilePath $script:LogFile -Append -Encoding UTF8 -ErrorAction SilentlyContinue
        } catch {
            Write-Host "[WARNING] Could not write to log file: $_" -ForegroundColor Yellow
        }
        finally { if ($acquired) { $script:LogMutex.ReleaseMutex() } }
    }
}

#endregion

#region Graph API Helpers

function Invoke-GraphRequestWithDebug {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$Uri,
        
        [Parameter(Mandatory=$false)]
        [string]$Method = "GET",
        
        [Parameter(Mandatory=$false)]
        [object]$Body,
        
        [Parameter(Mandatory=$false)]
        [string]$ContentType,
        
        [Parameter(Mandatory=$false)]
        [hashtable]$Headers,

        # Transient Graph/Intune backend errors (5xx, 429) are retried with backoff before
        # giving up. Backup scripts treat a failed fetch the same as "item no longer exists"
        # (they simply don't (re)write that item's backup file), so without a retry here a
        # single transient 500 from Intune's proxy can make a still-live policy/app look
        # deleted in the next backup commit. GET is always safe to retry; non-GET calls are
        # rare in backup scripts but are also idempotent-ish here (re-reads), so retry them too.
        [Parameter(Mandatory=$false)]
        [int]$MaxRetries = 4,

        [Parameter(Mandatory=$false)]
        [int]$RetryDelaySeconds = 3
    )
    
    # Debug logging for request
    if ($script:DebugMode) {
        Write-Log "[API REQUEST] $Method $Uri" "DEBUG"
        if ($Body) {
            $bodyPreview = if ($Body -is [string]) { 
                if ($Body.Length -gt 200) { $Body.Substring(0, 200) + "..." } else { $Body }
            } else {
                $bodyJson = $Body | ConvertTo-Json -Depth 3 -Compress -ErrorAction SilentlyContinue
                if ($bodyJson.Length -gt 200) { $bodyJson.Substring(0, 200) + "..." } else { $bodyJson }
            }
            Write-Log "  Body: $bodyPreview" "DEBUG"
        }
    }

    $graphParams = @{
        Uri = $Uri
        Method = $Method
    }
    if ($Body) { $graphParams.Body = $Body }
    if ($ContentType) { $graphParams.ContentType = $ContentType }
    if ($Headers) { $graphParams.Headers = $Headers }

    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        try {
            $response = Invoke-MgGraphRequest @graphParams

            # Debug logging for response
            if ($script:DebugMode) {
                if ($response.PSObject.Properties.Name -contains 'value') {
                    $itemCount = if ($response.value) { $response.value.Count } else { 0 }
                    Write-Log "  Response: $itemCount items returned" "DEBUG"
                } else {
                    Write-Log "  Response: Single object returned" "DEBUG"
                }
            }

            return $response
        }
        catch {
            $errorMessage = $_.Exception.Message
            # Match transient server-side/throttling failures: HTTP 429/500/502/503/504, or the
            # named status text Graph/Intune returns for them (InternalServerError, BadGateway,
            # ServiceUnavailable, GatewayTimeout, TooManyRequests).
            $isTransient = $errorMessage -match '(?:^|\D)(429|500|502|503|504)(?:\D|$)' -or
                           $errorMessage -match 'InternalServerError|BadGateway|ServiceUnavailable|GatewayTimeout|TooManyRequests'

            if ($isTransient -and $attempt -lt $MaxRetries) {
                $delay = $RetryDelaySeconds * $attempt
                Write-Log "[API TRANSIENT ERROR] $Method $Uri - attempt $attempt/$MaxRetries failed: $errorMessage - retrying in ${delay}s..." "WARN"
                Start-Sleep -Seconds $delay
                continue
            }

            Write-Log "[API ERROR] $Method $Uri - $errorMessage" "ERROR"
            throw
        }
    }
}

function Get-AllGraphResults {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Uri,
        
        [Parameter(Mandatory=$false)]
        [string]$Description = "items",
        
        [Parameter(Mandatory=$false)]
        [int]$PageSize = 999
    )
    
    $allResults = @()
    $pageCount = 0
    
    # Add $top parameter to get more results per page (avoids pagination issues)
    # Use string concatenation to avoid escaping issues with $top
    $topParam = '$top=' + $PageSize
    $separator = if ($Uri -match '\?') { '&' } else { '?' }
    $pagedUri = $Uri + $separator + $topParam
    
    $response = Invoke-GraphRequestWithDebug -Uri $pagedUri -Method GET
    if ($null -eq $response) { return $allResults }
    $allResults = @($response.value)
    $pageCount++
    
    # Handle pagination (in case there are still more results)
    # Note: Invoke-MgGraphRequest returns hashtable, so use ContainsKey() not PSObject.Properties
    while ($response.ContainsKey('@odata.nextLink') -and $response.'@odata.nextLink') {
        $pageCount++
        $nextLink = $response.'@odata.nextLink'
        Write-Log "Fetching $Description page $pageCount..." "DEBUG"
        $response = Invoke-GraphRequestWithDebug -Uri $nextLink -Method GET
        $allResults += $response.value
    }
    
    if ($pageCount -gt 1) {
        Write-Log "Retrieved $($allResults.Count) $Description across $pageCount pages" "DEBUG"
    }
    
    return $allResults
}

function Invoke-ParallelBatch {
<#
.SYNOPSIS
    Exports a list of items to disk in parallel batches.

.DESCRIPTION
    Splits $Items into N equal slices (N = ThrottleLimit) and runs each slice
    in its own ForEach-Object -Parallel runspace.  Each runspace:
      1. Dot-sources Backup-Common.ps1 so all helpers are available.
      2. Restores $script: state from $using: variables.
      3. Authenticates to Microsoft Graph once (one OAuth call per batch).
      4. Calls the provided $Process script block with the batch array.

    The $Process script block must output [PSCustomObject]@{ Success = $bool; Name = $string }
    for every item it processes so the caller can aggregate BackedUp / Failed counts.

    Shared read-only data is passed in via the $SharedVars hashtable and accessed
    inside $Process using $using:SharedVars.  The following keys are expected:
      ScriptDir, BackupPath, DebugMode, TenantId, LogFile, GroupCache, FilterCache,
      NamedLocationCache

    If $Items is empty the function returns an empty array immediately.

    The entire parallel batch runs inside a Start-ThreadJob so that a wall-clock
    TimeoutSec can be enforced.  This guards against indefinite TCP hangs on Linux
    where PowerShell/HttpClient cancellation tokens are unreliable.  If the batch
    exceeds TimeoutSec the job is forcefully stopped and an empty result is returned
    (the backup section is skipped rather than the whole run hanging forever).
    Override the default via the BACKUP_BATCH_TIMEOUT_SEC environment variable.

.EXAMPLE
    $results = Invoke-ParallelBatch -Items $apps -ThrottleLimit 5 `
        -SharedVars @{ ScriptDir = $scriptDir; BackupPath = $script:BackupPath; ... } `
        -Process {
            param($batch)
            $sv = $using:SharedVars
            . "$($sv.ScriptDir)\Backup-Common.ps1"
            $script:BackupPath = $sv.BackupPath
            # ... restore remaining state ...
            Connect-M365Backup
            foreach ($app in $batch) {
                try   { ...; [PSCustomObject]@{ Success = $true;  Name = $app.displayName } }
                catch { [PSCustomObject]@{ Success = $false; Name = $app.displayName; Error = "$_" } }
            }
        }
    $backedUp = ($results | Where-Object  Success).Count
    $failed   = ($results | Where-Object { -not $_.Success }).Count
#>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Items,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Process,

        [Parameter(Mandatory = $false)]
        [int]$ThrottleLimit = 5,

        [Parameter(Mandatory = $false)]
        [hashtable]$SharedVars = @{},

        [Parameter(Mandatory = $false)]
        [int]$TimeoutSec = 0
    )

    if ($TimeoutSec -eq 0) {
        $TimeoutSec = if ($env:BACKUP_BATCH_TIMEOUT_SEC) { [int]$env:BACKUP_BATCH_TIMEOUT_SEC } else { 600 }
    }

    if ($Items.Count -eq 0) { return @() }

    # Split into at most ThrottleLimit equal slices
    $n    = [Math]::Min($ThrottleLimit, $Items.Count)
    $size = [Math]::Ceiling($Items.Count / $n)

    $batches = [System.Collections.Generic.List[object[]]]::new()
    for ($i = 0; $i -lt $Items.Count; $i += $size) {
        $end = [Math]::Min($i + $size - 1, $Items.Count - 1)
        $batches.Add([object[]]($Items[$i..$end]))
    }

    Write-Log "Invoke-ParallelBatch: $($Items.Count) items → $($batches.Count) batch(es), ThrottleLimit $ThrottleLimit, TimeoutSec $TimeoutSec" "DEBUG"

    # Run inside a Start-ThreadJob so Wait-Job -Timeout can kill the whole batch if it hangs.
    # $SharedVars MUST be a named param here: $using:SharedVars inside $Process resolves
    # from the thread-job scope where the param named $SharedVars is in scope.
    $job = Start-ThreadJob -ScriptBlock {
        param($b, $p, $t, $SharedVars)
        $b | ForEach-Object -Parallel $p -ThrottleLimit $t
    } -ArgumentList $batches, $Process, $ThrottleLimit, $SharedVars

    $completed = Wait-Job -Job $job -Timeout $TimeoutSec
    if (-not $completed) {
        Stop-Job  -Job $job
        Remove-Job -Job $job -Force
        Write-Log "Invoke-ParallelBatch timed out after ${TimeoutSec}s — section skipped to avoid indefinite hang" "WARN"
        return @()
    }

    $results = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
    Remove-Job -Job $job -Force
    return $results
}

#endregion

#region Caching Functions

function Initialize-GroupCache {
    Write-Log "Building group cache..." "INFO"
    
    try {
        $groups = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/groups?`$select=id,displayName,groupTypes,membershipRule" -Description "groups"
        
        foreach ($group in $groups) {
            $script:GroupCache[$group.id] = $group.displayName
        }
        
        Write-Log "Cached $($script:GroupCache.Count) groups" "INFO"
        if ($script:GroupCache.Count -eq 0) {
            Write-Log "WARNING: Group cache is empty — group IDs in assignments will not be translated to names. Check Group.Read.All permission." "WARN"
            Write-Host "##vso[task.logissue type=warning]Group cache is empty after initialization. Group IDs will remain as raw GUIDs in backup output."
        }
        return $true
    }
    catch {
        Write-Log "Failed to build group cache: $_" "ERROR"
        return $false
    }
}

function Initialize-NamedLocationCache {
    Write-Log "Building named location cache..." "INFO"
    
    try {
        $locations = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations" -Description "named locations"
        
        foreach ($location in $locations) {
            $script:NamedLocationCache[$location.id] = $location.displayName
        }
        
        Write-Log "Cached $($script:NamedLocationCache.Count) named locations" "INFO"
        return $true
    }
    catch {
        Write-Log "Failed to build named location cache: $_" "ERROR"
        return $false
    }
}

function Get-GroupDisplayName {
    param([string]$GroupId)
    
    if ($script:GroupCache.ContainsKey($GroupId)) {
        return $script:GroupCache[$GroupId]
    }
    return $null
}

function Resolve-UnknownGroupId {
    param([string]$GroupId)
    
    if ($script:GroupCache.ContainsKey($GroupId)) {
        return $script:GroupCache[$GroupId]
    }
    
    # Skip GUIDs already confirmed to not be groups (role IDs, app IDs, SP IDs, etc.)
    if ($script:NonGroupCache.ContainsKey($GroupId)) {
        return $null
    }
    
    try {
        # Use Invoke-MgGraphRequest directly (not Invoke-GraphRequestWithDebug) so that
        # expected 404s for non-group GUIDs are NOT logged as [ERROR]
        $selectParam = '$select=id,displayName'
        $group = Invoke-MgGraphRequest -Uri "https://graph.microsoft.com/v1.0/groups/$GroupId`?$selectParam" -Method GET -ErrorAction Stop
        if ($group -and $group.displayName) {
            $script:GroupCache[$GroupId] = $group.displayName
            Write-Log "Resolved group ID '$GroupId' to '$($group.displayName)' (live lookup)" "INFO"
            return $group.displayName
        }
    }
    catch {
        $statusCode = $null
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
        
        if ($statusCode -eq 404) {
            # Expected — this GUID is a role template ID, app ID, service principal ID, etc.
            $script:NonGroupCache[$GroupId] = $true
            Write-Log "GUID '$GroupId' is not a group (role/app/SP ID) — leaving as-is" "DEBUG"
        }
        else {
            Write-Log "Could not resolve group ID '$GroupId' via live lookup (HTTP $statusCode): $($_.Exception.Message)" "WARN"
        }
    }
    return $null
}

function Get-NamedLocationDisplayName {
    param([string]$LocationId)
    
    if ($script:NamedLocationCache.ContainsKey($LocationId)) {
        return $script:NamedLocationCache[$LocationId]
    }
    return $null
}

#endregion

#region Placeholder Conversion

# Properties that should ALWAYS be arrays (even with single elements)
# This prevents PowerShell's ConvertFrom-Json from unwrapping single-element arrays
$script:ForceArrayProperties = @(
    'omaSettings',
    'roleScopeTagIds',
    'assignments',
    'excludeGroups',
    'includeGroups',
    'excludeUsers',
    'includeUsers',
    'excludeRoles',
    'includeRoles',
    'excludeApplications',
    'includeApplications',
    'excludeLocations',
    'includeLocations',
    'includePlatforms',
    'excludePlatforms',
    'builtInControls',
    'customAuthenticationFactors',
    'termsOfUse',
    'clientAppTypes',
    'signInRiskLevels',
    'userRiskLevels',
    'servicePrincipalRiskLevels',
    'settings',
    'settingInstance',
    'groupSettingCollectionValue',
    'children',
    # Group Policy Configurations: keep these as JSON arrays even when empty so
    # the baseline distinguishes "setting has no presentation" ([]) from
    # "value was never captured" (null). PowerShell's default ConvertTo-Json
    # collapses @() to "null", which previously made every GPC setting look
    # unconfigured. The deploy side relies on this distinction.
    'presentationValues',
    'definitionValues'
)

function ConvertTo-Hashtable {
    param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $InputObject,
        
        [Parameter(Mandatory=$false)]
        [string]$PropertyName = $null
    )
    
    if ($null -eq $InputObject) { return $null }
    
    # Check if this property should always be an array
    $shouldBeArray = $PropertyName -and ($script:ForceArrayProperties -contains $PropertyName)
    
    if ($InputObject -is [System.Collections.IEnumerable] -and
        $InputObject -isnot [string] -and
        $InputObject -isnot [System.Collections.IDictionary]) {
        $collection = @()
        foreach ($item in $InputObject) {
            $collection += ConvertTo-Hashtable -InputObject $item
        }
        return @($collection)  # Force array wrapper
    }
    elseif ($InputObject -is [System.Collections.IDictionary]) {
        # Handles Hashtable returned directly by Invoke-MgGraphRequest (no ConvertFrom-Json needed).
        # Must come before PSCustomObject so Hashtable (which is IDictionary) takes this branch.
        $hashtable = @{}
        foreach ($key in $InputObject.Keys) {
            $value = $InputObject[$key]
            if ($null -ne $value) {
                $converted = ConvertTo-Hashtable -InputObject $value -PropertyName $key
                if (($script:ForceArrayProperties -contains $key) -and
                    ($null -ne $converted) -and
                    ($converted -isnot [System.Collections.IEnumerable] -or
                     $converted -is [string] -or
                     $converted -is [System.Collections.IDictionary])) {
                    $hashtable[$key] = @($converted)
                } else {
                    $hashtable[$key] = $converted
                }
            } else {
                $hashtable[$key] = $null
            }
        }
        # Also pick up NoteProperties added via Add-Member (stored on PSObject wrapper, not in .Keys).
        # Invoke-MgGraphRequest returns a Hashtable; callers that do $ht | Add-Member ... attach the
        # value to the PSObject wrapper rather than a hash key, so we must collect it here too.
        foreach ($prop in $InputObject.PSObject.Properties) {
            if ($prop.MemberType -eq 'NoteProperty' -and -not $hashtable.ContainsKey($prop.Name)) {
                $key   = $prop.Name
                $value = $prop.Value
                if ($null -ne $value) {
                    $converted = ConvertTo-Hashtable -InputObject $value -PropertyName $key
                    if (($script:ForceArrayProperties -contains $key) -and
                        ($null -ne $converted) -and
                        ($converted -isnot [System.Collections.IEnumerable] -or
                         $converted -is [string] -or
                         $converted -is [System.Collections.IDictionary])) {
                        $hashtable[$key] = @($converted)
                    } else {
                        $hashtable[$key] = $converted
                    }
                } else {
                    $hashtable[$key] = $null
                }
            }
        }
        return $hashtable
    }
    elseif ($InputObject -is [PSCustomObject]) {
        $hashtable = @{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $value = $property.Value
            if ($null -ne $value) {
                $converted = ConvertTo-Hashtable -InputObject $value -PropertyName $property.Name
                # If this property should be an array but isn't, wrap it
                if (($script:ForceArrayProperties -contains $property.Name) -and
                    ($null -ne $converted) -and
                    ($converted -isnot [System.Collections.IEnumerable] -or $converted -is [string] -or $converted -is [System.Collections.IDictionary])) {
                    $hashtable[$property.Name] = @($converted)
                } else {
                    $hashtable[$property.Name] = $converted
                }
            } else {
                $hashtable[$property.Name] = $null
            }
        }
        return $hashtable
    }
    else {
        # If this should be an array but we got a single value, wrap it
        if ($shouldBeArray) {
            return @($InputObject)
        }
        return $InputObject
    }
}

function Convert-IdsToPlaceholders {
    param(
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        $ConfigObject,
        
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string]$SourceTenantId
    )
    
    if ($null -eq $ConfigObject) { return $null }
    
    if ($ConfigObject -is [string]) {
        $result = $ConfigObject
        
        # Replace tenant ID
        if ($SourceTenantId -and $result -match $SourceTenantId) {
            $result = $result -replace [regex]::Escape($SourceTenantId), '{{TENANTID}}'
        }
        
        # Replace group IDs with placeholders
        foreach ($groupId in $script:GroupCache.Keys) {
            if ($result -match $groupId) {
                $groupName = $script:GroupCache[$groupId]
                $result = $result -replace [regex]::Escape($groupId), "{{GROUP:$groupName}}"
            }
        }
        
        # Replace named location IDs with placeholders
        foreach ($locationId in $script:NamedLocationCache.Keys) {
            if ($result -match $locationId) {
                $locationName = $script:NamedLocationCache[$locationId]
                $result = $result -replace [regex]::Escape($locationId), "{{LOCATION:$locationName}}"
            }
        }
        
        # Replace assignment filter IDs with placeholders
        if ($script:FilterCache) {
            foreach ($filterId in $script:FilterCache.Keys) {
                if ($result -match $filterId) {
                    $filterName = $script:FilterCache[$filterId]
                    $result = $result -replace [regex]::Escape($filterId), "{{FILTER:$filterName}}"
                }
            }
        }
        
        # Fallback: scan for any remaining GUIDs not matched by the caches and attempt live group resolution.
        # Note: CA policies contain role template IDs and app IDs which will 404 as groups — that is expected.
        $guidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
        $remainingGuids = [regex]::Matches($result, $guidPattern) | ForEach-Object { $_.Value } | Select-Object -Unique
        $unknownGuids = $remainingGuids | Where-Object { $_ -ne $SourceTenantId -and -not $script:NonGroupCache.ContainsKey($_) }
        if ($unknownGuids.Count -gt 0) {
            Write-Log "Found $($unknownGuids.Count) unresolved GUID(s) — attempting live group lookup (GroupCache has $($script:GroupCache.Count) entries)" "DEBUG"
        }
        foreach ($guid in $remainingGuids) {
            if ($guid -eq $SourceTenantId) { continue }
            if ($script:NonGroupCache.ContainsKey($guid)) { continue }
            $resolvedName = Resolve-UnknownGroupId -GroupId $guid
            if ($resolvedName) {
                $result = $result -replace [regex]::Escape($guid), "{{GROUP:$resolvedName}}"
            }
            elseif (-not $script:NonGroupCache.ContainsKey($guid)) {
                # Resolution failed for an unexpected reason (not a 404) — this is worth flagging
                Write-Log "Unresolved GUID in backup output: $guid" "WARN"
                Write-Host "##vso[task.logissue type=warning]Unresolved GUID '$guid' — not found as group and not a known non-group ID"
            }
        }
        
        return $result
    }
    elseif ($ConfigObject -is [System.Collections.IDictionary]) {
        $newDict = @{}
        foreach ($key in $ConfigObject.Keys) {
            $newDict[$key] = Convert-IdsToPlaceholders -ConfigObject $ConfigObject[$key] -SourceTenantId $SourceTenantId
        }
        return $newDict
    }
    elseif ($ConfigObject -is [System.Collections.IEnumerable]) {
        $newArray = @()
        foreach ($item in $ConfigObject) {
            $newArray += Convert-IdsToPlaceholders -ConfigObject $item -SourceTenantId $SourceTenantId
        }
        return $newArray
    }
    else {
        return $ConfigObject
    }
}

function ConvertTo-JsonWithPlaceholders {
    param(
        [Parameter(Mandatory=$true)]
        [AllowNull()]
        $InputObject,
        
        [Parameter(Mandatory=$false)]
        [int]$Depth = 10
    )
    
    if ($null -eq $InputObject) {
        return "null"
    }
    
    # Remember whether the caller passed a top-level array (e.g. assignment lists) so we can
    # preserve the JSON array wrapper even when there is only a single element.
    $inputWasArray = $InputObject -is [System.Collections.IEnumerable] `
                     -and $InputObject -isnot [string] `
                     -and $InputObject -isnot [System.Collections.IDictionary]

    # PowerShell ConvertTo-Json returns an empty string for empty collections — write [] explicitly.
    if ($inputWasArray -and @($InputObject).Count -eq 0) {
        return '[]'
    }

    # Walk the object directly via ConvertTo-Hashtable — no ConvertFrom-Json round-trip.
    # ConvertFrom-Json was previously used to produce a PSCustomObject that ConvertTo-Hashtable
    # could traverse, but it silently unwraps nested single-element arrays (e.g. passkeyProfiles,
    # includeTargets), corrupting the stored JSON. ConvertTo-Hashtable now handles IDictionary
    # inputs (Hashtable returned by Invoke-MgGraphRequest) directly, so the round-trip is gone.
    $hashtable = ConvertTo-Hashtable -InputObject $InputObject

    if ($null -eq $hashtable) {
        # Fallback: serialise as-is if conversion failed (should not happen in practice)
        return $InputObject | ConvertTo-Json -Depth $Depth
    }

    # Apply placeholder conversion (only if we have a tenant ID)
    if ($script:CurrentTenantId) {
        $hashtable = Convert-IdsToPlaceholders -ConfigObject $hashtable -SourceTenantId $script:CurrentTenantId
    }

    if ($null -eq $hashtable) {
        return $InputObject | ConvertTo-Json -Depth $Depth
    }

    # Re-wrap in array if the input was a top-level collection but ConvertTo-Hashtable
    # returned a non-array (single item that was in an array passed by the caller).
    # Note: In PowerShell 5.1, @($obj) | ConvertTo-Json still unwraps single-element arrays,
    # so we build the JSON array string manually when there is only one item.
    $resultIsArray = $hashtable -is [System.Collections.IEnumerable] `
                     -and $hashtable -isnot [string] `
                     -and $hashtable -isnot [System.Collections.IDictionary]
    if ($inputWasArray -and -not $resultIsArray) {
        $singleItemJson = $hashtable | ConvertTo-Json -Depth $Depth
        return "[`n$singleItemJson`n]"
    }
    
    # Convert back to JSON
    return $hashtable | ConvertTo-Json -Depth $Depth
}

#endregion

#region File Utilities

function Get-SafeFileName {
    param([string]$Name)
    return $Name -replace '[\\/:*?"<>|\[\]]', '_'
}

function Get-NormalizedJson {
    <#
    .SYNOPSIS
        Returns a compact, alphabetically key-sorted JSON string for equality comparison.
        Arrays are preserved in order; only object keys are sorted.
    #>
    param([string]$JsonString)

    function Sort-JsonObject {
        param($obj)
        if ($null -eq $obj) { return $null }
        if ($obj -is [System.Collections.IDictionary]) {
            $sorted = [ordered]@{}
            foreach ($key in ($obj.Keys | Sort-Object)) {
                $sorted[$key] = Sort-JsonObject $obj[$key]
            }
            return $sorted
        }
        elseif ($obj -is [System.Collections.IEnumerable] -and $obj -isnot [string]) {
            return @($obj | ForEach-Object { Sort-JsonObject $_ })
        }
        else { return $obj }
    }

    try {
        $parsed = $JsonString | ConvertFrom-Json -AsHashtable
        $sorted = Sort-JsonObject $parsed
        return ($sorted | ConvertTo-Json -Depth 50 -Compress)
    }
    catch { return $null }
}

function Save-BackupFile {
    param(
        [Parameter(Mandatory=$true)]
        $Content,
        
        [Parameter(Mandatory=$true)]
        [string]$RelativePath,
        
        [Parameter(Mandatory=$false)]
        [int]$Depth = 20
    )
    
    $fullPath = Join-Path $script:BackupPath $RelativePath
    $directory = Split-Path $fullPath -Parent
    
    if (-not (Test-Path $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    
    $newJson = ConvertTo-JsonWithPlaceholders -InputObject $Content -Depth $Depth

    # For JSON files: skip write if normalized content is identical to the existing file
    if ((Test-Path $fullPath) -and $fullPath -match '\.json$') {
        try {
            $existingJson = Get-Content -Path $fullPath -Raw -Encoding UTF8
            $normalizedNew      = Get-NormalizedJson $newJson
            $normalizedExisting = Get-NormalizedJson $existingJson
            if ($normalizedNew -and $normalizedExisting -and ($normalizedNew -eq $normalizedExisting)) {
                Write-Log "Unchanged: $RelativePath" "DEBUG"
                return
            }
        }
        catch {
            # Comparison failed — fall through and overwrite to be safe
        }
    }

    $newJson | Out-File -FilePath $fullPath -Encoding UTF8
    Write-Log "Saved: $fullPath" "DEBUG"
}

function Save-PolicyWithAssignments {
    param(
        [Parameter(Mandatory=$true)]
        $Policy,
        
        [Parameter(Mandatory=$true)]
        [string]$OutputFolder,
        
        [Parameter(Mandatory=$true)]
        [string]$FileName,
        
        [Parameter(Mandatory=$false)]
        [string]$AssignmentsUri,
        
        [Parameter(Mandatory=$false)]
        [string]$PolicyType = "policy"
    )
    
    # Save the policy
    $policyPath = Join-Path $OutputFolder "$FileName.json"
    Save-BackupFile -Content $Policy -RelativePath $policyPath
    
    # Get and save assignments if URI provided
    if ($AssignmentsUri) {
        try {
            $assignmentsResponse = Invoke-GraphRequestWithDebug -Uri $AssignmentsUri -Method GET
            $assignmentArray = @($assignmentsResponse.value)
            if ($assignmentArray.Count -gt 0) {
                $assignmentPath = Join-Path $OutputFolder "$FileName.assignment.json"
                Save-BackupFile -Content $assignmentArray -RelativePath $assignmentPath -Depth 10
            }
        }
        catch {
            $pName = if ($Policy.displayName) { $Policy.displayName } elseif ($Policy.name) { $Policy.name } else { $FileName }
            Write-Log "Could not retrieve assignments for $PolicyType '$pName': $_" "DEBUG"
            # The policy's own .json above may have saved fine — only its .assignment.json is at
            # risk of going missing (and thus looking "deleted" vs. the last backup) this run.
            Add-BackupItemFailure -RelativePath "$OutputFolder/$FileName.assignment.json" -Reason "$_"
        }
    }
}

# ---------------------------------------------------------------------------
# Failed-item protection
# ---------------------------------------------------------------------------
# The backup pipeline wipes backups/ clean at the start of every run and
# regenerates it from scratch, then commits whatever differs. A single item
# that fails to fetch (transient Graph/Intune 5xx, throttling, etc.) simply
# never gets its file (re)written this run — which looks IDENTICAL, from
# git's perspective, to that item having been genuinely deleted from the
# tenant. Without this safeguard a transient API blip on one item silently
# becomes a permanent "deleted" entry in the tenant's backup history.
#
# Call this from a per-item catch block with the backup-relative path(s)
# that item would have written (e.g. "intune/settings-catalog/Foo.json").
# The pipeline's "Protect Failed Backup Items" step (runs after `git add -A`,
# before commit) reads these back and restores any of them that are staged
# as deleted from the previous commit, so a fetch failure preserves the last
# known-good copy instead of deleting it. Genuine deletions (item fetched
# successfully as "gone", or absent from a successful full list call) are
# unaffected — this only protects paths that were actively reported as failed.
#
# No-ops silently if $env:BACKUP_FAILURES_FILE isn't set (e.g. ad-hoc/local
# runs of a single Backup-*.ps1 script outside the pipeline).
function Add-BackupItemFailure {
    param(
        [Parameter(Mandatory=$true)]
        [string]$RelativePath,

        [Parameter(Mandatory=$false)]
        [string]$Reason = ""
    )

    $failuresFile = $env:BACKUP_FAILURES_FILE
    if (-not $failuresFile) { return }

    # JSON Lines (one compact JSON object per line) rather than a single JSON array —
    # simpler to append to safely than a read-modify-write of one big JSON array.
    $entry = [PSCustomObject]@{
        Path      = $RelativePath -replace '\\', '/'
        Reason    = $Reason
        Timestamp = (Get-Date -Format 'o')
    } | ConvertTo-Json -Compress

    # Invoke-ParallelBatch runs items across concurrent ForEach-Object -Parallel runspaces
    # (same process), so multiple items can fail and append to this file at the same instant.
    # Best-effort a named Mutex (process-wide, works across runspaces) to serialize the append
    # so concurrent failures can't interleave into a corrupt/malformed line. Mutex creation
    # itself is wrapped separately — some platforms don't support named sync objects — so a
    # failure there still falls through to a plain (unsynchronized but still best-effort) append
    # rather than losing the failure record entirely. A parser that skips malformed lines
    # (Protect-FailedBackupItems.ps1) tolerates any rare interleaving either way.
    $mutex = $null
    try { $mutex = New-Object System.Threading.Mutex($false, "Config365BackupFailuresFile") } catch {}

    try {
        if ($mutex) { [void]$mutex.WaitOne(5000) }

        $dir = Split-Path $failuresFile -Parent
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

        Add-Content -Path $failuresFile -Value $entry -Encoding UTF8
    }
    catch {
        Write-Log "Could not record backup item failure for '$RelativePath': $_" "WARN"
    }
    finally {
        if ($mutex) {
            try { $mutex.ReleaseMutex() } catch {}
            $mutex.Dispose()
        }
    }
}

#endregion

#region Directory Setup

function Initialize-BackupDirectories {
    param(
        [Parameter(Mandatory=$true)]
        [string]$BackupPath
    )
    
    $directories = @(
        "entra-id",
        "entra-id-device-settings",
        "conditional-access",
        "groups",
        "applications",
        "domains",
        "authentication-policies",
        "sharepoint-settings",
        "sharepoint-settings/tenant-configuration",
        "entra-id-consentpermissions/policies",
        "entra-id-consentpermissions/permissionClassifications",
        "exchange/transport-rules",
        "exchange/anti-spam-policies",
        "exchange/anti-phishing-policies",
        "exchange/malware-filter-policies",
        "exchange/connectors/inbound",
        "exchange/connectors/outbound",
        "exchange/organization-config",
        "exchange/irm-configuration",
        "exchange/ome-configuration",
        "exchange/aip-service",
        "exchange/aip-service/configuration",
        "exchange/owa-policies",
        "information-protection/sensitivity-labels",
        "information-protection/label-policies",
        "information-protection/label-policy-rules",
        "information-protection/auto-label-policies",
        "information-protection/auto-label-rules",
        "information-protection/dlp-policies",
        "information-protection/dlp-rules",
        "intune/filters",
        "intune/device-configurations",
        "intune/compliance-policies",
        "intune/app-protection",
        "intune/windows-updates",
        "intune/autopilot",
        "intune/settings-catalog",
        "intune/defender-connector",
        "intune/endpoint-security",
        "intune/platform-scripts-powershell",
        "intune/platform-scripts-bash",
        "intune/remediations",
        "intune/mobile-apps",
        "licenses",
        "logs"
    )
    
    foreach ($dir in $directories) {
        $dirPath = Join-Path $BackupPath $dir
        if (-not (Test-Path $dirPath)) {
            New-Item -ItemType Directory -Path $dirPath -Force | Out-Null
        }
    }
    
    Write-Log "Backup directories initialized" "INFO"
}

function Clear-BackupDirectory {
    param(
        [Parameter(Mandatory=$true)]
        [string]$BackupPath
    )
    
    if (Test-Path $BackupPath) {
        Write-Log "Cleaning existing backup directory (preserving logs, signin-logs, secure-score history)..." "INFO"
        Get-ChildItem -Path $BackupPath |
            Where-Object { $_.Name -notin @('logs', 'signin-logs', 'secure-score') } |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}

#endregion

#region Authentication

function Connect-M365Backup {
    param(
        [Parameter(Mandatory=$false)]
        [string]$TenantId,
        
        [Parameter(Mandatory=$false)]
        [string]$ClientId,
        
        [Parameter(Mandatory=$false)]
        [string]$ClientSecret,
        
        [Parameter(Mandatory=$false)]
        [string]$CertificateThumbprint
    )
    
    Write-Log "Connecting to Microsoft Graph..." "INFO"

    try {
        # Check if already connected to the right tenant
        $existingContext = Get-MgContext
        if ($existingContext) {
            $matchesTenant = -not $TenantId -or $existingContext.TenantId -eq $TenantId
            if ($matchesTenant) {
                Write-Log "Already connected to tenant: $($existingContext.TenantId)" "INFO"
                $script:CurrentTenantId = $existingContext.TenantId
                return $true
            }
            Write-Log "Connected to different tenant ($($existingContext.TenantId)), reconnecting to $TenantId..." "INFO"
            Disconnect-MgGraph | Out-Null
        }

        $context = $null

        # 1. Delegated auth via Config365 token API (preferred in pipeline context)
        # PORTAL_TOKEN_API_URL defaults to http://localhost:4322 if not set
        if ((Get-Command -Name Connect-M365GraphDelegated -ErrorAction SilentlyContinue) -and
            $env:PORTAL_INTERNAL_KEY -and $env:TENANT_SLUG) {

            Write-Log "Using delegated authentication via Config365 token API..." "INFO"
            $context = Connect-M365GraphDelegated
        }
        # 2. Service principal (explicit params take priority over env vars)
        elseif ($ClientId -and $ClientSecret -and $TenantId) {
            Write-Log "Using Service Principal authentication..." "INFO"
            if (Get-Command -Name Connect-M365Graph -ErrorAction SilentlyContinue) {
                $context = Connect-M365Graph -TenantId $TenantId -ClientId $ClientId -ClientSecret $ClientSecret
            }
            else {
                $secureSecret = ConvertTo-SecureString $ClientSecret -AsPlainText -Force
                $credential   = New-Object System.Management.Automation.PSCredential($ClientId, $secureSecret)
                Connect-MgGraph -TenantId $TenantId -ClientSecretCredential $credential -NoWelcome
                $context = Get-MgContext
            }
        }
        # 3. Service principal from environment variables
        elseif ((Get-Command -Name Connect-M365Graph -ErrorAction SilentlyContinue)) {
            if ($ClientId) { $env:AZURE_CLIENT_ID     = $ClientId }
            if ($ClientSecret) { $env:AZURE_CLIENT_SECRET = $ClientSecret }
            if ($TenantId) { $env:AZURE_TENANT_ID    = $TenantId }
            $context = Connect-M365Graph
        }
        else {
            throw "No authentication method available. Authenticate the tenant via the Config365 portal, or set AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID."
        }

        $script:CurrentTenantId = $context.TenantId

        $envInfo = if (Get-Command -Name Get-CurrentGraphEnvironment -ErrorAction SilentlyContinue) { Get-CurrentGraphEnvironment } else { $null }
        if ($envInfo -and $envInfo.Environment -eq "USGov") {
            Write-Log "Connected to GCC High environment (USGov)" "INFO"
        }

        Write-Log "Connected to tenant: $($script:CurrentTenantId)" "INFO"
        return $true
    }
    catch {
        Write-Log "Failed to connect to Microsoft Graph: $_" "ERROR"
        return $false
    }
}

#endregion

# Note: When dot-sourcing this file, all functions and variables are automatically available
# No Export-ModuleMember needed for dot-sourced scripts

