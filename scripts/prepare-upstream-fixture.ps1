param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Revision)
$ErrorActionPreference = 'Stop'
if ($Revision -notmatch '^[a-f0-9]{40}$') { throw 'Use an immutable upstream commit for native compatibility checks.' }
$archive = Join-Path $Root 'upstream.zip'
$sourceRoot = Join-Path $Root 'upstream'
$pob = Join-Path $Root 'PoB-modern'
if ((Test-Path -LiteralPath $sourceRoot) -or (Test-Path -LiteralPath $pob)) { throw 'Upstream fixture directories must be fresh.' }
New-Item -ItemType Directory -Path $sourceRoot,$pob -Force | Out-Null
# curl avoids Windows PowerShell's per-chunk progress overhead on large files.
& curl.exe --fail --location --silent --show-error --output $archive ('https://codeload.github.com/PathOfBuildingCommunity/PathOfBuilding/zip/' + $Revision)
if ($LASTEXITCODE) { throw 'Could not download the pinned official PoB source.' }
& tar.exe -xf $archive -C $sourceRoot
if ($LASTEXITCODE) { throw 'Could not extract the pinned official PoB source.' }
$source = Join-Path $sourceRoot ('PathOfBuilding-' + $Revision)
& tar.exe -xf (Join-Path $source 'runtime-win32.zip') -C $pob
if ($LASTEXITCODE) { throw 'Could not extract the official PoB runtime.' }
foreach ($part in @('runtime','src')) {
    Get-ChildItem -LiteralPath (Join-Path $source $part) -Force | Copy-Item -Destination $pob -Recurse -Force
}
# Updater repository names encode spaces; the executable must match the DLLs
# from this revision instead of the older executable in runtime-win32.zip.
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $source 'runtime') -File | Where-Object Name -Like '*{space}*') {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $pob $file.Name.Replace('{space}',' ')) -Force
}
Copy-Item -LiteralPath (Join-Path $source 'manifest.xml') -Destination (Join-Path $pob 'manifest.xml')
if (-not (Test-Path -LiteralPath (Join-Path $pob 'Path of Building.exe'))) { throw 'Official upstream runtime layout changed.' }
Write-Output $pob
