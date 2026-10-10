param(
    [string]$ToolsDirectory = (Join-Path $PSScriptRoot '..\tools'),
    [switch]$Force,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ToolsDirectory = [IO.Path]::GetFullPath($ToolsDirectory)
New-Item -ItemType Directory -Path $ToolsDirectory -Force | Out-Null
$stageDirectory = Join-Path $ToolsDirectory ('.setup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stageDirectory -Force | Out-Null
$requestHeaders = @{ 'User-Agent' = 'PULL-video-downloader-setup'; 'Accept' = 'application/vnd.github+json' }

function Get-Download([string]$Uri, [string]$Destination) {
    if (-not $Uri.StartsWith('https://')) { throw 'Only HTTPS tool sources are accepted.' }
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -Headers @{ 'User-Agent' = 'PULL-video-downloader-setup' }
}

function Assert-Sha256([string]$File, [string]$Expected) {
    if ($Expected -notmatch '^[a-fA-F0-9]{64}$') { throw "No valid SHA256 checksum for $([IO.Path]::GetFileName($File))." }
    $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash
    if ($actual -ne $Expected) { throw "SHA256 verification failed for $([IO.Path]::GetFileName($File))." }
}

function Get-ManifestHash([string]$Manifest, [string]$Filename) {
    foreach ($line in (Get-Content -LiteralPath $Manifest)) {
        if ($line -match '^([a-fA-F0-9]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $Filename) { return $Matches[1] }
    }
    throw "Checksum missing for $Filename."
}

try {
    if ($Force -or -not (Test-Path -LiteralPath (Join-Path $ToolsDirectory 'yt-dlp.exe'))) {
        Write-Host 'Downloading official yt-dlp release...'
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' -Headers $requestHeaders
        $binary = $release.assets | Where-Object name -eq 'yt-dlp.exe' | Select-Object -First 1
        $checksums = $release.assets | Where-Object name -eq 'SHA2-256SUMS' | Select-Object -First 1
        if (-not $binary -or -not $checksums) { throw 'Official yt-dlp release assets are missing.' }
        $binaryPath = Join-Path $stageDirectory 'yt-dlp.exe'
        $checksumPath = Join-Path $stageDirectory 'yt-dlp-SHA256.txt'
        Get-Download $binary.browser_download_url $binaryPath
        Get-Download $checksums.browser_download_url $checksumPath
        Assert-Sha256 $binaryPath (Get-ManifestHash $checksumPath 'yt-dlp.exe')
        Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $ToolsDirectory 'yt-dlp.exe') -Force
        $release.tag_name | Set-Content -LiteralPath (Join-Path $ToolsDirectory 'yt-dlp.version') -Encoding utf8
        Get-Download "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$($release.tag_name)/THIRD_PARTY_LICENSES.txt" (Join-Path $ToolsDirectory 'yt-dlp-THIRD_PARTY_LICENSES.txt')
    }

    if ($Force -or -not (Test-Path -LiteralPath (Join-Path $ToolsDirectory 'ffmpeg.exe')) -or -not (Test-Path -LiteralPath (Join-Path $ToolsDirectory 'ffprobe.exe'))) {
        Write-Host 'Downloading FFmpeg from the yt-dlp FFmpeg-Builds release...'
        $ffRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest' -Headers $requestHeaders
        $asset = $ffRelease.assets | Where-Object { $_.name -match '^ffmpeg-.*win64-gpl\.zip$' } | Select-Object -First 1
        if (-not $asset) { throw 'Official Windows x64 FFmpeg GPL ZIP was not found.' }
        $archive = Join-Path $stageDirectory $asset.name
        Get-Download $asset.browser_download_url $archive
        if ($asset.digest -match '^sha256:([a-fA-F0-9]{64})$') {
            Assert-Sha256 $archive $Matches[1]
        } else {
            $hashAsset = $ffRelease.assets | Where-Object { $_.name -eq ($asset.name + '.sha256') } | Select-Object -First 1
            if (-not $hashAsset) { throw 'FFmpeg release has no verifiable SHA256 digest. Nothing was installed.' }
            $hashPath = Join-Path $stageDirectory 'ffmpeg.sha256'
            Get-Download $hashAsset.browser_download_url $hashPath
            $hashText = Get-Content -LiteralPath $hashPath -Raw
            if ($hashText -notmatch '([a-fA-F0-9]{64})') { throw 'Invalid FFmpeg checksum.' }
            Assert-Sha256 $archive $Matches[1]
        }
        $expandedDirectory = Join-Path $stageDirectory 'ffmpeg-expanded'
        Expand-Archive -LiteralPath $archive -DestinationPath $expandedDirectory -Force
        foreach ($executable in @('ffmpeg.exe', 'ffprobe.exe')) {
            $found = Get-ChildItem -LiteralPath $expandedDirectory -Recurse -File -Filter $executable | Select-Object -First 1
            if (-not $found) { throw "$executable missing in FFmpeg archive." }
            Copy-Item -LiteralPath $found.FullName -Destination (Join-Path $ToolsDirectory $executable) -Force
        }
        $licenseDirectory = Join-Path $ToolsDirectory 'ffmpeg-licenses'
        New-Item -ItemType Directory -Path $licenseDirectory -Force | Out-Null
        Get-ChildItem -LiteralPath $expandedDirectory -Recurse -File | Where-Object { $_.Name -match 'LICENSE|COPYING|README' } | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licenseDirectory $_.Name) -Force
        }
        $ffRelease.tag_name | Set-Content -LiteralPath (Join-Path $ToolsDirectory 'ffmpeg.version') -Encoding utf8
    }

    if ($Force -or -not (Test-Path -LiteralPath (Join-Path $ToolsDirectory 'node.exe'))) {
        if (-not $NodePath) {
            $availableNode = Get-Command node.exe -ErrorAction SilentlyContinue
            if ($availableNode) { $NodePath = $availableNode.Source }
        }
        if ($NodePath -and (Test-Path -LiteralPath $NodePath)) {
            Write-Host 'Copying the installed Node.js runtime for JavaScript challenges...'
            Copy-Item -LiteralPath $NodePath -Destination (Join-Path $ToolsDirectory 'node.exe') -Force
        } else {
            Write-Host 'Downloading an official Node.js LTS runtime...'
            $nodeReleases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
            $nodeRelease = $nodeReleases | Where-Object { $_.lts -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
            if (-not $nodeRelease) { throw 'No supported Node.js LTS runtime found.' }
            $zipName = "node-$($nodeRelease.version)-win-x64.zip"
            $nodeBase = "https://nodejs.org/dist/$($nodeRelease.version)"
            $nodeArchive = Join-Path $stageDirectory $zipName
            $nodeHashes = Join-Path $stageDirectory 'node-SHASUMS256.txt'
            Get-Download "$nodeBase/$zipName" $nodeArchive
            Get-Download "$nodeBase/SHASUMS256.txt" $nodeHashes
            Assert-Sha256 $nodeArchive (Get-ManifestHash $nodeHashes $zipName)
            $nodeExpanded = Join-Path $stageDirectory 'node-expanded'
            Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExpanded -Force
            $nodeExecutable = Get-ChildItem -LiteralPath $nodeExpanded -Recurse -File -Filter 'node.exe' | Select-Object -First 1
            Copy-Item -LiteralPath $nodeExecutable.FullName -Destination (Join-Path $ToolsDirectory 'node.exe') -Force
            $nodeLicense = Get-ChildItem -LiteralPath $nodeExpanded -Recurse -File -Filter 'LICENSE' | Select-Object -First 1
            if ($nodeLicense) { Copy-Item -LiteralPath $nodeLicense.FullName -Destination (Join-Path $ToolsDirectory 'node-LICENSE.txt') -Force }
        }
    }

    @'
Bundled executable sources and licensing:
yt-dlp: https://github.com/yt-dlp/yt-dlp (standalone Windows binary includes GPLv3+ dependencies).
FFmpeg: https://github.com/yt-dlp/FFmpeg-Builds (GPL build; source/build recipes and release sources there).
FFmpeg upstream: https://ffmpeg.org/download.html#get-sources
Node.js: https://nodejs.org/ and https://github.com/nodejs/node/blob/main/LICENSE
Version tags are saved next to the executables. Preserve the license files when redistributing.
'@ | Set-Content -LiteralPath (Join-Path $ToolsDirectory 'SOURCES.txt') -Encoding utf8
    Write-Host 'Tools are ready:' $ToolsDirectory
    & (Join-Path $ToolsDirectory 'yt-dlp.exe') --version
    & (Join-Path $ToolsDirectory 'node.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'A downloaded runtime failed to start.' }
} finally {
    # Resolve and check the exact temporary directory before removing it.
    $resolvedStage = [IO.Path]::GetFullPath($stageDirectory)
    $resolvedTools = [IO.Path]::GetFullPath($ToolsDirectory).TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($resolvedTools, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedStage).StartsWith('.setup-')) {
        if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
    }
}
