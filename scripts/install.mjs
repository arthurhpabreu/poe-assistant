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
      if (existing.launcher) {
        const file = path.resolve(existing.launcher);
        if (path.dirname(file) !== install || !path.basename(file).startsWith('PobHelperLaunch-')) throw Error('Launcher is outside the expected destination.');
        const text = await fs.readFile(file, 'utf8').catch(() => '');
        if (text.includes(existing.id)) await fs.rm(file, { force: true });
      }
      await shortcut(existing, true);
      await atomicWrite(path.join(existing.runtime, 'uninstalled.json'), { time: Date.now() });
    }
    console.log('Addon launcher removed. Official files, data and backups were preserved.'); return;
  }
  const id = existing?.id || `pobhelper-${crypto.randomUUID()}`;
  const session = { id, owner: 'poe-assistant', root, state, runtime: path.join(state, 'sessions', id), install, node: process.execPath, protocol: 1, launcher: path.join(install, `PobHelperLaunch-${id.slice(10, 18)}.lua`) };
  await fs.mkdir(path.join(session.runtime, 'inbox'), { recursive: true });
  if (!compatible(await fs.readFile(path.join(install, 'Modules/Main.lua'), 'utf8'))) throw Error('This PoB version is incompatible with the expected API.');
  await restoreLegacyHook(session);
  await atomicWrite(sessionPath, session);
  await fs.rm(path.join(session.runtime, 'uninstalled.json'), { force: true });
  await atomicWrite(session.launcher, bootstrap(session));
  session.shortcut = process.argv.includes('--no-shortcut') ? existing?.shortcut : await shortcut(session);
  await atomicWrite(sessionPath, session);
  console.log(`PoB Helper installed without changing official sources. Session ${id}\nPoB: ${install}\nShortcut: ${session.shortcut}\nOpen the PoB Helper shortcut or scripts\\launch.ps1. F8 collapses the panel.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await install();
