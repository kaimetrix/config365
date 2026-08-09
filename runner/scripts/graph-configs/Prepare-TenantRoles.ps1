<#
.SYNOPSIS
    Assigns required Azure AD directory roles to the deployment Graph app service principal
    and (when using delegated auth) to the signed-in user.

.DESCRIPTION
    This script ensures both the service principal AND the delegated user have all
    necessary directory roles for deploying M365 configurations. It's idempotent.

    The Graph app registration client ID is always resolved from the Config365 token API
    (same portal MSP/tenant Graph credentials used for device-code auth).

    Note: Custom Security Attribute roles (Attribute Definition Administrator,
    Attribute Assignment Administrator) are NOT granted by Global Admin — they must
    be assigned explicitly to every principal that will call the relevant Graph APIs.

    Future roles can be added to the $RequiredRoles array.

.NOTES
    Requires Microsoft.Graph.Authentication and Microsoft.Graph.Identity.Governance modules
    Requires RoleManagement.ReadWrite.Directory permission
    Requires PORTAL_TOKEN_API_URL, PORTAL_INTERNAL_KEY, and TENANT_SLUG
#>

[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = "Stop"

Write-Host "##[section]Preparing Tenant Roles for Deployment Service Principal"

# Define required roles - add more here as needed
$RequiredRoles = @(
    @{
        DisplayName = "Attribute Definition Administrator"
        Description = "Required to create/manage custom security attribute definitions (for backup/deploy of attributes)"
    },
    @{
        DisplayName = "Attribute Assignment Administrator"
        Description = "Required to assign custom security attribute values to users/groups/applications"
    },
    @{
        DisplayName = "Exchange Administrator"
        Description = "Required for Exchange Online backup and configuration via PowerShell"
    }
)

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.Identity.Governance"
)

Write-Host "`nChecking required PowerShell modules..."
foreach ($module in $requiredModules) {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        throw "Required module not found: $module. Install with: Install-Module $module"
    }
    Import-Module $module -ErrorAction Stop
    Write-Host "  Loaded: $module"
}

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection -Scopes @("RoleManagement.ReadWrite.Directory", "Application.Read.All")
    Write-Host "Connected to tenant: $($context.TenantId)"
    Write-Host "  Account: $($context.Account)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Graph app registration client ID — always from token API (portal MSP/tenant Graph creds)
if (-not (Get-Command Get-Config365GraphAppId -ErrorAction SilentlyContinue)) {
    throw "Get-Config365GraphAppId not available. Ensure Connect-M365Graph.ps1 was loaded."
}
$ServicePrincipalAppId = Get-Config365GraphAppId
if (-not $ServicePrincipalAppId) {
    throw "Could not resolve Graph app client ID from the Config365 token API. Check PORTAL_TOKEN_API_URL, PORTAL_INTERNAL_KEY, TENANT_SLUG, and MSP Graph Client ID in the portal."
}

Write-Host "`nTarget Service Principal App ID: $ServicePrincipalAppId"

# Get the service principal object
try {
    $servicePrincipal = Get-MgServicePrincipal -Filter "appId eq '$ServicePrincipalAppId'" -ErrorAction Stop
    if (-not $servicePrincipal) {
        throw "Service principal not found with App ID: $ServicePrincipalAppId"
    }
    Write-Host "  Service Principal Object ID: $($servicePrincipal.Id)"
    Write-Host "  Display Name: $($servicePrincipal.DisplayName)"
}
catch {
    throw "Failed to get service principal: $_"
}

# Build list of principals to assign roles to
$principals = @(
    [PSCustomObject]@{ Id = $servicePrincipal.Id; DisplayName = $servicePrincipal.DisplayName; Kind = "ServicePrincipal" }
)

# When running as a delegated user, also assign roles to the signed-in user.
# Custom Security Attribute roles are NOT covered by Global Admin — they must be
# explicitly assigned to every principal that will call the relevant Graph APIs.
if ($context.AuthType -eq 'Delegated' -or $context.Account -match '@') {
    try {
        $me = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName' -ErrorAction Stop
        if ($me.id -and $me.id -ne $servicePrincipal.Id) {
            $principals += [PSCustomObject]@{ Id = $me.id; DisplayName = $me.userPrincipalName; Kind = "DelegatedUser" }
            Write-Host "`nDelegated user detected: $($me.userPrincipalName) ($($me.id))"
            Write-Host "  Roles will also be assigned to the signed-in user."
        }
    } catch {
        Write-Host "##[warning]Could not resolve delegated user identity: $_"
    }
}

# Helper: assign a role to a principal, idempotent
function Set-RoleAssignment {
    param($PrincipalId, $PrincipalName, $RoleDefinitionId, $RoleName, $Kind)

    $existing = Get-MgRoleManagementDirectoryRoleAssignment `
        -Filter "principalId eq '$PrincipalId' and roleDefinitionId eq '$RoleDefinitionId'" `
        -ErrorAction SilentlyContinue

    if ($existing) {
        Write-Host "  [$Kind] Already assigned to $PrincipalName"
        return "Already Assigned"
    }

    $params = @{ principalId = $PrincipalId; roleDefinitionId = $RoleDefinitionId; directoryScopeId = "/" }
    New-MgRoleManagementDirectoryRoleAssignment -BodyParameter $params -ErrorAction Stop | Out-Null
    Write-Host "  [$Kind] Assigned to $PrincipalName"
    return "Assigned"
}

# Process each required role across all principals
Write-Host "`n##[section]Checking and Assigning Required Roles"

$results = @()
$successCount = 0
$skippedCount = 0
$errorCount = 0

foreach ($roleInfo in $RequiredRoles) {
    $roleName = $roleInfo.DisplayName
    Write-Host "`n##[group]Processing role: $roleName"

    try {
        $roleDefinition = Get-MgRoleManagementDirectoryRoleDefinition -Filter "displayName eq '$roleName'" -ErrorAction Stop

        if (-not $roleDefinition) {
            Write-Host "##[warning]Role definition not found: $roleName"
            $results += [PSCustomObject]@{ Role = $roleName; Principal = "N/A"; Status = "Not Found"; Message = "Role does not exist in this tenant" }
            $errorCount++
            continue
        }

        foreach ($principal in $principals) {
            try {
                $status = Set-RoleAssignment -PrincipalId $principal.Id -PrincipalName $principal.DisplayName `
                    -RoleDefinitionId $roleDefinition.Id -RoleName $roleName -Kind $principal.Kind
                $results += [PSCustomObject]@{ Role = $roleName; Principal = $principal.DisplayName; Status = $status; Message = "" }
                if ($status -eq "Assigned") { $successCount++ } else { $skippedCount++ }
            } catch {
                Write-Host "  ##[error]Failed for $($principal.DisplayName): $_"
                $results += [PSCustomObject]@{ Role = $roleName; Principal = $principal.DisplayName; Status = "Failed"; Message = $_.Exception.Message }
                $errorCount++
            }
        }
    }
    catch {
        Write-Host "##[error]Failed to process role '$roleName': $_"
        $results += [PSCustomObject]@{ Role = $roleName; Principal = "N/A"; Status = "Failed"; Message = $_.Exception.Message }
        $errorCount++
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# Summary
Write-Host "`n##[section]Summary"
Write-Host "Total roles processed: $($RequiredRoles.Count) × $($principals.Count) principal(s)"
Write-Host "  Newly assigned: $successCount"
Write-Host "  Already assigned: $skippedCount"
Write-Host "  Errors: $errorCount"

Write-Host "`nRole Assignment Results:"
$results | Format-Table -AutoSize

if ($errorCount -gt 0) {
    Write-Host "##[warning]Some roles could not be assigned. Check permissions and try again."
    exit 1
}
else {
    Write-Host "##[command]All required roles are now assigned!"
}
