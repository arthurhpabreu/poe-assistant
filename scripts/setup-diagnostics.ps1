# Diagnostics are limited to setup and named startup logs. No builds, settings,
# conversations, provider configuration or credential stores are collected.
function Write-SetupPhase([string]$Phase) {
    $script:setupPhase = $Phase
    if ($Diagnostics) {
        try {
            [IO.File]::WriteAllText((Join-Path $Diagnostics 'phase.txt'), $Phase, (New-Object Text.UTF8Encoding($false)))
            [IO.File]::AppendAllText((Join-Path $Diagnostics 'setup.log'), ([DateTime]::UtcNow.ToString('o') + ' ' + $Phase + "`r`n"), (New-Object Text.UTF8Encoding($false)))
        } catch { }
    }
}
function Save-SetupFailure($Failure) {
    if (-not $Diagnostics) { return }
    try {
        $file = Join-Path $Diagnostics 'failure.json'
        if (-not (Test-Path -LiteralPath $file)) {
            $phase = $script:setupPhase
            if (Test-Path -LiteralPath (Join-Path $Diagnostics 'phase.txt')) { $phase = [IO.File]::ReadAllText((Join-Path $Diagnostics 'phase.txt'), [Text.Encoding]::UTF8) }
            $record = @{phase=$phase;error=$Failure.Exception.Message;exception=$Failure.Exception.ToString();position=$Failure.InvocationInfo.PositionMessage;stack=$Failure.ScriptStackTrace;time=[DateTime]::UtcNow.ToString('o');invocation=$Invocation}
            [IO.File]::WriteAllText($file, ($record | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
            [IO.File]::AppendAllText((Join-Path $Diagnostics 'setup.log'), ("`r`nPRIMARY FAILURE`r`n" + ($record | ConvertTo-Json -Depth 5) + "`r`n"), (New-Object Text.UTF8Encoding($false)))
        }
    } catch { }
}
function Save-SetupCleanupFailure($Failure) {
    $script:setupCleanupErrors += @([string]$Failure.Exception.Message)
    try { [Console]::Error.WriteLine('Recovery incomplete: ' + $Failure.Exception.Message) } catch { }
    if ($Diagnostics) { try {
        $text = "`r`nROLLBACK/CLEANUP FAILURE`r`n" + $Failure.Exception.ToString() + "`r`n" + $Failure.ScriptStackTrace + "`r`n"
        [IO.File]::AppendAllText((Join-Path $Diagnostics 'cleanup-errors.log'), $text, (New-Object Text.UTF8Encoding($false)))
        [IO.File]::AppendAllText((Join-Path $Diagnostics 'setup.log'), $text, (New-Object Text.UTF8Encoding($false)))
    } catch { } }
}
function Save-SetupEvidence([string]$Folder,[string]$Name,[string]$Label) {
    if (-not $Diagnostics -or -not $Folder) { return }
    try {
        $file = Join-Path $Folder $Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return }
        # Bounded tail even if a native component wrote an unusually large log.
        $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -gt 65536) { $null = $stream.Seek(-65536, [IO.SeekOrigin]::End) }
            $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
        [IO.File]::AppendAllText((Join-Path $Diagnostics 'setup.log'), ("`r`nEVIDENCE " + $Label + ' [' + (Get-Item -LiteralPath $file).LastWriteTimeUtc.ToString('o') + "]`r`n" + $text + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    } catch { }
}
