$ErrorActionPreference = 'Stop'
try {
    $current = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json
    & (Join-Path $current.release 'runtime/node.exe') (Join-Path $current.release 'scripts/update.mjs') --destination $PSScriptRoot
    if ($LASTEXITCODE) { throw 'Update failed. Your previous installation was preserved.' }
} catch { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PoE Assistant update') | Out-Null; exit 1 }
