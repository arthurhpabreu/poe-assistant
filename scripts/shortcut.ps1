param([Parameter(Mandatory=$true)][string]$Session, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$config = Get-Content -Raw -LiteralPath $Session | ConvertFrom-Json
$integrationArgs = @{Pob=$config.install;Launcher=$config.launcher;Records=(Join-Path (Split-Path -Parent $Session) 'pob-shortcuts.json')}
if ($Remove) {
    & (Join-Path $PSScriptRoot 'integrate-shortcuts.ps1') @integrationArgs -Mode Restore
} else {
    & (Join-Path $PSScriptRoot 'integrate-shortcuts.ps1') @integrationArgs -Mode Install
    & (Join-Path $PSScriptRoot 'integrate-shortcuts.ps1') @integrationArgs -Mode Cleanup
}
