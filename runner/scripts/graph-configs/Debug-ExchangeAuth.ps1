<#
.SYNOPSIS
    Comprehensive diagnostic for Exchange Online delegated authentication failures.
    Tests every known connection method and dumps full JWT claims so the root cause
    of "UnAuthorized" can be pinpointed without guessing.
#>

param(
    [string]$TenantSlug  = $env:TENANT_SLUG,
    [string]$TenantId    = $env:AZURE_TENANT_ID,
    [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
    [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
)

if (-not $TokenApiUrl) { $TokenApiUrl = 'http://localhost:4322' }

function Decode-Jwt {
    param([string]$jwt)
    try {
        $seg = ($jwt -split '\.')[1]
        # base64url → base64: replace url-safe chars, then pad to multiple-of-4
        $b64 = $seg -replace '-', '+' -replace '_', '/'
        $rem = $b64.Length % 4
        if ($rem -gt 0) { $b64 = $b64.PadRight($b64.Length + (4 - $rem), '=') }
        return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Show-TokenClaims {
    param([string]$token, [string]$label)
    Write-Host ""
    Write-Host "  ── $label token claims ──"
    $c = Decode-Jwt $token
    if (-not $c) { Write-Host "  [WARN] Could not decode JWT" -ForegroundColor Yellow; return $null }
    Write-Host "  aud : $($c.aud)"
    Write-Host "  tid : $($c.tid)"
    Write-Host "  upn : $($c.upn)"
    Write-Host "  scp : $($c.scp)"
    Write-Host "  roles: $($c.roles -join ', ')"
    $exp = [System.DateTimeOffset]::FromUnixTimeSeconds([long]$c.exp).ToLocalTime()
    Write-Host "  exp : $exp ($(if ($c.exp -lt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) { 'EXPIRED' } else { 'valid' }))"
    if ($c.aud -notmatch 'outlook') {
        Write-Host "  [WARN] aud is NOT outlook.office365.com — wrong resource!" -ForegroundColor Yellow
    }
    if ($TenantId -and $c.tid -and $c.tid -ne $TenantId) {
        Write-Host "  [WARN] tid '$($c.tid)' != AZURE_TENANT_ID '$TenantId'" -ForegroundColor Yellow
    }
    return $c
}

function Test-Connect {
    param([string]$label, [scriptblock]$block)
    Write-Host ""
    Write-Host "--- $label ---"
    try {
        & $block
        $info = Get-ConnectionInformation -ErrorAction SilentlyContinue
        Write-Host "  [OK] Connected: $($info.UserPrincipalName) → org: $($info.Organization) tenant: $($info.TenantID)" -ForegroundColor Green
        try {
            $tc = Get-TransportConfig -ErrorAction Stop | Select-Object -First 1
            Write-Host "  [OK] Get-TransportConfig succeeded (MaxSendSize: $($tc.MaxSendSize))" -ForegroundColor Green
        } catch {
            Write-Host "  [WARN] Connect OK but Get-TransportConfig failed: $_" -ForegroundColor Yellow
        }
        try {
            $ext = Get-ExternalInOutlook -ErrorAction Stop | Select-Object -First 1
            Write-Host "  [OK] Get-ExternalInOutlook succeeded (Enabled=$($ext.Enabled))" -ForegroundColor Green
        } catch {
            Write-Host "  [WARN] Connect OK but Get-ExternalInOutlook failed: $_" -ForegroundColor Yellow
        }
        Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
        return $true
    } catch {
        Write-Host "  [FAIL] $($_.Exception.Message)" -ForegroundColor Red
        Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
        return $false
    }
}

# ═══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "══════════════════════════════════════════════════"
Write-Host "  Exchange Online Auth Diagnostics"
Write-Host "══════════════════════════════════════════════════"
Write-Host "  TenantSlug : $TenantSlug"
Write-Host "  TenantId   : $TenantId"
Write-Host "  TokenApiUrl: $TokenApiUrl"
Write-Host "  InternalKey: $(if ($InternalKey) { '***set***' } else { 'NOT SET' })"

# ── Module versions ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "--- Installed modules ---"
$eom = Get-Module ExchangeOnlineManagement -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1
Write-Host "  ExchangeOnlineManagement : $($eom.Version) at $($eom.ModuleBase)"
$mgAuth = Get-Module Microsoft.Graph.Authentication -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1
Write-Host "  Microsoft.Graph.Auth     : $($mgAuth.Version)"

Import-Module ExchangeOnlineManagement -Force -ErrorAction Stop
Write-Host "  Module imported. Connect-ExchangeOnline parameters:"
(Get-Command Connect-ExchangeOnline).Parameters.Keys | Sort-Object | ForEach-Object { Write-Host "    $_" }

# ── Fetch GRAPH token (baseline comparison) ───────────────────────────────────
Write-Host ""
Write-Host "--- Fetching Graph token from token API ---"
$graphResp = Invoke-RestMethod `
    -Uri     "$TokenApiUrl/tenant-auth/token" `
    -Method  POST `
    -Headers @{ Authorization = "Bearer $InternalKey"; 'Content-Type' = 'application/json' } `
    -Body    (ConvertTo-Json @{ tenantSlug = $TenantSlug }) `
    -SkipHttpErrorCheck -TimeoutSec 30

if ($graphResp.error) {
    Write-Host "  [ERROR] Graph token API error: $($graphResp.error) — $($graphResp.detail)" -ForegroundColor Red
} else {
    Write-Host "  Graph token length: $($graphResp.accessToken.Length) chars"
    $null = Show-TokenClaims $graphResp.accessToken "GRAPH"
}

# ── Fetch EXCHANGE token ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "--- Fetching Exchange token from token API ---"
try {
    $exoResp = Invoke-RestMethod `
        -Uri     "$TokenApiUrl/tenant-auth/token" `
        -Method  POST `
        -Headers @{ Authorization = "Bearer $InternalKey"; 'Content-Type' = 'application/json' } `
        -Body    (ConvertTo-Json @{ tenantSlug = $TenantSlug; resource = 'exchange' }) `
        -SkipHttpErrorCheck -TimeoutSec 30
} catch {
    Write-Host "  [ERROR] Token API request failed: $_" -ForegroundColor Red
    exit 1
}

Write-Host "  Full token API response keys: $($exoResp.PSObject.Properties.Name -join ', ')"
Write-Host "  organizationName from API   : $(if ($exoResp.organizationName) { $exoResp.organizationName } else { '(not returned)' })"
Write-Host "  userPrincipalName from API  : $(if ($exoResp.userPrincipalName) { $exoResp.userPrincipalName } else { '(not returned)' })"
if ($exoResp.error) {
    Write-Host "  [ERROR] Token API returned error: $($exoResp.error) — $($exoResp.detail)" -ForegroundColor Red
    Write-Host ""
    Write-Host "  This means the refresh_token→Exchange token exchange FAILED at Azure AD."
    Write-Host "  Likely cause: Exchange.Manage delegated permission not consented in this tenant,"
    Write-Host "  or the app registration does not have Exchange.Manage in its delegated permissions."
    exit 1
}

$rawToken = $exoResp.accessToken
if (-not $rawToken) {
    Write-Host "  [ERROR] Token API returned no accessToken" -ForegroundColor Red
    exit 1
}
Write-Host "  Exchange token length: $($rawToken.Length) chars"
$claims = Show-TokenClaims $rawToken "EXCHANGE"

# ── Run connect attempts ───────────────────────────────────────────────────────
$secureToken = ConvertTo-SecureString $rawToken -AsPlainText -Force
$upn = if ($exoResp.userPrincipalName) { $exoResp.userPrincipalName }
        elseif ($claims) {
            if ($claims.upn) { $claims.upn }
            elseif ($claims.preferred_username) { $claims.preferred_username }
            else { '' }
        } else { '' }

$a1 = Test-Connect "Attempt 1: SecureString + DelegatedOrganization=GUID (current method)" {
    Connect-ExchangeOnline -AccessToken $secureToken -DelegatedOrganization $TenantId -ShowBanner:$false -ErrorAction Stop
}

$a2 = Test-Connect "Attempt 2: SecureString only (no DelegatedOrganization)" {
    Connect-ExchangeOnline -AccessToken $secureToken -ShowBanner:$false -ErrorAction Stop
}

$a3 = Test-Connect "Attempt 3: Plain string + DelegatedOrganization=GUID" {
    Connect-ExchangeOnline -AccessToken $rawToken -DelegatedOrganization $TenantId -ShowBanner:$false -ErrorAction Stop
}

# Try to resolve tenant primary domain from Graph to use in DelegatedOrganization
$domain = $null
if ($graphResp.accessToken) {
    try {
        $orgResp = Invoke-RestMethod `
            -Uri     "https://graph.microsoft.com/v1.0/organization" `
            -Headers @{ Authorization = "Bearer $($graphResp.accessToken)" } `
            -TimeoutSec 15
        $domain = ($orgResp.value | Select-Object -First 1).verifiedDomains | Where-Object { $_.isDefault } | Select-Object -ExpandProperty name -First 1
        if (-not $domain) {
            $domain = ($orgResp.value | Select-Object -First 1).verifiedDomains | Where-Object { $_.name -like '*.onmicrosoft.com' } | Select-Object -ExpandProperty name -First 1
        }
        Write-Host ""
        Write-Host "  Resolved primary domain: $domain"
    } catch {
        Write-Host ""
        Write-Host "  [WARN] Could not resolve primary domain via Graph: $_" -ForegroundColor Yellow
    }
}

if ($domain) {
    $a4 = Test-Connect "Attempt 4: SecureString + DelegatedOrganization=domain ($domain)" {
        Connect-ExchangeOnline -AccessToken $secureToken -DelegatedOrganization $domain -ShowBanner:$false -ErrorAction Stop
    }
} else {
    Write-Host ""
    Write-Host "--- Attempt 4: Skipped (no domain resolved) ---"
}

if ($upn) {
    $a5 = Test-Connect "Attempt 5: SecureString + DelegatedOrganization + UserPrincipalName" {
        Connect-ExchangeOnline -AccessToken $secureToken -DelegatedOrganization $TenantId -UserPrincipalName $upn -ShowBanner:$false -ErrorAction Stop
    }
} else {
    Write-Host ""
    Write-Host "--- Attempt 5: Skipped (no UPN in token) ---"
}

# Attempt 6: Plain string + -Organization (no UPN) — previous production method
$orgName = if ($exoResp.organizationName) { $exoResp.organizationName } elseif ($domain) { $domain } else { $null }
if ($orgName) {
    $a6 = Test-Connect "Attempt 6: Plain string + -Organization '$orgName' (no UserPrincipalName)" {
        Connect-ExchangeOnline -AccessToken $rawToken -Organization $orgName -ShowBanner:$false -ErrorAction Stop
    }
} else {
    Write-Host ""
    Write-Host "--- Attempt 6: Skipped (no organizationName or domain available) ---"
}

# Attempt 7: Plain string + Organization + UserPrincipalName — current production method
if ($orgName -and $upn) {
    $a7 = Test-Connect "Attempt 7: Plain string + Organization + UserPrincipalName (production)" {
        Connect-ExchangeOnline -AccessToken $rawToken -Organization $orgName -UserPrincipalName $upn -ShowBanner:$false -ErrorAction Stop
    }
} else {
    Write-Host ""
    Write-Host "--- Attempt 7: Skipped (need organizationName and userPrincipalName) ---"
}

# ── Summary ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════════════"
Write-Host "  Summary"
Write-Host "══════════════════════════════════════════════════"
Write-Host "  Exchange token audience: $($claims.aud)"
Write-Host "  Exchange token scopes  : $($claims.scp)"
Write-Host "  organizationName (API) : $(if ($exoResp.organizationName) { $exoResp.organizationName } else { '(not returned)' })"
Write-Host "  Attempt 1 (SecureStr+GUID)        : $(if ($a1) { 'OK' } else { 'FAIL' })"
Write-Host "  Attempt 2 (SecureStr only)        : $(if ($a2) { 'OK' } else { 'FAIL' })"
Write-Host "  Attempt 3 (PlainStr+GUID)         : $(if ($a3) { 'OK' } else { 'FAIL' })"
if ($domain)   { Write-Host "  Attempt 4 (SecureStr+domain)      : $(if ($a4) { 'OK' } else { 'FAIL' })" }
if ($upn)      { Write-Host "  Attempt 5 (SecureStr+UPN)         : $(if ($a5) { 'OK' } else { 'FAIL' })" }
if ($orgName)  { Write-Host "  Attempt 6 (PlainStr+-Organization): $(if ($a6) { 'OK' } else { 'FAIL' })" }
if ($orgName -and $upn) { Write-Host "  Attempt 7 (PlainStr+Org+UPN, production): $(if ($a7) { 'OK' } else { 'FAIL' })" }
Write-Host ""
