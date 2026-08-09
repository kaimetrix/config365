function Resolve-Win32AppIconPath {
    param(
        [Parameter(Mandatory = $true)][string]$AppFolderPath,
        [object]$Config
    )
    $candidates = @()
    if ($Config.iconFile) { $candidates += [string]$Config.iconFile }
    $candidates += @('icon.png', 'icon.jpg', 'icon.jpeg')
    foreach ($name in $candidates | Select-Object -Unique) {
        if (-not $name) { continue }
        $path = Join-Path $AppFolderPath $name
        if (Test-Path -LiteralPath $path) { return $path }
    }
}

function Get-Win32AppIconHash {
    param([string]$IconPath)
    if (-not $IconPath -or -not (Test-Path -LiteralPath $IconPath)) { return '' }
    $bytes = [IO.File]::ReadAllBytes($IconPath)
    [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))
}

function Get-Win32AppIconMimeType {
    param([Parameter(Mandatory = $true)][string]$IconPath)
    switch ([IO.Path]::GetExtension($IconPath).ToLowerInvariant()) {
        '.png'  { 'image/png' }
        '.jpg'  { 'image/jpeg' }
        '.jpeg' { 'image/jpeg' }
        default { throw "Unsupported app icon type '$([IO.Path]::GetExtension($IconPath))' in $IconPath (use PNG or JPEG)" }
    }
}

function Get-Win32AppIconMimeContentHashtable {
    param([Parameter(Mandatory = $true)][string]$IconPath)
    $maxBytes = 512 * 1024
    $bytes    = [IO.File]::ReadAllBytes($IconPath)
    $mimeType = Get-Win32AppIconMimeType -IconPath $IconPath

    # Graph rejects icons with "Icon in invalid format" unless the PNG is 8-bit
    # truecolor+alpha. Indexed/paletted PNGs (e.g. produced by pngquant/TinyPNG/many
    # icon exporters) are perfectly valid PNGs but fail that check. Normalize
    # in-memory at upload time rather than requiring a specially-encoded source file.
    if ($mimeType -eq 'image/png') {
        try {
            $normalized = ConvertTo-TrueColorPngBytes -PngBytes $bytes
        } catch {
            throw "Icon '$IconPath' could not be normalized for Intune upload: $_"
        }
        if (-not [Object]::ReferenceEquals($normalized, $bytes)) {
            Write-Host "  Icon '$([IO.Path]::GetFileName($IconPath))' is not an 8-bit truecolor PNG — converted for Intune compatibility" -ForegroundColor DarkGray
        }
        $bytes = $normalized
    }

    if ($bytes.Length -gt $maxBytes) {
        throw "App icon exceeds $($maxBytes / 1024) KB: $IconPath ($($bytes.Length) bytes)"
    }
    @{
        '@odata.type' = '#microsoft.graph.mimeContent'
        type          = $mimeType
        value         = [Convert]::ToBase64String($bytes)
    }
}

function Get-Win32AppIconJsonFragment {
    param([string]$IconPath)
    if (-not $IconPath -or -not (Test-Path -LiteralPath $IconPath)) { return '' }
    # win32LobApp (via mobileApp) only defines "largeIcon" — there is no "smallIcon" property
    # in the Graph schema. Sending it causes Graph to reject the request with
    # "Icon in invalid format".
    $iconJson = (Get-Win32AppIconMimeContentHashtable -IconPath $IconPath | ConvertTo-Json -Compress -Depth 3)
    return "  `"largeIcon`": $iconJson,`n"
}

# ============================================================================
# PNG NORMALIZATION
#
# Intune's app-icon validation rejects any PNG that isn't 8-bit truecolor+alpha
# (colorType 6) with "Icon in invalid format", even though indexed/palette PNGs
# (colorType 3 — very common output from pngquant, TinyPNG, and many icon
# exporters/design tools) and plain grayscale/truecolor PNGs are fully valid
# per the PNG spec. Rather than requiring every icon file in Git to be
# re-exported in a specific way, decode and re-encode the icon in memory
# immediately before upload.
# ============================================================================

$script:PngCrc32Table = $null

function Get-PngCrc32Table {
    # NOTE: use [long] throughout — PowerShell's -bxor/-shr on [uint32] operands can
    # produce an intermediate that no longer round-trips through a [uint32] cast
    # (throws "value was either too large or too small for a UInt32"). Masking a
    # [long] with 0xFFFFFFFFL keeps the value in-range and always safely castable.
    if ($script:PngCrc32Table) { return $script:PngCrc32Table }
    $table = New-Object 'uint32[]' 256
    for ($n = 0; $n -lt 256; $n++) {
        [long]$c = $n
        for ($k = 0; $k -lt 8; $k++) {
            if (($c -band 1L) -ne 0) {
                $c = (0xEDB88320L -bxor ($c -shr 1)) -band 0xFFFFFFFFL
            } else {
                $c = ($c -shr 1) -band 0xFFFFFFFFL
            }
        }
        $table[$n] = [uint32]$c
    }
    $script:PngCrc32Table = $table
    # Comma forces PowerShell to treat the array as a single pipeline object instead
    # of unrolling/re-collecting each element (breaks reference identity and is slow
    # for large byte[] results elsewhere in this file).
    return ,$table
}

function Get-PngCrc32 {
    param([byte[]]$Bytes)
    $table = Get-PngCrc32Table
    [long]$crc = 0xFFFFFFFFL
    foreach ($b in $Bytes) {
        $idx  = [int](($crc -bxor [long]$b) -band 0xFFL)
        $crc  = ([long]$table[$idx] -bxor ($crc -shr 8)) -band 0xFFFFFFFFL
    }
    return [uint32](($crc -bxor 0xFFFFFFFFL) -band 0xFFFFFFFFL)
}

function ConvertTo-PngBigEndianBytes {
    param([uint32]$Value)
    [long]$v = $Value
    $result = [byte[]]@(
        [byte](($v -shr 24) -band 0xFFL),
        [byte](($v -shr 16) -band 0xFFL),
        [byte](($v -shr 8) -band 0xFFL),
        [byte]($v -band 0xFFL)
    )
    return ,$result
}

function ConvertFrom-PngBigEndianUInt32 {
    param([byte[]]$Bytes, [int]$Offset)
    [long]$v = (([long]$Bytes[$Offset] -shl 24) -bor ([long]$Bytes[$Offset + 1] -shl 16) `
        -bor ([long]$Bytes[$Offset + 2] -shl 8) -bor [long]$Bytes[$Offset + 3])
    return [uint32]($v -band 0xFFFFFFFFL)
}

function Read-PngChunks {
    param([byte[]]$Bytes)
    $signature = [byte[]]@(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    if ($Bytes.Length -lt 8) { throw "Not a valid PNG file (too short)" }
    for ($i = 0; $i -lt 8; $i++) {
        if ($Bytes[$i] -ne $signature[$i]) { throw "Not a valid PNG file (bad signature)" }
    }
    $chunks = [System.Collections.Generic.List[hashtable]]::new()
    $pos = 8
    while ($pos + 8 -le $Bytes.Length) {
        $len       = [int](ConvertFrom-PngBigEndianUInt32 -Bytes $Bytes -Offset $pos)
        $type      = [Text.Encoding]::ASCII.GetString($Bytes, $pos + 4, 4)
        $dataStart = $pos + 8
        if ($dataStart + $len + 4 -gt $Bytes.Length) { throw "Corrupt PNG chunk '$type'" }
        $data = New-Object byte[] $len
        if ($len -gt 0) { [Array]::Copy($Bytes, $dataStart, $data, 0, $len) }
        $chunks.Add(@{ Type = $type; Data = $data })
        $pos = $dataStart + $len + 4
        if ($type -eq 'IEND') { break }
    }
    return ,$chunks
}

function New-PngChunk {
    param([string]$Type, [byte[]]$Data)
    $typeBytes = [Text.Encoding]::ASCII.GetBytes($Type)
    $lenBytes  = ConvertTo-PngBigEndianBytes -Value ([uint32]$Data.Length)
    $crcBytes  = ConvertTo-PngBigEndianBytes -Value (Get-PngCrc32 -Bytes ($typeBytes + $Data))
    $result    = $lenBytes + $typeBytes + $Data + $crcBytes
    return ,$result
}

function Invoke-PngZlibInflate {
    param([byte[]]$Data)
    $inputStream = New-Object System.IO.MemoryStream(, $Data)
    $zlib        = New-Object System.IO.Compression.ZLibStream($inputStream, [System.IO.Compression.CompressionMode]::Decompress)
    $out         = New-Object System.IO.MemoryStream
    try { $zlib.CopyTo($out) } finally { $zlib.Dispose() }
    return ,$out.ToArray()
}

function Invoke-PngZlibDeflate {
    param([byte[]]$Data)
    $out  = New-Object System.IO.MemoryStream
    $zlib = New-Object System.IO.Compression.ZLibStream($out, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    try { $zlib.Write($Data, 0, $Data.Length) } finally { $zlib.Dispose() }
    return ,$out.ToArray()
}

function Get-PngBitsPerPixel {
    param([int]$ColorType, [int]$BitDepth)
    $channels = switch ($ColorType) {
        0 { 1 }  # grayscale
        2 { 3 }  # truecolor
        3 { 1 }  # indexed
        4 { 2 }  # grayscale + alpha
        6 { 4 }  # truecolor + alpha
        default { throw "Unsupported PNG color type: $ColorType" }
    }
    return $channels * $BitDepth
}

function Undo-PngFilters {
    param(
        [byte[]]$Raw,
        [int]$Width,
        [int]$Height,
        [int]$BitsPerPixel
    )
    $bpp      = [Math]::Max(1, [int][Math]::Ceiling($BitsPerPixel / 8.0))
    $rowBytes = [int][Math]::Ceiling(($Width * $BitsPerPixel) / 8.0)
    $stride   = $rowBytes + 1
    if ($Raw.Length -lt ($stride * $Height)) { throw "PNG image data is shorter than expected" }

    $result  = New-Object byte[] ($rowBytes * $Height)
    $prevRow = New-Object byte[] $rowBytes

    for ($y = 0; $y -lt $Height; $y++) {
        $rowStart   = $y * $stride
        $filterType = $Raw[$rowStart]
        $curRow     = New-Object byte[] $rowBytes
        for ($x = 0; $x -lt $rowBytes; $x++) {
            $filt = [int]$Raw[$rowStart + 1 + $x]
            $a = if ($x -ge $bpp) { [int]$curRow[$x - $bpp] } else { 0 }
            $b = [int]$prevRow[$x]
            $c = if ($x -ge $bpp) { [int]$prevRow[$x - $bpp] } else { 0 }
            $value = switch ($filterType) {
                0 { $filt }
                1 { $filt + $a }
                2 { $filt + $b }
                3 { $filt + [int][Math]::Floor(($a + $b) / 2.0) }
                4 {
                    $p  = $a + $b - $c
                    $pa = [Math]::Abs($p - $a)
                    $pb = [Math]::Abs($p - $b)
                    $pc = [Math]::Abs($p - $c)
                    if ($pa -le $pb -and $pa -le $pc) { $filt + $a }
                    elseif ($pb -le $pc) { $filt + $b }
                    else { $filt + $c }
                }
                default { throw "Unsupported PNG filter type: $filterType" }
            }
            $curRow[$x] = [byte]($value -band 0xFF)
        }
        [Array]::Copy($curRow, 0, $result, $y * $rowBytes, $rowBytes)
        $prevRow = $curRow
    }
    return ,$result
}

function Get-PngSampleValue {
    param([byte[]]$RowBytes, [int]$SampleIndex, [int]$BitDepth)
    if ($BitDepth -eq 8)  { return [int]$RowBytes[$SampleIndex] }
    if ($BitDepth -eq 16) { return [int]$RowBytes[$SampleIndex * 2] }  # high byte only
    $samplesPerByte = 8 / $BitDepth
    $byteIndex      = [int][Math]::Floor($SampleIndex / $samplesPerByte)
    $sampleInByte   = $SampleIndex % $samplesPerByte
    $shift          = 8 - $BitDepth - ($sampleInByte * $BitDepth)
    $mask           = (1 -shl $BitDepth) - 1
    return ([int]$RowBytes[$byteIndex] -shr $shift) -band $mask
}

<#
.SYNOPSIS
    Ensures a PNG is 8-bit truecolor+alpha (colorType 6), which is the only
    format Graph reliably accepts for mobileApp largeIcon uploads.

.DESCRIPTION
    Returns the original byte array unchanged (same reference) if it is
    already an 8-bit, non-interlaced truecolor+alpha PNG. Otherwise decodes
    grayscale / truecolor / indexed / grayscale+alpha PNGs (any bit depth
    1/2/4/8/16, non-interlaced) and re-encodes as 8-bit truecolor+alpha.
#>
function ConvertTo-TrueColorPngBytes {
    param([Parameter(Mandatory = $true)][byte[]]$PngBytes)

    $chunks    = Read-PngChunks -Bytes $PngBytes
    $ihdrChunk = $chunks | Where-Object { $_.Type -eq 'IHDR' } | Select-Object -First 1
    if (-not $ihdrChunk) { throw "PNG is missing its IHDR chunk" }
    $ihdr      = $ihdrChunk.Data
    $width     = [int](ConvertFrom-PngBigEndianUInt32 -Bytes $ihdr -Offset 0)
    $height    = [int](ConvertFrom-PngBigEndianUInt32 -Bytes $ihdr -Offset 4)
    $bitDepth  = [int]$ihdr[8]
    $colorType = [int]$ihdr[9]
    $interlace = [int]$ihdr[12]

    # Already Intune-compatible — nothing to do.
    if ($colorType -eq 6 -and $bitDepth -eq 8 -and $interlace -eq 0) {
        return ,$PngBytes
    }
    if ($interlace -ne 0) {
        throw "Interlaced PNGs aren't supported for automatic conversion — re-save the icon as a non-interlaced PNG."
    }
    if ($width -le 0 -or $height -le 0) { throw "PNG has invalid dimensions ($width x $height)" }

    $palette = $null
    $paletteChunk = $chunks | Where-Object { $_.Type -eq 'PLTE' } | Select-Object -First 1
    if ($paletteChunk) { $palette = $paletteChunk.Data }
    if ($colorType -eq 3 -and -not $palette) { throw "Indexed PNG is missing its PLTE palette chunk" }

    $trns = $null
    $trnsChunk = $chunks | Where-Object { $_.Type -eq 'tRNS' } | Select-Object -First 1
    if ($trnsChunk) { $trns = $trnsChunk.Data }

    $idatBytes = [System.Collections.Generic.List[byte]]::new()
    foreach ($c in ($chunks | Where-Object { $_.Type -eq 'IDAT' })) {
        $idatBytes.AddRange([byte[]]$c.Data)
    }
    if ($idatBytes.Count -eq 0) { throw "PNG has no IDAT image data" }

    $inflated     = Invoke-PngZlibInflate -Data $idatBytes.ToArray()
    $bitsPerPixel = Get-PngBitsPerPixel -ColorType $colorType -BitDepth $bitDepth
    $raw          = Undo-PngFilters -Raw $inflated -Width $width -Height $height -BitsPerPixel $bitsPerPixel
    $rowBytes     = [int][Math]::Ceiling(($width * $bitsPerPixel) / 8.0)
    $maxSample    = [Math]::Pow(2, [Math]::Min($bitDepth, 16)) - 1

    $rgba = New-Object byte[] ($width * $height * 4)

    for ($y = 0; $y -lt $height; $y++) {
        $rowOffset = $y * $rowBytes
        $rowSlice  = $raw[$rowOffset..($rowOffset + $rowBytes - 1)]
        for ($x = 0; $x -lt $width; $x++) {
            $outIdx = (($y * $width) + $x) * 4
            switch ($colorType) {
                0 {
                    # Grayscale
                    $g  = Get-PngSampleValue -RowBytes $rowSlice -SampleIndex $x -BitDepth $bitDepth
                    $g8 = if ($bitDepth -eq 8 -or $bitDepth -eq 16) { $g } else { [int][Math]::Round($g * 255.0 / $maxSample) }
                    $alpha = 255
                    if ($trns -and $trns.Length -ge 2) {
                        $trnsVal = ([int]$trns[0] -shl 8) -bor [int]$trns[1]
                        if ($g -eq $trnsVal) { $alpha = 0 }
                    }
                    $rgba[$outIdx]     = [byte]$g8
                    $rgba[$outIdx + 1] = [byte]$g8
                    $rgba[$outIdx + 2] = [byte]$g8
                    $rgba[$outIdx + 3] = [byte]$alpha
                }
                2 {
                    # Truecolor
                    $base = $x * 3
                    $rgba[$outIdx]     = [byte](Get-PngSampleValue -RowBytes $rowSlice -SampleIndex $base       -BitDepth $bitDepth)
                    $rgba[$outIdx + 1] = [byte](Get-PngSampleValue -RowBytes $rowSlice -SampleIndex ($base + 1) -BitDepth $bitDepth)
                    $rgba[$outIdx + 2] = [byte](Get-PngSampleValue -RowBytes $rowSlice -SampleIndex ($base + 2) -BitDepth $bitDepth)
                    $rgba[$outIdx + 3] = 255
                }
                3 {
                    # Indexed / palette
                    $index = Get-PngSampleValue -RowBytes $rowSlice -SampleIndex $x -BitDepth $bitDepth
                    $pOff  = $index * 3
                    if ($pOff + 2 -ge $palette.Length) { throw "PNG palette index $index is out of range" }
                    $rgba[$outIdx]     = $palette[$pOff]
                    $rgba[$outIdx + 1] = $palette[$pOff + 1]
                    $rgba[$outIdx + 2] = $palette[$pOff + 2]
                    $rgba[$outIdx + 3] = if ($trns -and $index -lt $trns.Length) { $trns[$index] } else { 255 }
                }
                4 {
                    # Grayscale + alpha
                    $base = $x * 2
                    $g = Get-PngSampleValue -RowBytes $rowSlice -SampleIndex $base -BitDepth $bitDepth
                    $a = Get-PngSampleValue -RowBytes $rowSlice -SampleIndex ($base + 1) -BitDepth $bitDepth
                    $rgba[$outIdx]     = [byte]$g
                    $rgba[$outIdx + 1] = [byte]$g
                    $rgba[$outIdx + 2] = [byte]$g
                    $rgba[$outIdx + 3] = [byte]$a
                }
                6 {
                    # Truecolor + alpha (only reached here for 16-bit; 8-bit returns early above)
                    $base = $x * 4
                    $rgba[$outIdx]     = [byte](Get-PngSampleValue -RowBytes $rowSlice -SampleIndex $base       -BitDepth $bitDepth)
                    $rgba[$outIdx + 1] = [byte](Get-PngSampleValue -RowBytes $rowSlice -SampleIndex ($base + 1) -BitDepth $bitDepth)
                    $rgba[$outIdx + 2] = [byte](Get-PngSampleValue -RowBytes $rowSlice -SampleIndex ($base + 2) -BitDepth $bitDepth)
                    $rgba[$outIdx + 3] = [byte](Get-PngSampleValue -RowBytes $rowSlice -SampleIndex ($base + 3) -BitDepth $bitDepth)
                }
            }
        }
    }

    # Re-filter using "None" (type 0) — simplest correct encoding; icons are small
    # enough that skipping filter-heuristics doesn't meaningfully affect file size.
    $newRowBytes = $width * 4
    $filtered    = New-Object byte[] (($newRowBytes + 1) * $height)
    for ($y = 0; $y -lt $height; $y++) {
        $srcOffset = $y * $newRowBytes
        $dstOffset = $y * ($newRowBytes + 1)
        $filtered[$dstOffset] = 0
        [Array]::Copy($rgba, $srcOffset, $filtered, $dstOffset + 1, $newRowBytes)
    }

    $newIdat = Invoke-PngZlibDeflate -Data $filtered
    $newIhdr = (ConvertTo-PngBigEndianBytes -Value ([uint32]$width)) +
               (ConvertTo-PngBigEndianBytes -Value ([uint32]$height)) +
               [byte[]]@(8, 6, 0, 0, 0)  # bitDepth=8, colorType=6 (truecolor+alpha), compression=0, filter=0, interlace=0

    $signature = [byte[]]@(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    $out = [System.Collections.Generic.List[byte]]::new()
    $out.AddRange([byte[]]$signature)
    $out.AddRange([byte[]](New-PngChunk -Type 'IHDR' -Data $newIhdr))
    $out.AddRange([byte[]](New-PngChunk -Type 'IDAT' -Data $newIdat))
    $out.AddRange([byte[]](New-PngChunk -Type 'IEND' -Data ([byte[]]@())))
    return ,$out.ToArray()
}

function Add-Win32AppIconToPatchBody {
    param(
        [hashtable]$Body,
        [string]$IconPath
    )
    if (-not $IconPath -or -not (Test-Path -LiteralPath $IconPath)) { return $Body }
    # Only "largeIcon" is a valid mobileApp/win32LobApp property — see note above.
    $Body.largeIcon = Get-Win32AppIconMimeContentHashtable -IconPath $IconPath
    return $Body
}
