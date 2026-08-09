<#
.SYNOPSIS
    Backs up Custom Security Attributes from Microsoft Entra ID

.DESCRIPTION
    This script backs up:
    - Attribute Sets (containers for attributes)
    - Attribute Definitions (the actual attributes)
    
    These are used in Conditional Access policies with dynamic filters.

.PARAMETER BackupPath
    The base path where backup files will be stored.

.PARAMETER DebugMode
    Enable detailed debug logging.

.NOTES
    Requires Microsoft.Graph.Identity.DirectoryManagement module
    Requires CustomSecAttributeDefinition.Read.All permission
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
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

# Resolve backup path: explicit param wins; fall back to script-level variable
if ($BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode  = $DebugMode
} elseif (-not $script:BackupPath) {
    throw "BackupPath is required. Pass -BackupPath or ensure `$script:BackupPath is set before dot-sourcing."
}

# Standalone execution: connect and initialize logging/dirs if not already done
if (-not $script:LogFile) {
    Initialize-BackupLogging    -BackupPath $script:BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $script:BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw "Failed to connect to Microsoft Graph" }
}

Write-Log "Starting Custom Security Attributes backup..." "INFO"

$attributesPath = Join-Path $script:BackupPath "custom-attributes"

# Create subdirectories
$attributeSetsPath = Join-Path $attributesPath "attribute-sets"
$attributeDefsPath = Join-Path $attributesPath "attribute-definitions"

if (-not (Test-Path $attributeSetsPath)) {
    New-Item -ItemType Directory -Path $attributeSetsPath -Force | Out-Null
}
if (-not (Test-Path $attributeDefsPath)) {
    New-Item -ItemType Directory -Path $attributeDefsPath -Force | Out-Null
}

# ============================================================================
# Backup Attribute Sets
# ============================================================================
Write-Log "Backing up Attribute Sets..." -Level INFO

try {
    $attributeSets = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/directory/attributeSets"
    
    if ($attributeSets -and $attributeSets.Count -gt 0) {
        Write-Log "Found $($attributeSets.Count) attribute set(s)" -Level INFO
        
        foreach ($attrSet in $attributeSets) {
            $fileName = Get-SafeFileName -Name $attrSet.id
            $relativePath = "custom-attributes/attribute-sets/$fileName.json"
            
            # Save the attribute set (Save-BackupFile handles conversion)
            Save-BackupFile -Content $attrSet -RelativePath $relativePath
            Write-Log "  Saved: $($attrSet.id)" -Level DEBUG
        }
        
        Write-Log "Backed up $($attributeSets.Count) attribute set(s)" -Level INFO
    }
    else {
        Write-Log "No attribute sets found" -Level INFO
    }
}
catch {
    if ($_.Exception.Message -match "Forbidden" -or $_.Exception.Message -match "Authorization") {
        Write-Log "No permission to read attribute sets (requires CustomSecAttributeDefinition.Read.All)" -Level WARN
    }
    else {
        Write-Log "Error backing up attribute sets: $_" -Level ERROR
    }
}

# ============================================================================
# Backup Attribute Definitions
# ============================================================================
Write-Log "Backing up Attribute Definitions..." -Level INFO

try {
    # Get all attribute definitions across all attribute sets
    $attributeDefs = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions"
    
    if ($attributeDefs -and $attributeDefs.Count -gt 0) {
        Write-Log "Found $($attributeDefs.Count) attribute definition(s)" -Level INFO
        
        foreach ($attrDef in $attributeDefs) {
            # Attribute definition ID format is "AttributeSet_AttributeName"
            $fileName = Get-SafeFileName -Name $attrDef.id
            $relativePath = "custom-attributes/attribute-definitions/$fileName.json"
            
            # Convert to a mutable object for adding allowed values
            $attrDefObj = $attrDef
            
            # Also get allowed values if this is a predefined values attribute
            if ($attrDef.usePreDefinedValuesOnly -eq $true) {
                try {
                    $allowedValues = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$($attrDef.id)/allowedValues"
                    if ($allowedValues -and $allowedValues.Count -gt 0) {
                        if ($attrDefObj -is [hashtable]) { $attrDefObj['_allowedValues'] = $allowedValues }
                        else { $attrDefObj | Add-Member -NotePropertyName '_allowedValues' -NotePropertyValue $allowedValues -Force }
                        Write-Log "    Found $($allowedValues.Count) allowed value(s) for $($attrDef.id)" -Level DEBUG
                    }
                }
                catch {
                    Write-Log "    Could not retrieve allowed values for $($attrDef.id): $_" -Level WARN
                }
            }
            
            # Save the attribute definition
            Save-BackupFile -Content $attrDefObj -RelativePath $relativePath
            Write-Log "  Saved: $($attrDef.id) (attributeSet: $($attrDef.attributeSet))" -Level DEBUG
        }
        
        Write-Log "Backed up $($attributeDefs.Count) attribute definition(s)" -Level INFO
    }
    else {
        Write-Log "No attribute definitions found" -Level INFO
    }
}
catch {
    if ($_.Exception.Message -match "Forbidden" -or $_.Exception.Message -match "Authorization") {
        Write-Log "No permission to read attribute definitions (requires CustomSecAttributeDefinition.Read.All)" -Level WARN
    }
    else {
        Write-Log "Error backing up attribute definitions: $_" -Level ERROR
    }
}

Write-Log "Custom Security Attributes backup completed" -Level INFO

