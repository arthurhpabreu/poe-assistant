if (-not ('PoeAssistantShortcut' -as [type])) {
    $assembly = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime/WindowsShortcut.dll'
    if (Test-Path -LiteralPath $assembly) { Add-Type -LiteralPath $assembly }
    else { Add-Type -Path (Join-Path $PSScriptRoot 'WindowsShortcut.cs') }
}
