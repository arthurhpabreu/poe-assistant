param([Parameter(Mandatory=$true)][string]$Pob, [Parameter(Mandatory=$true)][string]$ReleaseName, [switch]$Sustained)
$ErrorActionPreference = 'Stop'
if ($ReleaseName -notmatch '^[\w.-]+$') { throw 'Invalid test release.' }
$Pob = (Resolve-Path -LiteralPath $Pob).Path
$id = [Guid]::NewGuid().ToString('N')
$relative = 'PoEAssistant/verification/status-' + $id
$folder = Join-Path $Pob $relative
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$report = Join-Path $folder 'result.json'
$entry = Join-Path $Pob ('PAStatusCheck-' + $id + '.lua')
$assertion = if ($Sustained) { 'assert(not replaced and failure, "A sustained reader lock was not reported")' } else { 'assert(replaced, failure)' }
[IO.File]::WriteAllText($report,'{"stage":"old"}',(New-Object Text.UTF8Encoding($false)))
$lua = @"
#@ SimpleGraphic
SetWorkDir(GetScriptPath())
local _, replace = assert(loadfile('PoEAssistant/releases/$ReleaseName/addon/WindowsProcess.lua'))()
local f = assert(io.open('$relative/result.json.tmp', 'wb'))
f:write('{"stage":"new"}'); f:close()
local marker = assert(io.open('$relative/attempting', 'wb')); marker:write('ready'); marker:close()
local replaced, failure = replace('$relative/result.json.tmp', '$relative/result.json')
$assertion
Exit()
"@
[IO.File]::WriteAllText($entry,$lua,(New-Object Text.UTF8Encoding($false)))
$reader = $null; $probe = $null
try {
    # This reader allows other readers/writers, but denies deletion/replacement
    # just like a briefly open Windows status reader can do during verification.
    $reader = [IO.File]::Open($report,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    $probe = Start-Process -FilePath (Join-Path $Pob 'Path of Building.exe') -ArgumentList ('"' + $entry + '"') -WorkingDirectory $Pob -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath (Join-Path $folder 'attempting')) -and -not $probe.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
    if (-not (Test-Path -LiteralPath (Join-Path $folder 'attempting'))) { throw 'The native status writer did not run.' }
    if ($Sustained) {
        if (-not $probe.WaitForExit(5000) -or $probe.ExitCode -ne 0 -or [IO.File]::ReadAllText($report) -ne '{"stage":"old"}') { throw 'The native writer did not bound its retries and preserve the previous status under a sustained lock.' }
        Write-Output 'Native status replacement reported a sustained lock and preserved the previous report.'
    } else {
        Start-Sleep -Milliseconds 80
        if ([IO.File]::ReadAllText($report) -ne '{"stage":"old"}') { throw 'The previous status was lost while a reader held it open.' }
        $reader.Dispose(); $reader = $null
        if (-not $probe.WaitForExit(5000) -or $probe.ExitCode -ne 0 -or [IO.File]::ReadAllText($report) -ne '{"stage":"new"}') { throw 'The native status replacement did not recover after the reader released its lock.' }
        Write-Output 'Native status replacement preserved the previous report and recovered from a Windows reader lock.'
    }
} finally {
    if ($reader) { $reader.Dispose() }
    if ($probe -and -not $probe.HasExited) { Stop-Process -Id $probe.Id -ErrorAction SilentlyContinue }
    foreach ($file in @($entry,[IO.Path]::ChangeExtension($entry,'.cfg'))) {
        if ([IO.Path]::GetFullPath((Split-Path -Parent $file)) -ne [IO.Path]::GetFullPath($Pob) -or (Split-Path -Leaf $file) -notlike ('PAStatusCheck-' + $id + '.*')) { throw 'Invalid native status test cleanup path.' }
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
}
