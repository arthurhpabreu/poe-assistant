param([string]$Version='2.67.2', [string]$SourceRevision)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid PoB verification version.' }
# Official portable PoB is used only in the disposable test environment.
# It is never copied into the addon's distribution archive.
$root = Join-Path ([IO.Path]::GetTempPath()) ('pa-clean-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $root | Out-Null
if ($SourceRevision) {
    $pob = & (Join-Path $PSScriptRoot 'prepare-upstream-fixture.ps1') -Root $root -Revision $SourceRevision
} else {
    $archive = Join-Path $root 'pob.zip'
    Invoke-WebRequest -UseBasicParsing -Uri ('https://github.com/PathOfBuildingCommunity/PathOfBuilding/releases/download/v' + $Version + '/PathOfBuildingCommunity-Portable.zip') -OutFile $archive
    $pob = Join-Path $root ('PoB-Jo' + [char]0xE3 + 'o-' + [char]0x6D4B + [char]0x8BD5)
    Expand-Archive -LiteralPath $archive -DestinationPath $pob
}
if (-not (Test-Path -LiteralPath (Join-Path $pob 'Path of Building.exe'))) { throw 'Official portable PoB archive layout changed.' }
& node (Join-Path $PSScriptRoot 'verify-installer.mjs') --pob $pob
if ($LASTEXITCODE) {
    # The runner prints only its own named failure records, including the stack.
    throw 'Clean Windows installation verification failed.'
}
Write-Output ('Clean Windows verification passed using official PoB ' + $(if ($SourceRevision) { $SourceRevision } else { $Version }) + ' and isolated native shortcut startup.')
