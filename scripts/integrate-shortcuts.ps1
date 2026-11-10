param([Parameter(Mandatory=$true)][string]$Pob, [string]$Launcher, [Parameter(Mandatory=$true)][string]$Records, [ValidateSet('Inspect','Install','Restore','Cleanup')][string]$Mode = 'Install', [string[]]$Roots)
$ErrorActionPreference = 'Stop'
$Pob = [IO.Path]::GetFullPath($Pob).TrimEnd('\')
$executable = Join-Path $Pob 'Path of Building.exe'
. (Join-Path $PSScriptRoot 'shortcut-api.ps1')
if (-not $Roots) { $Roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'), (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')) }
function CanonicalPath($value) {
    # Shell links can target virtual folders or contain an invalid raw path.
    # They are unrelated to the selected PoB and cannot be compared as files.
    try { $full = [IO.Path]::GetFullPath($value).TrimEnd('\') }
    catch { return $null }
    $missing = @(); $ancestor = $full
    while ($ancestor -and -not (Test-Path -LiteralPath $ancestor)) { $missing = @((Split-Path -Leaf $ancestor)) + $missing; $ancestor = Split-Path -Parent $ancestor }
    if (-not $ancestor) { return $full }
    $resolved = (Get-Item -LiteralPath $ancestor).FullName.TrimEnd('\')
    foreach ($part in $missing) { $resolved = Join-Path $resolved $part }
    return $resolved
}
function EqualPath($a, $b) {
    if (-not $a -or -not $b) { return $false }
    $left = CanonicalPath $a; $right = CanonicalPath $b
    return $left -and $right -and $left -ieq $right
}
function ArgumentPath($value) {
    if ($value -match '^"([^"]+)"$') { return $Matches[1] }
    if ($value -match '^[^\s"]+$') { return $value }
    return $null
}
function SameArguments($a, $b) { return $a -eq $b -or (EqualPath (ArgumentPath $a) (ArgumentPath $b)) }
function SaveRecords($value) {
    $temporary = $Records + '.tmp'
    # ConvertFrom-Json in Windows PowerShell can decorate a one-element array
    # with value/Count properties; project plain records before serializing.
    $plain = @()
    foreach ($record in $value) {
        if (-not $record.file) { throw 'Invalid shortcut recovery record.' }
        $plain += @{file=$record.file;target=$record.target;arguments=$record.arguments;workingDirectory=$record.workingDirectory;installedArguments=$record.installedArguments}
    }
    [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $plain -Depth 8), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Records -Force
}
$previous = @()
if (Test-Path -LiteralPath $Records) { $previous = Get-Content -Encoding UTF8 -Raw -LiteralPath $Records | ConvertFrom-Json }
if ($Mode -eq 'Restore') {
    foreach ($entry in $previous) {
        if (-not (Test-Path -LiteralPath $entry.file)) { continue }
        $link = [PoeAssistantShortcut]::Open($entry.file)
        if ((EqualPath $link.TargetPath $entry.target) -and (SameArguments $link.Arguments $entry.installedArguments)) {
            $link.Arguments = $entry.arguments; $link.WorkingDirectory = $entry.workingDirectory; $link.Save()
        }
    }
    exit 0
}
$links = @(); $visited = @{}; $unreadable = 0
foreach ($folder in $Roots) {
    if (-not $folder -or -not (Test-Path -LiteralPath $folder)) { continue }
    $recurse = $folder -in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
    foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -Recurse:$recurse -ErrorAction SilentlyContinue) {
        if ($visited.ContainsKey($file.FullName)) { continue }; $visited[$file.FullName] = $true
        $link = $null
        try {
            $link = [PoeAssistantShortcut]::Open($file.FullName)
            $target = [string]$link.TargetPath; $arguments = [string]$link.Arguments; $workingDirectory = [string]$link.WorkingDirectory
        } catch {
            # A recorded link belongs to this installation: losing access to it
            # must fail rather than silently leave its integration unverified.
            if (@($previous | Where-Object file -EQ $file.FullName).Count) { throw }
            $unreadable++; continue
        } finally { if ($link) { try { $link.Dispose() } catch { } } }
        if (-not $target -or -not (CanonicalPath $target)) { continue }
        $legacy = $false; $legacyDestination = $null; $eligible = $false
        if (EqualPath $target $executable) {
            $argument = ArgumentPath $arguments.Trim()
            $argumentPath = $null
            if ($argument) {
                try {
                    $candidateArgument = if ([IO.Path]::IsPathRooted($argument)) { $argument } else { Join-Path $Pob $argument }
                    if (CanonicalPath $candidateArgument) { $argumentPath = $candidateArgument }
                } catch { $argumentPath = $null }
            }
            if ($argumentPath -and $file.BaseName -match '^PoB Helper(?: [\w-]+)?$' -and [IO.Path]::GetFileName($argumentPath) -like 'PobHelperLaunch-*.lua' -and (EqualPath (Split-Path -Parent $argumentPath) $Pob) -and (Test-Path -LiteralPath $argumentPath)) {
                $source = Get-Content -Encoding UTF8 -Raw -LiteralPath $argumentPath
                $legacy = $source -match 'PoB Helper' -and $source -match 'Session: pobhelper-[\w-]+'
            }
            $eligible = -not $legacy -and (-not $arguments.Trim() -or (EqualPath $argumentPath (Join-Path $Pob 'Launch.lua')) -or ($Launcher -and (EqualPath $argumentPath $Launcher)))
        } elseif ($file.BaseName -match '^(?:(?:Update|Rollback|Uninstall) )?PoE Assistant(?: [a-f0-9]{8})?$' -and [IO.Path]::GetFileName($target) -ieq 'powershell.exe' -and $arguments -match '(?i)-File\s+"([^"]+\\(?:Launch|Update|Rollback|Uninstall)\.ps1)"\s*$') {
            $candidate = Split-Path -Parent $Matches[1]
            $pointer = Join-Path $candidate 'current.json'
            if (Test-Path -LiteralPath $pointer) {
                try {
                    $current = Get-Content -Encoding UTF8 -Raw -LiteralPath $pointer | ConvertFrom-Json
                    $session = Get-Content -Encoding UTF8 -Raw -LiteralPath $current.session | ConvertFrom-Json
                    if ($current.repository -in @('arthurhpabreu/poe-assistant','autis-analytics/poe-assistant') -and (EqualPath $session.install $Pob)) { $legacy = $true; $legacyDestination = $candidate }
                } catch { }
            }
        }
        if ($legacy -or $eligible) { $links += [pscustomobject]@{file=$file.FullName;target=$target;arguments=$arguments;workingDirectory=$workingDirectory;legacy=$legacy;legacyDestination=$legacyDestination;eligible=$eligible} }
    }
}
if ($unreadable) { Write-Warning ('Skipped ' + $unreadable + ' unreadable Windows shortcut(s) during detection.') }
if ($Mode -eq 'Inspect') { ConvertTo-Json -InputObject @($links) -Depth 8; exit 0 }
if ($Mode -eq 'Cleanup') {
    $backupDir = Join-Path (Split-Path -Parent $Records) 'removed-shortcuts'
    foreach ($entry in $links | Where-Object legacy) {
        try {
            New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
            $key = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($entry.file))).Replace('-','').Substring(0,12)
            Copy-Item -LiteralPath $entry.file -Destination (Join-Path $backupDir ($key + '-' + (Split-Path -Leaf $entry.file))) -Force
            Remove-Item -LiteralPath $entry.file -Force
        } catch { Write-Warning ('Assistant is installed, but could not remove an old shortcut: ' + $entry.file) }
    }
    exit 0
}
if (-not $Launcher) { throw 'The addon launch script is required.' }
if (-not @($links | Where-Object eligible).Count) {
    # Portable installations may have no shortcut yet. Create one ordinary PoB
    # shortcut, never a separate addon/update/rollback/uninstall shortcut.
    $folder = $Roots[0]
    if (-not $folder -or -not (Test-Path -LiteralPath $folder)) { throw 'No shortcut destination is available.' }
    $file = Join-Path $folder 'Path of Building Community.lnk'
    if (Test-Path -LiteralPath $file) { throw 'The standard shortcut belongs to another installation. Select this PoB using its existing shortcut or repair that shortcut first.' }
    $link = [PoeAssistantShortcut]::Open($file); $link.TargetPath = $executable; $link.WorkingDirectory = $Pob; $link.IconLocation = $executable + ',0'; $link.Save()
    $links += [pscustomobject]@{file=$file;target=$executable;arguments='';workingDirectory=$Pob;eligible=$true;legacy=$false}
}
$changed = @(); foreach ($record in $previous) { $changed += $record }; $errors = @(); $integrated = 0
$mutations = @(); $active = @()
try {
    foreach ($entry in $links | Where-Object eligible) {
        $installed = '"' + $Launcher + '"'
        if (SameArguments $entry.arguments $installed) { $integrated++; $active += $entry.file; continue }
        if (-not @($changed | Where-Object file -EQ $entry.file).Count) {
            $changed += [pscustomobject]@{file=$entry.file;target=$entry.target;arguments=$entry.arguments;workingDirectory=$entry.workingDirectory;installedArguments=$installed}
            # Persist the original before touching the user's existing shortcut.
            SaveRecords $changed
        }
        try {
            $mutations += [pscustomobject]@{file=$entry.file;target=$entry.target;arguments=$entry.arguments;workingDirectory=$entry.workingDirectory;installedArguments=$installed}
            $link = [PoeAssistantShortcut]::Open($entry.file); $link.Arguments = $installed; $link.WorkingDirectory = $Pob; $link.Save()
            $saved = [PoeAssistantShortcut]::Open($entry.file)
            if (-not (EqualPath $saved.TargetPath $executable) -or -not (SameArguments $saved.Arguments $installed)) { throw 'Windows did not retain the addon startup argument.' }
            $integrated++; $active += $entry.file
        }
        catch { $errors += $_.Exception.Message }
    }
    if (-not $integrated) { throw ('No writable standard PoB shortcut was found. Create a normal shortcut to Path of Building.exe, then run setup again. ' + ($errors -join ' ')) }
    if ($errors.Count) { throw ('Some PoB shortcuts could not be updated. Setup cannot confirm that they will load the assistant: ' + ($errors -join '; ')) }
    SaveRecords $changed
    [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $Records) 'active-shortcuts.json'), (ConvertTo-Json -InputObject @($active)), (New-Object Text.UTF8Encoding($false)))
    Write-Output ('Integrated with ' + $integrated + ' existing PoB shortcut(s). No extra shortcuts were created.')
} catch {
    foreach ($entry in $mutations) {
        if (Test-Path -LiteralPath $entry.file) { $link = [PoeAssistantShortcut]::Open($entry.file); if ((SameArguments $link.Arguments $entry.installedArguments) -and (EqualPath $link.TargetPath $entry.target)) { $link.Arguments = $entry.arguments; $link.WorkingDirectory = $entry.workingDirectory; $link.Save() } }
    }
    throw
}
