<#
.SYNOPSIS
    Generates admin consent URLs for Tenant tenants

.DESCRIPTION
    This script generates the admin consent URL that Tenant Global Administrators
    need to visit to grant permissions to the multi-tenant app.

.PARAMETER ClientId
    The Application (Client) ID of your multi-tenant app registration

.PARAMETER TenantName
    Optional Tenant name to include in the state parameter

.EXAMPLE
    .\Generate-ConsentUrl.ps1 -ClientId "12345678-1234-1234-1234-123456789012"

.EXAMPLE
    .\Generate-ConsentUrl.ps1 -ClientId "12345678-1234-1234-1234-123456789012" -TenantName "Contoso"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$ClientId,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantName
)

Write-Host "`n" + ("=" * 80) -ForegroundColor Cyan
Write-Host "Multi-Tenant App - Tenant Consent URL Generator" -ForegroundColor Cyan
Write-Host ("=" * 80) -ForegroundColor Cyan
Write-Host ""

# Get Client ID if not provided
if (-not $ClientId) {
    $ClientId = Read-Host "Enter the Application (Client) ID of your multi-tenant app"
}

# Get Tenant Name if not provided
if (-not $TenantName) {
    $TenantName = Read-Host "Enter Tenant name (optional, press Enter to skip)"
}

# Generate consent URL
$baseUrl = "https://login.microsoftonline.com/organizations/v2.0/adminconsent"
$redirectUri = "https://portal.azure.com"
$scope = "https://graph.microsoft.com/.default"

if ($TenantName) {
    $consentUrl = "$baseUrl`?client_id=$ClientId&redirect_uri=$redirectUri&scope=$scope&state=$TenantName"
} else {
    $consentUrl = "$baseUrl`?client_id=$ClientId&redirect_uri=$redirectUri&scope=$scope"
}

# Display instructions
Write-Host "ADMIN CONSENT URL" -ForegroundColor Yellow
Write-Host ("=" * 80) -ForegroundColor Yellow
Write-Host ""
Write-Host $consentUrl -ForegroundColor Cyan
Write-Host ""
Write-Host ("=" * 80) -ForegroundColor Yellow
Write-Host ""

Write-Host "INSTRUCTIONS FOR Tenant GLOBAL ADMINISTRATOR" -ForegroundColor Green
Write-Host ("=" * 80) -ForegroundColor Green
Write-Host ""
Write-Host "1. Copy the URL above" -ForegroundColor White
Write-Host "2. Open in a browser while signed in as Global Administrator" -ForegroundColor White
Write-Host "3. Review the requested permissions" -ForegroundColor White
Write-Host "4. Click 'Accept' to grant admin consent" -ForegroundColor White
Write-Host "5. After successful consent, provide your Tenant ID back to the MSP" -ForegroundColor White
Write-Host ""

Write-Host "PERMISSIONS REQUESTED" -ForegroundColor Yellow
Write-Host ("=" * 80) -ForegroundColor Yellow
Write-Host ""
Write-Host "The app will request these Microsoft Graph permissions:" -ForegroundColor White
Write-Host "  ✓ Directory.ReadWrite.All" -ForegroundColor White
Write-Host "  ✓ Policy.ReadWrite.All (includes mobility/MDM scope)" -ForegroundColor White
Write-Host "  ✓ Policy.ReadWrite.MobilityManagement" -ForegroundColor White
Write-Host "  ✓ Group.Read.All" -ForegroundColor White
Write-Host "  ✓ Policy.ReadWrite.ConditionalAccess" -ForegroundColor White
Write-Host "  ✓ Policy.ReadWrite.AuthenticationMethod" -ForegroundColor White
Write-Host "  ✓ Group.ReadWrite.All" -ForegroundColor White
Write-Host "  ✓ Application.ReadWrite.All" -ForegroundColor White
Write-Host "  ✓ TeamSettings.ReadWrite.All" -ForegroundColor White
Write-Host "  ✓ Sites.FullControl.All" -ForegroundColor White
Write-Host "  ✓ DeviceManagementConfiguration.ReadWrite.All" -ForegroundColor White
Write-Host "  ✓ DeviceManagementManagedDevices.ReadWrite.All" -ForegroundColor White
Write-Host ""

Write-Host "AFTER CONSENT" -ForegroundColor Yellow
Write-Host ("=" * 80) -ForegroundColor Yellow
Write-Host ""
Write-Host "Request the Tenant to provide:" -ForegroundColor White
Write-Host "  - Their Azure AD Tenant ID (found in Azure Portal > Azure AD > Overview)" -ForegroundColor Cyan
Write-Host ""
Write-Host "You will use:" -ForegroundColor White
Write-Host "  - Tenant's Tenant ID: <from Tenant>" -ForegroundColor Yellow
Write-Host "  - Your Client ID:       <from Azure DevOps variable group (secret)>" -ForegroundColor Yellow
Write-Host "  - Your Client Secret:   <from Azure DevOps variable group (secret)>" -ForegroundColor Yellow
Write-Host ""

# Option to copy to clipboard
if ($IsWindows -or $PSVersionTable.PSVersion.Major -lt 6) {
    Write-Host "Copy URL to clipboard? (Y/N): " -NoNewline -ForegroundColor Yellow
    $response = Read-Host
    if ($response -eq 'Y' -or $response -eq 'y') {
        $consentUrl | Set-Clipboard
        Write-Host "✓ URL copied to clipboard!" -ForegroundColor Green
    }
}

Write-Host ""

