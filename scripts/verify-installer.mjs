import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { atomicWrite,readJson,hash } from '../src/files.mjs';
import { runProcess } from '../src/process.mjs';
import { calculateBuild } from '../src/build-lab.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=process.argv.indexOf('--pob');
if(arg<0)throw Error('Use --pob with an isolated test PoB; this test changes only its own addon session.');
const pob=await fs.realpath(process.argv[arg+1]);
const dir=path.join(root,'.pob-helper','installer-check-'+crypto.randomUUID().slice(0,8));
await fs.mkdir(dir,{recursive:true});
try {
const source=path.join(dir,'source'),destination=path.join(pob,'PoEAssistant');
if (await readJson(path.join(destination,'current.json'))) throw Error('Use a fresh isolated PoB fixture, not an existing addon installation.');
const links=path.join(dir,'links'),legacy=path.join(dir,'legacy');
const selectedFolder=path.join(dir,'User shortcuts'),selectedShortcut=path.join(selectedFolder,'My usual PoB.lnk');
const nestedFolder=path.join(links,'Games'),nestedShortcut=path.join(nestedFolder,'Path of Building.lnk');
const legacyState=path.join(legacy,'data'),legacyRuntime=path.join(legacyState,'sessions','pobhelper-migration-fixture');
await fs.mkdir(path.join(legacyRuntime,'backups'),{recursive:true});await fs.mkdir(nestedFolder,{recursive:true});await fs.mkdir(selectedFolder);
await atomicWrite(path.join(legacyState,'session.json'),{id:'pobhelper-migration-fixture',install:pob,state:legacyState,runtime:legacyRuntime,root:legacy,node:process.execPath});
await atomicWrite(path.join(legacy,'current.json'),{repository:'arthurhpabreu/poe-assistant',session:path.join(legacyState,'session.json'),version:'0.2.2'});
await atomicWrite(path.join(legacyState,'settings.json'),{provider:'codex',custom:'preserve-test'});
await fs.writeFile(path.join(legacyRuntime,'backups','migration.xml'),'<test-backup/>');
await fs.writeFile(path.join(legacy,'Launch.ps1'),'# owned legacy fixture');
const literal=value=>"'"+value.replaceAll("'","''")+"'";
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',`. ${literal(path.join(root,'scripts/shortcut-api.ps1'))}; $link=[PoeAssistantShortcut]::Open(${literal(path.join(links,'Path of Building Community.lnk'))}); $link.TargetPath=${literal(path.join(pob,'Path of Building.exe'))}; $link.WorkingDirectory=${literal(pob)}; $link.Save(); $link=[PoeAssistantShortcut]::Open(${literal(path.join(links,'PoE Assistant abcdef12.lnk'))}); $link.TargetPath=Join-Path $PSHOME 'powershell.exe'; $link.Arguments='-NoProfile -File "'+${literal(path.join(legacy,'Launch.ps1'))}+'"'; $link.Save()`]);
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',`. ${literal(path.join(root,'scripts/shortcut-api.ps1'))}; foreach($file in @(${literal(selectedShortcut)},${literal(nestedShortcut)})) { $link=[PoeAssistantShortcut]::Open($file); try { $link.TargetPath=${literal(path.join(pob,'Path of Building.exe'))}; $link.Arguments='"'+${literal(path.join(pob,'Launch.lua'))}+'"'; $link.WorkingDirectory=${literal(pob)}; $link.Save() } finally { $link.Dispose() } }`]);
const version=(await readJson(path.join(root,'package.json'))).version;
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/extract-package.ps1'),'-Archive',path.join(root,'dist',`poe-assistant-${version}-win-x64.zip`),'-Destination',source]);
const deploy=()=>runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/deploy.ps1'),'-Source',source,'-Pob',pob,'-Destination',destination,'-ShortcutRoots',links],{timeoutMs:60000});
const exeDiagnostics=path.join(dir,'exe-diagnostics');await fs.mkdir(exeDiagnostics);
const installExe=exe=>runProcess(exe,['--silent','--pob',pob,'--shortcut',selectedShortcut,'--diagnostics',exeDiagnostics],{timeoutMs:90000});
await deploy(); const first=await readJson(path.join(destination,'current.json'));
const session=await readJson(first.session);
assert.equal(session.id,'pobhelper-migration-fixture');
assert.deepEqual(await readJson(path.join(session.state,'settings.json')),{provider:'codex',custom:'preserve-test'});
const proof=await readJson(path.join(destination,'native-verification.json'));
assert.equal(proof.stage,'ready');assert.equal(proof.release,first.releaseName);assert(proof.processId>0 && proof.nonce && proof.backendVerified);
assert((await readJson(path.join(session.state,'active-shortcuts.json'))).includes(nestedShortcut),'Nested shortcut was not integrated.');
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/verify-status-writes.ps1'),'-Pob',pob,'-ReleaseName',first.releaseName],{timeoutMs:25000});
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/verify-status-writes.ps1'),'-Pob',pob,'-ReleaseName',first.releaseName,'-Sustained'],{timeoutMs:25000});
// A healthy Node process is insufficient: a broken native addon must reject
// setup and restore the previous release/shortcut rather than claim success.
const addonFile=path.join(source,'addon/PobHelper.lua'),originalAddon=await fs.readFile(addonFile,'utf8');
const packageManifest=path.join(source,'release-manifest.json');
const originalManifest=await readJson(packageManifest);
await fs.writeFile(addonFile,'error("Deliberate native activation failure")\n');
const broken=structuredClone(originalManifest);broken.files.find(f=>f.path==='addon/PobHelper.lua').sha256=hash(await fs.readFile(addonFile));await atomicWrite(packageManifest,broken);
// Exercise the actual distribution entry point, including embedded extraction,
// stdout/stderr capture, durable error details and native failure rollback.
const brokenArchive=path.join(dir,'broken-native.zip'),brokenExe=path.join(dir,'broken-native.exe');
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/compress-package.ps1'),'-Source',source,'-Destination',brokenArchive],{timeoutMs:60000});
await runProcess(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/platform:x64',`/out:${brokenExe}`,`/resource:${brokenArchive},Payload.zip`,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll','/reference:System.Web.Extensions.dll',path.join(root,'scripts/Installer.cs'),path.join(root,'scripts/WindowsShortcut.cs')]);
await assert.rejects(installExe(brokenExe),/Deliberate native activation failure/);
const failedDiagnostic=path.join(exeDiagnostics,(await fs.readdir(exeDiagnostics))[0]);
assert.match((await readJson(path.join(failedDiagnostic,'failure.json'))).error,/Deliberate native activation failure/);
assert.match(await fs.readFile(path.join(failedDiagnostic,'setup.log'),'utf8'),/EVIDENCE Native probe/);
assert.equal(await readJson(path.join(failedDiagnostic,'success.json')),null);
assert.equal((await readJson(path.join(destination,'current.json'))).release,first.release);
await fs.writeFile(addonFile,originalAddon);await atomicWrite(packageManifest,originalManifest);
assert.equal(await fs.readFile(path.join(session.runtime,'backups','migration.xml'),'utf8'),'<test-backup/>');
assert.deepEqual((await fs.readdir(links)).sort(),['Games','Path of Building Community.lnk']);
await installExe(path.join(root,'dist',`PoE-Assistant-Setup-${version}.exe`)); const upgraded=await readJson(path.join(destination,'current.json'));
const successDirectories=(await fs.readdir(exeDiagnostics)).filter(name=>path.join(exeDiagnostics,name)!==failedDiagnostic);
assert.equal(successDirectories.length,1);
const receipt=await readJson(path.join(exeDiagnostics,successDirectories[0],'success.json'));
assert.equal(receipt.status,'success');assert.equal(receipt.version,version);assert.equal(receipt.release,upgraded.releaseName);
assert.equal(receipt.nonce,(await readJson(path.join(destination,'native-verification.json'))).nonce);
assert.equal(receipt.verifiedShortcut,selectedShortcut);
assert.equal((await readJson(path.join(destination,'native-verification.json'))).shortcut,selectedShortcut);
const shortcutProof=await readJson(path.join(session.state,'shortcut-verification.json'));
assert.equal(shortcutProof.selectedShortcut,selectedShortcut);assert.equal(shortcutProof.verifiedShortcut,selectedShortcut);
assert(shortcutProof.shortcuts.includes(nestedShortcut) && shortcutProof.shortcuts.includes(selectedShortcut));
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
assert.equal((await readJson(path.join(session.state,'shortcut-verification.json'))).release,upgraded.releaseName,'Failed activation replaced the prior shortcut proof.');
await atomicWrite(path.join(session.runtime,'shutdown.json'),{sessionId:session.id});
await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(rolledBack.release,'scripts/start-backend.ps1'),'-Session',first.session],{timeoutMs:20000});
assert.equal(await readJson(path.join(session.runtime,'shutdown.json')),null,'A deliberate stop prevented a future PoB launch.');
const reopened=await readJson(path.join(session.runtime,'heartbeat.json'));assert(reopened?.pid>0 && Date.now()-reopened.time<5000);
await atomicWrite(path.join(session.runtime,'shutdown.json'),{sessionId:session.id});
const xml='<PathOfBuilding><Build level="1" characterLevelAutoMode="false" targetVersion="3_0" className="Scion" ascendClassName="None"/><Tree activeSpec="1"><Spec treeVersion="3_29" classId="0" ascendClassId="0" nodes=""/></Tree><Items/><Skills/><Config/><Notes/></PathOfBuilding>';
const calculated=await calculateBuild({engine:pob,xml,dir:path.join(pob,'requests','installation-verification'),inspections:[{kind:'unique',query:'Blackheart',exact:true,details:true}]});
assert.equal(calculated.report.level,1);assert.equal(calculated.report.output.Life,60);assert.equal(calculated.report.validation.errors.length,0);
assert(calculated.inspections[0].results[0].itemText.includes('Blackheart'),'The real worker did not construct the current unique item.');
// A direct script caller without -Diagnostics must still see both causes when
// activation and restoration fail. The previous immutable fixture is repaired
// in finally, then its verified release is installed again through deployment.
const restoreScript=path.join(upgraded.release,'scripts/install.mjs'),restoreOriginal=await fs.readFile(restoreScript,'utf8');
await fs.writeFile(addonFile,originalAddon);await atomicWrite(manifestFile,manifest);
try {
  await fs.appendFile(restoreScript,'\nthrow Error("Deliberate rollback failure");\n');
  await assert.rejects(deploy(),error=>error.message.includes('Deliberate activation failure') && error.message.includes('Recovery incomplete'));
} finally { await fs.writeFile(restoreScript,restoreOriginal); }
const repair=()=>runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/deploy.ps1'),'-Source',upgraded.release,'-Pob',pob,'-Destination',destination,'-ShortcutRoots',links],{timeoutMs:90000});
const setSelectedArguments=args=>runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',`. ${literal(path.join(root,'scripts/shortcut-api.ps1'))}; $link=[PoeAssistantShortcut]::Open(${literal(selectedShortcut)}); try { $link.Arguments=${literal(args)}; $link.Save() } finally { $link.Dispose() }`]);
const beforeSelectedFailure=await readJson(path.join(destination,'current.json'));
try {
  await setSelectedArguments('"custom.lua"');
  await assert.rejects(repair(),/selected shortcut/i);
  assert.equal((await readJson(path.join(destination,'current.json'))).release,beforeSelectedFailure.release,'An unsupported remembered selection switched releases.');
} finally { await setSelectedArguments('"'+path.join(pob,'PoEAssistant.lua')+'"'); }
await repair();
const repaired=await readJson((await readJson(path.join(destination,'current.json'))).session);
assert.equal((await readJson(path.join(destination,'native-verification.json'))).shortcut,selectedShortcut,'Reinstall forgot the selected shortcut outside discovery roots.');
await atomicWrite(path.join(repaired.runtime,'shutdown.json'),{sessionId:repaired.id});
await atomicWrite(path.join(dir,'verified.json'),{initialInstall:true,nativeRenderConfirmed:true,nativeStatusReaderLockRecovered:true,nativeFailureRejected:true,packagedExeFailureDiagnostic:true,packagedExeSuccessReceipt:true,selectedShortcutNativeVerified:true,nestedShortcutIntegrated:true,selectedShortcutRetainedOnReinstall:true,unsupportedRememberedSelectionRejected:true,directRollbackFailureReported:true,legacyMigration:true,legacyShortcutsRemoved:true,reinstall:true,settingsPreserved:true,activationFailureRollback:true,restoredBackendHealthy:true,tamperingRejected:true,reopenAfterShutdown:true});
console.log('Installer deployment, legacy settings/backups migration, shortcut reuse/cleanup, reinstall, activation rollback, corruption rejection and reopening after shutdown passed.');
} catch(error) {
  // Only this invocation's named fixture records, never another running test's.
  const diagnostics=path.join(dir,'exe-diagnostics');
  for(const name of await fs.readdir(diagnostics).catch(()=>[])) {
    const file=path.join(diagnostics,name,'failure.json');
    const text=await fs.readFile(file,'utf8').catch(()=>null);
    if(text) console.error(text.slice(-65536));
  }
  throw error;
}
