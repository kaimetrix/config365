<#
.SYNOPSIS
    Creates and manages Intune Uploaded ADMX Definition Files via Microsoft Graph API

.DESCRIPTION
    Handles importing (uploading) custom ADMX policy definition files into Intune.
    Each baseline entry is a JSON metadata file with companion .admx and .adml files.

    Companion file layout in the baseline folder:
        {Name}.json          - Metadata (displayName, description, fileName, languageCodes, version)
        {Name}.admx          - ADMX XML content (plain text, encoded at deploy time)
        {Name}.en-US.adml    - English ADML resource file
        {Name}.{lang}.adml   - Additional language ADML files (optional)

    Update detection:
        - ADMX content:    Only re-uploaded when the 'revision' attribute in the local ADMX XML
                           differs from the 'version' field in the JSON metadata. File bytes are
                           not retrievable from the Graph API — content comparison is not possible.
        - Language files:  Sent inline on the initial Create (matches Intune portal HAR). For an
                           ADMX that is already 'available' in the tenant we do NOT call
                           /updateLanguageFiles — that endpoint is gated by a backend feature flag
                           and returns 5xx on most tenants, and language files only affect admin-UI
                           localization, not policy enforcement. An uploadNewVersion replaces them
                           when the revision changes.

    After processing, this module populates $script:UploadedADMXCache with a mapping of
        fileName -> uploadedDefinitionFileId
    which is consumed by Configure-Intune-GroupPolicyConfigurations.ps1 to resolve
    definition IDs for policies that reference imported ADMX files.

    This module is called by the main Configure-Intune.ps1 orchestrator.

.PARAMETER PolicyConfigs
    Array of policy configuration objects to process (loaded from *.json files)

.PARAMETER WhatIfMode
    Show what would be changed without making changes

.NOTES
    API: https://graph.microsoft.com/beta/deviceManagement/groupPolicyUploadedDefinitionFiles
    Required permission: DeviceManagementConfiguration.ReadWrite.All

    API actions used:
        Create:         POST /groupPolicyUploadedDefinitionFiles  (content + language files inline)
        Version update: POST /groupPolicyUploadedDefinitionFiles/{id}/uploadNewVersion
        Remove:         POST /groupPolicyUploadedDefinitionFiles/{id}/remove
                        (Intune portal uses this action, not DELETE — queues removalInProgress)
        Delete:         DELETE /groupPolicyUploadedDefinitionFiles/{id} (documented but often 400;
                        strict replace uses /remove per portal HAR and Graph remove action)

    Strict replace (when uploadNewVersion returns FeatureDisabled):
        1. Clear definitionValues on dependent Group Policy Configurations
        2. POST .../remove on old uploaded ADMX
        2b. Wait-ADMXRemoved (poll until status is not removalInProgress)
        3. CREATE new upload with baseline .admx + .adml
        4. GPC module redeploys settings from baseline (separate step)
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [array]$PolicyConfigs,

    [Parameter(Mandatory=$false)]
    [array]$AllPolicyConfigs = @(),

    [Parameter(Mandatory=$false)]
    [switch]$WhatIfMode
)

# Always load helpers (required when called from orchestrator with & operator)
$helpersPath = Join-Path $PSScriptRoot "Configure-Intune-Helpers.ps1"
. $helpersPath

# Load common ignore helpers for protection marker support
$ignoreHelpersPath = Join-Path $PSScriptRoot "..\Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

$admxBaseUri = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyUploadedDefinitionFiles"

# Dot-source GPC helpers (Clear-GroupPolicyConfigurationsForAdmx) without running GPC entry point.
# GPC shares the $PolicyConfigs param name — dot-sourcing with @() would clobber this module's
# incoming policies unless we save/restore around the dot-source.
$gpcModulePath = Join-Path $PSScriptRoot "Configure-Intune-GroupPolicyConfigurations.ps1"
if (Test-Path $gpcModulePath) {
    $savedPolicyConfigsForGpcDotSource = $PolicyConfigs
    . $gpcModulePath -PolicyConfigs @()
    $PolicyConfigs = $savedPolicyConfigsForGpcDotSource
}

# ============================================================================
# ADMX-SPECIFIC HELPERS
# ============================================================================

function ConvertTo-AdmxVersion {
    param([string]$Revision)
    if ([string]::IsNullOrWhiteSpace($Revision)) { return $null }
    try { return [version]$Revision }
    catch {
        try { return [version]($Revision -replace '^(\d+)$', '$1.0') } catch { return $null }
    }
}

function Get-EffectiveBaselineAdmxRevision {
    param([string]$BaselineRev, [string]$LocalRevision)
    $best = $null
    foreach ($r in @($BaselineRev, $LocalRevision)) {
        if ([string]::IsNullOrWhiteSpace($r)) { continue }
        $v = ConvertTo-AdmxVersion -Revision $r
        if (-not $v) { continue }
        if (-not $best -or $v -gt $best) { $best = $v }
    }
    if ($best) { return $best.ToString(2).TrimEnd('.0') }
    if ($BaselineRev) { return $BaselineRev }
    return $LocalRevision
}

function Test-IsGraphErrorFeatureDisabled {
    param($ErrorRecord)
    return ($ErrorRecord.ToString() -match 'FeatureDisabled|Feature disabled')
}

function Test-IsGraphErrorNotFound {
    param($ErrorRecord)
    return ($ErrorRecord.ToString() -match '404|NotFound|ResourceNotFound|itemNotFound')
}

function Get-AllUploadedADMXFiles {
    <#
    .SYNOPSIS
        Returns all uploaded ADMX definition files from the tenant (cached).
    #>
    if ($script:PolicyCache.ContainsKey("admx-files")) {
        return $script:PolicyCache["admx-files"]
    }

    Write-Verbose "  Fetching all uploaded ADMX definition files from tenant..."
    $all = @()
    $uri = $admxBaseUri
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        $all += $response.value
        $uri = $response.'@odata.nextLink'
    } while ($uri)

    $script:PolicyCache["admx-files"] = $all
    Write-Verbose "  Found $($all.Count) uploaded ADMX file(s) in tenant"
    return $all
}

function Get-ADMXFileContent {
    <#
    .SYNOPSIS
        Reads the .admx companion file, sanitizes it, and returns its base64-encoded content.
    .NOTES
        Two sanitizations are applied at runtime (baseline files are never edited directly):

        1. UTF-8 BOM (EF BB BF) is stripped. The Microsoft GroupPolicy Admin Service
           rejects ADMX uploads that begin with a BOM (HTTP 500). BOMs are introduced
           when files are uploaded via the portal UI.

        2. Oversized maxLength attributes on <text> elements are clamped to 32767.
           The ADMX schema allows maxLength up to 2^32-1 but the GroupPolicy Admin
           Service crashes (HTTP 500 / Operation ID 00000000) when the value exceeds
           what it can store internally. Values like 1000000 trigger this.
           Microsoft's own ADMX files use a default of 1023.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$JsonSourcePath
    )

    $admxPath = $JsonSourcePath -replace '\.json$', '.admx'
    if (-not (Test-Path $admxPath)) {
        throw "ADMX companion file not found: $admxPath"
    }

    $bytes = [System.IO.File]::ReadAllBytes($admxPath)

    # Strip UTF-8 BOM (EF BB BF) — Graph API rejects ADMX content that starts with BOM
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Write-Host "  [!] Stripping UTF-8 BOM from ADMX file (BOM causes HTTP 500 from Microsoft Graph)" -ForegroundColor Yellow
        $bytes = $bytes[3..($bytes.Length - 1)]
    }

    # Clamp oversized maxLength attributes — values > 32767 can cause validation issues.
    # Use regex string substitution to preserve the original XML formatting (indentation,
    # whitespace). Re-serialising via [xml].OuterXml strips whitespace, producing a compact
    # XML that differs structurally from what the portal uploads and triggers a 500.
    try {
        $xmlStr  = [System.Text.Encoding]::UTF8.GetString($bytes)
        $maxSafe = 32767
        $patched = 0
        $xmlFixed = [System.Text.RegularExpressions.Regex]::Replace($xmlStr, 'maxLength="(\d+)"', {
            param($m)
            $val = [int]$m.Groups[1].Value
            if ($val -gt $maxSafe) {
                $script:patched++
                "maxLength=""$maxSafe"""
            } else {
                $m.Value
            }
        })
        if ($xmlFixed -ne $xmlStr) {
            Write-Host "  [!] Clamped oversized maxLength value(s) in ADMX (inline substitution, formatting preserved)" -ForegroundColor Yellow
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($xmlFixed)
        }
    }
    catch {
        Write-Host "  [!] Could not apply maxLength remediation — uploading as-is: $_" -ForegroundColor Yellow
    }

    return [System.Convert]::ToBase64String($bytes)
}

function Get-ADMXRevision {
    <#
    .SYNOPSIS
        Parses the 'revision' attribute from the local ADMX XML file.
    .RETURNS
        The revision string (e.g. "1.0"), or $null if not found or parse fails.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$JsonSourcePath
    )

    $admxPath = $JsonSourcePath -replace '\.json$', '.admx'
    if (-not (Test-Path $admxPath)) { return $null }

    try {
        $xml = [xml][System.IO.File]::ReadAllText($admxPath)
        return $xml.policyDefinitions.revision
    }
    catch {
        Write-Verbose "  Could not parse ADMX revision from '$admxPath': $_"
        return $null
    }
}

function Get-ADMLLanguageFiles {
    <#
    .SYNOPSIS
        Finds all .adml companion files for an ADMX entry and returns them as an array
        of { fileName, content } objects ready for the Graph API upload body.
    .DESCRIPTION
        Expects companion files named: {BaseName}.{lang}.adml
        e.g. MySettings.en-US.adml, MySettings.de-DE.adml
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$JsonSourcePath
    )

    $dir      = Split-Path $JsonSourcePath -Parent
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($JsonSourcePath)  # e.g. "MySettings"

    $admlFiles = Get-ChildItem -Path $dir -Filter "$baseName.*.adml" -File -ErrorAction SilentlyContinue

    if ($admlFiles.Count -eq 0) {
        Write-Host "  ##[warning]No .adml language files found for '$baseName' (expected: $baseName.{lang}.adml)"
    }

    $result = @()
    foreach ($adml in $admlFiles) {
        $bytes = [System.IO.File]::ReadAllBytes($adml.FullName)
        # Strip UTF-8 BOM from ADML — same issue as ADMX: BOM causes HTTP 500 from Graph API
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            Write-Host "  [!] Stripping UTF-8 BOM from ADML file: $($adml.Name)" -ForegroundColor Yellow
            $bytes = $bytes[3..($bytes.Length - 1)]
        }
        # Extract languageCode from filename: "MySettings.en-US.adml" → "en-US"
        # The Graph API (confirmed via Intune portal HAR) requires a languageCode field
        # on each language file object alongside fileName and content.
        $nameWithoutExt = [System.IO.Path]::GetFileNameWithoutExtension($adml.Name)  # "MySettings.en-US"
        $langCode       = $nameWithoutExt -replace '^.*\.', ''                        # "en-US"
        $result += @{
            fileName     = $adml.Name
            languageCode = $langCode
            content      = [System.Convert]::ToBase64String($bytes)
        }
        Write-Host "  Found language file: $($adml.Name) (lang: $langCode)"
    }

    return $result
}

# ============================================================================
# RETRY HELPER
# ============================================================================

function Wait-ADMXAvailable {
    <#
    .SYNOPSIS
        Polls the ADMX upload status until it is 'available' (or fails/times out).
    .DESCRIPTION
        ADMX uploads are processed asynchronously by the GroupPolicy Admin Service.
        After a create or uploadNewVersion, status starts as 'uploadInProgress' and
        transitions to 'available' once processing completes (typically 5–30s).
        Definition indexing is a separate concern handled by the GPC step.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$UploadedId,
        [string]$AdmxFileName   = "ADMX",
        [int]$PollIntervalSecs  = 5,
        [int]$TimeoutSecs       = 300
    )

    $uri      = "$admxBaseUri/$UploadedId"
    $deadline = (Get-Date).AddSeconds($TimeoutSecs)
    $waited   = 0
    $status   = "unknown"

    Write-Host "  Waiting for ADMX to become available (polling every ${PollIntervalSecs}s, max ${TimeoutSecs}s)..." -ForegroundColor Cyan

    while ((Get-Date) -lt $deadline) {
        try {
            $r      = Invoke-MgGraphRequest -Method GET -Uri $uri
            $status = $r.status

            if ($status -eq 'uploadFailed') {
                throw "ADMX upload failed on the server side (status: uploadFailed) for '$AdmxFileName'"
            }

            if ($status -eq 'available') {
                Write-Host "  ADMX '$AdmxFileName' is available (waited ~${waited}s)" -ForegroundColor Green
                return
            }

            Write-Host "  Status: $($status) - waiting ${PollIntervalSecs}s..." -ForegroundColor DarkCyan
        }
        catch {
            if ($_.ToString() -match 'uploadFailed') { throw }
            Write-Host "  Poll error (non-fatal, retrying): $_" -ForegroundColor DarkYellow
        }
        Start-Sleep $PollIntervalSecs
        $waited += $PollIntervalSecs
    }

    throw "Timed out after ${TimeoutSecs}s waiting for ADMX '$AdmxFileName' to become available (last status: $status)"
}

function Wait-ADMXRemoved {
    <#
    .SYNOPSIS
        Polls until an ADMX upload has been fully removed after DELETE.
    .DESCRIPTION
        DELETE is asynchronous: status becomes removalInProgress before the resource
        disappears. Do not CREATE a replacement until removal completes.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$UploadedId,
        [string]$AdmxFileName = "ADMX",
        [int]$PollIntervalSecs = 5,
        [int]$TimeoutSecs = 600
    )

    $uri      = "$admxBaseUri/$UploadedId"
    $deadline = (Get-Date).AddSeconds($TimeoutSecs)
    $waited   = 0

    Write-Host "  Waiting for ADMX removal to complete (polling every ${PollIntervalSecs}s, max ${TimeoutSecs}s)..." -ForegroundColor Cyan

    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-MgGraphRequest -Method GET -Uri $uri
            $status = $r.status

            if ($status -eq 'removalFailed') {
                Write-Host "  Status: removalFailed - retrying POST /remove..." -ForegroundColor Yellow
                try {
                    Invoke-AdmxRemoveUploadedFile -UploadedId $UploadedId
                }
                catch {
                    throw "ADMX removal failed on the server side (status: removalFailed) for '$AdmxFileName': $($_.Exception.Message)"
                }
                Start-Sleep $PollIntervalSecs
                $waited += $PollIntervalSecs
                continue
            }

            if ($status -eq 'removalInProgress') {
                Write-Host "  Status: removalInProgress - waiting ${PollIntervalSecs}s..." -ForegroundColor DarkCyan
            }
            else {
                Write-Host "  Status: $($status) (expected removal) - waiting ${PollIntervalSecs}s..." -ForegroundColor DarkYellow
            }
        }
        catch {
            if (Test-IsGraphErrorNotFound -ErrorRecord $_) {
                Write-Host "  ADMX '$AdmxFileName' removed (GET returned 404, waited ~${waited}s)" -ForegroundColor Green
                $script:PolicyCache.Remove("admx-files")
                return
            }
            if ($_.ToString() -match 'removalFailed') { throw }
            Write-Host "  Poll error (non-fatal, retrying): $_" -ForegroundColor DarkYellow
        }

        # Also verify fileName no longer lists this id
        $all = @()
        $listUri = $admxBaseUri
        do {
            $listR = Invoke-MgGraphRequest -Method GET -Uri $listUri
            $all += $listR.value
            $listUri = $listR.'@odata.nextLink'
        } while ($listUri)

        $stillThere = @($all | Where-Object { $_.id -eq $UploadedId })
        if ($stillThere.Count -eq 0) {
            Write-Host "  ADMX '$AdmxFileName' no longer listed by id (waited ~${waited}s)" -ForegroundColor Green
            $script:PolicyCache.Remove("admx-files")
            return
        }

        Start-Sleep $PollIntervalSecs
        $waited += $PollIntervalSecs
    }

    throw "Timed out after ${TimeoutSecs}s waiting for ADMX '$AdmxFileName' to be removed (id: $UploadedId)"
}

function Invoke-AdmxRemoveUploadedFile {
    <#
    .SYNOPSIS
        Queues removal of an uploaded ADMX file (portal + Graph remove action).
        Returns 204 No Content; resource transitions to removalInProgress then disappears.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$UploadedId
    )

    $uri = "$admxBaseUri/$UploadedId/remove"
    Invoke-GraphApiWrite -Method POST -Uri $uri
}

function Test-AdmxRemovalQueued {
    <#
    .SYNOPSIS
        Graph sometimes returns 400 on DELETE while removal is still queued (status removalInProgress or 404).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$UploadedId,
        [string]$AdmxFileName = "ADMX"
    )

    try {
        $r = Invoke-MgGraphRequest -Method GET -Uri "$admxBaseUri/$UploadedId"
        if ($r.status -eq 'removalInProgress') {
            Write-Host "  ADMX '$AdmxFileName' status=removalInProgress (DELETE accepted asynchronously)" -ForegroundColor Cyan
            return $true
        }
        if ($r.status -eq 'removalFailed') {
            throw "ADMX removal failed on the server side (status: removalFailed) for '$AdmxFileName'"
        }
        return $false
    }
    catch {
        if (Test-IsGraphErrorNotFound -ErrorRecord $_) {
            Write-Host "  ADMX '$AdmxFileName' already absent (404 after DELETE attempt)" -ForegroundColor Cyan
            return $true
        }
        return $false
    }
}

function Invoke-AdmxStrictReplace {
    param(
        [Parameter(Mandatory = $true)]$PolicyConfig,
        [Parameter(Mandatory = $true)]$ExistingUpload,
        [string]$AdmxBase64,
        [array]$LanguageFiles,
        [array]$AllPolicyConfigs,
        [switch]$WhatIf
    )

    $admxFileName = $PolicyConfig.fileName
    $displayName  = if ($PolicyConfig.displayName) { $PolicyConfig.displayName } else { $PolicyConfig.name }
    $oldId        = $ExistingUpload.id
    $nsDisplay    = $ExistingUpload.displayName

    Write-Host "  Starting ADMX strict replace (Microsoft workflow) for '$admxFileName'..." -ForegroundColor Cyan
    Write-Host "  Step 1/3: Clear dependent Group Policy Configuration settings"

    Clear-GroupPolicyConfigurationsForAdmx -AdmxFileName $admxFileName `
        -AllPolicyConfigs $AllPolicyConfigs -UploadedAdmxDisplayName $nsDisplay -WhatIf:$WhatIf -RemoveGpcShell

    if (-not $WhatIf) {
        Start-Sleep -Seconds 30
    }

    if ($WhatIf) {
        Write-Host "  [WhatIf] Would POST remove on ADMX id=$oldId and CREATE new upload"
        return $null
    }

    Write-Host "  Step 2/3: Remove old ADMX via POST /remove (id: $oldId, revision: $($ExistingUpload.revision))"
    $removeOk = $false
    $removeAttempts = 8
    for ($attempt = 1; $attempt -le $removeAttempts; $attempt++) {
        try {
            Invoke-ADMXWriteWithRetry -Label "remove ADMX" -Action {
                Invoke-AdmxRemoveUploadedFile -UploadedId $oldId
            }
            $removeOk = $true
            break
        }
        catch {
            if (Test-AdmxRemovalQueued -UploadedId $oldId -AdmxFileName $admxFileName) {
                $removeOk = $true
                break
            }
            if ($attempt -ge $removeAttempts) {
                if (Test-AdmxRemovalQueued -UploadedId $oldId -AdmxFileName $admxFileName) {
                    $removeOk = $true
                    break
                }
                throw "ADMX remove failed - ensure all GPC settings using this template are removed first. Error: $($_.Exception.Message)"
            }
            Write-Host "  Remove not accepted yet (attempt $attempt/$removeAttempts) - waiting 15s for GPC/ADMX backend..." -ForegroundColor Yellow
            Start-Sleep -Seconds 15
        }
    }
    if (-not $removeOk) {
        if (Test-AdmxRemovalQueued -UploadedId $oldId -AdmxFileName $admxFileName) {
            $removeOk = $true
        }
        else {
            throw "ADMX remove failed after $removeAttempts attempt(s)"
        }
    }

    $script:PolicyCache.Remove("admx-files")

    Write-Host "  Step 2b/3: Wait for ADMX removal to complete"
    Wait-ADMXRemoved -UploadedId $oldId -AdmxFileName $admxFileName

    Write-Host "  Step 3/3: CREATE new ADMX upload"
    $createBody = @{
        content                          = $admxBase64
        fileName                         = $admxFileName
        defaultLanguageCode              = ""
        groupPolicyUploadedLanguageFiles = @($LanguageFiles)
    } | ConvertTo-Json -Depth 10

    $response = Invoke-ADMXWriteWithRetry -Label "Create ADMX (strict replace)" -Action {
        Invoke-GraphApiWrite -Method POST -Uri $admxBaseUri -Body $createBody
    }

    $newId = $response.id
    $script:PolicyCache.Remove("admx-files")
    Wait-ADMXAvailable -UploadedId $newId -AdmxFileName $admxFileName

    Write-Host "  [+] ADMX strict replace complete: $admxFileName (new ID: $newId)" -ForegroundColor Green
    return $newId
}

function Invoke-ADMXWriteWithRetry {
    <#
    .SYNOPSIS
        Wraps an ADMX Graph write operation with retry logic for transient 5xx errors.
    .DESCRIPTION
        The Microsoft GroupPolicy Admin Service (proxy.msua*.manage.microsoft.com) is known
        to return HTTP 500/503 transiently on ADMX create/uploadNewVersion operations.
        Retries up to $MaxAttempts times with a fixed delay before propagating the error.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [scriptblock]$Action,
        [int]$MaxAttempts  = 3,
        [int]$DelaySeconds = 30,
        [string]$Label     = "ADMX write"
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            return & $Action
        }
        catch {
            $isRetryable = ($_.ToString() -match 'HTTP.*5\d\d|InternalServerError|ServiceUnavailable|GatewayTimeout|BadGateway|5\d\d Internal')
            if (-not $isRetryable -or $attempt -eq $MaxAttempts) {
                throw
            }
            Write-Host "  [!] $Label failed with server error (attempt $attempt/$MaxAttempts) — retrying in ${DelaySeconds}s..." -ForegroundColor Yellow
            Write-Host "      Error: $($_.ToString().Split([Environment]::NewLine)[0])" -ForegroundColor DarkYellow
            Start-Sleep $DelaySeconds
        }
    }
}

# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-ADMXFiles {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [array]$AllPolicyConfigs = @(),
        [switch]$WhatIf
    )

    $results = @()

    # Ensure the shared upload cache exists (used by GroupPolicyConfigurations module)
    if (-not (Get-Variable -Name 'UploadedADMXCache' -Scope Script -ErrorAction SilentlyContinue)) {
        $script:UploadedADMXCache = @{}
    }

    if (-not (Get-Variable -Name 'AdmxReplacementRequired' -Scope Global -ErrorAction SilentlyContinue)) {
        $global:AdmxReplacementRequired  = $false
        $global:AdmxReplacementSucceeded = $false
        $global:AdmxReplacementFailed    = $false
    }

    foreach ($policyConfig in $Policies) {
        $displayName  = if ($policyConfig.displayName) { $policyConfig.displayName } else { $policyConfig.name }
        $admxFileName = $policyConfig.fileName

        Write-Host "`n##[group]Processing [admx-files]: $displayName"

        if (-not $admxFileName) {
            Write-Host "  ##[error]'fileName' property is required in the JSON metadata. Skipping: $displayName"
            $results += @{ DisplayName = $displayName; PolicyType = "admx-files"; Status = "Failed"; Error = "Missing 'fileName' property" }
            Write-Host "##[endgroup]"
            continue
        }

        try {
            # ----------------------------------------------------------------
            # Read companion ADMX / ADML files from disk
            # ----------------------------------------------------------------
            $admxBase64    = Get-ADMXFileContent  -JsonSourcePath $policyConfig._sourcePath
            $languageFiles = Get-ADMLLanguageFiles -JsonSourcePath $policyConfig._sourcePath

            # ----------------------------------------------------------------
            # Check if this ADMX already exists in the tenant (match by fileName)
            # ----------------------------------------------------------------
            $allUploaded = Get-AllUploadedADMXFiles

            # Diagnostic: log all tenant ADMX files so detection failures are visible
            Write-Host "  Tenant has $($allUploaded.Count) uploaded ADMX file(s):"
            foreach ($uf in $allUploaded) {
                Write-Host "    id=$($uf.id)  fileName='$($uf.fileName)'  status=$($uf.status)  revision=$($uf.revision)"
            }

            # When multiple uploads exist with the same fileName (from retried runs),
            # prefer the 'available' one. Never treat removalInProgress as a live upload.
            $matches        = @($allUploaded | Where-Object { $_.fileName -ieq $admxFileName })
            $existingUpload = $matches | Where-Object { $_.status -eq 'available' } | Select-Object -First 1
            $pendingRemoval = $matches | Where-Object { $_.status -eq 'removalInProgress' } | Select-Object -First 1

            if (-not $existingUpload -and $pendingRemoval) {
                Write-Host "  ADMX '$admxFileName' is pending delete (id: $($pendingRemoval.id), status: removalInProgress)"
                if ($WhatIf) {
                    Write-Host "  [WhatIf] Would wait for removal then create new upload"
                }
                else {
                    Wait-ADMXRemoved -UploadedId $pendingRemoval.id -AdmxFileName $admxFileName
                }
                $existingUpload = $null
            }

            $failedRemoval = $matches | Where-Object { $_.status -eq 'removalFailed' } | Select-Object -First 1
            if (-not $existingUpload -and $failedRemoval) {
                Write-Host "  ADMX '$admxFileName' removal failed previously (id: $($failedRemoval.id), revision: $($failedRemoval.revision))"
                $localRevForStale     = Get-ADMXRevision -JsonSourcePath $policyConfig._sourcePath
                $effectiveRevForStale = Get-EffectiveBaselineAdmxRevision -BaselineRev $policyConfig.revision -LocalRevision $localRevForStale
                if ($WhatIf) {
                    Write-Host "  [WhatIf] Would clear GPC (if drift), retry POST /remove, wait, then create"
                }
                else {
                    if ($effectiveRevForStale -and $failedRemoval.revision -and $effectiveRevForStale -ne $failedRemoval.revision) {
                        $global:AdmxReplacementRequired = $true
                        Write-Host "  Revision drift on removalFailed row - clearing GPC before retry remove..."
                        Clear-GroupPolicyConfigurationsForAdmx -AdmxFileName $admxFileName `
                            -AllPolicyConfigs $AllPolicyConfigs -UploadedAdmxDisplayName $failedRemoval.displayName -RemoveGpcShell
                        Start-Sleep -Seconds 30
                    }
                    Invoke-ADMXWriteWithRetry -Label "retry remove ADMX" -Action {
                        Invoke-AdmxRemoveUploadedFile -UploadedId $failedRemoval.id
                    }
                    Wait-ADMXRemoved -UploadedId $failedRemoval.id -AdmxFileName $admxFileName
                }
                $existingUpload = $null
                $script:PolicyCache.Remove("admx-files")
                $allUploaded = Get-AllUploadedADMXFiles
                $matches = @($allUploaded | Where-Object { $_.fileName -ieq $admxFileName })
            }

            # Stale non-available rows block CREATE with the same fileName (e.g. uploadFailed from a prior attempt).
            $staleSameName = @($matches | Where-Object { $_.status -ne 'available' })
            if (-not $existingUpload -and $staleSameName.Count -gt 0 -and -not $WhatIf) {
                foreach ($stale in $staleSameName) {
                    if ($stale.status -in @('removalInProgress', 'removalFailed')) { continue }
                    Write-Host "  Cleaning stale ADMX row id=$($stale.id) status=$($stale.status) for fileName '$admxFileName'..."
                    try {
                        Invoke-AdmxRemoveUploadedFile -UploadedId $stale.id
                        Wait-ADMXRemoved -UploadedId $stale.id -AdmxFileName $admxFileName
                    }
                    catch {
                        Write-Host "  ##[warning]Could not remove stale ADMX id=$($stale.id): $_" -ForegroundColor Yellow
                    }
                }
                $script:PolicyCache.Remove("admx-files")
                $allUploaded = Get-AllUploadedADMXFiles
                $matches = @($allUploaded | Where-Object { $_.fileName -ieq $admxFileName })
            }

            # ----------------------------------------------------------------
            # Change detection
            # ----------------------------------------------------------------
            # NOTE: We intentionally do NOT diff language files against the tenant.
            # The Intune portal only sends language files inline on the initial create
            # (confirmed via HAR capture). The /updateLanguageFiles action returns 5xx
            # from the GroupPolicy Admin Service when called against an existing ADMX,
            # and language files are admin-UI localization only — they do not affect
            # policy enforcement. If an ADMX is 'available' in the tenant, treat it as
            # complete.
            $action = "Create"

            if ($existingUpload) {
                Write-Host "  ADMX file already uploaded (id: $($existingUpload.id), status: $($existingUpload.status), tenant revision: $($existingUpload.revision))"

                # Pre-populate cache so GPC module can use this ID even if no changes are made
                $script:UploadedADMXCache[$admxFileName] = $existingUpload.id

                # ----------------------------------------------------------------
                # Revision comparison strategy
                # ----------------------------------------------------------------
                # Three "revision" concepts exist; we use them in priority order:
                #   1. $existingUpload.revision   — tenant-side counter returned by Graph (e.g. "1.04").
                #                                   Increments each uploadNewVersion. Source of truth
                #                                   for what's CURRENTLY in the tenant.
                #   2. $policyConfig.revision     — value captured at backup time in the JSON metadata.
                #                                   Reflects the revision of the ADMX as it lived in
                #                                   the SOURCE tenant when the baseline was generated.
                #   3. Get-ADMXRevision (XML)     — admin-set revision attribute inside the .admx file
                #                                   (e.g. "1.6"). Schema author's version, not API.
                #
                # Comparison logic:
                #   * If baseline-captured revision (#2) differs from tenant's current revision (#1),
                #     the tenant is out of sync with the baseline — upload baseline content. This
                #     handles tenants that have an OLDER ADMX than what was captured for the baseline,
                #     or tenants where someone manually replaced the ADMX with a different version.
                #   * If baseline metadata revision is missing (older backups), fall back to comparing
                #     the local XML revision against the tenant's revision string.
                #   * If we have no comparable signals, default to NoChange (conservative).
                #
                # Side effect: uploadNewVersion may DEPRECATE definitions (e.g. WAUaaS dropped
                # "Reinstall on Policy Update" / ReinstallOnRefresh between 1.04 and 1.6).
                # The GPC sync downstream will skip-with-warning any orphaned settings — see
                # Resolve-DefinitionId in Configure-Intune-GroupPolicyConfigurations.ps1.
                $localRevision      = Get-ADMXRevision -JsonSourcePath $policyConfig._sourcePath
                $baselineRev        = $policyConfig.revision
                $tenantRev            = $existingUpload.revision
                $effectiveBaselineRev = Get-EffectiveBaselineAdmxRevision -BaselineRev $baselineRev -LocalRevision $localRevision

                if ($effectiveBaselineRev -and $tenantRev) {
                    if ($effectiveBaselineRev -eq $tenantRev) {
                        $action = "NoChange"
                        Write-Host "  ADMX revision '$tenantRev' matches effective baseline '$effectiveBaselineRev' - no content update needed"
                    }
                    else {
                        $action = "Update"
                        $global:AdmxReplacementRequired = $true
                        Write-Host "  ADMX revision drift detected: tenant '$tenantRev' != effective baseline '$effectiveBaselineRev' - will upload baseline content"
                        if ($baselineRev -and $localRevision -and $baselineRev -ne $localRevision) {
                            Write-Host "  (baseline JSON revision '$baselineRev', local XML revision '$localRevision')" -ForegroundColor DarkGray
                        }
                        Write-Host "  Note: settings removed by the new ADMX will be skipped with a warning during GPC sync"
                    }
                }
                else {
                    $action = "NoChange"
                    Write-Host "  ADMX revision not comparable (local XML: '$localRevision', baseline JSON: '$baselineRev', tenant: '$tenantRev') - no content update (conservative)"
                }

                if ($action -eq "NoChange" -and $existingUpload.status -eq 'available') {
                    Write-Host "  ADMX is available - language files were applied at create time (no separate updateLanguageFiles needed)"
                }
            }
            else {
                Write-Host "  ADMX file not yet uploaded - will create"
            }

            Write-Host "  File: $admxFileName  |  Language files (local): $($languageFiles.Count)"

            # ----------------------------------------------------------------
            # WhatIf branch
            # ----------------------------------------------------------------
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create"       { "WouldCreate"       }
                    "Update"       { "WouldUpdate"       }
                    "NoChange"     { "No changes"         }
                }
                Write-Host "  [WhatIf] ${whatIfStatus}: $admxFileName"
                $results += @{ DisplayName = $displayName; PolicyType = "admx-files"; Status = $whatIfStatus; FileName = $admxFileName }
                Write-Host "##[endgroup]"
                continue
            }

            # ----------------------------------------------------------------
            # No changes needed
            # ----------------------------------------------------------------
            if ($action -eq "NoChange") {
                $results += @{ DisplayName = $displayName; PolicyType = "admx-files"; Status = "No changes"; FileName = $admxFileName; UploadedId = $existingUpload.id }
                Write-Host "##[endgroup]"
                continue
            }

            # ----------------------------------------------------------------
            # Deploy
            # ----------------------------------------------------------------
            $uploadedId = if ($existingUpload) { $existingUpload.id } else { $null }

            if ($action -eq "Update") {
                $uploadedId = $null
                $strictReplaceUsed = $false

                Write-Host "  Uploading new ADMX version (id: $($existingUpload.id)) via uploadNewVersion..."
                $updateBody = @{ content = $admxBase64; groupPolicyUploadedLanguageFiles = @($languageFiles) } | ConvertTo-Json -Depth 10
                try {
                    Invoke-ADMXWriteWithRetry -Label "uploadNewVersion" -Action {
                        Invoke-GraphApiWrite -Method POST -Uri "$admxBaseUri/$($existingUpload.id)/uploadNewVersion" -Body $updateBody
                    }
                    $uploadedId = $existingUpload.id
                    $script:PolicyCache.Remove("admx-files")
                    Wait-ADMXAvailable -UploadedId $uploadedId -AdmxFileName $admxFileName
                    $global:AdmxReplacementSucceeded = $true
                }
                catch {
                    if (Test-IsGraphErrorFeatureDisabled -ErrorRecord $_) {
                        Write-Host "  [!] uploadNewVersion unavailable (FeatureDisabled) - using strict replace (clear GPC, delete ADMX, upload)" -ForegroundColor Yellow
                        $uploadedId = Invoke-AdmxStrictReplace -PolicyConfig $policyConfig -ExistingUpload $existingUpload `
                            -AdmxBase64 $admxBase64 -LanguageFiles $languageFiles -AllPolicyConfigs $AllPolicyConfigs
                        $strictReplaceUsed = $true
                        $global:AdmxReplacementSucceeded = $true
                    }
                    else {
                        $global:AdmxReplacementFailed = $true
                        throw
                    }
                }

                if (-not $strictReplaceUsed -and -not $uploadedId) {
                    $global:AdmxReplacementFailed = $true
                    throw "ADMX update did not produce an uploaded id"
                }
            }
            elseif ($action -eq "Create") {
                $stillListed = @(Get-AllUploadedADMXFiles | Where-Object { $_.fileName -ieq $admxFileName })
                if ($stillListed.Count -gt 0 -and -not $WhatIf) {
                    $summary = ($stillListed | ForEach-Object { "id=$($_.id) status=$($_.status)" }) -join '; '
                    throw "Cannot CREATE ADMX '$admxFileName': tenant still lists $($stillListed.Count) row(s) ($summary). Remove stale uploads in Intune or re-run after cleanup."
                }

                # Body structure confirmed via Intune portal HAR capture (uploadadmx.har):
                #   { content, fileName, defaultLanguageCode, groupPolicyUploadedLanguageFiles: [{fileName, languageCode, content}] }
                # The portal sends language files WITH the initial create. The languageCode
                # field on each language file is required — omitting it or using
                # "languageFiles" (wrong field name) causes the GroupPolicy Admin Service to
                # return HTTP 500. The portal does NOT call /updateLanguageFiles afterwards.
                Write-Host "  Creating new ADMX upload (including $(@($languageFiles).Count) language file(s))..."
                $createBody = @{
                    content                          = $admxBase64
                    fileName                         = $admxFileName
                    defaultLanguageCode              = ""
                    groupPolicyUploadedLanguageFiles = @($languageFiles)
                } | ConvertTo-Json -Depth 10
                $response = Invoke-ADMXWriteWithRetry -Label "Create ADMX" -Action {
                    Invoke-GraphApiWrite -Method POST -Uri $admxBaseUri -Body $createBody
                }
                $uploadedId = $response.id
                $script:PolicyCache.Remove("admx-files")
                Wait-ADMXAvailable -UploadedId $uploadedId -AdmxFileName $admxFileName
            }

            Write-Host "  [+] ADMX processed: $admxFileName (ID: $uploadedId)"

            if ($global:AdmxReplacementRequired -and $uploadedId) {
                $global:AdmxReplacementSucceeded = $true
            }

            # Populate shared cache for GroupPolicyConfigurations module
            $script:UploadedADMXCache[$admxFileName] = $uploadedId

            $results += @{
                DisplayName = $displayName
                PolicyType  = "admx-files"
                Status      = switch ($action) {
                    "Update"   { "Updated"    }
                    "Create"   { "Created"    }
                    "NoChange" { "No changes" }
                }
                FileName    = $admxFileName
                UploadedId  = $uploadedId
            }
        }
        catch {
            if ($global:AdmxReplacementRequired) {
                $global:AdmxReplacementFailed = $true
            }
            Write-Host "  ✗ Failed to process ADMX file '$admxFileName': $_" -ForegroundColor Red
            Write-Host "##[error]Failed to process ADMX file: $displayName"
            Write-Host "##[error]Error: $_"

            $results += @{
                DisplayName = $displayName
                PolicyType  = "admx-files"
                Status      = "Failed"
                Error       = $_.ToString()
                FileName    = $admxFileName
            }
        }
        finally {
            Write-Host "##[endgroup]"
        }
    }

    return $results
}

# ============================================================================
# ENTRY POINT
# ============================================================================

$admxPolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "admx-files" }

if ($admxPolicies.Count -eq 0) {
    Write-Host "No ADMX definition files to process"
    return @()
}

Write-Host "`n##[section]Processing ADMX Definition Files ($($admxPolicies.Count) file(s))"

$results = Invoke-ADMXFiles -Policies $admxPolicies -AllPolicyConfigs $AllPolicyConfigs -WhatIf:$WhatIfMode

return $results
