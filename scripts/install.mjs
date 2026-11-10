import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readJson, hash } from '../src/files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateArg = process.argv.indexOf('--state');
const state = stateArg >= 0 ? path.resolve(process.argv[stateArg + 1]) : path.join(root, '.pob-helper');
export function removeHook(text) { return text.replace(/\n-- POB_HELPER_BEGIN[\s\S]*?-- POB_HELPER_END\n?/g, '\n'); }
export function compatible(text) {
  return /function main:OnFrame\(\)/.test(text) && /function main:Init\(\)/.test(text) && /GetVirtualScreenSize\(\)/.test(text) && /return main\s*$/.test(text) && /self\.inputEvents/.test(text);
}
export async function restoreLegacyHook(session) {
  const file = path.join(session.install, 'Modules/Main.lua');
  const source = await fs.readFile(file, 'utf8');
  if (!source.includes('-- POB_HELPER_BEGIN')) return;
  if (!source.includes(session.id)) throw Error('A hook belonging to another session was found and will not be changed.');
  const integration = await readJson(path.join(session.runtime, 'integration.json'));
  let restored = removeHook(source);
  if (integration?.sourceHash) {
    const backup = await fs.readFile(path.join(session.runtime, 'install-backups', `${integration.sourceHash}-Main.lua`), 'utf8');
    const prefix = source.slice(0, source.indexOf('\n-- POB_HELPER_BEGIN'));
    const originalPrefix = backup.replace(/return main\s*$/, '');
    if (hash(backup) === integration.sourceHash && prefix === originalPrefix) restored = backup;
  }
  await atomicWrite(file, restored);
}
export function bootstrap(session) {
  if (session.direct) return managedBootstrap(path.relative(session.install, session.destination).replaceAll('\\', '/'));
  const config = { ...session, startScript: path.join(root, 'scripts/start-backend.ps1'), sessionFile: path.join(session.state || state, 'session.json') };
  const literal = value => JSON.stringify(value.replaceAll('\\', '/'));
  return `#@ SimpleGraphic
-- PoB Helper standalone entry point. Official PoB files remain untouched.
-- Session: ${session.id}
local originalPLoadModule = PLoadModule
PLoadModule = function(name, ...)
 if name ~= "Modules/Main" then return originalPLoadModule(name, ...) end
 local err, main = originalPLoadModule(name, ...)
 PLoadModule = originalPLoadModule
 if not err and main then
  local ok, failure = pcall(function()
   assert(type(main.Init) == "function" and type(main.OnFrame) == "function", "Unsupported PoB API")
   local config = require("dkjson").decode(${JSON.stringify(JSON.stringify(config))})
   local attach = assert(loadfile(${literal(path.join(root, 'addon/PobHelper.lua'))}))()
   attach(main, config)
  end)
  if not ok then ConPrintf("PoB Helper disabled: %s", tostring(failure)) end
 end
 return err, main
end
assert(loadfile(${literal(path.join(session.install, 'Launch.lua'))}))()
`;
}
// Root-level entry keeps GetScriptPath/PoB imports unchanged. All paths are
// resolved on this machine, so the installed folder contains no developer path.
export function managedBootstrap(relative = 'PoEAssistant') {
  return `#@ SimpleGraphic
-- PoE Assistant managed entry point. No official PoB files are changed.
local base = GetScriptPath():gsub('\\\\', '/'):gsub('/$', '')
local destination = base .. '/' .. ${JSON.stringify(relative)}
local json = require('dkjson')
local function read(path)
 local file = assert(io.open(path, 'rb')); local value = json.decode(file:read('*a')); file:close(); return assert(value)
end
local ok, failure = pcall(function()
 local current = read(destination .. '/current.json')
 assert(current.repository == 'arthurhpabreu/poe-assistant', 'Unexpected addon identity')
 assert(type(current.releaseName) == 'string' and current.releaseName:match('^[%w%.%-]+$'), 'Invalid addon release')
 local config = read(destination .. '/data/session.json')
 config.install = base; config.destination = destination
 config.root = destination .. '/releases/' .. current.releaseName
 config.state = destination .. '/data'; config.runtime = config.state .. '/sessions/' .. config.id
 config.node = config.root .. '/runtime/node.exe'; config.launcher = base .. '/PoEAssistant.lua'
 config.startScript = config.root .. '/scripts/start-backend.ps1'; config.sessionFile = config.state .. '/session.json'
 local stored = assert(io.open(config.sessionFile, 'wb')); stored:write(json.encode(config)); stored:close()
 local original = PLoadModule
 PLoadModule = function(name, ...)
  if name ~= 'Modules/Main' then return original(name, ...) end
  local err, main = original(name, ...); PLoadModule = original
  if not err and main then
   local attached, problem = pcall(function() assert(loadfile(config.root .. '/addon/PobHelper.lua'))()(main, config) end)
   if not attached then ConPrintf('PoE Assistant disabled: %s', tostring(problem)) end
  end
  return err, main
 end
end)
if not ok then ConPrintf('PoE Assistant could not start: %s. Run setup again to repair it.', tostring(failure)) end
assert(loadfile(base .. '/Launch.lua'))()
-- Normal Restart() retains this entry. Basic updates use a separate runtime;
-- redirect only the exact known update command to our own untracked wrapper.
local officialApply = launch.ApplyUpdate
launch.ApplyUpdate = function(self, mode)
 local originalSpawn = SpawnProcess
 SpawnProcess = function(target, arguments, ...)
  local expected = (GetRuntimePath() .. '/Update'):gsub('\\\\', '/'):lower()
  if target:gsub('\\\\', '/'):lower() == expected and arguments == 'UpdateApply.lua Update/opFileRuntime.txt' then
   arguments = 'PoEAssistantUpdate.lua Update/opFileRuntime.txt'
  end
  return originalSpawn(target, arguments, ...)
 end
 local result, problem = pcall(officialApply, self, mode)
 SpawnProcess = originalSpawn
 if not result then error(problem) end
end
`;
}
export function updateBootstrap(install) {
  const normal = JSON.stringify(path.join(install, 'Path of Building.exe').replaceAll('\\', '/'));
  const entry = JSON.stringify(path.join(install, 'PoEAssistant.lua').replaceAll('\\', '/'));
  return `#@
-- Delegates update operations to the current official implementation.
local operationFile = ...
local originalSpawn = SpawnProcess
local expected = (${normal}):lower()
SpawnProcess = function(target, arguments, ...)
 if target:gsub('\\\\', '/'):lower() == expected and not arguments then
  -- CompactHost passes this directly to CreateProcess: include argv[0].
  arguments = '"' .. target .. '" "' .. ${entry} .. '"'
 end
 return originalSpawn(target, arguments, ...)
end
-- The basic update runtime has no graphical GetScriptPath/LoadModule API.
assert(loadfile('UpdateApply.lua'))(operationFile)
SpawnProcess = originalSpawn
`;
}
async function shortcut(session, remove = false) {
  if (process.platform !== 'win32') return;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/shortcut.ps1'), '-Session', path.join(state, 'session.json'), ...(remove ? ['-Remove'] : [])], { windowsHide: true, shell: false });
    let output = '', error = '';
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { error += d; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output.trim()) : reject(Error(error)));
  });
}
async function install() {
  const sessionPath = path.join(state, 'session.json');
  const existing = await readJson(sessionPath);
  const argument = process.argv.indexOf('--pob');
  const installPath = argument >= 0 ? path.resolve(process.argv[argument + 1]) : existing?.install || path.join(process.env.APPDATA || '', 'Path of Building Community');
  const install = await fs.realpath(installPath);
  await fs.access(path.join(install, 'Path of Building.exe'));
  if (process.argv.includes('--uninstall')) {
    if (existing) {
      await restoreLegacyHook(existing);
      if (!existing.direct) await shortcut(existing, true);
      if (existing.launcher && !existing.direct) {
        const file = path.resolve(existing.launcher);
        if (path.dirname(file) !== install || !path.basename(file).startsWith('PobHelperLaunch-')) throw Error('Launcher is outside the expected destination.');
        const text = await fs.readFile(file, 'utf8').catch(() => '');
        if (text.includes(existing.id)) await fs.rm(file, { force: true });
      }
      if (existing.direct) {
        for (const name of ['PoEAssistant.lua', 'PoEAssistantUpdate.lua']) {
          const file = path.join(install, name);
          const text = await fs.readFile(file, 'utf8').catch(() => '');
          if (text.includes('PoE Assistant') || text.includes('Delegates update operations')) await fs.rm(file, { force: true });
        }
      }
      await atomicWrite(path.join(existing.runtime, 'uninstalled.json'), { time: Date.now() });
    }
    console.log('Addon launcher removed. Official files, data and backups were preserved.'); return;
  }
  const id = existing?.id || `pobhelper-${crypto.randomUUID()}`;
  const managedArg = process.argv.indexOf('--managed-destination');
  const direct = managedArg >= 0;
  const destination = direct ? path.resolve(process.argv[managedArg + 1]) : undefined;
  const session = { id, owner: 'poe-assistant', root, state, runtime: path.join(state, 'sessions', id), install, node: process.execPath, protocol: 1, direct, destination, installRelative: direct ? path.relative(destination, install) : undefined, launcher: path.join(install, direct ? 'PoEAssistant.lua' : `PobHelperLaunch-${id.slice(10, 18)}.lua`) };
  await fs.mkdir(path.join(session.runtime, 'inbox'), { recursive: true });
  if (!compatible(await fs.readFile(path.join(install, 'Modules/Main.lua'), 'utf8'))) throw Error('This PoB version is incompatible with the expected API.');
  await restoreLegacyHook(session);
  await atomicWrite(sessionPath, session);
  await fs.rm(path.join(session.runtime, 'uninstalled.json'), { force: true });
  await atomicWrite(session.launcher, bootstrap(session));
  if (direct) await atomicWrite(path.join(install, 'PoEAssistantUpdate.lua'), updateBootstrap(install));
  if (!direct && !process.argv.includes('--no-shortcut')) await shortcut(session);
  await atomicWrite(sessionPath, session);
  console.log(`PoE Assistant installed. Session ${id}\nPoB: ${install}\nOpen your usual Path of Building shortcut. F8 collapses the panel.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await install();
