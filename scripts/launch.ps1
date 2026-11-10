param([string]$Session)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sessionPath = if ($Session) { $Session } else { Join-Path $projectRoot '.pob-helper\session.json' }
if (-not (Test-Path -LiteralPath $sessionPath)) { throw 'Run npm run install:addon first.' }
$config = Get-Content -Encoding UTF8 -Raw -LiteralPath $sessionPath | ConvertFrom-Json
& (Join-Path $PSScriptRoot 'start-backend.ps1') -Session $sessionPath
# This is the interactive PoB window explicitly opened by the user's shortcut.
Start-Process -FilePath (Join-Path $config.install 'Path of Building.exe') -ArgumentList ('"' + $config.launcher + '"') -WorkingDirectory $config.install -WindowStyle Normal
