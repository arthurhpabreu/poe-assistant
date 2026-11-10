param([Parameter(Mandatory=$true)][string]$Session, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$config = Get-Content -Raw -LiteralPath $Session | ConvertFrom-Json
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = if ($config.shortcut) { $config.shortcut } else { Join-Path $desktop 'PoB Helper.lnk' }
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
    $existing = $shell.CreateShortcut($shortcutPath)
    if ($existing.Arguments -ne ('"' + $config.launcher + '"')) {
        if ($Remove) { exit 0 }
        $shortcutPath = Join-Path $desktop ('PoB Helper ' + $config.id.Substring(10,8) + '.lnk')
    }
}
if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) {
        $existing = $shell.CreateShortcut($shortcutPath)
        if ($existing.Arguments -eq ('"' + $config.launcher + '"')) { Remove-Item -LiteralPath $shortcutPath }
    }
    exit 0
}
$link = $shell.CreateShortcut($shortcutPath)
$link.TargetPath = Join-Path $config.install 'Path of Building.exe'
$link.Arguments = '"' + $config.launcher + '"'
$link.WorkingDirectory = $config.install
$link.Description = 'Path of Building Community Fork with Claude/Codex assistant'
$link.IconLocation = (Join-Path $config.install 'Path of Building.exe') + ',0'
$link.Save()
Write-Output $shortcutPath
