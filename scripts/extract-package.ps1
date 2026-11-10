param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
if (Test-Path -LiteralPath $Destination) { throw 'Extraction destination must be new.' }
New-Item -ItemType Directory -Path $Destination | Out-Null
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $seen = @{}; $size = 0L
    foreach ($entry in $zip.Entries) {
        $file = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
        $size += $entry.Length
        if (-not $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or $entry.FullName.Contains(':') -or $seen.ContainsKey($file) -or $size -gt 1000000000) { throw 'Invalid update archive.' }
        $seen[$file]=$true
        if (-not $entry.Name) { New-Item -ItemType Directory -Path $file -Force | Out-Null; continue }
        New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$file,$false)
    }
} finally { $zip.Dispose() }
