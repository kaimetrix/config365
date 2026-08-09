<#
.SYNOPSIS
    Common Microsoft Graph connection utilities with GCC High support

.DESCRIPTION
    This module provides helper functions for connecting to Microsoft Graph
    with automatic detection of GCC High environments and credential fallback support.

.NOTES
    This module should be dot-sourced by other scripts that need Graph connectivity.
    
    Supported environments:
    - Global (Commercial): graph.microsoft.com, login.microsoftonline.com
    - USGov (GCC High): graph.microsoft.us, login.microsoftonline.us
    
    Credential priority:
    1. Tenant-specific: Tenant_CLIENT_ID / Tenant_CLIENT_SECRET
    2. Azure standard: AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
    3. ARM fallback: ARM_CLIENT_ID / ARM_CLIENT_SECRET

    All functions in this file are deliberately simple functions (no [CmdletBinding()]).
    Advanced functions participate in PS7's WhatIf propagation: when the calling script
    runs with -WhatIf, PS7 tries to explicitly pass -WhatIf:$true to every advanced-
    function call inside it. Simple functions are completely exempt from this — PS7 will
    not attempt to bind -WhatIf to them at all.
#>

# Cache for tenant environment detection to avoid repeated API calls
$script:TenantEnvironmentCache = @{}

#region Environment Detection

<#
.SYNOPSIS
    Detects if a tenant is GCC High by querying the OpenID configuration endpoint

.DESCRIPTION
    Queries the OpenID configuration endpoint for the tenant and examines the 
    issuer URL to determine if the tenant is in a GCC High environment.
    Results are cached to avoid repeated API calls.

.PARAMETER TenantId
    The Azure AD tenant ID (GUID)

.OUTPUTS
    String - Either "Global" for commercial tenants or "USGov" for GCC High tenants

.EXAMPLE
    $environment = Get-TenantEnvironment -TenantId "12345678-1234-1234-1234-123456789012"
    # Returns "USGov" for GCC High, "Global" for commercial
#>
function Get-TenantEnvironment {
    param(
        [ValidateNotNullOrEmpty()]
        [string]$TenantId
    )
    
    # Return cached result if available
    if ($script:TenantEnvironmentCache.ContainsKey($TenantId)) {
        Write-Verbose "Using cached environment for tenant $($TenantId): $($script:TenantEnvironmentCache[$TenantId])"
        return $script:TenantEnvironmentCache[$TenantId]
    }
    
    Write-Verbose "Detecting environment for tenant $($TenantId)..."
    
    try {
        # Query the OpenID configuration endpoint
        # This endpoint is publicly accessible and doesn't require authentication
        $openIdUrl = "https://login.microsoftonline.com/$TenantId/v2.0/.well-known/openid-configuration"
        
        $response = Invoke-RestMethod -Uri $openIdUrl -Method Get -TimeoutSec 8 -ErrorAction Stop
        
        # Check the issuer URL to determine the environment
        # GCC High tenants use login.microsoftonline.us
        if ($response.issuer -match 'microsoftonline\.us') {
            $environment = "USGov"
            Write-Verbose "Tenant $TenantId detected as GCC High (USGov)"
        }
        elseif ($response.token_endpoint -match 'login\.microsoftonline\.us') {
            $environment = "USGov"
            Write-Verbose "Tenant $TenantId detected as GCC High (USGov) via token endpoint"
        }
        else {
            $environment = "Global"
            Write-Verbose "Tenant $TenantId detected as Commercial (Global)"
        }
        
        # Cache the result
        $script:TenantEnvironmentCache[$TenantId] = $environment
        
        return $environment
    }
    catch {
        Write-Warning "Failed to detect tenant environment for $TenantId. Defaulting to Global. Error: $_"
        
        # Default to Global if detection fails
        $script:TenantEnvironmentCache[$TenantId] = "Global"
        return "Global"
    }
}

<#
.SYNOPSIS
    Gets the Graph API base URL for the specified environment

.PARAMETER Environment
    The Microsoft Graph environment (Global or USGov)

.OUTPUTS
    String - The base URL for the Graph API
#>
function Get-GraphApiBaseUrl {
    param(
        [ValidateSet("Global", "USGov")]
        [string]$Environment
    )
    
    switch ($Environment) {
        "USGov" { return "https://graph.microsoft.us" }
        default { return "https://graph.microsoft.com" }
    }
}

#endregion

#region Credential Resolution

<#
.SYNOPSIS
    Resolves the appropriate client credentials with fallback support

.DESCRIPTION
    Checks for Tenant-specific credentials first, then falls back to
    shared/general credentials if Tenant-specific ones are not available.

.OUTPUTS
    Hashtable with ClientId, ClientSecret, and TenantId keys
#>
function Get-M365Credentials {
    param()
    
    # Helper to check if a value is a valid credential (not empty, not an unreplaced ADO variable)
    function Test-ValidCredential {
        param([string]$Value)
        if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
        # Check for unreplaced Azure DevOps variable references like $(varName)
        if ($Value -match '^\$\(.+\)$') { return $false }
        return $true
    }
    
    # Resolve Client ID with priority: Tenant-specific > Azure standard > ARM fallback
    # Note: Check for non-empty strings and filter out unreplaced ADO variable references
    $clientId = $null
    $clientIdSource = $null
    
    # Only use Tenant credentials if BOTH clientId AND clientSecret are valid
    $hasTenantCredentials = (Test-ValidCredential $env:Tenant_CLIENT_ID) -and 
                               (Test-ValidCredential $env:Tenant_CLIENT_SECRET)
    
    if ($hasTenantCredentials) {
        $clientId = $env:Tenant_CLIENT_ID
        $clientIdSource = "Tenant_CLIENT_ID"
    }
    elseif (Test-ValidCredential $env:AZURE_CLIENT_ID) {
        $clientId = $env:AZURE_CLIENT_ID
        $clientIdSource = "AZURE_CLIENT_ID"
    }
    elseif (Test-ValidCredential $env:ARM_CLIENT_ID) {
        $clientId = $env:ARM_CLIENT_ID
        $clientIdSource = "ARM_CLIENT_ID"
    }
    
    # Resolve Client Secret with same priority (use Tenant only if both credentials are present)
    $clientSecret = $null
    $clientSecretSource = $null
    
    if ($hasTenantCredentials) {
        $clientSecret = $env:Tenant_CLIENT_SECRET
        $clientSecretSource = "Tenant_CLIENT_SECRET"
    }
    elseif (Test-ValidCredential $env:AZURE_CLIENT_SECRET) {
        $clientSecret = $env:AZURE_CLIENT_SECRET
        $clientSecretSource = "AZURE_CLIENT_SECRET"
    }
    elseif (Test-ValidCredential $env:ARM_CLIENT_SECRET) {
        $clientSecret = $env:ARM_CLIENT_SECRET
        $clientSecretSource = "ARM_CLIENT_SECRET"
    }
    
    # Resolve Tenant ID
    $tenantId = $null
    $tenantIdSource = $null
    
    if (Test-ValidCredential $env:AZURE_TENANT_ID) {
        $tenantId = $env:AZURE_TENANT_ID
        $tenantIdSource = "AZURE_TENANT_ID"
    }
    elseif (Test-ValidCredential $env:ARM_TENANT_ID) {
        $tenantId = $env:ARM_TENANT_ID
        $tenantIdSource = "ARM_TENANT_ID"
    }
    
    return @{
        ClientId = $clientId
        ClientIdSource = $clientIdSource
        ClientSecret = $clientSecret
        ClientSecretSource = $clientSecretSource
        TenantId = $tenantId
        TenantIdSource = $tenantIdSource
    }
}

#endregion

#region Graph Connection

<#
.SYNOPSIS
    Connects to Microsoft Graph with automatic GCC High detection and credential fallback

.DESCRIPTION
    This function handles the complete connection flow:
    1. Resolves credentials (Tenant-specific with fallback to shared)
    2. Detects if the tenant is GCC High
    3. Connects to the appropriate Microsoft Graph environment

.PARAMETER TenantId
    Optional. The Azure AD tenant ID. If not provided, uses environment variables.

.PARAMETER ClientId
    Optional. The application (client) ID. If not provided, resolves from environment.

.PARAMETER ClientSecret
    Optional. The client secret. If not provided, resolves from environment.

.PARAMETER Scopes
    Optional. Array of scopes for interactive authentication.
    Only used if service principal credentials are not available.

.PARAMETER NoWelcome
    Suppresses the welcome message from Connect-MgGraph

.OUTPUTS
    The Microsoft Graph context object

.EXAMPLE
    # Using environment variables (typical pipeline scenario)
    Connect-M365Graph
    
.EXAMPLE
    # Explicit credentials
    Connect-M365Graph -TenantId "12345..." -ClientId "abcde..." -ClientSecret "secret..."
    
.EXAMPLE
    # Interactive authentication with scopes
    Connect-M365Graph -Scopes @("User.Read.All", "Group.Read.All")
#>
function Connect-M365Graph {
    param(
        [string]$TenantId,
        [string]$ClientId,
        [string]$ClientSecret,
        [string[]]$Scopes,
        [switch]$NoWelcome = $true
    )
    
    Write-Host "Connecting to Microsoft Graph..."
    
    # Resolve credentials from parameters or environment
    $credentials = Get-M365Credentials
    
    $effectiveTenantId = if ($TenantId) { $TenantId } else { $credentials.TenantId }
    $effectiveClientId = if ($ClientId) { $ClientId } else { $credentials.ClientId }
    $effectiveClientSecret = if ($ClientSecret) { $ClientSecret } else { $credentials.ClientSecret }
    
    # Log credential sources for debugging
    if (-not $TenantId -and $credentials.TenantIdSource) {
        Write-Verbose "Using TenantId from $($credentials.TenantIdSource)"
    }
    if (-not $ClientId -and $credentials.ClientIdSource) {
        Write-Verbose "Using ClientId from $($credentials.ClientIdSource)"
        if ($credentials.ClientIdSource -eq "Tenant_CLIENT_ID") {
            Write-Host "  Using Tenant-specific credentials"
        }
    }
    
    # Check if already connected to the right tenant
    $existingContext = Get-MgContext
    if ($existingContext) {
        if ($effectiveTenantId -and $existingContext.TenantId -ne $effectiveTenantId) {
            Write-Host "  Connected to different tenant ($($existingContext.TenantId)), reconnecting to $effectiveTenantId..."
            Disconnect-MgGraph | Out-Null
        }
        else {
            Write-Host "  Already connected to tenant: $($existingContext.TenantId)"
            return $existingContext
        }
    }
    
    # Detect environment (GCC High vs Commercial)
    $environment = "Global"
    if ($effectiveTenantId) {
        $environment = Get-TenantEnvironment -TenantId $effectiveTenantId
        if ($environment -eq "USGov") {
            Write-Host "  GCC High tenant detected - using USGov environment"
        }
    }
    
    # Build connection parameters
    $connectParams = @{
        NoWelcome = $NoWelcome
        Environment = $environment
    }
    
    if ($effectiveClientId -and $effectiveClientSecret -and $effectiveTenantId) {
        # Service Principal authentication
        Write-Host "  Authenticating with Service Principal..."
        $secureSecret = ConvertTo-SecureString $effectiveClientSecret -AsPlainText -Force
        $credential = New-Object System.Management.Automation.PSCredential($effectiveClientId, $secureSecret)

        $connectParams.TenantId = $effectiveTenantId
        $connectParams.ClientSecretCredential = $credential

        # Connect to Microsoft Graph
        Connect-MgGraph @connectParams
    }
    elseif ($env:PORTAL_INTERNAL_KEY -and $env:TENANT_SLUG) {
        # Delegated auth via Config365 token API — preferred over interactive in pipeline context
        # PORTAL_TOKEN_API_URL defaults to http://localhost:4322 if not set
        Write-Host "  Using delegated authentication via Config365 token API..."
        return Connect-M365GraphDelegated
    }
    elseif ($Scopes) {
        # Interactive authentication — only as a last resort (will fail in headless pipelines)
        Write-Host "  Using interactive authentication..."
        $connectParams.Scopes = $Scopes

        if ($effectiveTenantId) {
            $connectParams.TenantId = $effectiveTenantId
        }

        # Connect to Microsoft Graph
        Connect-MgGraph @connectParams
    }
    else {
        throw "No authentication method available. Set PORTAL_TOKEN_API_URL/PORTAL_INTERNAL_KEY/TENANT_SLUG for delegated auth, or AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID for service principal auth."
    }
    
    # Verify connection and return context
    $context = Get-MgContext
    Write-Host "  Connected to tenant: $($context.TenantId)"
    Write-Host "  Environment: $environment"
    Write-Host "  Account: $($context.Account)"
    
    # Store environment in script-level variable for later use
    $script:CurrentGraphEnvironment = $environment
    $script:CurrentGraphBaseUrl = Get-GraphApiBaseUrl -Environment $environment
    
    return $context
}

<#
.SYNOPSIS
    Ensures Microsoft Graph is connected to the expected tenant for this job.

.DESCRIPTION
    Never trusts a bare Get-MgContext — always routes through Connect-M365Graph,
    which disconnects and reconnects when TenantId does not match AZURE_TENANT_ID.
#>
function Ensure-M365GraphConnection {
    param(
        [string[]]$Scopes
    )

    $credentials = Get-M365Credentials
    $expectedTenantId = $credentials.TenantId

    $existingContext = Get-MgContext
    $previousTenantId = if ($existingContext) { $existingContext.TenantId } else { 'none' }

    if ($expectedTenantId) {
        Write-Host "Ensuring Graph connection for tenant $expectedTenantId (was: $previousTenantId)"
    }
    else {
        Write-Host "Ensuring Graph connection (was: $previousTenantId)"
    }

    $connectParams = @{}
    if ($Scopes) { $connectParams['Scopes'] = $Scopes }
    return Connect-M365Graph @connectParams
}

<#
.SYNOPSIS
    Imports AIPService when available; returns $false instead of throwing on Linux runners
    where System.Web.Services is unavailable (IRM/OME via Exchange Online still work).
#>
function Import-AipServiceModuleSafe {
    [CmdletBinding()]
    param()

    if (Get-Module -Name AIPService) { return $true }

    if (-not (Get-Module -ListAvailable -Name AIPService)) {
        Write-Host 'AIPService module is not installed — skipping AIP cmdlets (IRM/OME still available via Exchange Online).'
        return $false
    }

    try {
        Import-Module AIPService -ErrorAction Stop
        return $true
    }
    catch {
        Write-Host "##[warning]AIPService module could not be loaded ($($_.Exception.Message)). AIP backup/deploy will be skipped; IRM/OME via Exchange Online are unaffected."
        return $false
    }
}

<#
.SYNOPSIS
    Disconnects Microsoft Graph and Exchange Online sessions after a pipeline job.
#>
function Disconnect-M365Connections {
    $ctx = Get-MgContext -ErrorAction SilentlyContinue
    if ($ctx) {
        Write-Host "Disconnecting Microsoft Graph (tenant: $($ctx.TenantId))"
        Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
    }

    try {
        if (Get-Module -ListAvailable -Name ExchangeOnlineManagement) {
            Import-Module ExchangeOnlineManagement -ErrorAction SilentlyContinue
            if (Get-Command Disconnect-ExchangeOnline -ErrorAction SilentlyContinue) {
                Write-Host "Disconnecting Exchange Online"
                Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
            }
        }
    }
    catch {
        Write-Host "##[warning]Exchange Online disconnect skipped: $($_.Exception.Message)"
    }

    try {
        if (Get-Module -Name AIPService -ErrorAction SilentlyContinue) {
            if (Get-Command Disconnect-AipService -ErrorAction SilentlyContinue) {
                Write-Host 'Disconnecting Azure Information Protection service'
                Disconnect-AipService -ErrorAction SilentlyContinue | Out-Null
            }
        }
    }
    catch {
        Write-Host "##[warning]AIP service disconnect skipped: $($_.Exception.Message)"
    }

    try {
        if (Get-Command Disconnect-PnPOnline -ErrorAction SilentlyContinue) {
            Write-Host 'Disconnecting SharePoint Online (PnP)'
            Disconnect-PnPOnline -ErrorAction SilentlyContinue | Out-Null
        }
    }
    catch {
        Write-Host "##[warning]SharePoint Online disconnect skipped: $($_.Exception.Message)"
    }
}

<#
.SYNOPSIS
    Gets the current Graph environment and base URL

.OUTPUTS
    Hashtable with Environment and BaseUrl keys
#>
function Get-CurrentGraphEnvironment {
    param()
    
    return @{
        Environment = $script:CurrentGraphEnvironment
        BaseUrl = $script:CurrentGraphBaseUrl
    }
}

#endregion

#endregion

#region Graph Delegated Connection

<#
.SYNOPSIS
    Acquires a Microsoft Graph access token without setting process-global Get-MgContext.

.DESCRIPTION
    Use for Graph REST calls where bearer-per-request isolation is required (e.g. parallel
    backup runspaces, policy compare reads). Verifies JWT tid against AZURE_TENANT_ID when set.
#>
function Get-M365GraphAccessToken {
    param(
        [string]$TenantSlug  = $env:TENANT_SLUG,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    $credentials = Get-M365Credentials
    $effectiveTenantId = $credentials.TenantId

    if ($InternalKey -and $TenantSlug) {
        if (-not $TokenApiUrl) { $TokenApiUrl = 'http://localhost:4322' }

        $response = Invoke-RestMethod `
            -Uri               "$TokenApiUrl/tenant-auth/token" `
            -Method            POST `
            -Headers           @{ Authorization = "Bearer $InternalKey"; 'Content-Type' = 'application/json' } `
            -Body              (ConvertTo-Json @{ tenantSlug = $TenantSlug }) `
            -SkipHttpErrorCheck `
            -TimeoutSec        30

        if ($response.error) {
            throw "[Get-M365GraphAccessToken] Token API error: $($response.error) - $($response.detail)"
        }
        $accessToken = $response.accessToken
        if (-not $accessToken) {
            throw "[Get-M365GraphAccessToken] Token API returned no accessToken."
        }
    }
    elseif ($credentials.ClientId -and $credentials.ClientSecret -and $effectiveTenantId) {
        $environment = Get-TenantEnvironment -TenantId $effectiveTenantId
        $loginHost = if ($environment -eq 'USGov') { 'login.microsoftonline.us' } else { 'login.microsoftonline.com' }
        $tokenUri = "https://$loginHost/$effectiveTenantId/oauth2/v2.0/token"
        $tokenResponse = Invoke-RestMethod -Uri $tokenUri -Method POST -Body @{
            client_id     = $credentials.ClientId
            client_secret = $credentials.ClientSecret
            scope         = 'https://graph.microsoft.com/.default'
            grant_type    = 'client_credentials'
        } -ContentType 'application/x-www-form-urlencoded'
        $accessToken = $tokenResponse.access_token
        if (-not $accessToken) {
            throw "[Get-M365GraphAccessToken] Service principal token request returned no access_token."
        }
    }
    else {
        throw "[Get-M365GraphAccessToken] Set PORTAL_INTERNAL_KEY/TENANT_SLUG or AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID."
    }

    if ($env:AZURE_TENANT_ID) {
        $payload = Get-JwtPayload -Jwt $accessToken
        $tid = if ($payload.tid) { [string]$payload.tid } elseif ($payload.Tid) { [string]$payload.Tid } else { $null }
        if ($tid -and $tid -ne $env:AZURE_TENANT_ID) {
            throw "[Get-M365GraphAccessToken] Token tenant mismatch: tid '$tid' but AZURE_TENANT_ID is '$($env:AZURE_TENANT_ID)'."
        }
    }

    return $accessToken
}

<#
.SYNOPSIS
    Invokes Microsoft Graph REST with an explicit bearer token (no Get-MgContext).
#>
function Invoke-M365GraphRest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [string]$Method = 'GET',
        [string]$AccessToken,
        [object]$Body,
        [string]$ContentType = 'application/json'
    )

    if (-not $AccessToken) {
        $AccessToken = Get-M365GraphAccessToken
    }

    $params = @{
        Uri     = $Uri
        Method  = $Method
        Headers = @{ Authorization = "Bearer $AccessToken" }
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $params.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 20 }
        $params.ContentType = $ContentType
    }

    return Invoke-RestMethod @params
}

<#
.SYNOPSIS
    Resolves the Graph app registration client ID for a tenant from the Config365 token API.

.DESCRIPTION
    Reads the same MSP/tenant Graph client ID used for device-code and token refresh.
    Does not return the client secret.
#>
function Get-Config365GraphAppId {
    [CmdletBinding()]
    param(
        [string]$TenantSlug = $env:TENANT_SLUG,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    if (-not $TenantSlug -or -not $InternalKey) {
        return $null
    }
    if (-not $TokenApiUrl) { $TokenApiUrl = 'http://localhost:4322' }

    try {
        $response = Invoke-RestMethod `
            -Uri               "$TokenApiUrl/tenant-auth/graph-app?tenantSlug=$([uri]::EscapeDataString($TenantSlug))" `
            -Method            GET `
            -Headers           @{ Authorization = "Bearer $InternalKey" } `
            -SkipHttpErrorCheck `
            -TimeoutSec        30

        if ($response.error) {
            Write-Warning "[Get-Config365GraphAppId] Token API error: $($response.error) - $($response.detail)"
            return $null
        }
        if ($response.clientId) {
            return [string]$response.clientId
        }
    }
    catch {
        Write-Warning "[Get-Config365GraphAppId] Failed: $_"
    }
    return $null
}

<#
.SYNOPSIS
    Connects to Microsoft Graph using a delegated access token from the Config365 token API.

.DESCRIPTION
    Fetches a short-lived Graph access token from the internal token API using the stored
    delegated refresh token, then connects Connect-MgGraph via that token.

    Prerequisites:
      - The tenant must be authenticated via the Config365 device code flow.
      - PORTAL_TOKEN_API_URL and PORTAL_INTERNAL_KEY must be set.
      - TENANT_SLUG must be set (Gitea repo variable).

.PARAMETER TenantSlug
    The Config365 tenant slug. Defaults to $env:TENANT_SLUG.

.PARAMETER TokenApiUrl
    URL of the internal token API. Defaults to $env:PORTAL_TOKEN_API_URL.

.PARAMETER InternalKey
    The MSP portal internal key. Defaults to $env:PORTAL_INTERNAL_KEY.
#>
function Connect-M365GraphDelegated {
    param(
        [string]$TenantSlug  = $env:TENANT_SLUG,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    if (-not $TenantSlug)  { throw "TenantSlug is required (set TENANT_SLUG env var)" }
    if (-not $TokenApiUrl) { $TokenApiUrl = 'http://localhost:4322' }
    if (-not $InternalKey) { throw "InternalKey is required (set PORTAL_INTERNAL_KEY env var)" }

    Write-Host "Getting Microsoft Graph delegated token for tenant '$TenantSlug'..."

    $accessToken = Get-M365GraphAccessToken -TenantSlug $TenantSlug -TokenApiUrl $TokenApiUrl -InternalKey $InternalKey

    $secureToken = ConvertTo-SecureString $accessToken -AsPlainText -Force
    Connect-MgGraph -AccessToken $secureToken -NoWelcome

    $context = Get-MgContext
    Write-Host "  Connected via delegated auth to tenant: $($context.TenantId)"
    Write-Host "  Account: $($context.Account)"

    # Guard: verify the connected tenant matches the expected AZURE_TENANT_ID repo variable.
    # This catches the case where the portal token belongs to a different Entra directory
    # than the one this pipeline is supposed to manage.
    if ($env:AZURE_TENANT_ID) {
        if ($context.TenantId -ne $env:AZURE_TENANT_ID) {
            throw "Tenant ID mismatch: token is for '$($context.TenantId)' but AZURE_TENANT_ID is '$($env:AZURE_TENANT_ID)'. Re-authenticate the tenant via the Config365 portal."
        }
        Write-Host "  Tenant ID verified: $($context.TenantId)"
    }

    $script:CurrentGraphEnvironment = "Global"
    $script:CurrentGraphBaseUrl     = "https://graph.microsoft.com"

    return $context
}

#endregion

#region Exchange Online Delegated Connection

<#
.SYNOPSIS
    Connects to Exchange Online using a delegated access token from the Config365 token API.

.DESCRIPTION
    Fetches a short-lived Exchange Online token (outlook.office365.com resource) from the
    internal token API using the stored delegated refresh token. Passes it directly to
    Connect-ExchangeOnline, eliminating the need for a certificate.

    Prerequisites:
      - The tenant must be authenticated via the Config365 device code flow.
      - PORTAL_TOKEN_API_URL and PORTAL_INTERNAL_KEY must be set (set by the pipeline env block).
      - TENANT_SLUG must be set (set as a Gitea repo variable).
      - AZURE_TENANT_ID must be set (used as the DelegatedOrganization value).

.PARAMETER TenantSlug
    The Config365 tenant slug. Defaults to $env:TENANT_SLUG.

.PARAMETER TenantId
    The managed tenant ID or primary domain. Defaults to $env:AZURE_TENANT_ID.

.PARAMETER TokenApiUrl
    URL of the internal token API. Defaults to $env:PORTAL_TOKEN_API_URL.

.PARAMETER InternalKey
    The MSP portal internal key. Defaults to $env:PORTAL_INTERNAL_KEY.
#>
function Get-JwtPayload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Jwt
    )

    try {
        $segment = ($Jwt -split '\.')[1]
        if (-not $segment) { return $null }
        $base64 = $segment -replace '-', '+' -replace '_', '/'
        $pad = 4 - ($base64.Length % 4)
        if ($pad -ne 4) { $base64 = $base64.PadRight($base64.Length + $pad, '=') }
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64))
        return $json | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-ExchangeDelegatedUserPrincipalName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AccessToken,
        [string]$TokenApiUpn
    )

    if ($TokenApiUpn) { return $TokenApiUpn }

    $payload = Get-JwtPayload -Jwt $AccessToken
    if (-not $payload) { return $null }

    foreach ($claim in @('upn', 'preferred_username', 'unique_name', 'email')) {
        if ($payload.PSObject.Properties.Name -contains $claim -and $payload.$claim) {
            return [string]$payload.$claim
        }
    }
    return $null
}

function Connect-ExchangeOnlineDelegated {
    param(
        [string]$TenantSlug  = $env:TENANT_SLUG,
        [string]$TenantId    = $env:AZURE_TENANT_ID,
        [string]$OrgName     = $env:EXCHANGE_ORG_NAME,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    Ensure-ExchangeOnlineConnection `
        -TenantSlug  $TenantSlug `
        -TenantId    $TenantId `
        -OrgName     $OrgName `
        -TokenApiUrl $TokenApiUrl `
        -InternalKey $InternalKey
}

<#
.SYNOPSIS
    Ensures Exchange Online is connected to the expected tenant for this job.

.DESCRIPTION
    Disconnects any stale EXO session, fetches a fresh delegated token for TENANT_SLUG,
    verifies JWT tid against AZURE_TENANT_ID, then connects. Required for parallel pipeline
    jobs that share the same container user (root) without cross-tenant session bleed.
#>
function Ensure-ExchangeOnlineConnection {
    param(
        [string]$TenantSlug  = $env:TENANT_SLUG,
        [string]$TenantId    = $env:AZURE_TENANT_ID,
        [string]$OrgName     = $env:EXCHANGE_ORG_NAME,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    if (-not $TenantSlug)  { throw "TenantSlug is required (set TENANT_SLUG env var or pass -TenantSlug)" }
    if (-not $TenantId)    { throw "TenantId is required (set AZURE_TENANT_ID env var or pass -TenantId)" }
    if (-not $TokenApiUrl) { $TokenApiUrl = 'http://localhost:4322' }
    if (-not $InternalKey) { throw "InternalKey is required (set PORTAL_INTERNAL_KEY env var)" }

    # Clear any cached EXO session/token before connecting (parallel jobs on shared host).
    if (Get-Module -ListAvailable -Name ExchangeOnlineManagement) {
        Import-Module ExchangeOnlineManagement -ErrorAction SilentlyContinue
        if (Get-Command Disconnect-ExchangeOnline -ErrorAction SilentlyContinue) {
            Write-Host "Disconnecting any existing Exchange Online session before reconnect..."
            Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
        }
    }

    Write-Host "Ensuring Exchange Online connection for tenant '$TenantSlug' (expected tid: $TenantId)..."

    $response = Invoke-RestMethod `
        -Uri               "$TokenApiUrl/tenant-auth/token" `
        -Method            POST `
        -Headers           @{ Authorization = "Bearer $InternalKey"; 'Content-Type' = 'application/json' } `
        -Body              (ConvertTo-Json @{ tenantSlug = $TenantSlug; resource = 'exchange' }) `
        -SkipHttpErrorCheck `
        -TimeoutSec        30

    if ($response.error) {
        throw "[Ensure-ExchangeOnlineConnection] Token API error: $($response.error) - $($response.detail)"
    }
    $exchangeToken = $response.accessToken
    if (-not $exchangeToken) {
        throw "[Ensure-ExchangeOnlineConnection] Token API returned no accessToken. Ensure the tenant is authenticated."
    }

    $payload = Get-JwtPayload -Jwt $exchangeToken
    $tokenTid = if ($payload -and ($payload.PSObject.Properties.Name -contains 'tid')) { [string]$payload.tid } else { $null }
    if ($tokenTid -and $tokenTid -ne $TenantId) {
        throw "[Ensure-ExchangeOnlineConnection] Token tenant mismatch: JWT tid '$tokenTid' != AZURE_TENANT_ID '$TenantId' for slug '$TenantSlug'. Re-authenticate the tenant in the portal."
    }
    if ($tokenTid) {
        Write-Host "  Exchange token tid verified: $tokenTid"
    }

    if (-not $OrgName -and $response.organizationName) {
        $OrgName = $response.organizationName
    }
    if (-not $OrgName) {
        throw "[Ensure-ExchangeOnlineConnection] OrgName is required. Set EXCHANGE_ORG_NAME, or ensure the tenant domain is saved in portal settings."
    }

    $userPrincipalName = Get-ExchangeDelegatedUserPrincipalName -AccessToken $exchangeToken -TokenApiUpn $response.userPrincipalName
    if (-not $userPrincipalName) {
        throw "[Ensure-ExchangeOnlineConnection] Could not determine UserPrincipalName from the Exchange access token. Re-connect the tenant in the portal using an Exchange Administrator account."
    }

    if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
        Write-Host "Installing ExchangeOnlineManagement module..."
        Install-Module -Name ExchangeOnlineManagement -Force -AllowClobber -Scope CurrentUser
    }
    Import-Module ExchangeOnlineManagement -ErrorAction Stop

    Connect-ExchangeOnline `
        -AccessToken        $exchangeToken `
        -Organization       $OrgName `
        -UserPrincipalName  $userPrincipalName `
        -ShowBanner:$false

    Write-Host "Connected to Exchange Online: slug=$TenantSlug tid=$TenantId org=$OrgName upn=$userPrincipalName"

    $script:ExoDelegatedAccessToken = $exchangeToken
    $script:ExoDelegatedUserPrincipalName = $userPrincipalName
    $script:ExoDelegatedOrganization = $OrgName
    $script:ExoDelegatedTenantId = $TenantId

    $null = Ensure-ExchangeOrganizationManagementRole -UserPrincipalName $userPrincipalName
}

function Get-IPPSSessionConnectSplat {
    param(
        [Parameter(Mandatory)][string]$AccessToken,
        [Parameter(Mandatory)][string]$UserPrincipalName,
        [Parameter(Mandatory)][string]$Organization,
        [Parameter(Mandatory)][string]$TenantId
    )

    $environment = Get-TenantEnvironment -TenantId $TenantId
    $splat = @{
        AccessToken       = $AccessToken
        UserPrincipalName = $UserPrincipalName
        Organization      = $Organization
        ShowBanner        = $false
    }
    if ($environment -eq 'USGov') {
        $splat['AzureADAuthorizationEndpointUri'] = "https://login.microsoftonline.us/$TenantId/oauth2/authorize"
    }
    return $splat
}

function Connect-IPPSSessionDelegated {
    param(
        [string]$TenantSlug  = $env:TENANT_SLUG,
        [string]$TenantId    = $env:AZURE_TENANT_ID,
        [string]$OrgName     = $env:EXCHANGE_ORG_NAME,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    Ensure-IPPSSessionConnection `
        -TenantSlug  $TenantSlug `
        -TenantId    $TenantId `
        -OrgName     $OrgName `
        -TokenApiUrl $TokenApiUrl `
        -InternalKey $InternalKey
}

<#
.SYNOPSIS
    Ensures Security & Compliance PowerShell (IPPS) is connected for this job.

.DESCRIPTION
    Fetches a delegated Exchange token (same resource as EXO) and connects via
    Connect-IPPSSession. Required for sensitivity labels, label policies, and
    auto-labeling cmdlets (Get-Label, Get-LabelPolicy, etc.).
#>
function Ensure-IPPSSessionConnection {
    param(
        [string]$TenantSlug  = $env:TENANT_SLUG,
        [string]$TenantId    = $env:AZURE_TENANT_ID,
        [string]$OrgName     = $env:EXCHANGE_ORG_NAME,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    if (-not $TenantSlug)  { throw "TenantSlug is required (set TENANT_SLUG env var or pass -TenantSlug)" }
    if (-not $TenantId)    { throw "TenantId is required (set AZURE_TENANT_ID env var or pass -TenantId)" }
    if (-not $TokenApiUrl) { $TokenApiUrl = 'http://localhost:4322' }
    if (-not $InternalKey) { throw "InternalKey is required (set PORTAL_INTERNAL_KEY env var)" }

    if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
        Write-Host "Installing ExchangeOnlineManagement module..."
        Install-Module -Name ExchangeOnlineManagement -Force -AllowClobber -Scope CurrentUser
    }
    Import-Module ExchangeOnlineManagement -ErrorAction Stop

    if (Get-Command Disconnect-ExchangeOnline -ErrorAction SilentlyContinue) {
        Write-Host "Disconnecting any existing Exchange/IPPS session before reconnect..."
        Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    }

    Write-Host "Ensuring Security & Compliance (IPPS) connection for tenant '$TenantSlug' (expected tid: $TenantId)..."

    $response = Invoke-RestMethod `
        -Uri               "$TokenApiUrl/tenant-auth/token" `
        -Method            POST `
        -Headers           @{ Authorization = "Bearer $InternalKey"; 'Content-Type' = 'application/json' } `
        -Body              (ConvertTo-Json @{ tenantSlug = $TenantSlug; resource = 'exchange' }) `
        -SkipHttpErrorCheck `
        -TimeoutSec        30

    if ($response.error) {
        throw "[Ensure-IPPSSessionConnection] Token API error: $($response.error) - $($response.detail)"
    }
    $accessToken = $response.accessToken
    if (-not $accessToken) {
        throw "[Ensure-IPPSSessionConnection] Token API returned no accessToken. Ensure the tenant is authenticated."
    }

    $payload = Get-JwtPayload -Jwt $accessToken
    $tokenTid = if ($payload -and ($payload.PSObject.Properties.Name -contains 'tid')) { [string]$payload.tid } else { $null }
    if ($tokenTid -and $tokenTid -ne $TenantId) {
        throw "[Ensure-IPPSSessionConnection] Token tenant mismatch: JWT tid '$tokenTid' != AZURE_TENANT_ID '$TenantId' for slug '$TenantSlug'. Re-authenticate the tenant in the portal."
    }

    if (-not $OrgName -and $response.organizationName) {
        $OrgName = $response.organizationName
    }
    if (-not $OrgName) {
        throw "[Ensure-IPPSSessionConnection] OrgName is required. Set EXCHANGE_ORG_NAME, or ensure the tenant domain is saved in portal settings."
    }

    $userPrincipalName = Get-ExchangeDelegatedUserPrincipalName -AccessToken $accessToken -TokenApiUpn $response.userPrincipalName
    if (-not $userPrincipalName) {
        throw "[Ensure-IPPSSessionConnection] Could not determine UserPrincipalName from the access token. Re-connect the tenant in the portal using a Compliance Administrator account."
    }

    if (-not (Get-Command Connect-IPPSSession -ErrorAction SilentlyContinue)) {
        throw "Connect-IPPSSession cmdlet not found. Install ExchangeOnlineManagement module version 3.2.0 or later."
    }

    $connectSplat = Get-IPPSSessionConnectSplat `
        -AccessToken $accessToken `
        -UserPrincipalName $userPrincipalName `
        -Organization $OrgName `
        -TenantId $TenantId

    Connect-IPPSSession @connectSplat

    Write-Host "Connected to Security & Compliance PowerShell: slug=$TenantSlug tid=$TenantId org=$OrgName upn=$userPrincipalName"

    $script:IppsDelegatedAccessToken = $accessToken
    $script:IppsDelegatedUserPrincipalName = $userPrincipalName
    $script:IppsDelegatedOrganization = $OrgName
    $script:IppsDelegatedTenantId = $TenantId
}

function Connect-AipServiceDelegated {
    param(
        [string]$TenantSlug  = $env:TENANT_SLUG,
        [string]$TenantId    = $env:AZURE_TENANT_ID,
        [string]$OrgName     = $env:EXCHANGE_ORG_NAME,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    Ensure-AipServiceConnection `
        -TenantSlug  $TenantSlug `
        -TenantId    $TenantId `
        -OrgName     $OrgName `
        -TokenApiUrl $TokenApiUrl `
        -InternalKey $InternalKey
}

<#
.SYNOPSIS
    Ensures Azure Information Protection (AIP) service PowerShell is connected.

.DESCRIPTION
    Uses the same delegated Exchange token as EXO/IPPS. Required for Get-AipService,
    Enable-AipService, and Get-AipServiceConfiguration per the Prof-IT AIP remediation guide.
#>
function Ensure-AipServiceConnection {
    param(
        [string]$TenantSlug  = $env:TENANT_SLUG,
        [string]$TenantId    = $env:AZURE_TENANT_ID,
        [string]$OrgName     = $env:EXCHANGE_ORG_NAME,
        [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey = $env:PORTAL_INTERNAL_KEY
    )

    if (-not $TenantSlug)  { throw "TenantSlug is required (set TENANT_SLUG env var or pass -TenantSlug)" }
    if (-not $TenantId)    { throw "TenantId is required (set AZURE_TENANT_ID env var or pass -TenantId)" }
    if (-not $TokenApiUrl) { $TokenApiUrl = 'http://localhost:4322' }
    if (-not $InternalKey) { throw "InternalKey is required (set PORTAL_INTERNAL_KEY env var)" }

    if (-not (Get-Module -ListAvailable -Name AIPService)) {
        Write-Host 'Installing AIPService module...'
        Install-Module -Name AIPService -Force -AllowClobber -Scope CurrentUser -Confirm:$false
    }
    if (-not (Import-AipServiceModuleSafe)) {
        throw '[Ensure-AipServiceConnection] AIPService module unavailable on this runner.'
    }

    if (Get-Command Disconnect-AipService -ErrorAction SilentlyContinue) {
        Write-Host 'Disconnecting any existing AIP service session before reconnect...'
        Disconnect-AipService -ErrorAction SilentlyContinue | Out-Null
    }

    $accessToken = $script:ExoDelegatedAccessToken
    if (-not $accessToken) {
        Write-Host "Ensuring AIP service connection for tenant '$TenantSlug' (expected tid: $TenantId)..."

        $response = Invoke-RestMethod `
            -Uri               "$TokenApiUrl/tenant-auth/token" `
            -Method            POST `
            -Headers           @{ Authorization = "Bearer $InternalKey"; 'Content-Type' = 'application/json' } `
            -Body              (ConvertTo-Json @{ tenantSlug = $TenantSlug; resource = 'exchange' }) `
            -SkipHttpErrorCheck `
            -TimeoutSec        30

        if ($response.error) {
            throw "[Ensure-AipServiceConnection] Token API error: $($response.error) - $($response.detail)"
        }
        $accessToken = $response.accessToken
        if (-not $accessToken) {
            throw "[Ensure-AipServiceConnection] Token API returned no accessToken. Ensure the tenant is authenticated."
        }

        $payload = Get-JwtPayload -Jwt $accessToken
        $tokenTid = if ($payload -and ($payload.PSObject.Properties.Name -contains 'tid')) { [string]$payload.tid } else { $null }
        if ($tokenTid -and $tokenTid -ne $TenantId) {
            throw "[Ensure-AipServiceConnection] Token tenant mismatch: JWT tid '$tokenTid' != AZURE_TENANT_ID '$TenantId' for slug '$TenantSlug'. Re-authenticate the tenant in the portal."
        }
    }
    else {
        Write-Host "Reusing delegated Exchange access token for AIP service connection (tenant '$TenantSlug')..."
    }

    $connectSplat = @{
        AccessToken = $accessToken
        TenantId    = $TenantId
    }
    $environment = Get-TenantEnvironment -TenantId $TenantId
    if ($environment -eq 'USGov') {
        $connectSplat['EnvironmentName'] = 'AzureUSGovernment'
    }

    Connect-AipService @connectSplat
    Write-Host "Connected to Azure Information Protection service: slug=$TenantSlug tid=$TenantId"

    $script:AipServiceDelegatedAccessToken = $accessToken
    $script:AipServiceDelegatedTenantId = $TenantId
}

function Test-ExchangeOrganizationManagementMember {
    param([Parameter(Mandatory)][string]$UserPrincipalName)

    $members = @(Get-RoleGroupMember -Identity 'Organization Management' -ErrorAction Stop)
    $match = $members | Where-Object {
        ($_.PrimarySmtpAddress -and $_.PrimarySmtpAddress -ieq $UserPrincipalName) -or
        ($_.WindowsLiveID -and $_.WindowsLiveID -ieq $UserPrincipalName) -or
        ($_.Name -and $UserPrincipalName -and $_.Name -ieq ($UserPrincipalName -replace '@.*', ''))
    } | Select-Object -First 1
    return [bool]$match
}

function Ensure-ExchangeOrganizationManagementRole {
    param([Parameter(Mandatory)][string]$UserPrincipalName)

    try {
        if (Test-ExchangeOrganizationManagementMember -UserPrincipalName $UserPrincipalName) {
            Write-Host "Exchange RBAC: $UserPrincipalName already in Organization Management"
            return $true
        }

        Write-Host "Exchange RBAC: adding $UserPrincipalName to Organization Management (required for Get-ExternalInOutlook)..."
        Add-RoleGroupMember -Identity 'Organization Management' -Member $UserPrincipalName -ErrorAction Stop
        Start-Sleep -Seconds 5

        if (Test-ExchangeOrganizationManagementMember -UserPrincipalName $UserPrincipalName) {
            Write-Host "Exchange RBAC: Organization Management membership confirmed"
            return $true
        }

        Write-Warning "Exchange RBAC: Add-RoleGroupMember completed but membership not yet visible"
        return $false
    }
    catch {
        Write-Warning "Exchange RBAC: could not add $UserPrincipalName to Organization Management: $_"
        Write-Warning "If Get-ExternalInOutlook fails, add this account to Organization Management manually in Exchange admin center."
        return $false
    }
}

function Invoke-ExoAdminCmdletRest {
    param(
        [Parameter(Mandatory)][string]$CmdletName,
        [hashtable]$Parameters = @{},
        [string]$AccessToken = $script:ExoDelegatedAccessToken,
        [string]$AnchorUpn = $script:ExoDelegatedUserPrincipalName,
        [string]$TenantKey = $script:ExoDelegatedTenantId,
        [int]$TimeoutSec = 45
    )

    if (-not $AccessToken -or -not $AnchorUpn -or -not $TenantKey) {
        throw 'Invoke-ExoAdminCmdletRest requires an active Connect-ExchangeOnlineDelegated session.'
    }

    $payload = @{
        CmdletInput = @{
            CmdletName = $CmdletName
            Parameters = $Parameters
        }
    } | ConvertTo-Json -Depth 10

    $headers = @{
        Authorization         = "Bearer $AccessToken"
        'X-CmdletName'        = $CmdletName
        'X-ResponseFormat'    = 'json'
        'X-ClientApplication' = 'ExoManagementModule'
        'X-AnchorMailbox'     = $AnchorUpn
        Accept                = 'application/json'
        'Content-Type'        = 'application/json'
    }

    $uri = "https://outlook.office365.com/adminapi/beta/$TenantKey/InvokeCommand"

    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $uri)
        $request.Content = [System.Net.Http.StringContent]::new($payload, [System.Text.Encoding]::UTF8, 'application/json')
        foreach ($key in $headers.Keys) {
            if ($key -eq 'Content-Type') { continue }
            $null = $request.Headers.TryAddWithoutValidation($key, [string]$headers[$key])
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "HTTP $([int]$response.StatusCode): $body"
        }
        return ($body | ConvertFrom-Json)
    }
    finally {
        $client.Dispose()
    }
}

function Get-ExternalInOutlookConfiguration {
    param([int]$RestTimeoutSec = 20)

    foreach ($tenantKey in @($script:ExoDelegatedOrganization, $script:ExoDelegatedTenantId)) {
        if (-not $tenantKey) { continue }
        try {
            Write-Host "  Trying adminApi InvokeCommand Get-ExternalInOutlook ($tenantKey)..."
            $json = Invoke-ExoAdminCmdletRest -CmdletName 'Get-ExternalInOutlook' -TenantKey $tenantKey -TimeoutSec $RestTimeoutSec
            $row = $null
            if ($json.value) { $row = @($json.value) | Select-Object -First 1 }
            if ($row) {
                return @{
                    Enabled   = [bool]$row.Enabled
                    AllowList = @($row.AllowList | Where-Object { $_ })
                    Source    = "InvokeCommand/$tenantKey"
                }
            }
            Write-Host "  InvokeCommand ($tenantKey): empty value array"
        }
        catch {
            Write-Host "  InvokeCommand ($tenantKey) failed: $($_.Exception.Message)"
        }
    }

    return $null
}

function Set-ExternalInOutlookConfiguration {
    param(
        [Parameter(Mandatory)][hashtable]$Parameters,
        [int]$RestTimeoutSec = 45,
        [int]$MaxAttempts = 3
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        foreach ($tenantKey in @($script:ExoDelegatedOrganization, $script:ExoDelegatedTenantId)) {
            if (-not $tenantKey) { continue }
            try {
                if ($attempt -gt 1) {
                    Write-Host "  Set-ExternalInOutlook retry attempt $attempt of $MaxAttempts ($tenantKey)..."
                }
                else {
                    Write-Host "  Trying adminApi InvokeCommand Set-ExternalInOutlook ($tenantKey)..."
                }
                $json = Invoke-ExoAdminCmdletRest -CmdletName 'Set-ExternalInOutlook' -Parameters $Parameters -TenantKey $tenantKey -TimeoutSec $RestTimeoutSec
                if ($json.error) {
                    $errMsg = if ($json.error.message) { $json.error.message } else { ($json.error | ConvertTo-Json -Compress) }
                    throw $errMsg
                }
                return @{
                    Success  = $true
                    Source   = "InvokeCommand/$tenantKey"
                    Response = $json
                }
            }
            catch {
                $lastError = $_
                Write-Host "  InvokeCommand Set-ExternalInOutlook ($tenantKey) failed: $($_.Exception.Message)"
            }
        }
        if ($attempt -lt $MaxAttempts) {
            Start-Sleep -Seconds 10
        }
    }

    throw "Set-ExternalInOutlook failed after $MaxAttempts attempts: $lastError"
}

#endregion

#region SharePoint Online Delegated Connection (PnP)

<#
.SYNOPSIS
    Connects to SharePoint Online admin using a delegated token from the Config365 token API.

.DESCRIPTION
    Fetches a SharePoint resource token and connects with PnP.PowerShell to the tenant admin URL.
    Requires SharePoint delegated permissions (e.g. AllSites.FullControl) on the Config365 app.
#>
function Connect-SharePointOnlineDelegated {
    param(
        [string]$TenantSlug       = $env:TENANT_SLUG,
        [string]$TenantId         = $env:AZURE_TENANT_ID,
        [string]$OrgName          = $env:EXCHANGE_ORG_NAME,
        [string]$TokenApiUrl      = $env:PORTAL_TOKEN_API_URL,
        [string]$InternalKey      = $env:PORTAL_INTERNAL_KEY,
        [string]$SharePointAdminUrl = $env:SHAREPOINT_ADMIN_URL
    )

    if (-not $TenantSlug) { throw 'TenantSlug is required (set TENANT_SLUG env var or pass -TenantSlug)' }
    if (-not $TenantId) { throw 'TenantId is required (set AZURE_TENANT_ID env var or pass -TenantId)' }
    if (-not $TokenApiUrl) { $TokenApiUrl = 'http://127.0.0.1:4322' }
    if (-not $InternalKey) { throw 'InternalKey is required (set PORTAL_INTERNAL_KEY env var)' }

    $settingsPath = Join-Path $PSScriptRoot '..\graph-configs\SharePoint-TenantSettings.ps1'
    if (Test-Path $settingsPath) {
        . $settingsPath
    }
    elseif (Test-Path '/scripts-staging/graph-configs/SharePoint-TenantSettings.ps1') {
        . '/scripts-staging/graph-configs/SharePoint-TenantSettings.ps1'
    }
    else {
        throw 'SharePoint-TenantSettings.ps1 helpers not found'
    }

    if (-not (Import-PnPModuleSafe)) {
        throw 'PnP.PowerShell module is not available'
    }

    if (Get-Command Disconnect-PnPOnline -ErrorAction SilentlyContinue) {
        Write-Host 'Disconnecting any existing SharePoint Online (PnP) session before reconnect...'
        Disconnect-PnPOnline -ErrorAction SilentlyContinue | Out-Null
    }

    Write-Host "Ensuring SharePoint Online connection for tenant '$TenantSlug' (expected tid: $TenantId)..."

    $response = Invoke-RestMethod `
        -Uri        "$TokenApiUrl/tenant-auth/token" `
        -Method     POST `
        -Headers    @{ Authorization = "Bearer $InternalKey"; 'Content-Type' = 'application/json' } `
        -Body       (ConvertTo-Json @{ tenantSlug = $TenantSlug; resource = 'sharepoint' }) `
        -SkipHttpErrorCheck `
        -TimeoutSec 30

    if ($response.error) {
        throw "[Connect-SharePointOnlineDelegated] Token API error: $($response.error) - $($response.detail)"
    }

    $accessToken = $response.accessToken
    if (-not $accessToken) {
        throw '[Connect-SharePointOnlineDelegated] Token API returned no accessToken. Ensure SharePoint delegated permissions are consented.'
    }

    $payload = Get-JwtPayload -Jwt $accessToken
    $tokenTid = if ($payload -and ($payload.PSObject.Properties.Name -contains 'tid')) { [string]$payload.tid } else { $null }
    if ($tokenTid -and $tokenTid -ne $TenantId) {
        throw "[Connect-SharePointOnlineDelegated] Token tenant mismatch: JWT tid '$tokenTid' != AZURE_TENANT_ID '$TenantId'"
    }

    $adminUrl = $SharePointAdminUrl
    if (-not $adminUrl -and $response.sharePointAdminUrl) {
        $adminUrl = $response.sharePointAdminUrl
    }
    if (-not $adminUrl) {
        $domain = if ($OrgName) { $OrgName } else { $response.organizationName }
        $prefix = Get-SharePointTenantPrefixFromDomain -Domain $domain
        if ($prefix) {
            $adminUrl = Get-SharePointAdminUrlFromPrefix -TenantPrefix $prefix
        }
    }
    if (-not $adminUrl) {
        throw '[Connect-SharePointOnlineDelegated] Could not determine SharePoint admin URL. Set SHAREPOINT_ADMIN_URL or ensure tenant domain is saved.'
    }

    Connect-PnPOnline -Url $adminUrl -AccessToken $accessToken -ErrorAction Stop

    $script:SpoDelegatedAccessToken = $accessToken
    $script:SpoDelegatedAdminUrl = $adminUrl
    $script:SpoDelegatedTenantId = $TenantId

    Write-Host "Connected to SharePoint Online: slug=$TenantSlug tid=$TenantId admin=$adminUrl"
}

#endregion

# Export functions when dot-sourced
# Note: When dot-sourcing a .ps1 file, all functions become available automatically

