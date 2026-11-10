param([Parameter(Mandatory=$true)][string]$Session)
$ErrorActionPreference = 'Stop'
$sessionPath = (Resolve-Path -LiteralPath $Session).Path
$config = Get-Content -Raw -LiteralPath $sessionPath | ConvertFrom-Json
$heartbeat = Join-Path $config.runtime 'heartbeat.json'
if (Test-Path -LiteralPath $heartbeat) {
    $last = Get-Content -Raw -LiteralPath $heartbeat | ConvertFrom-Json
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $last.time -lt 12000) {
        $existingBackend = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $last.pid) -ErrorAction SilentlyContinue
        if ($existingBackend -and $existingBackend.CommandLine.Contains((Join-Path $config.root 'src\server.mjs'))) { exit 0 }
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
            $beat = Get-Content -Raw -LiteralPath $heartbeat | ConvertFrom-Json
            if ($beat.sessionId -eq $config.id -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $beat.time -lt 3000) { $ready = $true; break }
        } catch { }
    }
}
if (-not $ready) { throw ('Assistant did not start. See ' + (Join-Path $config.runtime 'backend-error.log')) }
