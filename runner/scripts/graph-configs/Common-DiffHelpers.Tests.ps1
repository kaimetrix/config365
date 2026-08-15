# Pester tests for monitor sidecar merge / filter.
# Run: Invoke-Pester -Path $PSCommandPath
BeforeAll {
    . (Join-Path $PSScriptRoot 'Common-DiffHelpers.ps1')
}

Describe 'Merge-MonitorConfigs' {
    It 'drops folder include AllowedSenders when file excludes AllowedSenders' {
        $file   = @{ Exclude = [string[]]@('AllowedSenders') }
        $folder = @{ Include = [string[]]@('EnableEndUserSpamNotifications', 'AllowedSenders', 'SpamAction') }
        $merged = Merge-MonitorConfigs -FileConfig $file -FolderConfig $folder
        $merged['Exclude'] | Should -Be @('AllowedSenders')
        $merged['Include'] | Should -Not -Contain 'AllowedSenders'
        $merged['Include'] | Should -Be @('EnableEndUserSpamNotifications', 'SpamAction')
    }

    It 'drops folder include AllowedSenders.Sender when file excludes AllowedSenders' {
        $file   = @{ Exclude = [string[]]@('AllowedSenders') }
        $folder = @{ Include = [string[]]@('AllowedSenders.Sender', 'SpamAction') }
        $merged = Merge-MonitorConfigs -FileConfig $file -FolderConfig $folder
        $merged['Include'] | Should -Not -Contain 'AllowedSenders.Sender'
        $merged['Exclude'] | Should -Be @('AllowedSenders')
    }

    It 'merges two single-element excludes as two keys not one concatenated string' {
        $fileRaw   = '{"exclude":["AllowedSenders"]}' | ConvertFrom-Json -AsHashtable
        $folderRaw = '{"exclude":["DirectoryObjectVersion"]}' | ConvertFrom-Json -AsHashtable
        $file   = _MF_FinalizeMonitorConfig $null $fileRaw['exclude']
        $folder = _MF_FinalizeMonitorConfig $null $folderRaw['exclude']
        $merged = Merge-MonitorConfigs -FileConfig $file -FolderConfig $folder
        $merged['Exclude'] -is [string] | Should -BeFalse
        $merged['Exclude'] | Should -HaveCount 2
        $merged['Exclude'] | Should -Contain 'AllowedSenders'
        $merged['Exclude'] | Should -Contain 'DirectoryObjectVersion'
        $merged['Exclude'] | Should -Not -Be 'AllowedSendersDirectoryObjectVersion'
    }

    It 'keeps a single-element exclude usable (no character-walk on apply)' {
        $file   = @{ Exclude = 'AllowedSenders' }
        $merged = Merge-MonitorConfigs -FileConfig $file -FolderConfig $null
        $merged['Exclude'] | Should -HaveCount 1
        $merged['Exclude'] | Should -Contain 'AllowedSenders'
        $filtered = Apply-MonitorFilter -PolicyObject @{ AllowedSenders = 1; SpamAction = 'x' } -MonitorConfig $merged
        $filtered.ContainsKey('AllowedSenders') | Should -BeFalse
        $filtered['SpamAction'] | Should -Be 'x'
    }
}

Describe 'Apply-MonitorFilter' {
    BeforeAll {
        $script:policy = [ordered]@{
            AddXHeaderValue = ''
            AllowedSenders  = @{
                Group  = 'Default'
                Sender = @{ Address = 'no-reply@mintago.com' }
            }
            SpamAction = 'MoveToJmf'
        }
    }

    It 'strips AllowedSenders when file+folder excludes would previously concatenate' {
        $fileRaw   = '{"exclude":["AllowedSenders"]}' | ConvertFrom-Json -AsHashtable
        $folderRaw = '{"exclude":["DirectoryObjectVersion"]}' | ConvertFrom-Json -AsHashtable
        $merged = Merge-MonitorConfigs `
            -FileConfig (_MF_FinalizeMonitorConfig $null $fileRaw['exclude']) `
            -FolderConfig (_MF_FinalizeMonitorConfig $null $folderRaw['exclude'])
        $filtered = Apply-MonitorFilter -PolicyObject $script:policy -MonitorConfig $merged
        $filtered.ContainsKey('AllowedSenders') | Should -BeFalse
        $filtered['SpamAction'] | Should -Be 'MoveToJmf'
    }

    It 'removes AllowedSenders for a single-element exclude (no character-walk)' {
        $cfg = @{ Exclude = 'AllowedSenders' }
        $filtered = Apply-MonitorFilter -PolicyObject $script:policy -MonitorConfig $cfg
        $filtered.ContainsKey('AllowedSenders') | Should -BeFalse
        $filtered['SpamAction'] | Should -Be 'MoveToJmf'
    }

    It 'file exclude wins after folder include of AllowedSenders.Sender' {
        $merged = Merge-MonitorConfigs `
            -FileConfig @{ Exclude = [string[]]@('AllowedSenders') } `
            -FolderConfig @{ Include = [string[]]@('AllowedSenders.Sender', 'SpamAction') }
        $filtered = Apply-MonitorFilter -PolicyObject $script:policy -MonitorConfig $merged
        $filtered.ContainsKey('AllowedSenders') | Should -BeFalse
        $filtered['SpamAction'] | Should -Be 'MoveToJmf'
    }

    It 'removes empty parent after nested exclude' {
        $onlySender = [ordered]@{
            AllowedSenders = @{ Sender = @{ Address = 'a@b.com' } }
            SpamAction     = 'MoveToJmf'
        }
        $cfg = @{ Exclude = [string[]]@('AllowedSenders.Sender') }
        $filtered = Apply-MonitorFilter -PolicyObject $onlySender -MonitorConfig $cfg
        $filtered.ContainsKey('AllowedSenders') | Should -BeFalse
    }
}

Describe 'Get-MonitorExcludeTopLevelKeys' {
    It 'flattens nested exclude paths to the top-level key' {
        $cfg = @{ Exclude = [string[]]@('AllowedSenders.Sender', 'BlockedSenders') }
        $keys = Get-MonitorExcludeTopLevelKeys -MonitorConfig $cfg
        $keys | Should -Contain 'AllowedSenders'
        $keys | Should -Contain 'BlockedSenders'
        $keys.Count | Should -Be 2
    }
}
