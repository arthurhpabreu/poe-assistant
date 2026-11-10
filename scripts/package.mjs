import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWrite, hash } from '../src/files.mjs';
import { runProcess } from '../src/process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build the Windows x64 installer on Windows x64.');
const dist=path.join(root,'dist'), stage=path.join(dist,'staging-'+crypto.randomUUID());
await fs.mkdir(stage,{recursive:true});
for (const name of ['src','addon','scripts','docs','README.md','LICENSE','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','package.json','package-lock.json']) await fs.cp(path.join(root,name),path.join(stage,name),{recursive:true});
await fs.mkdir(path.join(stage,'node_modules','@xmldom'),{recursive:true});
await fs.cp(path.join(root,'node_modules','@xmldom','xmldom'),path.join(stage,'node_modules','@xmldom','xmldom'),{recursive:true});
await fs.mkdir(path.join(stage,'runtime'));
await fs.copyFile(process.execPath,path.join(stage,'runtime','node.exe'));
const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
if (!license.ok) throw Error('Could not obtain the bundled Node runtime license.');
await fs.writeFile(path.join(stage,'runtime','LICENSE-node.txt'),await license.text());
const compiler=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
await runProcess(compiler,['/nologo','/target:library',`/out:${path.join(stage,'runtime','WindowsShortcut.dll')}`,path.join(root,'scripts/WindowsShortcut.cs')],{cwd:root,timeoutMs:60000});
const entries=await fs.readdir(stage,{recursive:true,withFileTypes:true});
const files=[];
for(const entry of entries.filter(e=>e.isFile())) {
  const file=path.join(entry.parentPath,entry.name);
  files.push({path:path.relative(stage,file).replaceAll('\\','/'),sha256:hash(await fs.readFile(file))});
}
files.sort((a,b)=>a.path.localeCompare(b.path));
await atomicWrite(path.join(stage,'release-manifest.json'),{repository:'arthurhpabreu/poe-assistant',version:pkg.version,node:process.version,files});
const archive=path.join(dist,`poe-assistant-${pkg.version}-win-x64.zip`);
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/compress-package.ps1'),'-Source',stage,'-Destination',archive],{cwd:root,timeoutMs:180000});
const executable=path.join(dist,`PoE-Assistant-Setup-${pkg.version}.exe`);
await runProcess(compiler,['/nologo','/target:winexe','/platform:x64',`/out:${executable}`,`/resource:${archive},Payload.zip`,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',path.join(root,'scripts','Installer.cs')],{cwd:root,timeoutMs:180000});
await atomicWrite(path.join(dist,'SHA256SUMS.json'),{repository:'arthurhpabreu/poe-assistant',version:pkg.version,files:[archive,executable].map(file=>({name:path.basename(file),sha256:null}))});
const sums=JSON.parse(await fs.readFile(path.join(dist,'SHA256SUMS.json'),'utf8'));
for (const file of sums.files) file.sha256=hash(await fs.readFile(path.join(dist,file.name)));
await atomicWrite(path.join(dist,'SHA256SUMS.json'),sums);
// Delete only the unique staging directory created by this invocation.
if(path.dirname(stage) !== dist || !path.basename(stage).startsWith('staging-')) throw Error('Invalid staging cleanup path.');
await fs.rm(stage,{recursive:true,force:true});
console.log(JSON.stringify({version:pkg.version,installer:executable,archive,checksums:path.join(dist,'SHA256SUMS.json')}));
