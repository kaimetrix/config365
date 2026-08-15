<#
.SYNOPSIS
    Creates and manages Intune Win32 LOB apps from WinGet install scripts via Microsoft Graph API

.DESCRIPTION
    Reads install.ps1 + config.json pairs from one or more /apps/winget/{packageId}/ directories
    (baseline repo and/or tenant repo), packages each script as a Win32 LOB app using
    IntuneWinAppUtil.exe, uploads the .intunewin content to Intune, and applies group assignments.

    Detection is auto-generated (winget list --id check).
    Uninstall command runs uninstall.ps1 from the package (same resolver as install).

    Supports -WhatIfMode to preview changes without making them (skips packaging and upload).

.PARAMETER ConfigDirectories
    One or more paths to scan for package subfolders. Each subfolder must contain
    install.ps1 and config.json. If the same packageId appears in multiple directories,
    the last one processed wins (tenant directory should be listed last).

.PARAMETER OutputPath
    Optional path to save a JSON summary of planned/applied changes.

.PARAMETER WhatIfMode
    Show what would be changed without making changes or uploading content.

.EXAMPLE
    .\Configure-WingetApps.ps1 `
        -ConfigDirectories "baseline/apps/winget","Tenant-repo/apps/winget" `
        -WhatIfMode -OutputPath "wingetapps-plan.json"

.NOTES
    Requires Microsoft.Graph.Authentication and Microsoft.Graph.Groups modules.
    Requires DeviceManagementApps.ReadWrite.All Graph API permission.
    Linux runners use the native intunewin CLI at /usr/local/share/config365/tools/intunewin.
    Windows runners may use IntuneWinAppUtil.exe when present.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$ConfigDirectories,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIfMode
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$scriptRoot = $PSScriptRoot

# ============================================================================
# CONSTANTS
# ============================================================================

$GRAPH_BASE              = 'https://graph.microsoft.com/beta'
$UPLOAD_CHUNK_SIZE       = 6 * 1024 * 1024   # 6 MB

# ============================================================================
# IMPORT DEPENDENCIES
# ============================================================================

$commonScriptPath = Join-Path $scriptRoot '..\common\Connect-M365Graph.ps1'
if (Test-Path $commonScriptPath) { . $commonScriptPath }

$intuneWinPackagerPath = Join-Path $scriptRoot '..\common\Get-IntuneWinPackager.ps1'
if (Test-Path $intuneWinPackagerPath) { . $intuneWinPackagerPath }

$intuneWinPackagePath = Join-Path $scriptRoot '..\common\New-IntuneWinPackage.ps1'
if (Test-Path $intuneWinPackagePath) { . $intuneWinPackagePath }

$intuneDisplayNamePath = Join-Path $scriptRoot '..\common\Get-AppIntuneDisplayName.ps1'
if (Test-Path $intuneDisplayNamePath) { . $intuneDisplayNamePath }

$syncAssignmentsPath = Join-Path $scriptRoot '..\common\Sync-MobileAppAssignments.ps1'
if (Test-Path $syncAssignmentsPath) { . $syncAssignmentsPath }

$wingetPath = Join-Path $scriptRoot '..\common\Resolve-WingetExecutable.ps1'
if (Test-Path $wingetPath) { . $wingetPath }

$iconHelperPath = Join-Path $scriptRoot '..\common\Get-Win32AppIconForIntune.ps1'
if (Test-Path $iconHelperPath) { . $iconHelperPath }

# Preload zip support once (Get-IntuneWinMetadata uses ZipFile)
if (-not ('System.IO.Compression.ZipFile' -as [type])) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
}

function Write-DeployLog {
    param([string]$Message)
    Write-Host $Message
}

# ============================================================================
# GRAPH HELPER FUNCTIONS
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

# ============================================================================
# AUTHENTICATION
# ============================================================================

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

$requiredModules = @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Groups')
Import-RequiredGraphModules -ModuleNames $requiredModules

try {
    $context = Ensure-M365GraphConnection
    Write-Host "  Connected to tenant: $($context.TenantId)"
} catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# ============================================================================
# DISCOVER PACKAGE FOLDERS
# ============================================================================

Write-Host "`n##[section]Discovering WinGet app packages"

$packageMap = [ordered]@{}

foreach ($dir in $ConfigDirectories) {
    if (-not (Test-Path $dir)) {
        Write-Host "  Directory not found, skipping: $dir" -ForegroundColor DarkGray
        continue
    }
    $subFolders = Get-ChildItem -Path $dir -Directory -ErrorAction SilentlyContinue
    foreach ($folder in $subFolders) {
        $installPs1  = Join-Path $folder.FullName 'install.ps1'
        $configJson  = Join-Path $folder.FullName 'config.json'
        if (-not (Test-Path $installPs1) -or -not (Test-Path $configJson)) {
            Write-Host "  Skipping $($folder.Name): missing install.ps1 or config.json" -ForegroundColor DarkGray
            continue
        }
        $packageMap[$folder.Name] = @{
            PackageId  = $folder.Name
            InstallPs1 = $installPs1
            ConfigJson = $configJson
            Directory  = $folder.FullName
        }
        Write-Host "  Found package: $($folder.Name) (from $dir)"
    }
}

if ($packageMap.Count -eq 0) {
    Write-Host "No WinGet app packages found in any of the provided directories." -ForegroundColor DarkGray
    if ($OutputPath) {
        @{ Service = 'WingetApps'; WouldCreateCount = 0; WouldUpdateCount = 0; NoChangeCount = 0; ErrorCount = 0; Results = @() } |
            ConvertTo-Json | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

Write-Host "Total packages to process: $($packageMap.Count)"

# ============================================================================
# HELPER: AUTO-GENERATE DETECTION SCRIPT
# ============================================================================

function New-WingetDetectionScript {
    param(
        [string]$PackageId,
        [string]$RunAsAccount = 'system'
    )
    $scope = Get-WingetInstallScope -RunAsAccount $RunAsAccount
    $preamble = Get-WingetClientScriptPreamble
    return @"
$preamble
try {
    `$winget = Resolve-WingetExecutable
    if (-not `$winget) {
        Write-Output 'winget not found'
        exit 1
    }
    `$result = & `$winget list --id '$PackageId' --exact --scope $scope --accept-source-agreements 2>`$null
    if (`$LASTEXITCODE -eq 0 -and (`$result | Select-String -Pattern '$PackageId' -SimpleMatch)) {
        Write-Output 'Detected'
        exit 0
    }
    Write-Output 'Not detected'
    exit 1
} catch {
    Write-Output "Error: `$_"
    exit 1
}
"@
}

function Get-WingetUninstallPs1ForPack {
    param(
        [Parameter(Mandatory = $true)][string]$InstallPs1,
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][string]$PkgTmpDir,
        [string]$RunAsAccount = 'system'
    )
    $preferred = Join-Path (Split-Path $InstallPs1 -Parent) 'uninstall.ps1'
    if (Test-Path -LiteralPath $preferred) { return $preferred }
    $generated = Join-Path $PkgTmpDir 'uninstall.ps1'
    New-WingetUninstallScript -PackageId $PackageId -RunAsAccount $RunAsAccount | Set-Content -Path $generated -Encoding UTF8 -WhatIf:$false
    Write-Host "  Generated uninstall.ps1 (not in package folder)" -ForegroundColor DarkGray
    return $generated
}

# ============================================================================
# HELPER: EXTRACT ENCRYPTION METADATA FROM .intunewin
# ============================================================================

function Get-IntuneWinMetadata {
    param([string]$IntuneWinPath)

    Write-DeployLog "  Reading .intunewin metadata..."
    $zip = [System.IO.Compression.ZipFile]::OpenRead($IntuneWinPath)
    try {
        $detectionEntry = $zip.Entries | Where-Object { $_.FullName -like '*/Metadata/Detection.xml' }
        if (-not $detectionEntry) {
            throw "Detection.xml not found inside .intunewin (entries: $($zip.Entries.FullName -join ', '))"
        }
        $stream = $detectionEntry.Open()
        $reader = New-Object System.IO.StreamReader($stream)
        $xmlContent = $reader.ReadToEnd()
        $reader.Close(); $stream.Close()
        $xml = [xml]$xmlContent

        $contentEntry = $zip.Entries | Where-Object { $_.FullName -like '*/Contents/*.intunewin' } | Select-Object -First 1
        if (-not $contentEntry) { throw "Content entry not found inside .intunewin" }

        return @{
            EncryptionKey           = $xml.ApplicationInfo.EncryptionInfo.EncryptionKey
            MacKey                  = $xml.ApplicationInfo.EncryptionInfo.MacKey
            InitializationVector    = $xml.ApplicationInfo.EncryptionInfo.InitializationVector
            Mac                     = $xml.ApplicationInfo.EncryptionInfo.Mac
            ProfileIdentifier       = $xml.ApplicationInfo.EncryptionInfo.ProfileIdentifier
            FileDigest              = $xml.ApplicationInfo.EncryptionInfo.FileDigest
            FileDigestAlgorithm     = $xml.ApplicationInfo.EncryptionInfo.FileDigestAlgorithm
            UnencryptedContentSize  = [long]$xml.ApplicationInfo.UnencryptedContentSize
            EncryptedSize           = $contentEntry.Length
            ContentEntryName        = $contentEntry.FullName
        }
    } finally {
        $zip.Dispose()
    }
}

# ============================================================================
# HELPER: UPLOAD CONTENT TO AZURE STORAGE IN BLOCKS
# ============================================================================

function Send-ContentToAzureStorage {
    param(
        [string]$IntuneWinPath,
        [string]$ContentEntryName,
        [string]$SasUri
    )

    Add-Type -Assembly System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($IntuneWinPath)
    try {
        $contentEntry = $zip.Entries | Where-Object { $_.FullName -eq $ContentEntryName } | Select-Object -First 1
        $stream       = $contentEntry.Open()
        $blockIds     = [System.Collections.Generic.List[string]]::new()
        $blockIndex   = 0

        while ($stream.Position -lt $contentEntry.Length) {
            $remaining  = $contentEntry.Length - $stream.Position
            $chunkSize  = [Math]::Min($script:UPLOAD_CHUNK_SIZE, $remaining)
            $buffer     = New-Object byte[] $chunkSize
            $read       = $stream.Read($buffer, 0, $chunkSize)
            if ($read -lt $chunkSize) { $buffer = $buffer[0..($read - 1)] }

            $blockId    = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($blockIndex.ToString('D6')))
            $blockIds.Add($blockId)
            $putUri     = "$SasUri&comp=block&blockid=$([Uri]::EscapeDataString($blockId))"

            Invoke-WebRequest -Uri $putUri -Method PUT -Body $buffer `
                -Headers @{ 'x-ms-blob-type' = 'BlockBlob'; 'Content-Type' = 'application/octet-stream' } `
                -UseBasicParsing -TimeoutSec 300 | Out-Null

            Write-Host "    Uploaded block $($blockIndex + 1) ($read bytes)"
            $blockIndex++
        }
        $stream.Close()

        $blockListXml = "<?xml version='1.0' encoding='utf-8'?><BlockList>" +
            ($blockIds | ForEach-Object { "<Latest>$_</Latest>" }) + "</BlockList>"
        $commitUri = "$SasUri&comp=blocklist"
        Invoke-WebRequest -Uri $commitUri -Method PUT -Body $blockListXml `
            -Headers @{ 'Content-Type' = 'text/xml' } -UseBasicParsing -TimeoutSec 120 | Out-Null
        Write-Host "    Block list committed ($blockIndex blocks)"
    } finally {
        $zip.Dispose()
    }
}

# ============================================================================
# HELPER: RESOLVE GROUP ID BY DISPLAY NAME
# ============================================================================

function Resolve-GroupId {
    param([string]$GroupName, [string]$GroupId)
    if ($GroupId) { return $GroupId }
    if (-not $GroupName) { return $null }
    $encoded = [Uri]::EscapeDataString("displayName eq '$GroupName'")
    $result  = Invoke-GraphRequest -Uri "$script:GRAPH_BASE/groups?`$filter=$encoded&`$select=id,displayName"
    $match   = $result.value | Select-Object -First 1
    if (-not $match) {
        Write-Host "    Warning: Group '$GroupName' not found in directory" -ForegroundColor Yellow
        return $null
    }
    return $match.id
}

# ============================================================================
# HELPER: FETCH CURRENT APP ASSIGNMENTS WITH GROUP NAMES (for WhatIf diff)
# ============================================================================

function Get-AppAssignments {
    param([string]$AppId)
    try {
        $result = Invoke-GraphRequest -Uri "$script:GRAPH_BASE/deviceAppManagement/mobileApps/$AppId/assignments"
        $assignments = foreach ($a in $result.value) {
            $odataType = [string]$a.target.'@odata.type'
            if ($odataType -match 'allLicensedUsers') {
                [PSCustomObject]@{
                    groupId    = $null
                    groupName  = 'All Users'
                    intent     = $a.intent
                    targetType = 'allLicensedUsers'
                }
                continue
            }
            if ($odataType -match 'allDevices') {
                [PSCustomObject]@{
                    groupId    = $null
                    groupName  = 'All Devices'
                    intent     = $a.intent
                    targetType = 'allDevices'
                }
                continue
            }
            $gId    = $a.target.groupId
            $gName  = $null
            if ($gId) {
                try {
                    $grp   = Invoke-GraphRequest -Uri "$script:GRAPH_BASE/groups/$gId`?`$select=displayName"
                    $gName = $grp.displayName
                } catch { $gName = $gId }
            }
            $intent = if ($a.target.'@odata.type' -match 'exclusion') { 'exclude' } else { $a.intent }
            [PSCustomObject]@{ groupId = $gId; groupName = $gName; intent = $intent }
        }
        return @($assignments)
    } catch {
        return @()
    }
}

# ============================================================================
# HELPER: CHECK IF WIN32 APP EXISTS BY DISPLAY NAME
# ============================================================================

function Get-ExistingWin32App {
    param([string]$DisplayName)
    $safeName = $DisplayName.Replace("'", "''")
    $encoded = [Uri]::EscapeDataString("displayName eq '$safeName'")
    Write-Host "  Looking up existing app: $DisplayName"
    try {
        $result = Invoke-GraphRequest -Uri "$script:GRAPH_BASE/deviceAppManagement/mobileApps?`$filter=$encoded"
        return $result.value | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.win32LobApp' } | Select-Object -First 1
    } catch {
        Write-Host "  Lookup failed: $_" -ForegroundColor Yellow
        return $null
    }
}

# ============================================================================
# HELPER: FULL WIN32 APP CONTENT UPLOAD (multi-step)
# ============================================================================

function Publish-Win32AppContent {
    param(
        [string]$AppId,
        [string]$IntuneWinPath,
        [hashtable]$Metadata
    )

    $contentVersionUri = "$script:GRAPH_BASE/deviceAppManagement/mobileApps/$AppId/microsoft.graph.win32LobApp/contentVersions"
    $versionResult     = Invoke-GraphRequest -Method POST -Uri $contentVersionUri -Body @{}
    $versionId         = $versionResult.id
    Write-Host "    Content version created: $versionId"

    $fileBody = @{
        '@odata.type' = '#microsoft.graph.mobileAppContentFile'
        name          = 'install.intunewin'
        size          = $Metadata.UnencryptedContentSize
        sizeEncrypted = $Metadata.EncryptedSize
        manifest      = $null
        isDependency  = $false
    }
    $filesUri   = "$contentVersionUri/$versionId/files"
    $fileResult = Invoke-GraphRequest -Method POST -Uri $filesUri -Body $fileBody
    $fileId     = $fileResult.id

    $sasUri = $null
    Write-Host "    Waiting for Azure Storage SAS URI..."
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 3
        $fileStatus = Invoke-GraphRequest -Uri "$filesUri/$fileId"
        if ($fileStatus.azureStorageUri) { $sasUri = $fileStatus.azureStorageUri; break }
        Write-Host "    SAS not ready yet (attempt $($i + 1)/20)..."
    }
    if (-not $sasUri) { throw "Timed out waiting for Azure Storage SAS URI" }
    Write-Host "    Azure Storage URI obtained"

    Send-ContentToAzureStorage -IntuneWinPath $IntuneWinPath `
        -ContentEntryName $Metadata.ContentEntryName -SasUri $sasUri

    $commitBody = @{
        fileEncryptionInfo = @{
            encryptionKey        = $Metadata.EncryptionKey
            macKey               = $Metadata.MacKey
            initializationVector = $Metadata.InitializationVector
            mac                  = $Metadata.Mac
            profileIdentifier    = $Metadata.ProfileIdentifier
            fileDigest           = $Metadata.FileDigest
            fileDigestAlgorithm  = $Metadata.FileDigestAlgorithm
        }
    }
    Invoke-GraphRequest -Method POST -Uri "$filesUri/$fileId/commit" -Body $commitBody | Out-Null

    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 5
        $fileStatus = Invoke-GraphRequest -Uri "$filesUri/$fileId"
        Write-Host "    Processing state: $($fileStatus.uploadState)"
        if ($fileStatus.uploadState -eq 'commitFileSuccess') { break }
        if ($fileStatus.uploadState -like '*fail*') {
            throw "Content processing failed: $($fileStatus.uploadState)"
        }
    }
    Write-Host "    Content committed successfully"

    Invoke-GraphRequest -Method PATCH `
        -Uri "$script:GRAPH_BASE/deviceAppManagement/mobileApps/$AppId" `
        -Body @{ '@odata.type' = '#microsoft.graph.win32LobApp'; committedContentVersion = $versionId } | Out-Null
    Write-Host "    App content version committed: $versionId"
}

# ============================================================================
# MAIN PROCESSING LOOP
# ============================================================================

Write-Host "`n##[section]Processing WinGet apps"

$allResults  = [System.Collections.Generic.List[hashtable]]::new()
$appNameToFile = @{}
$invokeGraphSb = {
    param([string]$Method, [string]$Uri, [object]$Body)
    Invoke-GraphRequest -Method $Method -Uri $Uri -Body $Body
}
$resolveGroupSb = {
    param([string]$GroupName, [string]$GroupId)
    Resolve-GroupId -GroupName $GroupName -GroupId $GroupId
}
$wouldCreate = 0
$wouldUpdate = 0
$noChange    = 0
$errorCount  = 0

$globalTmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "WingetApps-$(Get-Random)"
if (-not $WhatIfMode) { New-Item -ItemType Directory -Path $globalTmpDir -Force | Out-Null }

try {
    foreach ($pkg in $packageMap.Values) {
        $packageId  = $pkg.PackageId
        $installPs1 = $pkg.InstallPs1
        $configPath = $pkg.ConfigJson

        Write-Host "`n--- Package: $packageId ---" -ForegroundColor Cyan

        $config      = Get-Content $configPath -Raw | ConvertFrom-Json
        $displayName = if ($config.displayName) { $config.displayName.Trim() } else { $packageId }
        $appName     = Resolve-IntuneAppDisplayName -Config $config -PackageId $packageId -Prefix 'WinGet'
        $appNameToFile[$appName] = $configPath
        $runAsAccount = if ($config.runAsAccount -eq 'user') { 'user' } else { 'system' }
        $appFolder    = Split-Path $configPath -Parent

        try {
        $iconFilePath = Resolve-Win32AppIconPath -AppFolderPath $appFolder -Config $config
        $iconHash     = Get-Win32AppIconHash -IconPath $iconFilePath
        $iconFragment = Get-Win32AppIconJsonFragment -IconPath $iconFilePath

        # Build detection script
        $detectionScript    = New-WingetDetectionScript -PackageId $packageId -RunAsAccount $runAsAccount
        $detectionScriptB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($detectionScript))

        # Compute hashes for change detection
        $installContent = Get-Content $installPs1 -Raw
        $installHash    = [Convert]::ToBase64String(
            [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($installContent))
        )
        $availableForAllUsers = [bool]($config.availableForAllUsers)
        # Detection hash — Intune runs detection scripts in Windows PowerShell 5.1; template fixes must redeploy
        $detectHash     = [Convert]::ToBase64String(
            [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($detectionScript))
        )

        # Build uninstall command (script bundled in .intunewin package)
        $version      = if ($config.version) { $config.version } else { 'latest' }
        $uninstallCmd = 'powershell.exe -ExecutionPolicy Bypass -File uninstall.ps1'

        $jDisplayName  = $appName | ConvertTo-Json -Compress
        $jDescription  = "Installs $displayName ($packageId) via WinGet. Version: $version. Managed by CONFIG365." | ConvertTo-Json -Compress
        $jInstallCmd   = 'powershell.exe -ExecutionPolicy Bypass -File install.ps1' | ConvertTo-Json -Compress
        $jUninstallCmd = $uninstallCmd | ConvertTo-Json -Compress
        $jRunAs        = $runAsAccount | ConvertTo-Json -Compress
        $jNotes        = "installHash:$installHash;detectHash:$detectHash;runAsAccount:$runAsAccount;iconHash:$iconHash" | ConvertTo-Json -Compress

        $appBody = @"
{
  "@odata.type": "#microsoft.graph.win32LobApp",
  "displayName": $jDisplayName,
$iconFragment  "description": $jDescription,
  "publisher": "CONFIG365",
  "fileName": "install.intunewin",
  "setupFilePath": "install.ps1",
  "installCommandLine": $jInstallCmd,
  "uninstallCommandLine": $jUninstallCmd,
  "installExperience": { "runAsAccount": $jRunAs, "deviceRestartBehavior": "suppress" },
  "returnCodes": [{ "returnCode": 0, "type": "success" }],
  "detectionRules": [{
    "@odata.type": "#microsoft.graph.win32LobAppPowerShellScriptDetection",
    "enforceSignatureCheck": false,
    "runAs32Bit": false,
    "scriptContent": "$detectionScriptB64"
  }],
  "applicableArchitectures": "x64",
  "minimumSupportedOperatingSystem": { "v10_1607": true },
  "notes": $jNotes
}
"@

            Write-Host "  Resolved Intune name: $appName"
            $lookup   = Find-ExistingWin32AppForConfig -Config $config -PackageId $packageId -Prefix 'WinGet' -GetExisting ${function:Get-ExistingWin32App}
            $existing = $lookup.Existing
            if ($lookup.WasLegacyName) {
                Write-Host "  Found existing app under legacy name '$($lookup.WasLegacyName)'" -ForegroundColor DarkGray
            } elseif ($existing) {
                Write-Host "  Found existing app: $($existing.id)"
            } else {
                Write-Host "  No existing app found — will create"
            }

            # Parse stored hashes from notes (format: "installHash:X;detectHash:Y;...")
            $existingNotes       = $existing.notes ?? ''
            $existingInstallHash = if ($existingNotes -match 'installHash:([^;]+)') { $Matches[1] } else { '' }
            $existingDetectHash  = if ($existingNotes -match 'detectHash:([^;]+)')  { $Matches[1] } else { '' }
            $existingIconHash    = if ($existingNotes -match 'iconHash:([^;]*)')    { $Matches[1] } else { '' }
            $scriptChanged       = $existingInstallHash -ne $installHash
            $detectChanged       = $existingDetectHash  -ne $detectHash
            $iconChanged         = $existingIconHash    -ne $iconHash
            $nameChanged         = $existing -and ($existing.displayName -ne $appName)

            $existingAsgn  = @()
            $assignChanged = $false
            if ($existing) {
                $existingAsgn  = @(Get-AppAssignments -AppId $existing.id)
                $assignChanged = -not (Test-MobileAppAssignmentsMatch -ExistingAssignments $existingAsgn `
                    -ConfigAssignments @($config.assignments) -AvailableForAllUsers $availableForAllUsers)
            }

            if ($WhatIfMode) {
                if (-not $existing) {
                    Write-Host "  WouldCreate: $appName" -ForegroundColor Green
                    $wouldCreate++
                    $allResults.Add(@{ DisplayName = $appName; Status = 'WouldCreate'; Type = 'Win32App'; PackageId = $packageId })
                } elseif ($scriptChanged) {
                    Write-Host "  WouldUpdate: $appName (install script changed)" -ForegroundColor Yellow
                    $wouldUpdate++
                    $allResults.Add(@{
                        DisplayName = $appName; Status = 'WouldUpdate'; Type = 'Win32App'; PackageId = $packageId
                        Changes     = @{ Modified = @('Install Script') }
                    })
                } elseif ($assignChanged -or $nameChanged -or $detectChanged -or $iconChanged) {
                    $changes = @()
                    if ($nameChanged) { $changes += 'Display Name' }
                    if ($assignChanged) { $changes += 'Assignments' }
                    if ($detectChanged) { $changes += 'Detection Script' }
                    if ($iconChanged) { $changes += 'Icon' }
                    Write-Host "  WouldUpdate: $appName ($($changes -join ', ') changed)" -ForegroundColor Yellow
                    $wouldUpdate++
                    $asgnCount    = if ($config.assignments) { @($config.assignments).Count } else { 0 }
                    $asgnJson     = if ($config.assignments) { ConvertTo-Json -InputObject @($config.assignments) -Compress -Depth 5 } else { '[]' }
                    $existingJson = ConvertTo-Json -InputObject $existingAsgn -Compress -Depth 5
                    $allResults.Add(@{
                        DisplayName = $appName; Status = 'WouldUpdate'; Type = 'Win32App'; PackageId = $packageId
                        Changes     = @{ Modified = $changes; AssignmentsDesired = $asgnJson; AssignmentsExisting = $existingJson }
                    })
                } else {
                    Write-Host "  No changes: $appName" -ForegroundColor DarkGray
                    $noChange++
                    $allResults.Add(@{ DisplayName = $appName; Status = 'No changes'; Type = 'Win32App'; PackageId = $packageId })
                }
                continue
            }

            $allowCreate = ($env:ALLOW_CREATE -ne 'false')
            $allowUpdate = ($env:ALLOW_UPDATE -ne 'false')

            $appId = $null

            if (-not $existing) {
                if (-not $allowCreate) {
                    Write-Host "  SKIPPED (ALLOW_CREATE=false): $appName" -ForegroundColor DarkGray
                    $allResults.Add(@{ DisplayName = $appName; Status = 'Blocked'; Type = 'Win32App'; PackageId = $packageId })
                    continue
                }

                Write-DeployLog "  Building .intunewin package..."
                $pkgTmpDir     = Join-Path $globalTmpDir $packageId
                New-Item -ItemType Directory -Path $pkgTmpDir -Force | Out-Null
                $uninstallPs1  = Get-WingetUninstallPs1ForPack -InstallPs1 $installPs1 -PackageId $packageId -PkgTmpDir $pkgTmpDir -RunAsAccount $runAsAccount
                $intuneWinPath = New-IntuneWinPackage -InstallPs1Path $installPs1 -UninstallPs1Path $uninstallPs1 -TmpDir $pkgTmpDir
                Write-DeployLog "  Package built: $intuneWinPath"
                $metadata      = Get-IntuneWinMetadata -IntuneWinPath $intuneWinPath
                Write-DeployLog "  Metadata ready (encrypted size: $($metadata.EncryptedSize))"

                Write-Host "  Creating: $appName" -ForegroundColor Green
                $createdApp = Invoke-GraphRequest -Method POST `
                    -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps" -Body $appBody
                $appId = $createdApp.id
                Write-Host "  App created: $appId"

                Publish-Win32AppContent -AppId $appId -IntuneWinPath $intuneWinPath -Metadata $metadata
                $allResults.Add(@{ DisplayName = $appName; Status = 'Created'; Type = 'Win32App'; PackageId = $packageId })

            } elseif ($scriptChanged) {
                if (-not $allowUpdate) {
                    Write-Host "  SKIPPED (ALLOW_UPDATE=false): $appName" -ForegroundColor DarkGray
                    $allResults.Add(@{ DisplayName = $appName; Status = 'Blocked'; Type = 'Win32App'; PackageId = $packageId })
                    continue
                }
                $appId = $existing.id

                Write-DeployLog "  Building .intunewin package..."
                $pkgTmpDir     = Join-Path $globalTmpDir $packageId
                New-Item -ItemType Directory -Path $pkgTmpDir -Force | Out-Null
                $uninstallPs1  = Get-WingetUninstallPs1ForPack -InstallPs1 $installPs1 -PackageId $packageId -PkgTmpDir $pkgTmpDir -RunAsAccount $runAsAccount
                $intuneWinPath = New-IntuneWinPackage -InstallPs1Path $installPs1 -UninstallPs1Path $uninstallPs1 -TmpDir $pkgTmpDir
                Write-DeployLog "  Package built: $intuneWinPath"
                $metadata      = Get-IntuneWinMetadata -IntuneWinPath $intuneWinPath
                Write-DeployLog "  Metadata ready (encrypted size: $($metadata.EncryptedSize))"

                Write-Host "  Updating: $appName (install script changed)" -ForegroundColor Yellow
                Invoke-GraphRequest -Method PATCH `
                    -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$appId" -Body $appBody | Out-Null
                Publish-Win32AppContent -AppId $appId -IntuneWinPath $intuneWinPath -Metadata $metadata
                $allResults.Add(@{ DisplayName = $appName; Status = 'Updated'; Type = 'Win32App'; PackageId = $packageId })

            } elseif ($assignChanged -or $nameChanged -or $detectChanged -or $iconChanged) {
                if (-not $allowUpdate) {
                    Write-Host "  SKIPPED (ALLOW_UPDATE=false): $appName" -ForegroundColor DarkGray
                    $allResults.Add(@{ DisplayName = $appName; Status = 'Blocked'; Type = 'Win32App'; PackageId = $packageId })
                    continue
                }
                $appId = $existing.id

                $changes = @()
                if ($nameChanged) { $changes += 'display name' }
                if ($assignChanged) { $changes += 'assignments' }
                if ($detectChanged) { $changes += 'detection script' }
                if ($iconChanged) { $changes += 'icon' }
                Write-Host "  Updating: $appName ($($changes -join ', ') changed, skipping repackage)" -ForegroundColor Yellow
                if ($detectChanged) {
                    Invoke-GraphRequest -Method PATCH `
                        -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$appId" -Body $appBody | Out-Null
                } else {
                    $metaBody = @{
                        '@odata.type' = '#microsoft.graph.win32LobApp'
                        notes         = "installHash:$installHash;detectHash:$detectHash;runAsAccount:$runAsAccount;iconHash:$iconHash"
                    }
                    if ($nameChanged) { $metaBody.displayName = $appName }
                    if ($iconChanged) {
                        $metaBody = Add-Win32AppIconToPatchBody -Body $metaBody -IconPath $iconFilePath
                    }
                    Invoke-GraphRequest -Method PATCH `
                        -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$appId" -Body ($metaBody | ConvertTo-Json -Compress -Depth 6) | Out-Null
                }
                $status = if ($detectChanged -and ($assignChanged -or $nameChanged -or $iconChanged)) { 'MetadataUpdated' }
                          elseif ($detectChanged) { 'DetectionUpdated' }
                          elseif ($iconChanged -and ($assignChanged -or $nameChanged)) { 'MetadataUpdated' }
                          elseif ($iconChanged) { 'MetadataUpdated' }
                          elseif ($assignChanged -and $nameChanged) { 'MetadataUpdated' }
                          elseif ($assignChanged) { 'AssignmentsUpdated' }
                          else { 'MetadataUpdated' }
                $allResults.Add(@{ DisplayName = $appName; Status = $status; Type = 'Win32App'; PackageId = $packageId })

            } else {
                $appId = $existing.id
                Write-Host "  No changes: $appName" -ForegroundColor DarkGray
                $noChange++
                $allResults.Add(@{ DisplayName = $appName; Status = 'No changes'; Type = 'Win32App'; PackageId = $packageId })
            }

            # ── Assignments — sync when the app was created/updated or assignment metadata changed ──
            if (-not $appId) { continue }

            $configHasAssignments = $availableForAllUsers -or @($config.assignments | Where-Object {
                $_.groupName -and [string]$_.groupName.Trim()
            }).Count -gt 0
            $currentAssignments = @()
            if (-not $WhatIfMode) {
                $currentAssignments = @(Get-AppAssignments -AppId $appId)
            }
            $currentHasAllUsersAvailable = @($currentAssignments | Where-Object {
                $_.targetType -eq 'allLicensedUsers' -and $_.intent -eq 'available'
            }).Count -gt 0
            $configuredGroupCount = @($config.assignments | Where-Object {
                $_.groupName -and [string]$_.groupName.Trim()
            }).Count
            $currentGroupCount = @($currentAssignments | Where-Object { $_.groupId }).Count
            # Re-sync when config expects groups or Company Portal availability but Intune is missing them.
            $missingConfiguredAssignments = ($configuredGroupCount -gt 0 -and $currentGroupCount -eq 0) `
                -or ($availableForAllUsers -and -not $currentHasAllUsersAvailable)

            $shouldSyncAssignments = (-not $WhatIfMode) -and (
                -not $existing -or $scriptChanged -or $assignChanged -or $nameChanged -or $missingConfiguredAssignments
            )

            if ($shouldSyncAssignments) {
                if ($missingConfiguredAssignments -and -not $assignChanged) {
                    Write-Host "  Assignments missing in Intune — re-syncing (config has assignments, app has none)" -ForegroundColor Yellow
                }
                Write-Host "  Syncing assignments..."
                Sync-MobileAppAssignments -GraphBase $GRAPH_BASE -AppId $appId `
                    -InvokeGraph $invokeGraphSb -ResolveGroupId $resolveGroupSb `
                    -ConfigAssignments @($config.assignments) `
                    -AvailableForAllUsers $availableForAllUsers
            }

        } catch {
            Write-Host "##[error]Failed to process package '$packageId': $_" -ForegroundColor Red
            $errorCount++
            if ($allResults.Count -gt 0) {
                $last = $allResults[$allResults.Count - 1]
                if ($last.DisplayName -eq $appName -and $last.Status -eq 'No changes') {
                    [void]$allResults.RemoveAt($allResults.Count - 1)
                    if ($noChange -gt 0) { $noChange-- }
                }
            }
            $allResults.Add(@{ DisplayName = $appName; Status = 'Failed'; Type = 'Win32App'; PackageId = $packageId; Error = $_.ToString() })
        }
    }
} finally {
    if ($globalTmpDir -and (Test-Path $globalTmpDir)) {
        Remove-Item $globalTmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================================
# SUMMARY
# ============================================================================

Write-Host "`n##[section]WinGet Apps Summary"

if ($WhatIfMode) {
    Write-Host "  WouldCreate : $wouldCreate"
    Write-Host "  WouldUpdate : $wouldUpdate"
    Write-Host "  No changes  : $noChange"
} else {
    $updateStatuses = @('Updated', 'AssignmentsUpdated', 'DetectionUpdated', 'MetadataUpdated')
    $created  = @($allResults | Where-Object { $_.Status -eq 'Created' }).Count
    $updated  = @($allResults | Where-Object { $_.Status -in $updateStatuses }).Count
    $noChange = @($allResults | Where-Object { $_.Status -eq 'No changes' }).Count
    Write-Host "  Created     : $created"
    Write-Host "  Updated     : $updated"
    Write-Host "  No changes  : $noChange"
    $allResults | Where-Object { $_.Status -in $updateStatuses -or $_.Status -eq 'Created' } | ForEach-Object {
        Write-Host "    → $($_.Status): $($_.DisplayName)" -ForegroundColor DarkGray
    }
}
Write-Host "  Errors      : $errorCount"

if ($errorCount -gt 0) {
    $allResults | Where-Object { $_.Status -eq 'Failed' } | ForEach-Object {
        Write-Host "  Failed: $($_.DisplayName) - $($_.Error)" -ForegroundColor Red
    }
}

# ============================================================================
# OUTPUT JSON
# ============================================================================

if ($OutputPath) {
    $summary = @{
        Service          = 'WingetApps'
        Timestamp        = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        WhatIfMode       = [bool]$WhatIfMode
        WouldCreateCount = $wouldCreate
        WouldUpdateCount = $wouldUpdate
        NoChangeCount    = $noChange
        ErrorCount       = $errorCount
        Results          = @($allResults | ForEach-Object {
            @{
                DisplayName = $_.DisplayName
                PolicyType  = $_.Type
                Status      = $_.Status
                Type        = $_.Type
                Error       = $_.Error
                PackageId   = $_.PackageId
                Changes     = $_.Changes
                FilePath    = $appNameToFile[$_.DisplayName]
            }
        })
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "Plan summary saved to: $OutputPath"
}

if ($errorCount -gt 0) { exit 1 }
