param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Pob, [Parameter(Mandatory=$true)][string]$Destination, [Parameter(Mandatory=$true)][string]$Diagnostics, [Parameter(Mandatory=$true)][string]$Invocation, [switch]$NoShortcut, [string]$Shortcut)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'setup-diagnostics.ps1')
try {
    Write-SetupPhase 'Starting deployment'
    & (Join-Path $PSScriptRoot 'deploy.ps1') -Source $Source -Pob $Pob -Destination $Destination -NoShortcut:$NoShortcut -Diagnostics $Diagnostics -Invocation $Invocation -Shortcut $Shortcut
    if (-not (Test-Path -LiteralPath (Join-Path $Diagnostics 'success.json'))) { throw 'Deployment returned without a verified installation receipt.' }
    exit 0
} catch {
    Save-SetupFailure $_
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
