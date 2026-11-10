param([Parameter(Mandatory=$true)][string]$Pob, [Parameter(Mandatory=$true)][string]$Destination, [string]$Shortcut, [int]$TimeoutSeconds=45)
$ErrorActionPreference = 'Stop'
$nonce = [Guid]::NewGuid().ToString()
$folder = Join-Path $Destination ('verification/' + $nonce)
New-Item -ItemType Directory -Path (Join-Path $folder 'runtime/inbox'),(Join-Path $folder 'runtime/receipts'),(Join-Path $folder 'user/Builds') -Force | Out-Null
$current = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $Destination 'current.json') | ConvertFrom-Json
$probeId = 'pobhelper-probe-' + $nonce
$sessionFile = Join-Path $folder 'session.json'
$session = @{id=$probeId;root=$current.release;install=$Pob;state=$folder;runtime=(Join-Path $folder 'runtime');verification=$true}
[IO.File]::WriteAllText($sessionFile, ($session | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
$request = @{nonce=$nonce;sessionId=$probeId;sessionFile=$sessionFile;startBackend=$true}
[IO.File]::WriteAllText((Join-Path $folder 'request.json'), ($request | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
$previousNonce = $env:POE_ASSISTANT_PROBE
$probe = $null
try {
    $env:POE_ASSISTANT_PROBE = $nonce
    if ($Shortcut) {
        $probe = Start-Process -FilePath $Shortcut -WorkingDirectory $Pob -WindowStyle Hidden -PassThru
    } else {
        $probe = Start-Process -FilePath (Join-Path $Pob 'Path of Building.exe') -ArgumentList ('"' + (Join-Path $Pob 'PoEAssistant.lua') + '"') -WorkingDirectory $Pob -WindowStyle Hidden -PassThru
    }
    if (-not $probe -or -not $probe.Id) { throw 'Windows did not return the PoB verification process.' }
    $result = $null; $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $file = Join-Path $folder 'result.json'
        if (Test-Path -LiteralPath $file) {
            try { $result = Get-Content -Encoding UTF8 -Raw -LiteralPath $file | ConvertFrom-Json } catch { $result = $null }
            if ($result.stage -eq 'failed') { throw ('PoB could not load the assistant: ' + $result.error) }
            if ($result.stage -eq 'ready' -and $result.backendConnected) { break }
        }
        if ($probe.HasExited) { break }
        Start-Sleep -Milliseconds 100
    }
    $current = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $Destination 'current.json') | ConvertFrom-Json
    $actualPath = if ($result.install) { [IO.Path]::GetFullPath($result.install).TrimEnd('\') }
    if ($result.stage -ne 'ready' -or -not $result.backendConnected -or $result.nonce -ne $nonce -or $result.processId -ne $probe.Id -or $actualPath -ine [IO.Path]::GetFullPath($Pob).TrimEnd('\') -or $result.release -ne $current.releaseName) {
        $detail = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $Destination 'startup-error.log') -ErrorAction SilentlyContinue
        throw ('The real PoB window did not confirm that the assistant rendered. Setup was not completed. ' + $detail + ' Verification: ' + $folder)
    }
    $backendReady = $false; $deadline = [DateTime]::UtcNow.AddSeconds(25)
    while ([DateTime]::UtcNow -lt $deadline) {
        $heartbeat = Join-Path $folder 'runtime/heartbeat.json'
        if (Test-Path -LiteralPath $heartbeat) {
            try { $beat = Get-Content -Encoding UTF8 -Raw -LiteralPath $heartbeat | ConvertFrom-Json } catch { $beat = $null }
            if ($beat.sessionId -eq $probeId -and $beat.pid -gt 0 -and ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $beat.time) -lt 5000) { $backendReady = $true; break }
        }
        $errorFile = Join-Path $folder 'runtime/backend-start-error.json'
        if (Test-Path -LiteralPath $errorFile) { throw ('Native backend startup failed: ' + (Get-Content -Encoding UTF8 -Raw -LiteralPath $errorFile)) }
        Start-Sleep -Milliseconds 100
    }
    if (-not $backendReady) { throw ('The panel rendered but PoB could not start its bundled Node backend. Diagnostics: ' + $folder) }
    $result | Add-Member -NotePropertyName backendVerified -NotePropertyValue $true
    $probe.WaitForExit(5000) | Out-Null
    [IO.File]::WriteAllText((Join-Path $Destination 'native-verification.json'), ($result | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    Write-Output ('PoB verified: assistant rendered through ' + $(if ($Shortcut) { $Shortcut } else { 'its native entry point' }))
} finally {
    $env:POE_ASSISTANT_PROBE = $previousNonce
    [IO.File]::WriteAllText((Join-Path $folder 'verification-complete.json'), '{"complete":true}')
    [IO.File]::WriteAllText((Join-Path $folder 'runtime/shutdown.json'), ('{"sessionId":"' + $probeId + '"}'))
    for ($attempt=0; $attempt -lt 100 -and (Test-Path -LiteralPath (Join-Path $folder 'runtime/backend.lock')); $attempt++) { Start-Sleep -Milliseconds 100 }
    # Only this exact process was created by setup. Never close existing windows.
    if ($probe -and -not $probe.HasExited) { Stop-Process -Id $probe.Id -ErrorAction SilentlyContinue }
}
