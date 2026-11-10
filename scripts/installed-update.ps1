$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'Common.ps1')
    $current = GetAssistantCurrent
    & (Join-Path $current.release 'runtime/node.exe') (Join-Path $current.release 'scripts/update.mjs') --destination $PSScriptRoot
    if ($LASTEXITCODE) { throw ('Update failed. See diagnostics in ' + (Join-Path $PSScriptRoot 'data/setup-diagnostics') + '. Run the latest installer to verify or repair this installation.') }
} catch { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PoE Assistant update') | Out-Null; exit 1 }
