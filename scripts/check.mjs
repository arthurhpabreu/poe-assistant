import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../src/process.mjs';
for (const folder of ['src','scripts']) for(const file of await fs.readdir(folder)) {
  if(file.endsWith('.mjs')) await runProcess(process.execPath,['--check',path.resolve(folder,file)]);
}
if(process.platform === 'win32') await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('scripts/check-powershell.ps1')]);
console.log('JavaScript and PowerShell syntax checks passed.');
