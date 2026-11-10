param([Parameter(Mandatory=$true)][string]$Session)
$ErrorActionPreference = 'Stop'
$sessionPath = (Resolve-Path -LiteralPath $Session).Path
$config = Get-Content -Encoding UTF8 -Raw -LiteralPath $sessionPath | ConvertFrom-Json
$heartbeat = Join-Path $config.runtime 'heartbeat.json'
function IsBackend($process) {
    return $process -and $process.CommandLine -and $process.CommandLine.Replace('/','\').ToLowerInvariant().Contains((Join-Path $config.root 'src\server.mjs').Replace('/','\').ToLowerInvariant())
}
$shutdown = Join-Path $config.runtime 'shutdown.json'
if (Test-Path -LiteralPath $shutdown) {
    $marker = Get-Content -Encoding UTF8 -Raw -LiteralPath $shutdown | ConvertFrom-Json
    if ($marker.sessionId -ne $config.id) { throw 'The backend shutdown marker belongs to another session.' }
    # A deliberate previous stop must not poison future ordinary PoB launches.
    $lock = Join-Path $config.runtime 'backend.lock'
    for ($attempt=0; $attempt -lt 100 -and (Test-Path -LiteralPath $lock); $attempt++) {
        $backendPid = [int](Get-Content -Encoding UTF8 -Raw -LiteralPath $lock -ErrorAction SilentlyContinue)
        $backend = if ($backendPid -gt 0) { Get-CimInstance Win32_Process -Filter ('ProcessId=' + $backendPid) -ErrorAction SilentlyContinue }
        if (-not (IsBackend $backend)) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue; break }
        Start-Sleep -Milliseconds 100
    }
    if (Test-Path -LiteralPath $lock) { throw 'The previous backend is still stopping. Reopen PoB in a moment.' }
    Remove-Item -LiteralPath $shutdown -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $heartbeat) {
    $last = Get-Content -Encoding UTF8 -Raw -LiteralPath $heartbeat | ConvertFrom-Json
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $last.time -lt 12000) {
        $existingBackend = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $last.pid) -ErrorAction SilentlyContinue
        if (IsBackend $existingBackend) { exit 0 }
    }
}
# No authentication environment/profile is modified. Only this project's backend is started.
$arguments = @('"' + (Join-Path $config.root 'src\server.mjs') + '"', '--session', '"' + $sessionPath + '"')
Start-Process -FilePath $config.node -ArgumentList $arguments -WorkingDirectory $config.root -WindowStyle Hidden -RedirectStandardError (Join-Path $config.runtime 'backend-error.log') -RedirectStandardOutput (Join-Path $config.runtime 'backend-output.log')
$ready = $false
for ($attempt = 0; $attempt -lt 100; $attempt++) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $heartbeat) {
        try {
            $beat = Get-Content -Encoding UTF8 -Raw -LiteralPath $heartbeat | ConvertFrom-Json
            if ($beat.sessionId -eq $config.id -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $beat.time -lt 3000) { $ready = $true; break }
        } catch { }
    }
}
if (-not $ready) { throw ('Assistant did not start. See ' + (Join-Path $config.runtime 'backend-error.log')) }
