<#
.SYNOPSIS
    Backs up Authentication Method Policies from Entra ID

.DESCRIPTION
    This script backs up authentication method configurations:
    - FIDO2 (Passkeys)
    - Temporary Access Pass
    - SMS
    - Voice
    - Email OTP
    - Microsoft Authenticator
    - Software OATH tokens
    - Hardware OATH tokens (x509Certificate)

    Each authentication method is saved as an individual JSON file.

.PARAMETER BackupPath
    The base path where backup files will be stored

.EXAMPLE
    .\Backup-AuthenticationPolicies.ps1 -BackupPath "C:\backups"
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

Write-Log "=== Starting Authentication Policies Backup ===" "INFO"

$methodsBackedUp = 0
$methodsFailed = 0

# Define authentication methods to backup with their API names and output file names
$authMethods = @(
    @{ ApiName = "fido2"; FileName = "passkeys-fido2"; DisplayName = "FIDO2 (Passkeys)" }
    @{ ApiName = "temporaryAccessPass"; FileName = "temporary-access-pass"; DisplayName = "Temporary Access Pass" }
    @{ ApiName = "sms"; FileName = "sms"; DisplayName = "SMS" }
    @{ ApiName = "voice"; FileName = "voice"; DisplayName = "Voice" }
    @{ ApiName = "email"; FileName = "email-otp"; DisplayName = "Email OTP" }
    @{ ApiName = "microsoftAuthenticator"; FileName = "microsoft-authenticator"; DisplayName = "Microsoft Authenticator" }
    @{ ApiName = "softwareOath"; FileName = "software-oath-tokens"; DisplayName = "Software OATH Tokens" }
    @{ ApiName = "x509Certificate"; FileName = "hardware-oath-tokens"; DisplayName = "Hardware OATH Tokens (x509)" }
)

#region Authentication Methods
try {
    Write-Log "Backing up Authentication Method Policies..." "INFO"
    
    foreach ($method in $authMethods) {
        try {
            Write-Log "Backing up $($method.DisplayName)..." "DEBUG"
            
            # Use beta for fido2 — v1.0 omits defaultPasskeyProfile and passkeyProfiles
            $apiVersion = if ($method.ApiName -eq 'fido2') { 'beta' } else { 'v1.0' }
            $uri = "https://graph.microsoft.com/$apiVersion/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/$($method.ApiName)"
            $config = Invoke-GraphRequestWithDebug -Uri $uri -Method GET
            
            if ($config) {
                Save-BackupFile -Content $config -RelativePath "authentication-policies/$($method.FileName).json"
                $methodsBackedUp++
                Write-Log "Saved: $($method.DisplayName)" "DEBUG"
            }
        }
        catch {
            $methodsFailed++
            Write-Log "Failed to backup $($method.DisplayName): $_" "WARN"
        }
    }
    
    Write-Log "Authentication Methods: Backed up $methodsBackedUp, Failed $methodsFailed" "INFO"
}
catch {
    Write-Log "Failed to backup Authentication Methods: $_" "ERROR"
}
#endregion

Write-Log "=== Authentication Policies Backup Complete ===" "INFO"

# Return summary
return @{
    Type = "AuthenticationPolicies"
    Success = ($methodsFailed -eq 0)
    Methods = @{
        BackedUp = $methodsBackedUp
        Failed = $methodsFailed
    }
}






