import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fengari from 'fengari';
import { managedBootstrap, updateBootstrap } from '../scripts/install.mjs';
import { runProcess } from '../src/process.mjs';

function lua(source) {
  const L = fengari.lauxlib.luaL_newstate(); fengari.lualib.luaL_openlibs(L);
  try {
    const result = fengari.lauxlib.luaL_dostring(L, fengari.to_luastring(source));
    assert.equal(result, 0, result ? fengari.to_jsstring(fengari.lua.lua_tostring(L, -1)) : '');
  } finally { fengari.lua.lua_close(L); }
}
test('managed entry resolves moved installations and preserves normal/basic updater handoffs', () => {
  const source = managedBootstrap().replace(/^#[^\n]*\n/, '');
  assert(!source.includes('C:\\Users'));
  lua(`
local base = 'D:/Moved PoB'
function GetScriptPath() return base end
function GetRuntimePath() return base end
function ConPrintf(...) error('Unexpected integration failure') end
local config = {id='pobhelper-fixture'}
local stored
package.preload.dkjson = function() return {
 decode=function(text) if text=='pointer' then return {repository='arthurhpabreu/poe-assistant',releaseName='0.3.0-abc'} end; return config end,
 encode=function(value) stored=value; return 'serialized' end
} end
io.open = function(file, mode)
 return {read=function() return file:match('current.json$') and 'pointer' or 'session' end, close=function() end, write=function() end}
end
local attached
PLoadModule = function() return nil, {} end
SpawnProcess = function(target,args) spawned={target=target,args=args} end
local restarted, exited
Restart=function() restarted=true end
Exit=function() exited=true end
loadfile = function(file)
 if file==base..'/Launch.lua' then return function()
  PLoadModule('Modules/Main')
  launch={ApplyUpdate=function(self,mode)
   if mode=='basic' then SpawnProcess(GetRuntimePath()..'/Update','UpdateApply.lua Update/opFileRuntime.txt'); Exit() else Restart() end
  end}
 end end
 assert(file==base..'/PoEAssistant/releases/0.3.0-abc/addon/PobHelper.lua',file)
 return function() return function(main,settings) attached=settings end end
end
${source}
assert(attached.install==base and attached.root==base..'/PoEAssistant/releases/0.3.0-abc')
assert(stored.node==attached.root..'/runtime/node.exe')
assert(stored.runtime==base..'/PoEAssistant/data/sessions/pobhelper-fixture')
launch:ApplyUpdate('normal'); assert(restarted)
local original=SpawnProcess
launch:ApplyUpdate('basic'); assert(exited and spawned.args=='PoEAssistantUpdate.lua Update/opFileRuntime.txt')
assert(SpawnProcess==original)
`);
  lua(`
function GetScriptPath() return 'D:/Moved PoB' end
local calls={}
SpawnProcess=function(target,args) calls[#calls+1]={target,args} end
local original=SpawnProcess
loadfile=function(name) return function(operations)
 assert(name=='UpdateApply.lua' and operations=='Update/opFileRuntime.txt')
 SpawnProcess([[D:\\Moved PoB\\Path of Building.exe]])
 SpawnProcess('D:/Other PoB/Path of Building.exe')
end end
local function run(...)
${updateBootstrap('D:/Moved PoB').replace(/^#[^\n]*\n/, '')}
end
run('Update/opFileRuntime.txt')
assert(calls[1][2]==[["D:\\Moved PoB\\Path of Building.exe" "D:/Moved PoB/PoEAssistant.lua"]])
assert(calls[2][2]==nil and SpawnProcess==original)
`);
});

test('existing PoB shortcut is reused, legacy links are owned, uninstall restores only unchanged links', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-links-'));
  try {
    const script = path.resolve('scripts/integrate-shortcuts.ps1').replaceAll("'", "''");
    const quoted = dir.replaceAll("'", "''");
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$dir='${quoted}'; $pob=Join-Path $dir 'PoB'; $links=Join-Path $dir 'Links'
New-Item -ItemType Directory -Path $pob,$links | Out-Null
$exe=Join-Path $pob 'Path of Building.exe'; [IO.File]::WriteAllText($exe,'fixture')
[IO.File]::WriteAllText((Join-Path $pob 'PoEAssistant.lua'),'fixture')
[IO.File]::WriteAllText((Join-Path $pob 'Launch.lua'),'fixture')
$shell=New-Object -ComObject WScript.Shell
$ordinary=Join-Path $links 'Path of Building Community.lnk'
$link=$shell.CreateShortcut($ordinary); $link.TargetPath=$exe; $link.Arguments='"'+(Join-Path $pob 'Launch.lua')+'"'; $link.WorkingDirectory=$pob; $link.Save()
$original=$shell.CreateShortcut($ordinary).Arguments
$custom=Join-Path $links 'Custom build.lnk'; $link=$shell.CreateShortcut($custom); $link.TargetPath=$exe; $link.Arguments='"custom.lua"'; $link.Save()
$helper=Join-Path $links 'PoB Helper.lnk'; $link=$shell.CreateShortcut($helper); $link.TargetPath=$exe; $link.Arguments='"'+(Join-Path $pob 'PobHelperLaunch-abc.lua')+'"'; $link.Save()
[IO.File]::WriteAllText((Join-Path $pob 'PobHelperLaunch-abc.lua'),'-- PoB Helper standalone entry point. Session: pobhelper-abc')
$unowned=Join-Path $links 'Update PoE Assistant 11111111.lnk'; $link=$shell.CreateShortcut($unowned); $link.TargetPath=$exe; $link.Arguments='"custom.lua"'; $link.Save()
$integrationArgs=@{Pob=$pob;Launcher=(Join-Path $pob 'PoEAssistant.lua');Records=(Join-Path $dir 'records.json');Roots=@($links)}
& '${script}' @integrationArgs -Mode Install
& '${script}' @integrationArgs -Mode Install
if ((Get-ChildItem -LiteralPath $links).Count -ne 4) { throw 'An extra shortcut was created' }
$changed=$shell.CreateShortcut($ordinary)
if ((Get-Item -LiteralPath $changed.TargetPath).FullName -ne (Get-Item -LiteralPath $exe).FullName -or (Get-Item -LiteralPath $changed.Arguments.Trim('"')).FullName -ne (Get-Item -LiteralPath $integrationArgs.Launcher).FullName) { throw 'Usual shortcut was not integrated' }
& '${script}' @integrationArgs -Mode Cleanup
if ((Test-Path -LiteralPath $helper) -or -not (Test-Path -LiteralPath $unowned)) { throw 'Legacy cleanup ownership failed' }
try { & '${script}' @integrationArgs -Mode Restore } catch { throw ($_ | Out-String) + $_.ScriptStackTrace + (Get-Content -Raw -LiteralPath $integrationArgs.Records) }
if ($shell.CreateShortcut($ordinary).Arguments -ne $original) { throw 'Original arguments were not restored' }
if ($shell.CreateShortcut($custom).Arguments -ne '"custom.lua"') { throw 'Custom shortcut was changed' }
& '${script}' @integrationArgs -Mode Install
$changed=$shell.CreateShortcut($ordinary); $changed.Arguments='"manually-changed.lua"'; $changed.Save()
& '${script}' @integrationArgs -Mode Restore
if ($shell.CreateShortcut($ordinary).Arguments -ne '"manually-changed.lua"') { throw 'Manual shortcut change overwritten' }
`], { timeoutMs: 30000 });
  } finally { assert(path.basename(dir).startsWith('pa-links-')); await fs.rm(dir, { recursive: true, force: true }); }
});
