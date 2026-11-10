import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { atomicWrite,readJson,hash } from '../src/files.mjs';
import { runProcess } from '../src/process.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=process.argv.indexOf('--pob');
if(arg<0)throw Error('Use --pob with an isolated test PoB; this test changes only its own addon session.');
const pob=await fs.realpath(process.argv[arg+1]);
const dir=path.join(root,'.pob-helper','installer-check-'+crypto.randomUUID().slice(0,8));
await fs.mkdir(dir,{recursive:true});
const source=path.join(dir,'source'),destination=path.join(dir,'app');
const version=(await readJson(path.join(root,'package.json'))).version;
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/extract-package.ps1'),'-Archive',path.join(root,'dist',`poe-assistant-${version}-win-x64.zip`),'-Destination',source]);
const deploy=()=>runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/deploy.ps1'),'-Source',source,'-Pob',pob,'-Destination',destination,'-NoShortcut'],{timeoutMs:60000});
await deploy(); const first=await readJson(path.join(destination,'current.json'));
const session=await readJson(first.session);await atomicWrite(path.join(session.state,'settings.json'),{provider:'codex',custom:'preserve-test'});
await deploy(); const upgraded=await readJson(path.join(destination,'current.json'));
assert.equal(upgraded.previous,first.release);assert.notEqual(upgraded.release,first.release);
assert.deepEqual(await readJson(path.join(session.state,'settings.json')),{provider:'codex',custom:'preserve-test'});
// Simulate a trusted release whose health check fails after activation.
const startup=path.join(source,'scripts/start-backend.ps1');await fs.appendFile(startup,'\nthrow "Deliberate activation failure"\n');
const manifestFile=path.join(source,'release-manifest.json'),manifest=await readJson(manifestFile);
manifest.files.find(f=>f.path==='scripts/start-backend.ps1').sha256=hash(await fs.readFile(startup));await atomicWrite(manifestFile,manifest);
await assert.rejects(deploy(),/Deliberate activation failure/);
const rolledBack=await readJson(path.join(destination,'current.json'));assert.equal(rolledBack.release,upgraded.release);
assert.equal(await readJson(path.join(session.runtime,'shutdown.json')),null);
const beat=await readJson(path.join(session.runtime,'heartbeat.json'));assert(beat?.pid>0 && Date.now()-beat.time<5000);
// Corruption must fail before switching any installed code.
await fs.appendFile(path.join(source,'addon/PobHelper.lua'),'\n-- tampered\n');await assert.rejects(deploy(),/checksum failed/);
assert.equal((await readJson(path.join(destination,'current.json'))).release,upgraded.release);
await atomicWrite(path.join(session.runtime,'shutdown.json'),{sessionId:session.id});
await atomicWrite(path.join(dir,'verified.json'),{initialInstall:true,reinstall:true,settingsPreserved:true,activationFailureRollback:true,restoredBackendHealthy:true,tamperingRejected:true});
console.log('Installer deployment, reinstall, state preservation, failed-activation rollback, backend restart and corruption rejection passed.');
