$ErrorActionPreference = 'Stop'
try {
    $current = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json
    if (-not $current.previous -or -not (Test-Path -LiteralPath $current.previous)) { throw 'No previous version is available.' }
    $session = Get-Content -Raw -LiteralPath $current.session | ConvertFrom-Json
    & (Join-Path $current.previous 'scripts/deploy.ps1') -Source $current.previous -Pob $session.install -Destination $PSScriptRoot
} catch { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PoE Assistant rollback') | Out-Null; exit 1 }
