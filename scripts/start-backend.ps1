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
