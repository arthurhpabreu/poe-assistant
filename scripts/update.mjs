import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { latestRelease, newerVersion, repository } from '../src/updates.mjs';
import { hash, readJson } from '../src/files.mjs';
import { runProcess } from '../src/process.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=process.argv.indexOf('--destination');
if(arg<0 || !process.argv[arg+1]) throw Error('Specify the managed installation destination.');
const destination=await fs.realpath(process.argv[arg+1]);
const current=await readJson(path.join(destination,'current.json'));
if (current?.direct) {
  if (!/^[\w.-]+$/.test(current.releaseName || '')) throw Error('Invalid release directory.');
  current.release=path.join(destination,'releases',current.releaseName); current.session=path.join(destination,'data/session.json');
}
if(current?.repository!==repository || !current.session) throw Error('Unexpected managed installation.');
const latest=await latestRelease();
if(!newerVersion(latest.version,current.version)) { console.log(`PoE Assistant ${current.version} is up to date.`); process.exit(0); }
const session=await readJson(current.session);
const dir=path.join(destination,'data','updates',crypto.randomUUID());
await fs.mkdir(dir,{recursive:true});
const name=`poe-assistant-${latest.version}-win-x64.zip`;
try {
  try { await runProcess('gh.exe',['release','download',latest.tag,'--repo',repository,'--pattern',name,'--pattern','SHA256SUMS.json','--dir',dir],{cwd:dir,timeoutMs:180000}); }
  catch {
    for(const asset of [name,'SHA256SUMS.json']) {
      const response=await fetch(`https://github.com/${repository}/releases/download/${latest.tag}/${asset}`,{signal:AbortSignal.timeout(180000)});
      if(!response.ok) throw Error('Release download failed. Check repository access; no version was changed.');
      const handle=await fs.open(path.join(dir,asset),'w'); let size=0;
      try { for await(const chunk of response.body) { size+=chunk.length; if(size>300000000) throw Error('Release asset exceeds size limit.'); await handle.write(chunk); } } finally { await handle.close(); }
    }
  }
  const sums=await readJson(path.join(dir,'SHA256SUMS.json'));
  const expected=sums?.files?.find(file=>file.name===name)?.sha256;
  if(sums?.repository!==repository || sums.version!==latest.version || !/^[a-f0-9]{64}$/.test(expected || '') || hash(await fs.readFile(path.join(dir,name)))!==expected) throw Error('Release checksum/identity mismatch. No version was changed.');
  const extracted=path.join(dir,'package');
  await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/extract-package.ps1'),'-Archive',path.join(dir,name),'-Destination',extracted],{cwd:dir,timeoutMs:180000});
  await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/deploy.ps1'),'-Source',extracted,'-Pob',session.install,'-Destination',destination],{cwd:dir,timeoutMs:180000});
  console.log(`Updated to PoE Assistant ${latest.version}. Open your usual Path of Building shortcut.`);
} finally {
  if(path.dirname(dir)!==path.join(destination,'data','updates')) throw Error('Invalid update cleanup path.');
  await fs.rm(dir,{recursive:true,force:true});
}
