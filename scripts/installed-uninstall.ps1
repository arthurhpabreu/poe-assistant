param([switch]$Silent)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'Common.ps1')
    $current = GetAssistantCurrent
    $session = Get-Content -Encoding UTF8 -Raw -LiteralPath $current.session | ConvertFrom-Json
    if (@(Get-CimInstance Win32_Process -Filter "Name='Path of Building.exe'" | Where-Object { $_.ExecutablePath -ieq (Join-Path $session.install 'Path of Building.exe') }).Count) { throw 'Save your build and close Path of Building first.' }
    $records = Join-Path $session.state 'pob-shortcuts.json'
    & (Join-Path $current.release 'scripts/integrate-shortcuts.ps1') -Pob $session.install -Launcher $session.launcher -Records $records -Mode Restore
    & (Join-Path $current.release 'runtime/node.exe') (Join-Path $current.release 'scripts/install.mjs') --pob $session.install --state $session.state --uninstall --no-shortcut
    if ($LASTEXITCODE) { throw 'Addon uninstall failed.' }
    [IO.File]::WriteAllText((Join-Path $session.runtime 'shutdown.json'), ('{"sessionId":"' + $session.id + '"}'))
    Remove-Item -LiteralPath (Join-Path $PSScriptRoot 'current.json') -Force
    if (-not $Silent) { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show('Assistant removed. Your usual PoB shortcut, builds, settings and recovery backups were preserved.', 'PoE Assistant') | Out-Null }
} catch { if (-not $Silent) { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PoE Assistant') | Out-Null }; Write-Error $_; exit 1 }
