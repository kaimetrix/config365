<#
.SYNOPSIS
    Backs up Consent and Permissions settings from Entra ID

.DESCRIPTION
    This script backs up consent and permissions configurations:
    - Authorization Policy (User consent settings - the 3 radio button options)
    - Admin Consent Request Policy (Admin consent workflow settings)
    - Permission Classifications (Low/Medium/High risk permissions)

    Each configuration is saved as an individual JSON file.

.PARAMETER BackupPath
    The base path where backup files will be stored

.EXAMPLE
    .\Backup-ConsentPermissions.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,
    
    [Parameter(Mandatory=$false)]
    [switch]$DebugMode
)

# Load common module if not already loaded
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Get-Command "Write-Log" -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

# Initialize if needed
if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode = $DebugMode
}

# Standalone execution: connect and initialize logging/dirs if not already done
if (-not $script:LogFile) {
    Initialize-BackupLogging    -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw "Failed to connect to Microsoft Graph" }
}

Write-Log "=== Starting Consent Permissions Backup ===" "INFO"

$policiesBackedUp = 0
$policiesFailed = 0
$classificationsBackedUp = 0
$classificationsFailed = 0

#region Authorization Policy (User Consent Settings)
try {
    Write-Log "Backing up Authorization Policy (User Consent Settings)..." "INFO"
    
    $uri = "https://graph.microsoft.com/v1.0/policies/authorizationPolicy"
    $authzPolicy = Invoke-GraphRequestWithDebug -Uri $uri -Method GET
    
    if ($authzPolicy) {
        Save-BackupFile -Content $authzPolicy -RelativePath "entra-id-consentpermissions/policies/authorization-policy.json"
        $policiesBackedUp++
        Write-Log "Saved: Authorization Policy" "DEBUG"
    }
}
catch {
    $policiesFailed++
    Write-Log "Failed to backup Authorization Policy: $_" "WARN"
}
#endregion

#region Admin Consent Request Policy
try {
    Write-Log "Backing up Admin Consent Request Policy..." "INFO"
    
    $uri = "https://graph.microsoft.com/v1.0/policies/adminConsentRequestPolicy"
    $adminConsentPolicy = Invoke-GraphRequestWithDebug -Uri $uri -Method GET
    
    if ($adminConsentPolicy) {
        Save-BackupFile -Content $adminConsentPolicy -RelativePath "entra-id-consentpermissions/policies/admin-consent-request-policy.json"
        $policiesBackedUp++
        Write-Log "Saved: Admin Consent Request Policy" "DEBUG"
    }
}
catch {
    $policiesFailed++
    Write-Log "Failed to backup Admin Consent Request Policy: $_" "WARN"
}
#endregion

#region Permission Classifications
try {
    Write-Log "Backing up Permission Classifications..." "INFO"
    
    # Get Microsoft Graph service principal (appId: 00000003-0000-0000-c000-000000000000)
    $graphAppId = "00000003-0000-0000-c000-000000000000"
    $spUri = "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$graphAppId'"
    $spResponse = Invoke-GraphRequestWithDebug -Uri $spUri -Method GET
    
    if ($spResponse.value -and $spResponse.value.Count -gt 0) {
        $graphSpId = $spResponse.value[0].id
        Write-Log "Found Microsoft Graph service principal: $graphSpId" "DEBUG"
        
        # Get delegated permission classifications
        $classUri = "https://graph.microsoft.com/v1.0/servicePrincipals/$graphSpId/delegatedPermissionClassifications"
        $classifications = Invoke-GraphRequestWithDebug -Uri $classUri -Method GET
        
        if ($classifications.value) {
            # Group classifications by classification level (low, medium, high)
            $classificationsByLevel = @{
                "low" = @()
                "medium" = @()
                "high" = @()
            }
            
            foreach ($classification in $classifications.value) {
                $level = $classification.classification.ToLower()
                if ($classificationsByLevel.ContainsKey($level)) {
                    $classificationsByLevel[$level] += $classification
                }
            }
            
            # Save each classification level as a separate file
            foreach ($level in $classificationsByLevel.Keys) {
                if ($classificationsByLevel[$level].Count -gt 0) {
                    $content = @{
                        classification = $level
                        servicePrincipalId = $graphSpId
                        servicePrincipalAppId = $graphAppId
                        permissions = $classificationsByLevel[$level]
                    }
                    Save-BackupFile -Content $content -RelativePath "entra-id-consentpermissions/permissionClassifications/$level.json"
                    $classificationsBackedUp++
                    Write-Log "Saved: $level permission classifications ($($classificationsByLevel[$level].Count) permissions)" "DEBUG"
                }
            }
            
            Write-Log "Permission Classifications: Found $($classifications.value.Count) total classifications" "INFO"
        }
        else {
            Write-Log "No permission classifications found" "INFO"
        }
    }
    else {
        Write-Log "Microsoft Graph service principal not found" "WARN"
        $classificationsFailed++
    }
}
catch {
    $classificationsFailed++
    Write-Log "Failed to backup Permission Classifications: $_" "WARN"
}
#endregion

Write-Log "=== Consent Permissions Backup Complete ===" "INFO"
Write-Log "Policies: Backed up $policiesBackedUp, Failed $policiesFailed" "INFO"
Write-Log "Classifications: Backed up $classificationsBackedUp levels, Failed $classificationsFailed" "INFO"

$totalBackedUp = $policiesBackedUp + $classificationsBackedUp
$totalFailed = $policiesFailed + $classificationsFailed

# Return summary
return @{
    Type = "ConsentPermissions"
    Success = ($totalFailed -eq 0)
    Policies = @{
        BackedUp = $policiesBackedUp
        Failed = $policiesFailed
    }
    PermissionClassifications = @{
        BackedUp = $classificationsBackedUp
        Failed = $classificationsFailed
    }
    TotalBackedUp = $totalBackedUp
    TotalFailed = $totalFailed
}






