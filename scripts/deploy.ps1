param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Pob, [string]$Destination = (Join-Path $env:LOCALAPPDATA 'PoE Assistant'), [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
function ChildPath([string]$Parent, [string]$Relative) {
    $base = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $target = [IO.Path]::GetFullPath((Join-Path $Parent $Relative))
    if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes installation root.' }
    return $target
}
function NoLinks([string]$Path) {
    $check = [IO.Path]::GetFullPath($Path)
    while ($check) {
        if ((Test-Path -LiteralPath $check) -and ((Get-Item -LiteralPath $check -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('Linked installation path is not allowed: ' + $check) }
        $parent = Split-Path -Parent $check
        if ($parent -eq $check) { break }; $check = $parent
    }
}
function VerifyPackage([string]$Folder) {
    NoLinks $Folder
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $Folder 'release-manifest.json') | ConvertFrom-Json
    if ($manifest.repository -ne 'arthurhpabreu/poe-assistant' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected release identity/version.' }
    $known = @{}
    foreach ($entry in $manifest.files) {
        if ($entry.path -match '(^|[\\/])\.\.([\\/]|$)|:|^[/\\]' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid package entry.' }
        $file = ChildPath $Folder $entry.path; NoLinks $file
        if ($known.ContainsKey($file)) { throw 'Duplicate package path.' }; $known[$file] = $true
        $digest = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($file))).Replace('-','').ToLowerInvariant()
        if ($digest -ne $entry.sha256) { throw ('Package checksum failed: ' + $entry.path) }
    }
    foreach ($file in Get-ChildItem -LiteralPath $Folder -File -Recurse -Force) {
        if ($file.Name -eq 'release-manifest.json' -and $file.DirectoryName -eq $Folder) { continue }
        if (-not $known.ContainsKey($file.FullName)) { throw ('Unexpected file in package: ' + $file.Name) }
    }
    return $manifest
}
function AtomicJson([string]$File, $Value) {
    $temp = $File + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 15), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $File) {
        $backup = $File + '.' + [Guid]::NewGuid().ToString('N') + '.bak'
        [IO.File]::Replace($temp, $File, $backup)
        Remove-Item -LiteralPath $backup -Force
    } else { [IO.File]::Move($temp, $File) }
}
$Source = (Resolve-Path -LiteralPath $Source).Path
$Destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\'); NoLinks $Destination
$Pob = (Resolve-Path -LiteralPath $Pob).Path
if (-not (Test-Path -LiteralPath (Join-Path $Pob 'Path of Building.exe'))) { throw 'Select an existing Path of Building Community installation.' }
$manifest = VerifyPackage $Source
$mutexHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Destination.ToLowerInvariant()))).Replace('-','')
$mutex = New-Object Threading.Mutex($false, ('Local\PoEAssistant-' + $mutexHash))
if (-not $mutex.WaitOne(0)) { throw 'Another installation/update is in progress for this destination.' }
$stage = $null; $old = $null; $activated = $false; $integrationInstalled = $false
try {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $data = ChildPath $Destination 'data'; New-Item -ItemType Directory -Path $data -Force | Out-Null
    $ownerFile = Join-Path $data 'owner.json'
    if (-not (Test-Path -LiteralPath $ownerFile)) { AtomicJson $ownerFile @{id=('poe-assistant-' + [Guid]::NewGuid().ToString());owner='PoE Assistant';destination=$Destination;pob=$Pob} }
    $sessionFile = Join-Path $data 'session.json'
    if (Test-Path -LiteralPath $sessionFile) {
        $session = Get-Content -Raw -LiteralPath $sessionFile | ConvertFrom-Json
        $windows = @(Get-CimInstance Win32_Process -Filter "Name='Path of Building.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($session.launcher) })
        if ($windows.Count) { throw 'Save your build and close this PoE Assistant window before installing/updating. Ordinary PoB windows may stay open.' }
        AtomicJson (Join-Path $session.runtime 'shutdown.json') @{sessionId=$session.id}
        for ($attempt=0; $attempt -lt 200 -and (Test-Path -LiteralPath (Join-Path $session.runtime 'backend.lock')); $attempt++) {
            $backendPid = [int](Get-Content -Raw -LiteralPath (Join-Path $session.runtime 'backend.lock') -ErrorAction SilentlyContinue)
            if (-not (Get-Process -Id $backendPid -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath (Join-Path $session.runtime 'backend.lock') -Force; break }
            Start-Sleep -Milliseconds 100
        }
        if (Test-Path -LiteralPath (Join-Path $session.runtime 'backend.lock')) { throw 'Assistant backend did not stop. No code was switched.' }
    }
    $pointer = Join-Path $Destination 'current.json'
    if (Test-Path -LiteralPath $pointer) { $old = Get-Content -Raw -LiteralPath $pointer | ConvertFrom-Json }
    $releases = ChildPath $Destination 'releases'; New-Item -ItemType Directory -Path $releases -Force | Out-Null
    $release = ChildPath $releases ($manifest.version + '-' + [Guid]::NewGuid().ToString('N'))
    $stage = $release
    New-Item -ItemType Directory -Path $stage | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $stage -Recurse
    $null = VerifyPackage $stage
    $node = Join-Path $stage 'runtime/node.exe'
    & $node --check (Join-Path $stage 'src/server.mjs'); if ($LASTEXITCODE) { throw 'Backend syntax check failed.' }
    & $node --check (Join-Path $stage 'src/build-lab.mjs'); if ($LASTEXITCODE) { throw 'Calculator syntax check failed.' }
    & $node (Join-Path $stage 'scripts/install.mjs') --pob $Pob --state $data --no-shortcut
    if ($LASTEXITCODE) { throw 'PoB addon compatibility/install check failed.' }
    $integrationInstalled = $true
    $session = Get-Content -Raw -LiteralPath $sessionFile | ConvertFrom-Json
    Remove-Item -LiteralPath (Join-Path $session.runtime 'shutdown.json') -Force -ErrorAction SilentlyContinue
    $entry = @{version=$manifest.version;release=$stage;session=$sessionFile;previous=$old.release;repository='arthurhpabreu/poe-assistant'}
    foreach ($name in @('Launch','Update','Uninstall','Rollback')) {
        Copy-Item -LiteralPath (Join-Path $stage ('scripts/installed-' + $name.ToLowerInvariant() + '.ps1')) -Destination (Join-Path $Destination ($name + '.ps1')) -Force
    }
    AtomicJson $pointer $entry; $activated = $true
    # Start only the backend for a health check. The installer never opens/saves a build.
    & (Join-Path $stage 'scripts/start-backend.ps1') -Session $sessionFile
    if (-not $NoShortcut) {
        $owner = Get-Content -Raw -LiteralPath $ownerFile | ConvertFrom-Json
        $suffix = $owner.id.Substring($owner.id.Length - 8)
        $shell = New-Object -ComObject WScript.Shell
        $shortcuts = @()
        foreach ($action in @('Launch','Update','Uninstall','Rollback')) {
            $label = if ($action -eq 'Launch') { 'PoE Assistant' } else { $action + ' PoE Assistant' }
            $linkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ($label + ' ' + $suffix + '.lnk')
            $link = $shell.CreateShortcut($linkPath)
            $link.TargetPath = (Join-Path $PSHOME 'powershell.exe')
            $link.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Destination ($action + '.ps1')) + '"'
            $link.WorkingDirectory = $Destination; $link.IconLocation = (Join-Path $Pob 'Path of Building.exe') + ',0'; $link.Save()
            $shortcuts += $linkPath
        }
        AtomicJson (Join-Path $data 'shortcuts.json') $shortcuts
    }
    Write-Output ('Installed PoE Assistant ' + $manifest.version + ' at ' + $Destination)
} catch {
    $failure = $_
    if ($activated -and $session) {
        AtomicJson (Join-Path $session.runtime 'shutdown.json') @{sessionId=$session.id}
        for ($attempt=0; $attempt -lt 200 -and (Test-Path -LiteralPath (Join-Path $session.runtime 'backend.lock')); $attempt++) { Start-Sleep -Milliseconds 100 }
    }
    if ($old -and (Test-Path -LiteralPath $old.release)) {
        $oldNode = Join-Path $old.release 'runtime/node.exe'
        & $oldNode (Join-Path $old.release 'scripts/install.mjs') --pob $Pob --state (Join-Path $Destination 'data') --no-shortcut
        if ($LASTEXITCODE -eq 0) {
            AtomicJson (Join-Path $Destination 'current.json') $old
            foreach ($name in @('Launch','Update','Uninstall','Rollback')) {
                Copy-Item -LiteralPath (Join-Path $old.release ('scripts/installed-' + $name.ToLowerInvariant() + '.ps1')) -Destination (Join-Path $Destination ($name + '.ps1')) -Force
            }
            $restoredSession = Get-Content -Raw -LiteralPath (Join-Path $Destination 'data/session.json') | ConvertFrom-Json
            Remove-Item -LiteralPath (Join-Path $restoredSession.runtime 'shutdown.json') -Force -ErrorAction SilentlyContinue
            & (Join-Path $old.release 'scripts/start-backend.ps1') -Session (Join-Path $Destination 'data/session.json')
        }
    } elseif ($integrationInstalled) {
        & (Join-Path $stage 'runtime/node.exe') (Join-Path $stage 'scripts/install.mjs') --pob $Pob --state (Join-Path $Destination 'data') --uninstall --no-shortcut
        Remove-Item -LiteralPath (Join-Path $Destination 'current.json') -Force -ErrorAction SilentlyContinue
    }
    throw $failure
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
