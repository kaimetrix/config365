<#
.SYNOPSIS
    Shared diff/comparison helpers for all configure scripts.

.DESCRIPTION
    Provides three functions used by every non-Intune configure script:
      Compare-PropertyValues  – deep semantic equality check
      Format-PropertyValue    – consistent single-value display string
      New-ChangesObject       – build the canonical Changes = @{ Modified; ModifiedValues } object

    Intune scripts use Configure-Intune-Helpers.ps1 which has its own equivalent logic.
    This file should be dot-sourced near the top of each consuming script:

        $diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
        . $diffHelpersPath
#>

# ─── Internal helpers ─────────────────────────────────────────────────────────

function _DH_IsEmpty {
    param($Value)
    return ($null -eq $Value) -or ($Value -is [System.Collections.IList] -and $Value.Count -eq 0)
}

function _DH_SortObject {
    param($Obj)
    if ($null -eq $Obj) { return $null }
    if ($Obj -is [System.Collections.IDictionary]) {
        $sorted = [ordered]@{}
        foreach ($key in ($Obj.Keys | Sort-Object)) { $sorted[$key] = _DH_SortObject $Obj[$key] }
        return $sorted
    }
    if ($Obj -is [System.Collections.IList] -and $Obj -isnot [string]) {
        return @(foreach ($item in $Obj) { _DH_SortObject $item })
    }
    if ($null -ne $Obj.PSObject -and $Obj.PSObject.Properties.Count -gt 0 -and $Obj -isnot [string]) {
        $sorted = [ordered]@{}
        foreach ($prop in ($Obj.PSObject.Properties | Where-Object { $_.MemberType -in @('NoteProperty','Property') } | Sort-Object Name)) {
            $sorted[$prop.Name] = _DH_SortObject $prop.Value
        }
        if ($sorted.Count -gt 0) { return $sorted }
    }
    return $Obj
}

function _DH_CanonicalJson {
    param($Obj)
    return (_DH_SortObject $Obj) | ConvertTo-Json -Depth 20 -Compress -ErrorAction SilentlyContinue
}

function _DH_ToHashtable {
    param($Obj)
    if ($null -eq $Obj)                              { return $null }
    if ($Obj -is [System.Collections.IDictionary])  { return $Obj }
    $hash = @{}
    if ($null -ne $Obj.PSObject) {
        foreach ($prop in $Obj.PSObject.Properties) {
            if ($prop.MemberType -in @('NoteProperty','Property')) { $hash[$prop.Name] = $prop.Value }
        }
    }
    if ($hash.Count -gt 0) { return $hash }
    return $null
}

# ─── Public functions ─────────────────────────────────────────────────────────

<#
.SYNOPSIS
    Deep semantic equality check.
    Null and empty-array are treated as equivalent.
    Arrays are compared as unordered sets.
    Objects are compared by desired keys only (extra keys in existing are ignored).
#>
function Compare-PropertyValues {
    param($Current, $New)

    $emptyC = _DH_IsEmpty $Current
    $emptyN = _DH_IsEmpty $New
    if ($emptyC -and $emptyN) { return $true }
    if ($emptyC -or  $emptyN) { return $false }

    # Single-element array vs scalar
    if ($Current -is [System.Collections.IList] -and $Current.Count -eq 1 -and $New -isnot [System.Collections.IList]) {
        return Compare-PropertyValues $Current[0] $New
    }
    if ($New -is [System.Collections.IList] -and $New.Count -eq 1 -and $Current -isnot [System.Collections.IList]) {
        return Compare-PropertyValues $Current $New[0]
    }

    # Arrays – order-independent via canonical JSON
    if ($Current -is [System.Collections.IList] -and $New -is [System.Collections.IList]) {
        if ($Current.Count -ne $New.Count) { return $false }
        $set1 = @(foreach ($i in $Current) { _DH_CanonicalJson $i })
        $set2 = [System.Collections.Generic.List[string]]@(foreach ($i in $New) { _DH_CanonicalJson $i })
        foreach ($j in $set1) {
            $idx = $set2.IndexOf($j)
            if ($idx -lt 0) { return $false }
            $set2.RemoveAt($idx)
        }
        return $true
    }

    # Primitives
    if ($Current -is [string] -or $Current -is [bool] -or $Current -is [int] -or
        $Current -is [long]   -or $Current -is [double] -or $Current -is [decimal]) {
        return $Current -eq $New
    }

    # Objects – compare only keys present in $New (desired state)
    $h1 = _DH_ToHashtable $Current
    $h2 = _DH_ToHashtable $New
    if ($null -eq $h1 -and $null -eq $h2) { return "$Current" -eq "$New" }
    if ($null -eq $h1 -or  $null -eq $h2) { return $false }
    foreach ($key in $h2.Keys) {
        $v1 = if ($h1.ContainsKey($key)) { $h1[$key] } else { $null }
        if (-not (Compare-PropertyValues $v1 $h2[$key])) { return $false }
    }
    return $true
}

<#
.SYNOPSIS
    Format a single value as a compact, readable display string.
    - $null                 → "(null)"
    - bool                  → "true" / "false"
    - string                → '"the string"'
    - array / object        → sorted compact JSON
#>
function Format-PropertyValue {
    param($Value)
    if ($null -eq $Value)                                    { return "(null)" }
    if ($Value -is [bool])                                   { return $Value.ToString().ToLower() }
    if ($Value -is [string])                                 { return "`"$Value`"" }
    if ($Value -is [System.Collections.IList] -or
        $Value -is [System.Collections.IDictionary] -or
        ($null -ne $Value.PSObject -and $Value.PSObject.Properties.Count -gt 0 -and $Value -isnot [string])) {
        $json = _DH_CanonicalJson $Value
        if ($json) { return $json }
    }
    return "$Value"
}

<#
.SYNOPSIS
    Build the canonical Changes object used by the WhatIf pipeline.

.PARAMETER Existing
    The current state object/hashtable as returned by the API.

.PARAMETER Desired
    The desired state object/hashtable from the baseline config.

.PARAMETER Keys
    Optional explicit list of property names to compare.
    If omitted, all keys present in $Desired are compared.

.OUTPUTS
    Hashtable: @{ Modified = @(...); ModifiedValues = @{...} }
    - Modified      : array of truncated human-readable change strings
    - ModifiedValues: hashtable of key → @{ Existing = "full"; Desired = "full" }
                      populated only for values whose display string exceeds 60 chars
#>
function New-ChangesObject {
    param(
        $Existing,
        $Desired,
        [string[]]$Keys = $null
    )

    $modified       = @()
    $modifiedValues = @{}

    # Resolve the set of keys to compare, excluding internal metadata properties (_SourceFile, etc.)
    $compareKeys = if ($Keys) { $Keys } else {
        $dHash = _DH_ToHashtable $Desired
        if ($dHash) { @($dHash.Keys) } else { @() }
    }
    $compareKeys = @($compareKeys | Where-Object { $_ -notlike '_*' })

    $eHash = _DH_ToHashtable $Existing

    foreach ($key in $compareKeys) {
        $currentVal = if ($eHash -and $eHash.ContainsKey($key)) { $eHash[$key] } else { $null }
        if ($Desired -is [System.Collections.IDictionary]) { $desiredVal = $Desired[$key] } else { $desiredVal = $Desired.$key }

        if (-not (Compare-PropertyValues -Current $currentVal -New $desiredVal)) {
            $existStr  = Format-PropertyValue $currentVal
            $desiredStr = Format-PropertyValue $desiredVal

            # Store full values when either is long (enables expandable UI)
            if ($existStr.Length -gt 60 -or $desiredStr.Length -gt 60) {
                $modifiedValues[$key] = @{ Existing = $existStr; Desired = $desiredStr }
            }

            # Truncated summary line
            $eSummary = if ($existStr.Length  -gt 60) { $existStr.Substring(0, 57)  + "..." } else { $existStr }
            $dSummary = if ($desiredStr.Length -gt 60) { $desiredStr.Substring(0, 57) + "..." } else { $desiredStr }
            $modified += "$key`: '$eSummary' → '$dSummary'"
        }
    }

    return @{
        Modified       = $modified
        ModifiedValues = $modifiedValues
    }
}

# ─── Field-monitor helpers ─────────────────────────────────────────────────────

<#
.SYNOPSIS
    Internal helper — parses a single .monitor.json file into a hashtable.
    Returns @{ Include=@(...); Exclude=@(...) } or $null if absent/invalid.
#>
function _ReadMonitorConfigFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        $raw    = Get-Content $Path -Raw -ErrorAction Stop
        $parsed = $raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        $result = @{}
        if ($parsed.ContainsKey('include') -and $parsed['include'].Count -gt 0) {
            $result['Include'] = @($parsed['include'])
        }
        if ($parsed.ContainsKey('exclude') -and $parsed['exclude'].Count -gt 0) {
            $result['Exclude'] = @($parsed['exclude'])
        }
        if ($result.Count -eq 0) { return $null }
        return $result
    }
    catch {
        Write-Host "##[warning]Failed to read monitor config at $Path`: $_"
        return $null
    }
}

<#
.SYNOPSIS
    Merges a per-file monitor config with a folder-level default.

.DESCRIPTION
    Both configs are active simultaneously. The file-level config wins on conflicts:
    - Folder include entries blocked by a file-level exclude are dropped.
    - Folder exclude entries blocked by a file-level include are dropped.
    Pure additions from either side are always kept. Returns $null when the
    merged result has no active rules.
#>
function Merge-MonitorConfigs {
    param(
        [hashtable]$FileConfig,
        [hashtable]$FolderConfig
    )
    if (-not $FileConfig -and -not $FolderConfig) { return $null }
    if (-not $FileConfig)   { return $FolderConfig }
    if (-not $FolderConfig) { return $FileConfig }

    $fInc = if ($FileConfig.ContainsKey('Include'))   { @($FileConfig['Include'])   } else { @() }
    $fExc = if ($FileConfig.ContainsKey('Exclude'))   { @($FileConfig['Exclude'])   } else { @() }
    $dInc = if ($FolderConfig.ContainsKey('Include')) { @($FolderConfig['Include']) } else { @() }
    $dExc = if ($FolderConfig.ContainsKey('Exclude')) { @($FolderConfig['Exclude']) } else { @() }

    $mergedInc = @($fInc + ($dInc | Where-Object { $_ -notin $fExc })) | Select-Object -Unique
    $mergedExc = @($fExc + ($dExc | Where-Object { $_ -notin $fInc })) | Select-Object -Unique

    $result = @{}
    if ($mergedInc.Count -gt 0) { $result['Include'] = $mergedInc }
    if ($mergedExc.Count -gt 0) { $result['Exclude'] = $mergedExc }
    if ($result.Count -gt 0) { return $result }
    return $null
}

<#
.SYNOPSIS
    Reads the effective field-monitoring config for a baseline policy file.

.DESCRIPTION
    Loads the per-file <basename>.monitor.json sidecar AND the folder-level
    _default.monitor.json (if present) and merges them. File-level settings
    take priority over folder-level settings on any conflict. Returns a
    hashtable with optional 'Include' and 'Exclude' string arrays, or $null
    when no monitoring is configured.

.PARAMETER BaselineFilePath
    Full path to the baseline policy JSON file.
#>
function Get-MonitorConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaselineFilePath
    )
    $sidecarPath   = [System.IO.Path]::ChangeExtension($BaselineFilePath, '.monitor.json')
    $folderDefault = Join-Path ([System.IO.Path]::GetDirectoryName($BaselineFilePath)) '_default.monitor.json'
    $fileConfig    = _ReadMonitorConfigFile $sidecarPath
    $folderConfig  = _ReadMonitorConfigFile $folderDefault
    return Merge-MonitorConfigs -FileConfig $fileConfig -FolderConfig $folderConfig
}

<#
.SYNOPSIS
    Filters a policy object to only the fields specified in a monitor config.

.DESCRIPTION
    Applies include/exclude rules from a monitor config (as returned by Get-MonitorConfig)
    to a policy hashtable. Supports dot-notation paths (e.g. "conditions.users").

    - Include: keep only the listed paths (all others are removed).
    - Exclude: remove the listed paths (all others are kept).
    Both can be combined.

    Returns a new (filtered) ordered hashtable. The original is not mutated.

.PARAMETER PolicyObject
    The policy object/hashtable to filter.

.PARAMETER MonitorConfig
    The monitor config hashtable from Get-MonitorConfig.
#>
function Apply-MonitorFilter {
    param(
        [Parameter(Mandatory = $true)]
        $PolicyObject,

        [Parameter(Mandatory = $true)]
        [hashtable]$MonitorConfig
    )

    # If the policy is an array, apply the filter element-by-element
    if ($PolicyObject -is [System.Collections.IEnumerable] -and $PolicyObject -isnot [string] -and $PolicyObject -isnot [System.Collections.IDictionary]) {
        return @($PolicyObject | ForEach-Object { Apply-MonitorFilter -PolicyObject $_ -MonitorConfig $MonitorConfig })
    }

    # Convert to hashtable for uniform access
    $hash = _DH_ToHashtable $PolicyObject
    if ($null -eq $hash) { return $PolicyObject }

    # Deep-clone via JSON round-trip so we never mutate the original
    $json = $hash | ConvertTo-Json -Depth 20 -ErrorAction SilentlyContinue
    $clone = $json | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
    if ($null -eq $clone) { return $PolicyObject }

    # Helper: get nested value by dot-notation path
    function _MF_Get {
        param($Obj, [string[]]$Parts)
        $cur = $Obj
        foreach ($part in $Parts) {
            if ($null -eq $cur -or -not ($cur -is [System.Collections.IDictionary]) -or -not $cur.ContainsKey($part)) { return $null }
            $cur = $cur[$part]
        }
        return $cur
    }

    # Helper: set nested value by dot-notation path (creates intermediate dicts)
    function _MF_Set {
        param($Obj, [string[]]$Parts, $Value)
        $cur = $Obj
        for ($i = 0; $i -lt $Parts.Count - 1; $i++) {
            $part = $Parts[$i]
            if (-not $cur.ContainsKey($part) -or -not ($cur[$part] -is [System.Collections.IDictionary])) {
                $cur[$part] = [ordered]@{}
            }
            $cur = $cur[$part]
        }
        $cur[$Parts[-1]] = $Value
    }

    # Helper: delete nested key by dot-notation path
    function _MF_Delete {
        param($Obj, [string[]]$Parts)
        $cur = $Obj
        for ($i = 0; $i -lt $Parts.Count - 1; $i++) {
            $part = $Parts[$i]
            if ($null -eq $cur -or -not ($cur -is [System.Collections.IDictionary]) -or -not $cur.ContainsKey($part)) { return }
            $cur = $cur[$part]
        }
        if ($cur -is [System.Collections.IDictionary]) { $cur.Remove($Parts[-1]) | Out-Null }
    }

    $result = $clone

    if ($MonitorConfig.ContainsKey('Include') -and $MonitorConfig['Include'].Count -gt 0) {
        $filtered = [ordered]@{}
        foreach ($path in $MonitorConfig['Include']) {
            $parts = $path -split '\.'
            $val = _MF_Get $clone $parts
            if ($null -ne $val) { _MF_Set $filtered $parts $val }
        }
        $result = $filtered
    }

    if ($MonitorConfig.ContainsKey('Exclude') -and $MonitorConfig['Exclude'].Count -gt 0) {
        foreach ($path in $MonitorConfig['Exclude']) {
            $parts = $path -split '\.'
            _MF_Delete $result $parts
        }
    }

    return $result
}
