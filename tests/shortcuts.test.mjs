import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../src/process.mjs';

const literal = value => "'" + value.replaceAll("'", "''") + "'";
async function withShortcuts(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-shortcuts-'));
  const script = path.resolve('scripts/integrate-shortcuts.ps1');
  const api = path.resolve('scripts/shortcut-api.ps1');
  try {
    const source = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
trap { [Console]::Error.WriteLine($_.Exception.Message + [Environment]::NewLine + $_.ScriptStackTrace); exit 1 }
$dir=(Get-Item -LiteralPath ${literal(dir)}).FullName; $script=${literal(script)}
$pob=Join-Path $dir 'PoB'; $links=Join-Path $dir 'Links'; $outside=Join-Path $dir 'My custom folder'
New-Item -ItemType Directory -Path $pob,$links,$outside | Out-Null
$exe=Join-Path $pob 'Path of Building.exe'; [IO.File]::WriteAllText($exe,'fixture')
$launcher=Join-Path $pob 'PoEAssistant.lua'; [IO.File]::WriteAllText($launcher,'fixture')
. ${literal(api)}
function NewLink($file,$target,$arguments,$cwd) {
 $link=[PoeAssistantShortcut]::Open($file)
 try { $link.TargetPath=$target; $link.Arguments=$arguments; $link.WorkingDirectory=$cwd; $link.Save() } finally { $link.Dispose() }
}
function Arguments($file) { $link=[PoeAssistantShortcut]::Open($file); try { return $link.Arguments } finally { $link.Dispose() } }
function WorkingDirectory($file) { $link=[PoeAssistantShortcut]::Open($file); try { return $link.WorkingDirectory } finally { $link.Dispose() } }
$original='"'+(Join-Path $pob 'Launch.lua')+'"'; $expected='"'+$launcher+'"'
$integration=@{Pob=$pob;Launcher=$launcher;Records=(Join-Path $dir 'records.json');Roots=@($links)}
${body}
`;
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { timeoutMs: 45000 });
  } finally {
    assert.equal(path.dirname(dir), os.tmpdir());
    assert(path.basename(dir).startsWith('pa-shortcuts-'));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('nested and explicitly selected shortcuts are maintained, audited and restored without following junctions', { skip: process.platform !== 'win32' }, async () => {
  await withShortcuts(`
$nested=Join-Path $links 'Games/PoE'; New-Item -ItemType Directory -Path $nested | Out-Null
$first=Join-Path $links 'PoB.lnk'; $deep=Join-Path $nested 'My PoB.lnk'; $selected=Join-Path $outside 'Play PoB.lnk'
foreach($file in @($first,$deep,$selected)) { NewLink $file $exe $original $dir }
$excluded=Join-Path $dir 'Excluded'; New-Item -ItemType Directory -Path $excluded | Out-Null
$excludedLink=Join-Path $excluded 'Do not traverse.lnk'; NewLink $excludedLink $exe $original $dir
$junction=Join-Path $links 'External junction'; New-Item -ItemType Junction -Path $junction -Target $excluded | Out-Null
try {
 & $script @integration -Shortcut $selected -Mode Install
 & $script @integration -Shortcut $selected -Mode Verify
 $active=Get-Content -LiteralPath (Join-Path $dir 'active-shortcuts.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 if($active.Count -ne 3 -or $selected -notin $active -or $deep -notin $active) { throw ('Not all actual shortcut routes were integrated: '+[IO.File]::ReadAllText((Join-Path $dir 'active-shortcuts.json'))+' selected='+$selected+' deep='+$deep+' count='+$active.Count) }
 if((Arguments $excludedLink) -ne $original) { throw 'Shortcut traversal escaped through a junction' }
 foreach($file in @($first,$deep,$selected)) { if((Arguments $file) -ne $expected -or (WorkingDirectory $file) -ne $pob) { throw ('Bad saved route: '+$file) } }
 # Correct arguments with a stale working directory must still be repaired.
 NewLink $deep $exe $expected $outside
 & $script @integration -Mode Install
 if((WorkingDirectory $deep) -ne $pob) { throw 'Already integrated shortcut skipped working directory repair' }
 # Future updates must maintain paths outside the current discovery roots.
 $empty=Join-Path $dir 'Empty'; New-Item -ItemType Directory -Path $empty | Out-Null
 $integration.Roots=@($empty)
 & $script @integration -Mode Install
 & $script @integration -Mode Verify
 $records=Get-Content -LiteralPath $integration.Records -Raw -Encoding UTF8 | ConvertFrom-Json
 if($records.Count -ne 3 -or @($records | Where-Object arguments -NE $original).Count) { throw 'Reinstall replaced original recovery arguments' }
 # Verification must detect a later bypass on any route, not only the first.
 NewLink $deep $exe $original $dir
 $rejected=$false; try { & $script @integration -Mode Verify } catch { $rejected=$_.Exception.Message.Contains($deep) }
 if(-not $rejected) { throw 'Audit missed a second shortcut that bypassed the assistant' }
 & $script @integration -Mode Install
 & $script @integration -Mode Restore
 foreach($file in @($first,$deep,$selected)) { if((Arguments $file) -ne $original -or (WorkingDirectory $file) -ne $dir) { throw 'Original shortcut was not restored exactly' } }
} finally {
 # Remove only the junction itself, never its destination or children.
 if(Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) }
}
`);
});

test('an unsupported selection fails before mutations and a later write failure restores earlier shortcut changes', { skip: process.platform !== 'win32' }, async () => {
  await withShortcuts(`
$first=Join-Path $links 'A.lnk'; $last=Join-Path $links 'Z.lnk'
foreach($file in @($first,$last)) { NewLink $file $exe $original $dir }
$custom=Join-Path $outside 'Custom build.lnk'; NewLink $custom $exe '"custom.lua"' $dir
$otherExe=Join-Path $outside 'Other.exe'; [IO.File]::WriteAllText($otherExe,'fixture')
$wrong=Join-Path $outside 'Wrong application.lnk'; NewLink $wrong $otherExe '' $dir
foreach($selection in @($custom,$wrong,(Join-Path $outside 'Missing.lnk'))) {
 $rejected=$false; try { & $script @integration -Shortcut $selection -Mode Install } catch { $rejected=$true }
 if(-not $rejected -or (Arguments $first) -ne $original) { throw 'Unsupported selected route was ignored or other shortcuts were changed' }
}
$lock=[IO.File]::Open($last,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
 $rejected=$false; try { & $script @integration -Mode Install } catch { $rejected=$true }
 if(-not $rejected) { throw 'Write-locked shortcut was accepted' }
 if((Arguments $first) -ne $original -or (WorkingDirectory $first) -ne $dir) { throw 'Earlier mutation was not rolled back' }
 if(Test-Path -LiteralPath (Join-Path $dir 'active-shortcuts.json')) { throw 'Failed integration published active routes' }
} finally { $lock.Dispose() }
& $script @integration -Mode Install
& $script @integration -Mode Verify
& $script @integration -Mode Restore
if((Arguments $custom) -ne '"custom.lua"' -or (Arguments $wrong) -ne '') { throw 'Custom or unrelated route changed' }
# A failed repair of an already-integrated first link must not prevent the
# rollback of a later link that was successfully changed by this attempt.
NewLink $first $exe $expected $dir
NewLink $last $exe $original $dir
$lock=[IO.File]::Open($first,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
 $rejected=$false; try { & $script @integration -Mode Install } catch { $rejected=$true }
 if(-not $rejected -or (Arguments $last) -ne $original -or (WorkingDirectory $last) -ne $dir) { throw 'Failed cwd repair prevented later route rollback' }
} finally { $lock.Dispose() }
`);
});
