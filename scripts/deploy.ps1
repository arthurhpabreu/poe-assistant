param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Pob, [string]$Destination, [switch]$NoShortcut, [string[]]$ShortcutRoots)
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
    $manifest = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $Folder 'release-manifest.json') | ConvertFrom-Json
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
        [IO.File]::Replace($temp, $File, $backup); Remove-Item -LiteralPath $backup -Force
    } else { [IO.File]::Move($temp, $File) }
}
function StopBackend($session) {
    AtomicJson (Join-Path $session.runtime 'shutdown.json') @{sessionId=$session.id}
    for ($attempt=0; $attempt -lt 200 -and (Test-Path -LiteralPath (Join-Path $session.runtime 'backend.lock')); $attempt++) {
        $backendPid = [int](Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $session.runtime 'backend.lock') -ErrorAction SilentlyContinue)
        if (-not (Get-Process -Id $backendPid -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath (Join-Path $session.runtime 'backend.lock') -Force -ErrorAction SilentlyContinue; break }
        Start-Sleep -Milliseconds 100
    }
    if (Test-Path -LiteralPath (Join-Path $session.runtime 'backend.lock')) { throw 'Assistant backend did not stop. No code was switched.' }
}
$Source = (Resolve-Path -LiteralPath $Source).Path
$Pob = (Resolve-Path -LiteralPath $Pob).Path; NoLinks $Pob
if (-not $Destination) { $Destination = Join-Path $Pob 'PoEAssistant' }
$Destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\'); NoLinks $Destination
if (-not (Test-Path -LiteralPath (Join-Path $Pob 'Path of Building.exe'))) { throw 'Select an existing Path of Building Community installation.' }
$manifest = VerifyPackage $Source
$windows = @(Get-CimInstance Win32_Process -Filter "Name='Path of Building.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq (Join-Path $Pob 'Path of Building.exe') })
if ($windows.Count) { throw 'Save your build and close Path of Building before installing. Setup will never close it or discard your changes.' }
$mutexHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Pob.ToLowerInvariant()))).Replace('-','')
$mutex = New-Object Threading.Mutex($false, ('Local\PoEAssistant-' + $mutexHash))
if (-not $mutex.WaitOne(0)) { throw 'Another installation/update is in progress for this PoB.' }
$stage = $null; $old = $null; $activated = $false; $integrationInstalled = $false; $linksChanged = $false
try {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $data = ChildPath $Destination 'data'; New-Item -ItemType Directory -Path $data -Force | Out-Null
    $sessionFile = Join-Path $data 'session.json'
    $linkArgs = @{Pob=$Pob;Launcher=(Join-Path $Pob 'PoEAssistant.lua');Records=(Join-Path $data 'pob-shortcuts.json')}
    if ($ShortcutRoots) { $linkArgs.Roots = $ShortcutRoots }
    $legacy = & (Join-Path $Source 'scripts/integrate-shortcuts.ps1') @linkArgs -Mode Inspect | ConvertFrom-Json
    # Migrate only addon-owned settings/recovery; never copy provider credentials,
    # native PoB settings/build folders, engine caches or queued commands.
    if (-not (Test-Path -LiteralPath $sessionFile)) {
        $candidates = @($legacy | Where-Object legacyDestination | Select-Object -ExpandProperty legacyDestination -Unique)
        foreach ($candidate in $candidates) {
            $oldPointer = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $candidate 'current.json') | ConvertFrom-Json
            $previousSession = Get-Content -Encoding UTF8 -Raw -LiteralPath $oldPointer.session | ConvertFrom-Json
            StopBackend $previousSession
            Copy-Item -LiteralPath $oldPointer.session -Destination $sessionFile
            $settings = Join-Path $previousSession.state 'settings.json'
            if (Test-Path -LiteralPath $settings) { Copy-Item -LiteralPath $settings -Destination (Join-Path $data 'settings.json') }
            $migratedRuntime = ChildPath $data ('sessions/' + $previousSession.id)
            New-Item -ItemType Directory -Path $migratedRuntime -Force | Out-Null
            foreach ($name in @('backups','receipts','recovery.xml','panel-layout.json','ui.json','snapshot.json','loaded-contexts.json')) {
                $from = Join-Path $previousSession.runtime $name
                if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $migratedRuntime $name) -Recurse }
            }
            AtomicJson (Join-Path $data 'migration.json') @{source=$candidate;sessionId=$previousSession.id;time=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
            break
        }
    }
    $ownerFile = Join-Path $data 'owner.json'
    if (-not (Test-Path -LiteralPath $ownerFile)) { AtomicJson $ownerFile @{id=('poe-assistant-' + [Guid]::NewGuid().ToString());owner='PoE Assistant';destination=$Destination;pob=$Pob} }
    if (Test-Path -LiteralPath $sessionFile) { $session = Get-Content -Encoding UTF8 -Raw -LiteralPath $sessionFile | ConvertFrom-Json; StopBackend $session }
    $pointer = Join-Path $Destination 'current.json'
    if (Test-Path -LiteralPath $pointer) { $old = Get-Content -Encoding UTF8 -Raw -LiteralPath $pointer | ConvertFrom-Json }
    $releases = ChildPath $Destination 'releases'; New-Item -ItemType Directory -Path $releases -Force | Out-Null
    $releaseName = $manifest.version + '-' + [Guid]::NewGuid().ToString('N')
    $stage = ChildPath $releases $releaseName
    New-Item -ItemType Directory -Path $stage | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $stage -Recurse
    $null = VerifyPackage $stage
    $node = Join-Path $stage 'runtime/node.exe'
    & $node --check (Join-Path $stage 'src/server.mjs'); if ($LASTEXITCODE) { throw 'Backend syntax check failed.' }
    & $node --check (Join-Path $stage 'src/build-lab.mjs'); if ($LASTEXITCODE) { throw 'Calculator syntax check failed.' }
    & $node (Join-Path $stage 'scripts/install.mjs') --pob $Pob --state $data --managed-destination $Destination --no-shortcut
    if ($LASTEXITCODE) { throw 'PoB addon compatibility/install check failed.' }
    $integrationInstalled = $true
    $session = Get-Content -Encoding UTF8 -Raw -LiteralPath $sessionFile | ConvertFrom-Json
    Remove-Item -LiteralPath (Join-Path $session.runtime 'shutdown.json') -Force -ErrorAction SilentlyContinue
    $entry = @{version=$manifest.version;release=$stage;releaseName=$releaseName;session=$sessionFile;previous=$old.release;previousName=$old.releaseName;repository='arthurhpabreu/poe-assistant';direct=$true}
    foreach ($name in @('Launch','Update','Uninstall','Rollback','Common')) {
        Copy-Item -LiteralPath (Join-Path $stage ('scripts/installed-' + $name.ToLowerInvariant() + '.ps1')) -Destination (Join-Path $Destination ($name + '.ps1')) -Force
    }
    AtomicJson $pointer $entry; $activated = $true
    & (Join-Path $stage 'scripts/start-backend.ps1') -Session $sessionFile
    if (-not $NoShortcut) {
        & (Join-Path $stage 'scripts/integrate-shortcuts.ps1') @linkArgs -Mode Install
        if (-not $?) { throw 'Could not integrate the existing PoB shortcut.' }
        $linksChanged = $true
        $activeLinks = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $data 'active-shortcuts.json') | ConvertFrom-Json
        $verifiedShortcut = @($activeLinks | Select-Object -First 1)[0]
        if (-not $verifiedShortcut) { throw 'No existing PoB shortcut is available for native verification.' }
        & (Join-Path $stage 'scripts/verify-native.ps1') -Pob $Pob -Destination $Destination -Shortcut $verifiedShortcut
        & (Join-Path $stage 'scripts/integrate-shortcuts.ps1') @linkArgs -Mode Cleanup
    } else {
        & (Join-Path $stage 'scripts/verify-native.ps1') -Pob $Pob -Destination $Destination
    }
    Write-Output ('Installed PoE Assistant ' + $manifest.version + '. Open your usual Path of Building shortcut.')
} catch {
    $failure = $_
    if ($activated -and $session) { StopBackend $session }
    if ($linksChanged -and -not $old) { & (Join-Path $stage 'scripts/integrate-shortcuts.ps1') @linkArgs -Mode Restore }
    if ($old -and (Test-Path -LiteralPath $old.release)) {
        $oldNode = Join-Path $old.release 'runtime/node.exe'
        $restore = @('--pob',$Pob,'--state',$data,'--no-shortcut')
        if ($old.direct) { $restore += @('--managed-destination',$Destination) }
        & $oldNode (Join-Path $old.release 'scripts/install.mjs') @restore
        if ($LASTEXITCODE -eq 0) {
            AtomicJson $pointer $old
            foreach ($name in @('Launch','Update','Uninstall','Rollback','Common')) {
                $helper = Join-Path $old.release ('scripts/installed-' + $name.ToLowerInvariant() + '.ps1')
                if (Test-Path -LiteralPath $helper) { Copy-Item -LiteralPath $helper -Destination (Join-Path $Destination ($name + '.ps1')) -Force }
            }
            $restoredSession = Get-Content -Encoding UTF8 -Raw -LiteralPath $sessionFile | ConvertFrom-Json
            Remove-Item -LiteralPath (Join-Path $restoredSession.runtime 'shutdown.json') -Force -ErrorAction SilentlyContinue
            & (Join-Path $old.release 'scripts/start-backend.ps1') -Session $sessionFile
        }
    } elseif ($integrationInstalled) {
        & (Join-Path $stage 'runtime/node.exe') (Join-Path $stage 'scripts/install.mjs') --pob $Pob --state $data --uninstall --no-shortcut
        Remove-Item -LiteralPath (Join-Path $Destination 'current.json') -Force -ErrorAction SilentlyContinue
    }
    throw $failure
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
