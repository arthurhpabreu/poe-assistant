$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'Common.ps1')
    $current = GetAssistantCurrent
    if (-not $current.previous -or -not (Test-Path -LiteralPath $current.previous)) { throw 'No previous version is available.' }
    $session = Get-Content -Encoding UTF8 -Raw -LiteralPath $current.session | ConvertFrom-Json
    & (Join-Path $current.previous 'scripts/deploy.ps1') -Source $current.previous -Pob $session.install -Destination $PSScriptRoot
} catch { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PoE Assistant rollback') | Out-Null; exit 1 }
