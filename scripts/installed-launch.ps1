$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'Common.ps1')
    $current = GetAssistantCurrent
    & (Join-Path $current.release 'scripts/launch.ps1') -Session $current.session
} catch { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PoE Assistant') | Out-Null; exit 1 }
