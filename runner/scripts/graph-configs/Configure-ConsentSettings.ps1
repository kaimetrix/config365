<#
.SYNOPSIS
    Configures Consent and Permissions settings via Microsoft Graph API

.DESCRIPTION
    Applies user consent and permissions configurations:
    - Authorization Policy (user consent settings, guest invite settings)
    - Permission Grant Policies (what users/admins can consent to)

    Settings reference: https://portal.azure.com/#view/Microsoft_AAD_IAM/ConsentPoliciesMenuBlade/~/UserSettings

.PARAMETER ConfigDirectory
    Path to the directory containing consent settings JSON files

.PARAMETER ConfigPath
    Path to a single JSON configuration file

.PARAMETER WhatIf
    Show what would be changed without making changes

.EXAMPLE
    .\Configure-ConsentSettings.ps1 -ConfigDirectory "baseline/consent-settings"

.EXAMPLE
    .\Configure-ConsentSettings.ps1 -ConfigPath "authorization-policy.json"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$false)]
    [string]$ConfigDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$ConfigPath,
    
    [Parameter(Mandatory=$false)]
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

Write-Host "##[section]Configuring Consent and Permissions Settings"

# Validate parameters - need at least one
if (-not $ConfigDirectory -and -not $ConfigPath) {
    throw "Either -ConfigDirectory or -ConfigPath must be specified"
}

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph
try {
    $context = Ensure-M365GraphConnection -Scopes @("Policy.ReadWrite.Authorization")
    Write-Host "Connected to tenant: $($context.TenantId)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Function to configure Authorization Policy (user consent settings)
function Set-AuthorizationPolicy {
    param(
        [object]$Config
    )
    
    Write-Host "`n##[group]Configuring Authorization Policy (User Consent Settings)..."
    
    try {
        # Remove metadata properties that shouldn't be sent in the update
        $configHash = $Config | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
        $propsToRemove = @('id', '@odata.type', '@odata.context', '_comment', '_notes')
        foreach ($prop in $propsToRemove) {
            if ($configHash.ContainsKey($prop)) {
                $configHash.Remove($prop)
            }
        }
        
        if ($PSCmdlet.ShouldProcess("Authorization Policy", "Update")) {
            $uri = "https://graph.microsoft.com/v1.0/policies/authorizationPolicy"
            Invoke-MgGraphRequest -Uri $uri -Method PATCH -Body ($configHash | ConvertTo-Json -Depth 10) -ContentType "application/json"
            Write-Host "✓ Authorization Policy configured"
        }
        else {
            Write-Host "[WhatIf] Would update Authorization Policy"
            Write-Host "Settings to apply:"
            $configHash.Keys | ForEach-Object {
                $value = $configHash[$_]
                if ($value -is [System.Collections.IDictionary] -or $value -is [System.Collections.IEnumerable]) {
                    Write-Host "  $_: $($value | ConvertTo-Json -Compress)"
                } else {
                    Write-Host "  $_: $value"
                }
            }
        }
    }
    catch {
        Write-Host "##[warning]Failed to configure Authorization Policy: $_"
    }
    
    Write-Host "##[endgroup]"
}

# Function to configure Permission Grant Policy
function Set-PermissionGrantPolicy {
    param(
        [object]$Config,
        [string]$PolicyId
    )
    
    Write-Host "`n##[group]Configuring Permission Grant Policy: $PolicyId..."
    
    try {
        # Remove metadata properties
        $configHash = $Config | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
        $propsToRemove = @('@odata.type', '@odata.context', '_comment', '_notes')
        foreach ($prop in $propsToRemove) {
            if ($configHash.ContainsKey($prop)) {
                $configHash.Remove($prop)
            }
        }
        
        # Check if policy exists
        $uri = "https://graph.microsoft.com/v1.0/policies/permissionGrantPolicies/$PolicyId"
        $exists = $false
        try {
            $existing = Invoke-MgGraphRequest -Uri $uri -Method GET
            $exists = $true
        }
        catch {
            if ($_.Exception.Message -notmatch "404") {
                throw
            }
        }
        
        if ($PSCmdlet.ShouldProcess("Permission Grant Policy: $PolicyId", $(if ($exists) { "Update" } else { "Create" }))) {
            if ($exists) {
                # Update existing policy
                Invoke-MgGraphRequest -Uri $uri -Method PATCH -Body ($configHash | ConvertTo-Json -Depth 10) -ContentType "application/json"
                Write-Host "✓ Permission Grant Policy updated: $PolicyId"
            }
            else {
                # Create new policy
                $createUri = "https://graph.microsoft.com/v1.0/policies/permissionGrantPolicies"
                Invoke-MgGraphRequest -Uri $createUri -Method POST -Body ($configHash | ConvertTo-Json -Depth 10) -ContentType "application/json"
                Write-Host "✓ Permission Grant Policy created: $PolicyId"
            }
        }
        else {
            Write-Host "[WhatIf] Would $(if ($exists) { 'update' } else { 'create' }) Permission Grant Policy: $PolicyId"
        }
    }
    catch {
        Write-Host "##[warning]Failed to configure Permission Grant Policy '$PolicyId': $_"
    }
    
    Write-Host "##[endgroup]"
}

# Process configuration based on input type
if ($ConfigDirectory) {
    # Process JSON files from directory
    if (-not (Test-Path $ConfigDirectory)) {
        throw "Configuration directory not found: $ConfigDirectory"
    }
    
    $configFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File
    if ($configFiles.Count -eq 0) {
        Write-Host "##[warning]No JSON files found in directory: $ConfigDirectory"
        exit 0
    }
    
    Write-Host "Found $($configFiles.Count) consent settings configuration(s)"
    
    foreach ($file in $configFiles) {
        Write-Host "Processing: $($file.Name)"
        
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $fileName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
        
        if ($fileName -eq "authorization-policy") {
            Set-AuthorizationPolicy -Config $config
        }
        elseif ($fileName -match "^permission-grant-policy-(.+)$") {
            $policyId = $Matches[1]
            Set-PermissionGrantPolicy -Config $config -PolicyId $policyId
        }
        else {
            Write-Host "##[warning]Unknown consent settings file: $($file.Name) - skipping"
        }
    }
}
elseif ($ConfigPath) {
    # Process single JSON file
    if (-not (Test-Path $ConfigPath)) {
        throw "Configuration file not found: $ConfigPath"
    }
    
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    Write-Host "Loaded configuration from: $ConfigPath"
    
    $fileName = [System.IO.Path]::GetFileNameWithoutExtension($ConfigPath)
    
    if ($fileName -eq "authorization-policy" -or $config.defaultUserRolePermissions) {
        Set-AuthorizationPolicy -Config $config
    }
    elseif ($fileName -match "^permission-grant-policy-(.+)$" -or $config.id) {
        $policyId = if ($config.id) { $config.id } else { $Matches[1] }
        Set-PermissionGrantPolicy -Config $config -PolicyId $policyId
    }
    else {
        Write-Host "##[warning]Could not determine config type from file: $ConfigPath"
    }
}

Write-Host "`n##[section]Consent Settings Configuration Complete"

