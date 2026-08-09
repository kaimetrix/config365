<#
.SYNOPSIS
    Applies default Outlook font settings to Exchange Online mailboxes based on Entra group membership.

.DESCRIPTION
    Reads an exchange-fonts configuration from the baseline repo and/or tenant repo. For each
    configured font rule, the script:
      1. Resolves members of the specified Entra group via Microsoft Graph.
      2. Connects to Exchange Online with certificate-based app-only authentication.
      3. Calls Set-MailboxMessageConfiguration for each member's mailbox to set the
         DefaultFontName and DefaultFontSize.

    Tenant rules override baseline rules that share the same id. Supports -WhatIfMode to
    preview changes without writing to Exchange Online.

.PARAMETER BaselineConfigDir
    Path to the directory containing baseline/exchange-fonts.json (the maintenance/ folder
    checked out from the baseline repo).

.PARAMETER TenantConfigDir
    Path to the directory containing config/maintenance/exchange-fonts.json in the tenant repo.
    Tenant entries with the same id as a baseline entry take precedence.

.PARAMETER TenantName
    Tenant name used in log messages.

.PARAMETER OutputPath
    Optional path to write a JSON summary of planned/applied changes.

.PARAMETER WhatIfMode
    Show intended changes without writing to Exchange Online.

.EXAMPLE
    .\Configure-ExchangeFonts.ps1 `
        -BaselineConfigDir "baseline/maintenance" `
        -TenantConfigDir   "Tenant-repo/config/maintenance" `
        -TenantName        "contoso" `
        -WhatIfMode

.NOTES
    Required permissions (already granted):
      GroupMember.Read.All      — Graph API application permission (resolve group members)
      Exchange.ManageAsApp      — Graph API application permission (EXO app-only access)
      Exchange Administrator    — Azure AD directory role on the service principal
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $false)]
    [string]$BaselineConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantName = '',

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIfMode
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

# ============================================================================
# IMPORT DEPENDENCIES
# ============================================================================

$commonScriptPath = Join-Path $scriptRoot '..\common\Connect-M365Graph.ps1'
if (Test-Path $commonScriptPath) { . $commonScriptPath }

# ============================================================================
# GRAPH HELPER
# ============================================================================

function Invoke-GraphRequest {
    param(
        [string]$Method = 'GET',
        [string]$Uri,
        [object]$Body,
        [string]$ContentType = 'application/json'
    )
    # Use the SDK's own request cmdlet rather than manually extracting a bearer token.
    # (Get-MgContext).AuthContext.AccessToken / Get-MgAccessToken are NOT reliable ways to
    # get a raw token in current Microsoft.Graph.Authentication versions — Get-MgContext
    # does not expose an AuthContext/AccessToken property and Get-MgAccessToken is not
    # exported at all in the installed SDK version. Invoke-MgGraphRequest uses the SDK's
    # internal auth provider (populated by Connect-MgGraph) directly, so no token
    # extraction is needed.
    $params = @{ Uri = $Uri; Method = $Method; ErrorAction = 'Stop' }
    if ($Body) {
        $params.Body = $Body
        $params.ContentType = $ContentType
    }
    return Invoke-MgGraphRequest @params
}

function Get-AllPages {
    param([string]$Uri)
    $results = [System.Collections.Generic.List[object]]::new()
    $next    = $Uri
    while ($next) {
        $page = Invoke-GraphRequest -Uri $next
        if ($page.value) { $results.AddRange($page.value) }
        $next = $page.'@odata.nextLink'
    }
    return $results
}

# ============================================================================
# LOAD AND MERGE CONFIGURATION
# ============================================================================

Write-Host "`n##[section]Loading exchange fonts configuration"

function Read-ExchangeFontsFile {
    param([string]$Dir)
    if (-not $Dir -or -not (Test-Path $Dir)) { return @() }
    $path = Join-Path $Dir 'exchange-fonts.json'
    if (-not (Test-Path $path)) {
        Write-Host "  No exchange-fonts.json found in: $Dir" -ForegroundColor DarkGray
        return @()
    }
    try {
        $parsed = Get-Content $path -Raw | ConvertFrom-Json
        $rules  = @($parsed.exchangeFonts)
        Write-Host "  Loaded $($rules.Count) rule(s) from: $path"
        return $rules
    } catch {
        Write-Host "  Warning: Failed to parse $path — $_" -ForegroundColor Yellow
        return @()
    }
}

$baselineRules = Read-ExchangeFontsFile -Dir $BaselineConfigDir
$tenantRules   = Read-ExchangeFontsFile -Dir $TenantConfigDir

$ruleMap = [ordered]@{}
foreach ($r in $baselineRules) { if ($r.id) { $ruleMap[$r.id] = $r } }
foreach ($r in $tenantRules)   { if ($r.id) { $ruleMap[$r.id] = $r } }

$allRules = @($ruleMap.Values)

if ($OutputPath) {
    $outputDir = Split-Path -Path $OutputPath -Parent
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
}

if ($allRules.Count -eq 0) {
    Write-Host "No exchange font rules found. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        @{ Service = 'ExchangeFonts'; Timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); WhatIfMode = [bool]$WhatIfMode; Results = @() } |
            ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

Write-Host "Total font rules to process: $($allRules.Count)"

# ============================================================================
# GRAPH AUTHENTICATION
# ============================================================================

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

$requiredModules = @('Microsoft.Graph.Authentication')
Import-RequiredGraphModules -ModuleNames $requiredModules

try {
    $context = Ensure-M365GraphConnection
    Write-Host "  Connected to Graph tenant: $($context.TenantId)"
} catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# ============================================================================
# EXCHANGE ONLINE AUTHENTICATION
# ============================================================================

Write-Host "`nConnecting to Exchange Online..."

if (-not $WhatIfMode) {
    try {
        Ensure-ExchangeOnlineConnection
        Write-Host "  Connected to Exchange Online via delegated auth"
    } catch {
        throw "Failed to connect to Exchange Online: $_"
    }
} else {
    Write-Host "  WhatIfMode: skipping Exchange Online connection"
}

# ============================================================================
# PROCESS RULES
# ============================================================================

Write-Host "`n##[section]Processing exchange font rules"

$allResults = [System.Collections.Generic.List[object]]::new()

foreach ($rule in $allRules) {
    $ruleId   = $rule.id
    $ruleName = if ($rule.displayName) { $rule.displayName.Trim() } else { $ruleId }
    $fontName = $rule.fontName
    $fontSize = [int]($rule.fontSize ?? 11)

    Write-Host "`n--- Rule: $ruleName ---" -ForegroundColor Cyan
    Write-Host "  Font: '$fontName' size $fontSize"

    if (-not $rule.groupId -and -not $rule.groupName) {
        Write-Host "  ERROR: No groupId or groupName configured — skipping." -ForegroundColor Red
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'Error'; Error = 'No group configured'; Applied = 0; Skipped = 0 })
        continue
    }

    # ── Resolve group members via Graph ──────────────────────────────────────
    $groupId = $rule.groupId
    if (-not $groupId -and $rule.groupName) {
        Write-Host "  Resolving group by name: $($rule.groupName)"
        try {
            $encoded = [Uri]::EscapeDataString("displayName eq '$($rule.groupName)'")
            $found   = Invoke-GraphRequest -Uri "https://graph.microsoft.com/v1.0/groups?`$filter=$encoded&`$select=id,displayName"
            $groupId = $found.value | Select-Object -First 1 -ExpandProperty id
        } catch {
            Write-Host "  ERROR: Failed to resolve group '$($rule.groupName)': $_" -ForegroundColor Red
        }
    }

    if (-not $groupId) {
        Write-Host "  ERROR: Could not resolve group — skipping." -ForegroundColor Red
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'Error'; Error = "Group not found: $($rule.groupName)"; Applied = 0; Skipped = 0 })
        continue
    }

    Write-Host "  Group ID: $groupId"

    $members = @()
    try {
        $members = @(Get-AllPages -Uri "https://graph.microsoft.com/v1.0/groups/$groupId/members?`$select=id,userPrincipalName,mail&`$top=999")
    } catch {
        Write-Host "  ERROR: Failed to retrieve group members: $_" -ForegroundColor Red
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'Error'; Error = "Failed to get members: $_"; Applied = 0; Skipped = 0 })
        continue
    }

    $userMembers = @($members | Where-Object { $_.userPrincipalName -and $_.userPrincipalName -notmatch '#EXT#' -or $_.mail })
    Write-Host "  Members with mailboxes: $($userMembers.Count)"

    if ($userMembers.Count -eq 0) {
        Write-Host "  No mailbox-eligible members found — skipping." -ForegroundColor DarkGray
        $allResults.Add([PSCustomObject]@{ RuleId = $ruleId; RuleName = $ruleName; Status = 'NoMembers'; Applied = 0; Skipped = 0 })
        continue
    }

    # ── Apply font settings ───────────────────────────────────────────────────
    $applied = 0
    $skipped = 0

    foreach ($member in $userMembers) {
        $identity = $member.userPrincipalName ?? $member.mail
        if (-not $identity) { $skipped++; continue }

        if ($WhatIfMode) {
            Write-Host "    WouldSet: '$identity' → font='$fontName' size=$fontSize" -ForegroundColor Yellow
            $applied++
            continue
        }

        try {
            Set-MailboxMessageConfiguration `
                -Identity        $identity `
                -DefaultFontName $fontName `
                -DefaultFontSize $fontSize `
                -ErrorAction Stop
            $applied++
        } catch {
            Write-Host "    Warning: Failed to set font for '$identity': $_" -ForegroundColor Yellow
            $skipped++
        }
    }

    $status = if ($WhatIfMode) { 'WouldUpdate' } else { 'Updated' }
    Write-Host "  Done: $applied applied, $skipped skipped" -ForegroundColor Green

    $allResults.Add([PSCustomObject]@{
        RuleId   = $ruleId
        RuleName = $ruleName
        Status   = $status
        Applied  = $applied
        Skipped  = $skipped
    })
}

# ============================================================================
# DISCONNECT EXCHANGE ONLINE
# ============================================================================

if (-not $WhatIfMode) {
    try {
        Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "`nDisconnected from Exchange Online"
    } catch { }
}

# ============================================================================
# SUMMARY
# ============================================================================

Write-Host "`n##[section]Exchange Font Configuration Summary"

$updated  = @($allResults | Where-Object { $_.Status -eq 'Updated' }).Count
$wouldUpd = @($allResults | Where-Object { $_.Status -eq 'WouldUpdate' }).Count
$noMem    = @($allResults | Where-Object { $_.Status -eq 'NoMembers' }).Count
$errCount = @($allResults | Where-Object { $_.Status -eq 'Error' }).Count

if ($WhatIfMode) {
    Write-Host "  WouldUpdate : $wouldUpd"
} else {
    Write-Host "  Updated     : $updated"
}
Write-Host "  No members  : $noMem"
Write-Host "  Errors      : $errCount"

if ($errCount -gt 0) {
    $allResults | Where-Object { $_.Status -eq 'Error' } | ForEach-Object {
        Write-Host "  Failed: $($_.RuleName) - $($_.Error)" -ForegroundColor Red
    }
}

# ============================================================================
# OUTPUT JSON
# ============================================================================

if ($OutputPath) {
    $baselineFontsFile = Join-Path $BaselineConfigDir 'exchange-fonts.json'
    $summary = @{
        Service    = 'ExchangeFonts'
        Timestamp  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        TenantName = $TenantName
        WhatIfMode = [bool]$WhatIfMode
        Results    = @($allResults | ForEach-Object {
            @{
                RuleId   = $_.RuleId
                RuleName = $_.RuleName
                Status   = $_.Status
                Applied  = $_.Applied
                Skipped  = $_.Skipped
                Error    = $_.Error
                FilePath = if (Test-Path $baselineFontsFile) { $baselineFontsFile } else { $null }
            }
        })
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "Summary saved to: $OutputPath"
}

if ($errCount -gt 0) { exit 1 }
