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
test('managed entry uses relative Lua paths with Unicode roots, no config rewrite, and preserves updater handoffs', async () => {
  const source = managedBootstrap().replace(/^#[^\n]*\n/, '');
  const implementation = await fs.readFile('addon/Bootstrap.lua', 'utf8');
  assert(!source.includes('C:\\Users'));
  lua(`
local base = 'D:/João 测试/PoB'
function GetScriptPath() return base end
function SetWorkDir(value) assert(value==base) end
function GetRuntimePath() return base end
function ConPrintf(...) error('Unexpected integration failure') end
os.getenv=function() return nil end
local config = {id='pobhelper-fixture'}
local rewroteSession
package.preload.dkjson = function() return {
 decode=function(text) if text=='pointer' then return {repository='arthurhpabreu/poe-assistant',releaseName='0.3.0-abc'} end; return config end,
 encode=function(value) return 'serialized' end
} end
io.open = function(file, mode)
 assert(not file:match('^%a:'), 'Lua used an absolute UTF-8 path')
 if mode=='wb' and file:match('session.json$') then rewroteSession=true end
 return {read=function() return file:match('current.json$') and 'pointer' or 'session' end, close=function() end, write=function() return true end}
end
os.remove=function() return true end; os.rename=function() return true end
local attached
PLoadModule = function() return nil, {} end
SpawnProcess = function(target,args) spawned={target=target,args=args} end
local restarted, exited
Restart=function() restarted=true end
Exit=function() exited=true end
loadfile = function(file)
 if file=='PoEAssistant/Bootstrap.lua' then return function() return (function()
${implementation}
 end)() end end
 if file=='Launch.lua' then return function()
  launch={OnInit=function() PLoadModule('Modules/Main') end,ApplyUpdate=function(self,mode)
   if mode=='basic' then SpawnProcess(GetRuntimePath()..'/Update','UpdateApply.lua Update/opFileRuntime.txt'); Exit() else Restart() end
  end}
 end end
 if file=='PoEAssistant/releases/0.3.0-abc/addon/WindowsProcess.lua' then return function() return function() end end end
 assert(file=='PoEAssistant/releases/0.3.0-abc/addon/PobHelper.lua',file)
 return function() return function(main,settings) attached=settings end end
end
${source}
launch:OnInit()
assert(attached.install==base and attached.root==base..'/PoEAssistant/releases/0.3.0-abc')
assert(attached.node==attached.root..'/runtime/node.exe')
assert(attached.runtime=='PoEAssistant/data/sessions/pobhelper-fixture' and not rewroteSession)
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

test('bootstrap failures remain visible while ordinary PoB initializes', () => {
  lua(`
function GetScriptPath() return 'D:/PoB' end
function SetWorkDir() end
os.getenv=function() return nil end
local log, initialized, prompt
io.open=function() return {write=function(_,text) log=text end,close=function() end} end
loadfile=function(file)
 if file=='Launch.lua' then return function() launch={OnInit=function() initialized=true end,ShowPrompt=function(self,...) prompt=select(4,...) end} end end
 return nil,'Deliberate missing bootstrap'
end
${managedBootstrap().replace(/^#[^\n]*\n/, '')}
launch:OnInit()
assert(initialized and log:find('Deliberate missing bootstrap') and prompt:find('PoE Assistant could not start'))
initialized=false; local exited
os.getenv=function() return 'probe-fixture' end
Exit=function() exited=true end
${managedBootstrap().replace(/^#[^\n]*\n/, '')}
launch:OnInit()
assert(exited and not initialized, 'Failed verification initialized ordinary user settings/builds')
`);
});

test('bundled Node restarts a stopped backend without any PowerShell script or policy change', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-node-start-'));
  const sessionFile=path.join(dir,'session.json'),id='pobhelper-native-launch-test';
  const { atomicWrite,readJson } = await import('../src/files.mjs');
  await atomicWrite(sessionFile,{id,install:dir,state:dir,runtime:dir});
  try {
    const start=()=>runProcess(process.execPath,[path.resolve('src/launch-backend.mjs'),'--session',sessionFile],{timeoutMs:30000});
    await start();const first=await readJson(path.join(dir,'heartbeat.json'));assert(first?.pid>0);
    await atomicWrite(path.join(dir,'shutdown.json'),{sessionId:id});
    await start();const second=await readJson(path.join(dir,'heartbeat.json'));assert(second?.pid>0 && second.pid!==first.pid);
    assert.equal(await readJson(path.join(dir,'shutdown.json')),null);
    assert.equal(await readJson(path.join(dir,'backend-start-error.json')),null);
  } finally {
    await atomicWrite(path.join(dir,'shutdown.json'),{sessionId:id});
    for(let i=0;i<100 && await fs.stat(path.join(dir,'backend.lock')).catch(()=>null);i++)await new Promise(r=>setTimeout(r,100));
    assert(path.basename(dir).startsWith('pa-node-start-'));await fs.rm(dir,{recursive:true,force:true});
  }
});

test('existing PoB shortcut is reused, legacy links are owned, uninstall restores only unchanged links', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-links-João-测试-'));
  try {
    const script = path.resolve('scripts/integrate-shortcuts.ps1').replaceAll("'", "''");
    const api = path.resolve('scripts/shortcut-api.ps1').replaceAll("'", "''");
    const quoted = dir.replaceAll("'", "''");
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`
$ErrorActionPreference='Stop'
$dir='${quoted}'; $pob=Join-Path $dir 'PoB'; $links=Join-Path $dir 'Links'
New-Item -ItemType Directory -Path $pob,$links | Out-Null
$exe=Join-Path $pob 'Path of Building.exe'; [IO.File]::WriteAllText($exe,'fixture')
[IO.File]::WriteAllText((Join-Path $pob 'PoEAssistant.lua'),'fixture')
[IO.File]::WriteAllText((Join-Path $pob 'Launch.lua'),'fixture')
. '${api}'
$ordinary=Join-Path $links 'Path of Building Community.lnk'
$link=[PoeAssistantShortcut]::Open($ordinary); $link.TargetPath=$exe; $link.Arguments='"'+(Join-Path $pob 'Launch.lua')+'"'; $link.WorkingDirectory=$pob; $link.Save()
$original=[PoeAssistantShortcut]::Open($ordinary).Arguments
$custom=Join-Path $links 'Custom build.lnk'; $link=[PoeAssistantShortcut]::Open($custom); $link.TargetPath=$exe; $link.Arguments='"custom.lua"'; $link.Save()
$helper=Join-Path $links 'PoB Helper.lnk'; $link=[PoeAssistantShortcut]::Open($helper); $link.TargetPath=$exe; $link.Arguments='"'+(Join-Path $pob 'PobHelperLaunch-abc.lua')+'"'; $link.Save()
[IO.File]::WriteAllText((Join-Path $pob 'PobHelperLaunch-abc.lua'),'-- PoB Helper standalone entry point. Session: pobhelper-abc')
$unowned=Join-Path $links 'Update PoE Assistant 11111111.lnk'; $link=[PoeAssistantShortcut]::Open($unowned); $link.TargetPath=$exe; $link.Arguments='"custom.lua"'; $link.Save()
$integrationArgs=@{Pob=$pob;Launcher=(Join-Path $pob 'PoEAssistant.lua');Records=(Join-Path $dir 'records.json');Roots=@($links)}
& '${script}' @integrationArgs -Mode Install
& '${script}' @integrationArgs -Mode Install
if ((Get-ChildItem -LiteralPath $links).Count -ne 4) { throw 'An extra shortcut was created' }
$changed=[PoeAssistantShortcut]::Open($ordinary)
if ((Get-Item -LiteralPath $changed.TargetPath).FullName -ne (Get-Item -LiteralPath $exe).FullName -or (Get-Item -LiteralPath $changed.Arguments.Trim('"')).FullName -ne (Get-Item -LiteralPath $integrationArgs.Launcher).FullName) { throw 'Usual shortcut was not integrated' }
& '${script}' @integrationArgs -Mode Cleanup
if ((Test-Path -LiteralPath $helper) -or -not (Test-Path -LiteralPath $unowned)) { throw 'Legacy cleanup ownership failed' }
try { & '${script}' @integrationArgs -Mode Restore } catch { throw ($_ | Out-String) + $_.ScriptStackTrace + (Get-Content -Raw -LiteralPath $integrationArgs.Records) }
if ([PoeAssistantShortcut]::Open($ordinary).Arguments -ne $original) { throw 'Original arguments were not restored' }
if ([PoeAssistantShortcut]::Open($custom).Arguments -ne '"custom.lua"') { throw 'Custom shortcut was changed' }
& '${script}' @integrationArgs -Mode Install
$changed=[PoeAssistantShortcut]::Open($ordinary); $changed.Arguments='"manually-changed.lua"'; $changed.Save()
& '${script}' @integrationArgs -Mode Restore
if ([PoeAssistantShortcut]::Open($ordinary).Arguments -ne '"manually-changed.lua"') { throw 'Manual shortcut change overwritten' }
`, 'utf16le').toString('base64')], { timeoutMs: 30000 });
  } finally { assert(path.basename(dir).startsWith('pa-links-')); await fs.rm(dir, { recursive: true, force: true }); }
});
