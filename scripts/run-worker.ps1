param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Script, [Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
# All paths belong to the caller's private engine/request. No global profile.
$worker = Start-Process -FilePath $Executable -ArgumentList ('"' + $Script + '"') -WorkingDirectory $Directory -WindowStyle Hidden -PassThru
$worker.WaitForExit()
exit $worker.ExitCode
