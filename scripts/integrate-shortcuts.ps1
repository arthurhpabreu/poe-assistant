param([Parameter(Mandatory=$true)][string]$Pob, [string]$Launcher, [Parameter(Mandatory=$true)][string]$Records, [ValidateSet('Inspect','Install','Restore','Cleanup','Verify')][string]$Mode = 'Install', [string[]]$Roots, [string]$Shortcut)
$ErrorActionPreference = 'Stop'
$Pob = [IO.Path]::GetFullPath($Pob).TrimEnd('\')
$executable = Join-Path $Pob 'Path of Building.exe'
. (Join-Path $PSScriptRoot 'shortcut-api.ps1')
if (-not $Roots) { $Roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'), (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'), (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu')) }
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
$activeFile = Join-Path (Split-Path -Parent $Records) 'active-shortcuts.json'
$previousActive = @()
if (Test-Path -LiteralPath $activeFile) {
    foreach ($activePath in (Get-Content -Encoding UTF8 -Raw -LiteralPath $activeFile | ConvertFrom-Json)) { $previousActive += [string]$activePath }
}
if ($Mode -eq 'Restore') {
    foreach ($entry in $previous) {
        if (-not (Test-Path -LiteralPath $entry.file)) { continue }
        $link = [PoeAssistantShortcut]::Open($entry.file)
        try { if ((EqualPath $link.TargetPath $entry.target) -and (SameArguments $link.Arguments $entry.installedArguments)) {
            $link.Arguments = $entry.arguments; $link.WorkingDirectory = $entry.workingDirectory; $link.Save()
        } } finally { $link.Dispose() }
    }
    exit 0
}
$links = @(); $visited = @{}; $unreadable = 0; $created = $false
$candidates = @()
if ($Shortcut) {
    $Shortcut = [IO.Path]::GetFullPath($Shortcut)
    if ([IO.Path]::GetExtension($Shortcut) -ine '.lnk' -or -not (Test-Path -LiteralPath $Shortcut -PathType Leaf)) { throw ('The selected PoB shortcut does not exist: ' + $Shortcut) }
    $candidates += Get-Item -LiteralPath $Shortcut
}
# Include previously integrated paths, even when they live outside standard
# folders. Updates must maintain the user's selected shortcut without reselecting.
foreach ($file in @($previous | ForEach-Object { $_.file }) + $previousActive) {
    if ($file -and (Test-Path -LiteralPath $file -PathType Leaf)) { $candidates += Get-Item -LiteralPath $file }
}
$folders = New-Object 'Collections.Generic.Stack[object]'
if ($Mode -ne 'Verify') {
    foreach ($folder in $Roots) { if ($folder -and (Test-Path -LiteralPath $folder -PathType Container)) { $folders.Push(@{path=[IO.Path]::GetFullPath($folder);depth=0}) } }
}
$visitedFolders = @{}
while ($folders.Count) {
    $next = $folders.Pop(); $folder = $next.path
    if ($visitedFolders.ContainsKey($folder)) { continue }; $visitedFolders[$folder] = $true
    try {
        foreach ($file in [IO.Directory]::EnumerateFiles($folder,'*.lnk')) { $candidates += Get-Item -LiteralPath $file -Force }
        # A Desktop may contain entire source/game trees. Bound automatic search
        # to four folder levels; the explicit picker handles any other location.
        if ($next.depth -ge 4) { continue }
        foreach ($child in [IO.Directory]::EnumerateDirectories($folder)) {
            if (-not ([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint)) { $folders.Push(@{path=$child;depth=$next.depth+1}) }
        }
    } catch { Write-Warning ('Could not finish searching shortcut folder: ' + $folder) }
}
foreach ($file in $candidates) {
        if ($visited.ContainsKey($file.FullName)) { continue }; $visited[$file.FullName] = $true
        $link = $null
        try {
            $link = [PoeAssistantShortcut]::Open($file.FullName)
            $target = [string]$link.TargetPath; $arguments = [string]$link.Arguments; $workingDirectory = [string]$link.WorkingDirectory
        } catch {
            # A recorded link belongs to this installation: losing access to it
            # must fail rather than silently leave its integration unverified.
            if ((EqualPath $file.FullName $Shortcut) -or @($previous | Where-Object file -EQ $file.FullName).Count) { throw }
            $unreadable++; continue
        } finally { if ($link) { try { $link.Dispose() } catch { } } }
        if (-not $target -or -not (CanonicalPath $target)) {
            if (EqualPath $file.FullName $Shortcut) { throw ('The selected shortcut has no valid executable target: ' + $Shortcut) }
            continue
        }
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
        if ((EqualPath $file.FullName $Shortcut) -and -not $eligible) { throw ('The selected shortcut must open this Path of Building.exe with no arguments, Launch.lua, or PoEAssistant.lua. Custom build/script arguments were preserved: ' + $Shortcut) }
        if ($legacy -or $eligible) { $links += [pscustomobject]@{file=$file.FullName;target=$target;arguments=$arguments;workingDirectory=$workingDirectory;legacy=$legacy;legacyDestination=$legacyDestination;eligible=$eligible} }
}
if ($unreadable) { Write-Warning ('Skipped ' + $unreadable + ' unreadable Windows shortcut(s) during detection.') }
if ($Mode -eq 'Inspect') { ConvertTo-Json -InputObject @($links) -Depth 8; exit 0 }
if ($Mode -eq 'Verify') {
    if (-not $Launcher -or -not $previousActive.Count) { throw 'There are no integrated PoB shortcuts to verify.' }
    foreach ($file in @($previousActive) + @($links | Where-Object eligible | ForEach-Object { $_.file }) | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('An integrated PoB shortcut is missing: ' + $file) }
        $link = [PoeAssistantShortcut]::Open($file)
        try {
            if (-not (EqualPath $link.TargetPath $executable) -or -not (SameArguments $link.Arguments ('"' + $Launcher + '"')) -or -not (EqualPath $link.WorkingDirectory $Pob)) { throw ('This PoB shortcut still bypasses the assistant or has the wrong working directory: ' + $file) }
            $link.Refresh()
        } finally { $link.Dispose() }
    }
    Write-Output ('Verified all ' + $previousActive.Count + ' integrated PoB shortcut(s).')
    exit 0
}
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
    $link = [PoeAssistantShortcut]::Open($file)
    try { $link.TargetPath = $executable; $link.WorkingDirectory = $Pob; $link.IconLocation = $executable + ',0'; $link.Save() } finally { $link.Dispose() }
    $created = $true
    $links += [pscustomobject]@{file=$file;target=$executable;arguments='';workingDirectory=$Pob;eligible=$true;legacy=$false}
}
$changed = @(); foreach ($record in $previous) { $changed += $record }; $errors = @(); $integrated = 0
$mutations = @(); $active = @()
try {
    foreach ($entry in $links | Where-Object eligible) {
        $installed = '"' + $Launcher + '"'
        if ((SameArguments $entry.arguments $installed) -and (EqualPath $entry.workingDirectory $Pob)) { $integrated++; $active += $entry.file; continue }
        if (-not @($changed | Where-Object file -EQ $entry.file).Count) {
            $changed += [pscustomobject]@{file=$entry.file;target=$entry.target;arguments=$entry.arguments;workingDirectory=$entry.workingDirectory;installedArguments=$installed}
            # Persist the original before touching the user's existing shortcut.
            SaveRecords $changed
        }
        try {
            $mutations += [pscustomobject]@{file=$entry.file;target=$entry.target;arguments=$entry.arguments;workingDirectory=$entry.workingDirectory;installedArguments=$installed}
            $link = [PoeAssistantShortcut]::Open($entry.file)
            try { $link.Arguments = $installed; $link.WorkingDirectory = $Pob; $link.Save() } finally { $link.Dispose() }
            $saved = [PoeAssistantShortcut]::Open($entry.file)
            try { if (-not (EqualPath $saved.TargetPath $executable) -or -not (SameArguments $saved.Arguments $installed) -or -not (EqualPath $saved.WorkingDirectory $Pob)) { throw 'Windows did not retain the addon startup argument and working directory.' } } finally { $saved.Dispose() }
            $integrated++; $active += $entry.file
        }
        catch { $errors += $_.Exception.Message }
    }
    if (-not $integrated) { throw ('No writable standard PoB shortcut was found. Create a normal shortcut to Path of Building.exe, then run setup again. ' + ($errors -join ' ')) }
    if ($errors.Count) { throw ('Some PoB shortcuts could not be updated. Setup cannot confirm that they will load the assistant: ' + ($errors -join '; ')) }
    SaveRecords $changed
    [IO.File]::WriteAllText($activeFile, (ConvertTo-Json -InputObject @($active)), (New-Object Text.UTF8Encoding($false)))
    Write-Output ('Integrated with ' + $integrated + ' PoB shortcut(s). ' + $(if ($created) { 'Created one ordinary PoB shortcut because none existed.' } else { 'Reused existing shortcuts.' }))
} catch {
    $failure = $_; $recoveryErrors = @()
    foreach ($entry in $mutations) {
        try { if (Test-Path -LiteralPath $entry.file) {
            $link = [PoeAssistantShortcut]::Open($entry.file)
            try {
                if ((SameArguments $link.Arguments $entry.arguments) -and ($link.WorkingDirectory -eq $entry.workingDirectory)) { continue }
                if ((SameArguments $link.Arguments $entry.installedArguments) -and (EqualPath $link.TargetPath $entry.target)) { $link.Arguments = $entry.arguments; $link.WorkingDirectory = $entry.workingDirectory; $link.Save() }
            } finally { $link.Dispose() }
        } } catch { $recoveryErrors += ($entry.file + ': ' + $_.Exception.Message) }
    }
    if ($recoveryErrors.Count) { throw ($failure.Exception.Message + ' Shortcut recovery incomplete: ' + ($recoveryErrors -join '; ')) }
    throw $failure
}
