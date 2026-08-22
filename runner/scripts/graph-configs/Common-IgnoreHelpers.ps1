<#
.SYNOPSIS
    Shared helper functions for baseline ignore functionality
    
.DESCRIPTION
    Provides functions to read and match patterns from .baseline-ignore files.
    Supports gitignore-style patterns including wildcards (* and **).
    
.NOTES
    This module should be dot-sourced by Configure-*.ps1 scripts.
#>

# ============================================================================
# GLOBAL IGNORE STATE
# ============================================================================

# Cache the ignore patterns once loaded
$script:BaselineIgnorePatterns = $null
$script:BaselineIgnoreLoaded = $false

$tenantGroupsHelpersPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'common\Common-TenantGroups.ps1'
if (Test-Path $tenantGroupsHelpersPath) {
    . $tenantGroupsHelpersPath
}

# Apply scope (allowlist) — $null means unrestricted; @(paths) means only those files
$script:BaselineApplyScope = $null
$script:BaselineApplyScopeLoaded = $false

# ============================================================================
# FUNCTIONS
# ============================================================================

function Initialize-BaselineIgnore {
    <#
    .SYNOPSIS
        Loads ignore patterns from .baseline-ignore and optionally .baseline-skip-<BuildId>
        
    .PARAMETER TenantRepoPath
        Path to the tenant's own repository root (contains .baseline-ignore)
        This is the tenant-specific repo (e.g., tenant-careforsons), NOT baseline.
        
    .PARAMETER TenantBaselinePath
        DEPRECATED: Use TenantRepoPath instead. Kept for backward compatibility.

    .PARAMETER BuildId
        Azure DevOps Build ID. If provided, patterns from .baseline-skip-<BuildId>
        in the tenant repo are also loaded. Defaults to the BUILD_BUILDID environment
        variable when not explicitly supplied.
        
    .EXAMPLE
        Initialize-BaselineIgnore -TenantRepoPath "C:\repos\tenant-pit"
        Initialize-BaselineIgnore -TenantRepoPath "C:\repos\tenant-pit" -BuildId "12345"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$false)]
        [string]$TenantRepoPath,
        
        [Parameter(Mandatory=$false)]
        [string]$TenantBaselinePath,  # Deprecated, for backward compatibility

        [Parameter(Mandatory=$false)]
        [string]$BuildId = $(if ($env:GITEA_RUN_ID) { $env:GITEA_RUN_ID } else { $env:BUILD_BUILDID })
    )
    
    # Reset state
    $script:BaselineIgnorePatterns = @()
    $script:BaselineIgnoreLoaded = $true
    
    # Use TenantRepoPath if provided, fall back to TenantBaselinePath for backward compatibility
    $ignoreSearchPath = if ($TenantRepoPath) { $TenantRepoPath } else { $TenantBaselinePath }
    
    if (-not $ignoreSearchPath) {
        Write-Host "  [Ignore] No TenantRepoPath provided, ignore filtering disabled" -ForegroundColor DarkGray
        return
    }

    # Helper: load patterns from a file into $script:BaselineIgnorePatterns
    function Load-PatternsFromFile {
        param([string]$FilePath, [string]$Label)
        if (-not (Test-Path $FilePath)) { return }
        Write-Host "##[section]Loading baseline ignore patterns from: $FilePath ($Label)"
        $lines = Get-Content $FilePath -ErrorAction SilentlyContinue
        $count = 0
        foreach ($line in $lines) {
            $line = $line.Trim()
            if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
            $pattern = $line -replace '\\', '/'
            $script:BaselineIgnorePatterns += $pattern
            Write-Host "  + Pattern: $pattern" -ForegroundColor DarkGray
            $count++
        }
        if ($count -gt 0) {
            Write-Host "  Loaded $count pattern(s) from $Label" -ForegroundColor Cyan
        }
    }
    
    # Load permanent ignore patterns
    $ignoreFilePath = Join-Path $ignoreSearchPath ".baseline-ignore"
    if (-not (Test-Path $ignoreFilePath)) {
        Write-Host "  [Ignore] No .baseline-ignore file found at: $ignoreFilePath" -ForegroundColor DarkGray
    } else {
        Load-PatternsFromFile -FilePath $ignoreFilePath -Label ".baseline-ignore"
    }

    # Load run-scoped skip patterns when a BuildId is available
    if ($BuildId) {
        $skipFilePath = Join-Path $ignoreSearchPath ".baseline-skip-$BuildId"
        if (Test-Path $skipFilePath) {
            Load-PatternsFromFile -FilePath $skipFilePath -Label ".baseline-skip-$BuildId"
        }
    }

    if ($script:BaselineIgnorePatterns.Count -gt 0) {
        Write-Host "  Total: $($script:BaselineIgnorePatterns.Count) active ignore pattern(s)" -ForegroundColor Cyan
    }

    # When running in apply mode (GITEA_RUN_ID is set but -WhatIf is not),
    # auto-load the plan-scoped allowlist written during the plan job.
    if ($env:GITEA_RUN_ID -and $TenantRepoPath -and -not $WhatIfPreference) {
        Initialize-BaselineApply -TenantRepoPath $TenantRepoPath -RunId $env:GITEA_RUN_ID
    }
}

function Initialize-BaselineApply {
    <#
    .SYNOPSIS
        Loads the plan-scoped apply allowlist from .baseline-apply-<RunId> in the tenant repo.

    .DESCRIPTION
        Written by the pipeline's plan summary step, this file contains the baseline-relative
        paths of every file that had a pending change (WouldCreate / WouldUpdate / WouldRemove)
        in the WhatIf plan. During the apply job, Get-FilteredPolicyFiles will restrict
        processing to only files present in this list.

    .PARAMETER TenantRepoPath
        Path to the tenant repo root (same value passed to Initialize-BaselineIgnore).

    .PARAMETER RunId
        Gitea run ID. Defaults to $env:GITEA_RUN_ID.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$TenantRepoPath,

        [Parameter(Mandatory=$false)]
        [string]$RunId = $env:GITEA_RUN_ID
    )

    if ([string]::IsNullOrWhiteSpace($RunId)) { return }

    $scopeFile = Join-Path $TenantRepoPath ".baseline-apply-$RunId"
    if (-not (Test-Path $scopeFile)) {
        Write-Host "  [ApplyScope] No scope file found at: $scopeFile — all plan-passing files will be processed" -ForegroundColor DarkGray
        return
    }

    $lines = Get-Content $scopeFile -ErrorAction SilentlyContinue |
             Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and -not $_.StartsWith('#') }

    $script:BaselineApplyScope = @($lines | ForEach-Object { $_.Replace('\', '/').Trim() })
    $script:BaselineApplyScopeLoaded = $true
    if ($script:BaselineApplyScope.Count -gt 0) {
        Write-Host "##[section]Plan-scoped apply: loaded $($script:BaselineApplyScope.Count) file(s) from: $scopeFile" -ForegroundColor Cyan
    } else {
        Write-Host "##[section]Plan-scoped apply: empty scope from: $scopeFile — no baseline files will be processed" -ForegroundColor Cyan
    }
}

function Test-BaselineFileInApplyScope {
    <#
    .SYNOPSIS
        Returns $true when the baseline-relative file should be processed in plan-scoped apply mode.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$BaselineRoot
    )

    if (-not $script:BaselineApplyScopeLoaded -or $null -eq $script:BaselineApplyScope) {
        return $true
    }

    $normalizedRoot = $BaselineRoot.TrimEnd('\', '/').Replace('\', '/') + '/'
    $relPath = $FilePath.Replace('\', '/')
    if ($relPath.StartsWith($normalizedRoot)) {
        $relPath = $relPath.Substring($normalizedRoot.Length)
    }
    return $script:BaselineApplyScope -contains $relPath
}

function Test-PolicyIgnored {
    <#
    .PARAMETER PolicyPath
        The file path of the policy (can be full path or relative)
        
    .PARAMETER BaselineRoot
        The root path of the baseline folder (used to calculate relative path)
        
    .OUTPUTS
        Returns $true if the policy should be ignored, $false otherwise
        
    .EXAMPLE
        if (Test-PolicyIgnored -PolicyPath "C:\repos\baseline\intune\policy.json" -BaselineRoot "C:\repos\baseline") {
            Write-Host "Policy is ignored"
        }
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$PolicyPath,
        
        [Parameter(Mandatory=$true)]
        [string]$BaselineRoot
    )
    
    # If not initialized or no patterns, don't ignore anything
    if (-not $script:BaselineIgnoreLoaded -or $script:BaselineIgnorePatterns.Count -eq 0) {
        return $false
    }
    
    # Calculate relative path from baseline root
    $normalizedPolicyPath = $PolicyPath -replace '\\', '/'
    $normalizedBaselineRoot = $BaselineRoot.TrimEnd('\', '/') -replace '\\', '/'
    
    # Get relative path
    $relativePath = $normalizedPolicyPath
    if ($normalizedPolicyPath.StartsWith($normalizedBaselineRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relativePath = $normalizedPolicyPath.Substring($normalizedBaselineRoot.Length).TrimStart('/')
    }
    
    # Also get just the filename for simple pattern matching
    $fileName = Split-Path $PolicyPath -Leaf
    
    # Build list of path variations to try matching (with and without baseline/ prefix)
    $pathsToTry = @($relativePath)
    
    # If relativePath starts with baseline/, also try without it
    if ($relativePath -like 'baseline/*') {
        $pathsToTry += $relativePath.Substring(9)  # Remove "baseline/" prefix
    }
    # If relativePath doesn't start with baseline/, also try with it
    else {
        $pathsToTry += "baseline/$relativePath"
    }
    
    foreach ($pattern in $script:BaselineIgnorePatterns) {
        # Build list of pattern variations (with and without baseline/ prefix)
        $patternsToTry = @($pattern)
        
        if ($pattern -like 'baseline/*') {
            $patternsToTry += $pattern.Substring(9)  # Remove "baseline/" prefix
        }
        elseif ($pattern.Contains('/')) {
            # Only add baseline/ prefix if pattern has a path component
            $patternsToTry += "baseline/$pattern"
        }
        
        # Try all combinations of paths and patterns
        foreach ($pathToTry in $pathsToTry) {
            foreach ($patternToTry in $patternsToTry) {
                if (Test-PatternMatch -Path $pathToTry -Pattern $patternToTry -FileName $fileName) {
                    return $true
                }
            }
        }
    }
    
    return $false
}

function Test-PatternMatch {
    <#
    .SYNOPSIS
        Tests if a path matches a gitignore-style pattern
        
    .PARAMETER Path
        The relative path to test (using forward slashes)
        
    .PARAMETER Pattern
        The pattern to match against
        
    .PARAMETER FileName
        The filename portion of the path
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$Path,
        
        [Parameter(Mandatory=$true)]
        [string]$Pattern,
        
        [Parameter(Mandatory=$true)]
        [string]$FileName
    )
    
    # Normalize for comparison (case-insensitive on Windows)
    $pathLower = $Path.ToLowerInvariant()
    $patternLower = $Pattern.ToLowerInvariant()
    $fileNameLower = $FileName.ToLowerInvariant()
    
    # If pattern has no path separator, match against filename only
    if (-not $patternLower.Contains('/')) {
        return Test-WildcardMatch -Text $fileNameLower -Pattern $patternLower
    }
    
    # Pattern has path separator - match against full relative path
    return Test-WildcardMatch -Text $pathLower -Pattern $patternLower
}

function Test-WildcardMatch {
    <#
    .SYNOPSIS
        Tests if text matches a wildcard pattern
        Supports * (any characters except /) and ** (any characters including /)
        
    .PARAMETER Text
        The text to test
        
    .PARAMETER Pattern
        The pattern with wildcards
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$Text,
        
        [Parameter(Mandatory=$true)]
        [string]$Pattern
    )
    
    # Convert gitignore-style pattern to regex
    # Escape regex special characters first (except * which we handle specially)
    $regexPattern = [regex]::Escape($Pattern)
    
    # Now handle our wildcards (they were escaped, so \* and \*\*)
    # Replace ** first (matches anything including /)
    $regexPattern = $regexPattern -replace '\\\*\\\*', '.*'
    
    # Replace remaining * (matches anything except /)
    $regexPattern = $regexPattern -replace '\\\*', '[^/]*'
    
    # Anchor the pattern
    $regexPattern = "^$regexPattern$"
    
    try {
        return $Text -match $regexPattern
    }
    catch {
        Write-Warning "Invalid pattern regex: $Pattern -> $regexPattern"
        return $false
    }
}

function Get-FilteredPolicyFiles {
    <#
    .SYNOPSIS
        Filters a list of policy files, removing those that match ignore patterns
        
    .PARAMETER PolicyFiles
        Array of FileInfo objects representing policy files
        
    .PARAMETER BaselineRoot
        The root path of the baseline folder
        
    .PARAMETER Silent
        If specified, don't log ignored files
        
    .OUTPUTS
        Array of FileInfo objects that should be processed (not ignored)
        
    .EXAMPLE
        $policyFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json"
        # Use baseline folder root (parent of groups/, intune/, etc.) so patterns work correctly
        $baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }
        $filteredFiles = Get-FilteredPolicyFiles -PolicyFiles $policyFiles -BaselineRoot $baselineRoot
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$false)]
        [System.IO.FileInfo[]]$PolicyFiles = @(),
        
        [Parameter(Mandatory=$true)]
        [string]$BaselineRoot,
        
        [Parameter(Mandatory=$false)]
        [switch]$Silent
    )
    
    # Fast path: no ignore patterns AND no scope loaded — nothing to filter
    $hasIgnorePatterns = $script:BaselineIgnoreLoaded -and $script:BaselineIgnorePatterns.Count -gt 0
    $hasScopeFilter    = $script:BaselineApplyScopeLoaded -and $null -ne $script:BaselineApplyScope

    if (-not $hasIgnorePatterns -and -not $hasScopeFilter) {
        return $PolicyFiles
    }

    # Apply .baseline-ignore filter (skip if no patterns loaded)
    $filteredFiles = if ($hasIgnorePatterns) {
        $ignoredCount = 0
        $kept = @()
        foreach ($file in $PolicyFiles) {
            if (Test-PolicyIgnored -PolicyPath $file.FullName -BaselineRoot $BaselineRoot) {
                $ignoredCount++
                if (-not $Silent) {
                    $relativePath = $file.FullName.Substring($BaselineRoot.Length).TrimStart('\', '/')
                    Write-Host "  [IGNORED] $relativePath" -ForegroundColor DarkYellow
                }
            }
            else {
                $kept += $file
            }
        }
        if ($ignoredCount -gt 0 -and -not $Silent) {
            Write-Host "  Ignored $ignoredCount file(s) based on .baseline-ignore patterns" -ForegroundColor Yellow
        }
        $kept
    } else {
        @($PolicyFiles)
    }

    # Apply plan-scoped allowlist: when a .baseline-apply-{RunId} scope was loaded,
    # restrict processing to only the files that had pending changes in the WhatIf plan.
    if ($hasScopeFilter) {
        $scopedFiles = @()
        $scopedSkipCount = 0
        foreach ($file in $filteredFiles) {
            $normalizedRoot = $BaselineRoot.TrimEnd('\', '/').Replace('\', '/') + '/'
            $relPath = $file.FullName.Replace('\', '/') -replace [regex]::Escape($normalizedRoot), ''
            if ($script:BaselineApplyScope -contains $relPath) {
                $scopedFiles += $file
            } else {
                $scopedSkipCount++
                if (-not $Silent) {
                    Write-Host "  [PLAN-SCOPE] Skipping (not in approved plan): $relPath" -ForegroundColor DarkGray
                }
            }
        }
        if ($scopedSkipCount -gt 0 -and -not $Silent) {
            Write-Host "  Plan-scoped apply: skipped $scopedSkipCount unchanged file(s)" -ForegroundColor DarkCyan
        }
        return $scopedFiles
    }

    return $filteredFiles
}

# ============================================================================
# CONFIG365 OPTIONS
# ============================================================================

# Global variable for options
$script:CONFIG365Options = $null

function Get-CONFIG365Options {
    <#
    .SYNOPSIS
        Loads and returns CONFIG365 configuration options
        
    .DESCRIPTION
        Reads options from om365do-options.json in the CONFIG365 repo root.
        Caches the result for subsequent calls.
        
    .OUTPUTS
        PSObject with configuration options
    #>
    [CmdletBinding()]
    param()
    
    if ($null -eq $script:CONFIG365Options) {
        # Try to find the options file relative to this script
        $optionsPath = Join-Path $PSScriptRoot "..\..\om365do-options.json"
        
        if (Test-Path $optionsPath) {
            try {
                $script:CONFIG365Options = Get-Content $optionsPath -Raw | ConvertFrom-Json
                Write-Verbose "Loaded CONFIG365 options from: $optionsPath"
            }
            catch {
                Write-Warning "Failed to parse om365do-options.json: $_"
                $script:CONFIG365Options = $null
            }
        }
        
        # Use defaults if file not found or failed to parse
        if ($null -eq $script:CONFIG365Options) {
            $script:CONFIG365Options = [PSCustomObject]@{
                protectionMarker = "CONFIG365:IGNORE"
                protectionMarkerEnabled = $true
            }
            Write-Verbose "Using default CONFIG365 options (no options file found)"
        }
    }
    
    return $script:CONFIG365Options
}

function Test-ResourceProtected {
    <#
    .SYNOPSIS
        Tests if a resource is protected from baseline updates
        
    .DESCRIPTION
        Checks if the resource's description contains the protection marker.
        Resources with the marker will be skipped during deployment.
        
    .PARAMETER Description
        The description field of the resource to check
        
    .OUTPUTS
        Returns $true if the resource should be protected (not updated)
        
    .EXAMPLE
        if (Test-ResourceProtected -Description $existingGroup.Description) {
            Write-Host "Group is protected - skipping"
        }
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$false)]
        [string]$Description
    )
    
    $options = Get-CONFIG365Options
    
    # Check if protection is enabled
    if (-not $options.protectionMarkerEnabled) { 
        return $false 
    }
    
    # No description means not protected
    if ([string]::IsNullOrWhiteSpace($Description)) { 
        return $false 
    }
    
    $markers = @(
        $options.protectionMarker,
        'CONFIG365:IGNORE',
        'OM365DO:IGNORE'
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

    $desc = $Description.ToUpperInvariant()
    foreach ($marker in $markers) {
        if ($desc.Contains(([string]$marker).ToUpperInvariant())) { return $true }
    }
    return $false
}

function Get-GroupExcludedFiles {
<#
.SYNOPSIS
    Filters a list of policy files by removing those that belong exclusively to
    config groups the current tenant is NOT a member of.

.DESCRIPTION
    Reads groups-config.json from the baseline checkout and resolves tenant
    membership via Get-ResolvedTenantGroupMembership (same logic as
    Resolve-TenantGroups.ps1, including dynamic license rules). For every group
    the tenant is NOT a member of, collects its content.folders,
    content.filePatterns, and content.files rules and removes matching files
    from the supplied list.

    Called by every Configure-*.ps1 after Get-FilteredPolicyFiles.

.PARAMETER Files
    FileInfo objects returned by Get-ChildItem / Get-FilteredPolicyFiles.

.PARAMETER TenantBaselinePath
    Path to the checked-out baseline repo root (already passed to every
    Configure-*.ps1 as $TenantBaselinePath).

.PARAMETER TenantRepoPath
    Path to the checked-out tenant repo root (already passed to every
    Configure-*.ps1 as $TenantRepoPath).
#>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Files,
        [string] $TenantBaselinePath,
        [string] $TenantRepoPath
    )

    # Nothing to do if parameters were not supplied (backward-compat with callers
    # that don't yet pass them, or when running outside a full pipeline context).
    if ([string]::IsNullOrWhiteSpace($TenantBaselinePath) -or
        [string]::IsNullOrWhiteSpace($TenantRepoPath)) {
        return $Files
    }

    $groupsConfigPath = Join-Path $TenantBaselinePath 'groups-config.json'
    if (-not (Test-Path $groupsConfigPath)) { return $Files }

    $groupsConfig = Get-Content $groupsConfigPath -Raw | ConvertFrom-Json
    # Unwrap { "groups": { ... } } format written by the WEB app baseline viewer
    if ($groupsConfig.PSObject.Properties['groups'] -and $groupsConfig.groups -is [PSCustomObject]) {
        $groupsConfig = $groupsConfig.groups
    }

    $tenantGroups = @(Get-ResolvedTenantGroupMembership -BaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
    Write-Verbose "Get-GroupExcludedFiles: Tenant member group(s): $($tenantGroups -join ', ')"

    $baselineContent = Join-Path $TenantBaselinePath 'baseline'

    # Collect exclusion rules from groups the tenant is NOT a member of
    $excFolders  = [System.Collections.Generic.List[string]]::new()
    $excPatterns = [System.Collections.Generic.List[string]]::new()
    $excFiles    = [System.Collections.Generic.List[string]]::new()

    foreach ($gName in $groupsConfig.PSObject.Properties.Name) {
        if ($tenantGroups -contains $gName) { continue }
        $gDef = $groupsConfig.$gName

        foreach ($folder in @($gDef.content.folders)) {
            if ([string]::IsNullOrWhiteSpace($folder)) { continue }
            $full = (Join-Path $baselineContent $folder).Replace('\', '/')
            if (-not $excFolders.Contains($full)) { $excFolders.Add($full) }
        }
        foreach ($pattern in @($gDef.content.filePatterns)) {
            if ([string]::IsNullOrWhiteSpace($pattern)) { continue }
            if (-not $excPatterns.Contains($pattern)) { $excPatterns.Add($pattern) }
        }
        foreach ($filePath in @($gDef.content.files)) {
            if ([string]::IsNullOrWhiteSpace($filePath)) { continue }
            $full = (Join-Path $baselineContent $filePath).Replace('\', '/')
            if (-not $excFiles.Contains($full)) { $excFiles.Add($full) }
        }
    }

    if ($excFolders.Count -eq 0 -and $excPatterns.Count -eq 0 -and $excFiles.Count -eq 0) {
        return $Files
    }

    $nonMemberGroups = @($groupsConfig.PSObject.Properties.Name | Where-Object { $tenantGroups -notcontains $_ })
    Write-Host "Get-GroupExcludedFiles: tenant groups [$($tenantGroups -join ', ')] — excluding content owned only by [$($nonMemberGroups -join ', ')]"

    $baselineContentNorm = $baselineContent.Replace('\', '/') + '/'
    $kept = [System.Collections.Generic.List[object]]::new()
    $skipped = [System.Collections.Generic.List[string]]::new()

    foreach ($file in @($Files)) {
        $full = $file.FullName.Replace('\', '/')
        $rel  = $full.Replace($baselineContentNorm, '')
        $drop = $false

        foreach ($f in $excFolders) {
            if ($full.StartsWith($f + '/') -or $full -eq $f) { $drop = $true; break }
        }
        if (-not $drop) {
            foreach ($p in $excPatterns) {
                if ($p -notlike '*/*') {
                    if ($file.Name -like $p) { $drop = $true; break }
                } else {
                    if ($rel -like $p) { $drop = $true; break }
                }
            }
        }
        if (-not $drop -and $excFiles -contains $full) { $drop = $true }

        if ($drop) {
            $skipped.Add($(if ($rel) { $rel } else { $file.Name }))
        } else {
            $kept.Add($file)
        }
    }

    if ($skipped.Count -gt 0) {
        Write-Host "  Skipped $($skipped.Count) baseline file(s) (tenant is not in the owning config group):"
        foreach ($name in $skipped) {
            Write-Host "    - $name"
        }
    }

    return @($kept)
}

# Note: This file is meant to be dot-sourced (. $path), not imported as a module.
# All functions above will be available in the calling script's scope after dot-sourcing.

