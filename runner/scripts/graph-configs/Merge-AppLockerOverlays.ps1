<#
.SYNOPSIS
    Merges tenant AppLocker overlay JSON into baseline device-configuration files.

.DESCRIPTION
    Mutates the runner working copy of baseline Intune custom profiles that contain
    AppLocker RuleCollection XML. Overlay files live in the tenant repo:

        intune/applocker/{exe,msi,script,appx,dll}.overlay.json

    {
      "excludeRuleIds": [ "guid" ],
      "rules": [ { "xmlName": "FilePathRule", ... } ],
      "enforcementMode": "Enabled"   # optional
    }

    Does not commit merged XML back to the baseline repo.
#>

function ConvertTo-AppLockerXmlEncoded {
    param([string]$Value)
    if ($null -eq $Value) { return '' }
    return (($Value -replace '&', '&amp;') -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;')
}

function ConvertTo-AppLockerConditionXml {
    param($Condition)
    if (-not $Condition) { return '' }
    $kind = [string]$Condition.kind
    if ($kind -eq 'path') {
        $path = ConvertTo-AppLockerXmlEncoded ([string]$Condition.path)
        return "<FilePathCondition Path=`"$path`" />"
    }
    if ($kind -eq 'hash') {
        $hashes = @()
        foreach ($h in @($Condition.hashes)) {
            $type = ConvertTo-AppLockerXmlEncoded ($(if ($h.type) { [string]$h.type } else { 'SHA256' }))
            $data = ConvertTo-AppLockerXmlEncoded ([string]$h.data)
            $name = ConvertTo-AppLockerXmlEncoded ([string]$h.sourceFileName)
            $len  = ConvertTo-AppLockerXmlEncoded ($(if ($h.sourceFileLength) { [string]$h.sourceFileLength } else { '0' }))
            $hashes += "<FileHash Type=`"$type`" Data=`"$data`" SourceFileName=`"$name`" SourceFileLength=`"$len`" />"
        }
        return "<FileHashCondition>$($hashes -join '')</FileHashCondition>"
    }
    $pub = ConvertTo-AppLockerXmlEncoded ($(if ($Condition.publisherName) { [string]$Condition.publisherName } else { '*' }))
    $prod = ConvertTo-AppLockerXmlEncoded ($(if ($Condition.productName) { [string]$Condition.productName } else { '*' }))
    $bin = ConvertTo-AppLockerXmlEncoded ($(if ($Condition.binaryName) { [string]$Condition.binaryName } else { '*' }))
    $low = ConvertTo-AppLockerXmlEncoded ($(if ($Condition.lowSection) { [string]$Condition.lowSection } else { '*' }))
    $high = ConvertTo-AppLockerXmlEncoded ($(if ($Condition.highSection) { [string]$Condition.highSection } else { '*' }))
    return "<FilePublisherCondition PublisherName=`"$pub`" ProductName=`"$prod`" BinaryName=`"$bin`"><BinaryVersionRange LowSection=`"$low`" HighSection=`"$high`" /></FilePublisherCondition>"
}

function ConvertTo-AppLockerRuleXml {
    param($Rule)
    $xmlName = [string]$Rule.xmlName
    if ($xmlName -notin @('FilePublisherRule', 'FilePathRule', 'FileHashRule')) { return '' }
    $id = ConvertTo-AppLockerXmlEncoded ($(if ($Rule.id) { [string]$Rule.id } else { [guid]::NewGuid().ToString().ToUpperInvariant() }))
    $name = ConvertTo-AppLockerXmlEncoded ([string]$Rule.name)
    $descText = if ($Rule.description) { [string]$Rule.description } else { '' }
    $desc = if ($descText) { " Description=`"$(ConvertTo-AppLockerXmlEncoded $descText)`"" } else { '' }
    $sid = ConvertTo-AppLockerXmlEncoded ($(if ($Rule.userOrGroupSid) { [string]$Rule.userOrGroupSid } else { 'S-1-1-0' }))
    $action = if ([string]$Rule.action -eq 'Deny') { 'Deny' } else { 'Allow' }
    $conds = (@($Rule.conditions) | ForEach-Object { ConvertTo-AppLockerConditionXml $_ }) -join ''
    $excs = (@($Rule.exceptions) | ForEach-Object { ConvertTo-AppLockerConditionXml $_ }) -join ''
    $excXml = if ($excs) { "<Exceptions>$excs</Exceptions>" } else { '' }
    return "<$xmlName Id=`"$id`" Name=`"$name`"$desc UserOrGroupSid=`"$sid`" Action=`"$action`"><Conditions>$conds</Conditions>$excXml</$xmlName>"
}

function Get-AppLockerOverlayKey {
    param([string]$OmaUri, [string]$FileName, [string]$Xml)
    $u = ($OmaUri + ' ' + $FileName + ' ' + $Xml).ToUpperInvariant()
    if ($u -match '/SCRIPT/POLICY' -or $FileName -match 'script') { return 'script' }
    if ($u -match '/STOREAPPS/POLICY' -or $FileName -match 'appx|store') { return 'appx' }
    if ($u -match '/MSI/POLICY' -or $FileName -match 'msi') { return 'msi' }
    if ($u -match '/DLL/POLICY' -or $FileName -match 'dll') { return 'dll' }
    if ($u -match '/EXE/POLICY' -or $FileName -match 'exe' -or $u -match 'APPLOCKER') { return 'exe' }
    return $null
}

function Merge-AppLockerOverlays {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$PolicyFiles,

        [Parameter(Mandatory = $false)]
        [string]$TenantRepoPath
    )

    if ([string]::IsNullOrWhiteSpace($TenantRepoPath) -or -not (Test-Path -LiteralPath $TenantRepoPath)) {
        return
    }

    $overlayRoot = Join-Path $TenantRepoPath 'intune/applocker'
    if (-not (Test-Path -LiteralPath $overlayRoot)) {
        return
    }

    Write-Host "Merging tenant AppLocker overlays from $overlayRoot"

    foreach ($file in @($PolicyFiles)) {
        if ($file.Directory.Name -ne 'device-configurations') { continue }
        if ($file.Name -like '*.assignment.json' -or $file.Name -like '*.monitor.json') { continue }

        try {
            $json = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        } catch {
            continue
        }

        $oma = $null
        if ($json.omaSettings) {
            $oma = @($json.omaSettings) | Where-Object {
                $_.omaUri -match 'ApplicationLaunchRestrictions' -or $_.value -match 'RuleCollection'
            } | Select-Object -First 1
        }
        if (-not $oma -or -not $oma.value) { continue }

        $key = Get-AppLockerOverlayKey -OmaUri ([string]$oma.omaUri) -FileName $file.Name -Xml ([string]$oma.value)
        if (-not $key) { continue }

        $overlayPath = Join-Path $overlayRoot "$key.overlay.json"
        if (-not (Test-Path -LiteralPath $overlayPath)) { continue }

        try {
            $overlay = Get-Content -LiteralPath $overlayPath -Raw | ConvertFrom-Json
        } catch {
            Write-Host "##[warning]Failed to parse AppLocker overlay $overlayPath : $_"
            continue
        }

        $xmlText = [string]$oma.value
        try {
            $doc = [xml]$xmlText
        } catch {
            Write-Host "##[warning]AppLocker XML in $($file.Name) is not well-formed: $_"
            continue
        }

        $root = $doc.DocumentElement
        if (-not $root -or $root.LocalName -ne 'RuleCollection') {
            $root = $doc.SelectSingleNode('//RuleCollection')
        }
        if (-not $root) { continue }

        $exclude = @()
        if ($overlay.excludeRuleIds) {
            $exclude = @($overlay.excludeRuleIds | ForEach-Object { ([string]$_).ToLowerInvariant() })
        }

        $removed = 0
        $toRemove = @($root.ChildNodes | Where-Object {
            $_.NodeType -eq [System.Xml.XmlNodeType]::Element -and
            $_.Id -and ($exclude -contains ([string]$_.Id).ToLowerInvariant())
        })
        foreach ($node in $toRemove) {
            [void]$root.RemoveChild($node)
            $removed++
        }

        $added = 0
        foreach ($rule in @($overlay.rules)) {
            $fragment = ConvertTo-AppLockerRuleXml -Rule $rule
            if (-not $fragment) { continue }
            $rid = ([string]$rule.id).ToLowerInvariant()
            if ($rid) {
                $dup = @($root.ChildNodes | Where-Object {
                    $_.NodeType -eq [System.Xml.XmlNodeType]::Element -and
                    $_.Id -and (([string]$_.Id).ToLowerInvariant() -eq $rid)
                })
                foreach ($node in $dup) { [void]$root.RemoveChild($node) }
            }
            $tmp = [xml]"<wrap>$fragment</wrap>"
            foreach ($child in @($tmp.DocumentElement.ChildNodes)) {
                $imported = $doc.ImportNode($child, $true)
                [void]$root.AppendChild($imported)
                $added++
            }
        }

        if ($overlay.enforcementMode) {
            $mode = [string]$overlay.enforcementMode
            if ($mode -in @('Enabled', 'AuditOnly', 'NotConfigured')) {
                $root.SetAttribute('EnforcementMode', $mode)
            }
        }

        $mergedXml = $root.OuterXml
        $oma.value = $mergedXml

        # Working-copy only — must write even when the deploy job is in -WhatIf.
        # Set-Content honors $WhatIfPreference, which left overlay merges as a no-op
        # and made AppLocker compare Graph (with tenant rules) to the raw baseline.
        $json | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $file.FullName -Encoding utf8 -WhatIf:$false -Confirm:$false
        Write-Host "  Merged AppLocker overlay ($key) into $($file.Name): excluded $removed, added $added"
    }
}
