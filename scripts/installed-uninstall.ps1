$ErrorActionPreference = 'Stop'
try {
    $current = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json
    $session = Get-Content -Raw -LiteralPath $current.session | ConvertFrom-Json
    if (@(Get-CimInstance Win32_Process -Filter "Name='Path of Building.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($session.launcher) }).Count) { throw 'Save your build and close this PoE Assistant window first.' }
    & (Join-Path $current.release 'runtime/node.exe') (Join-Path $current.release 'scripts/install.mjs') --state (Split-Path -Parent $current.session) --uninstall --no-shortcut
    if ($LASTEXITCODE) { throw 'Addon uninstall failed.' }
    $links = Join-Path (Split-Path -Parent $current.session) 'shortcuts.json'
    if (Test-Path -LiteralPath $links) {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($file in (Get-Content -Raw -LiteralPath $links | ConvertFrom-Json)) {
            if (Test-Path -LiteralPath $file) {
                $link = $shell.CreateShortcut($file)
                if ($link.Arguments.Contains($PSScriptRoot)) { Remove-Item -LiteralPath $file -Force }
            }
        }
    }
    Remove-Item -LiteralPath (Join-Path $PSScriptRoot 'current.json') -Force
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show('Addon removed. Official PoB, builds, backups and installation data were preserved.', 'PoE Assistant') | Out-Null
} catch { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PoE Assistant') | Out-Null; exit 1 }
