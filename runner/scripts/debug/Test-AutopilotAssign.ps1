<#
.SYNOPSIS
    Diagnostic: tests Autopilot group assignment via the correct CRUD /assignments endpoint.
    Replaces the old /assign action test (which returned FeatureNotEnabled for group targets).

.DESCRIPTION
    1. Connects to Graph using env vars or explicit params.
    2. Finds "Baseline Windows Autopilot" profile.
    3. Shows current live assignments.
    4. Resolves "Baseline - Modern Workplace Devices" group.
    5. Performs a full-replace via CRUD:
         DELETE /assignments/{id}   for each existing assignment
         POST   /assignments        with the desired group target
    6. Verifies the result by re-fetching assignments.
#>
param(
    [string]$TenantId      = $env:AZURE_TENANT_ID,
    [string]$ClientId      = $env:AZURE_CLIENT_ID,
    [string]$ClientSecret  = $env:AZURE_CLIENT_SECRET,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

# ── Auth ────────────────────────────────────────────────────────────────────
Write-Host "Connecting to Graph..."
$sec  = ConvertTo-SecureString $ClientSecret -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($ClientId, $sec)
Connect-MgGraph -TenantId $TenantId -ClientSecretCredential $cred -NoWelcome

$ctx = Get-MgContext
Write-Host "Connected: $($ctx.TenantId)  App: $($ctx.ClientId)"
Write-Host ""

# ── Find Autopilot profile ───────────────────────────────────────────────────
Write-Host "Fetching Autopilot profiles..."
$profiles = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles"
foreach ($p in $profiles.value) {
    Write-Host "  - $($p.displayName)  [$($p.id)]"
}
$profile = $profiles.value | Where-Object { $_.displayName -eq "Baseline Windows Autopilot" } | Select-Object -First 1
if (-not $profile) { throw "Profile 'Baseline Windows Autopilot' not found" }
$profileId = $profile.id
$baseUri   = "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles/$profileId/assignments"
Write-Host ""
Write-Host "Profile ID: $profileId"

# ── Current live assignments ─────────────────────────────────────────────────
Write-Host ""
Write-Host "Current live assignments:"
$existing = Invoke-MgGraphRequest -Method GET -Uri $baseUri
if ($existing.value.Count -eq 0) {
    Write-Host "  (none)"
} else {
    foreach ($a in $existing.value) {
        Write-Host "  - id=$($a.id)  groupId=$($a.target.groupId)"
    }
}

# ── Resolve target group ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "Looking up group 'Baseline - Modern Workplace Devices'..."
$groups = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/groups?`$filter=displayName eq 'Baseline - Modern Workplace Devices'&`$select=id,displayName"
if ($groups.value.Count -eq 0) {
    Write-Host "  [!] Group not found - cannot proceed"
    Disconnect-MgGraph | Out-Null
    exit 1
}
$groupId = $groups.value[0].id
Write-Host "  Found: $($groups.value[0].displayName)  [$groupId]"

if ($WhatIf) {
    Write-Host ""
    Write-Host "[WhatIf] Would DELETE $($existing.value.Count) existing assignment(s) and POST 1 new assignment (groupId=$groupId)"
    Disconnect-MgGraph | Out-Null
    Write-Host ""
    Write-Host "Done (WhatIf - no changes made)."
    exit 0
}

# ── Step 1: Delete all existing assignments ──────────────────────────────────
Write-Host ""
Write-Host "Step 1: Deleting existing assignments..."
foreach ($a in $existing.value) {
    Write-Host "  DELETE $($a.id) ..."
    Invoke-MgGraphRequest -Method DELETE -Uri "$baseUri/$($a.id)"
    Write-Host "    Deleted."
}

# ── Step 2: Create desired assignment ────────────────────────────────────────
Write-Host ""
Write-Host "Step 2: Creating new group assignment..."
$body = @{
    '@odata.type' = '#microsoft.graph.windowsAutopilotDeploymentProfileAssignment'
    target        = @{
        '@odata.type'                                    = '#microsoft.graph.groupAssignmentTarget'
        groupId                                          = $groupId
        deviceAndAppManagementAssignmentFilterId         = $null
        deviceAndAppManagementAssignmentFilterType       = 'none'
    }
}
$result = Invoke-MgGraphRequest -Method POST -Uri $baseUri `
    -Body ($body | ConvertTo-Json -Depth 10) `
    -ContentType "application/json"
Write-Host "  POST succeeded."
Write-Host ($result | ConvertTo-Json -Depth 5)

# ── Verify ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Verifying updated assignments:"
$updated = Invoke-MgGraphRequest -Method GET -Uri $baseUri
if ($updated.value.Count -eq 0) {
    Write-Host "  [!] No assignments found after update - something went wrong"
} else {
    foreach ($a in $updated.value) {
        Write-Host "  - id=$($a.id)  groupId=$($a.target.groupId)"
    }
    Write-Host "  SUCCESS - assignment updated correctly"
}

Disconnect-MgGraph | Out-Null
Write-Host ""
Write-Host "Done."
