import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../src/process.mjs';
import { readJson } from '../src/files.mjs';

test('real setup EXE preserves partial errors with retained pipes and requires an invocation receipt', { skip: process.platform !== 'win32' }, async t => {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pa-setup-envelope-')));
  const source=path.join(dir,'source'),scripts=path.join(source,'scripts'),logs=path.join(dir,'diagnostics');
  await fs.mkdir(scripts,{recursive:true}); await fs.mkdir(logs);
  const literal=value=>"'"+value.replaceAll("'","''")+"'";
  let holderPid;
  try {
    for(const name of ['setup-entry.ps1','setup-diagnostics.ps1']) await fs.copyFile(path.resolve('scripts',name),path.join(scripts,name));
    await fs.writeFile(path.join(source,'package.json'),JSON.stringify({version:'0.0.0'}));
    await fs.writeFile(path.join(scripts,'holder.mjs'),`import fs from 'node:fs'; fs.writeFileSync(process.argv[2],String(process.pid)); setTimeout(()=>{},20000);`);
    await fs.writeFile(path.join(scripts,'deploy.ps1'),`
param($Source,$Pob,$Destination,$Diagnostics,$Invocation,[switch]$NoShortcut,$Shortcut)
Write-SetupPhase 'Fixture deployment'
switch (Split-Path -Leaf $Pob) {
  'holding-pipes' {
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=${literal(process.execPath)}
    $start.Arguments='"'+(Join-Path $PSScriptRoot 'holder.mjs')+'" "'+(Join-Path $Diagnostics 'holder.pid')+'"'
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $null=[Diagnostics.Process]::Start($start)
    for($i=0;$i -lt 100 -and -not (Test-Path -LiteralPath (Join-Path $Diagnostics 'holder.pid'));$i++) { Start-Sleep -Milliseconds 20 }
    [Console]::Error.Write('Unique partial error without newline')
    [Environment]::Exit(19)
  }
  'exit-zero' { [Environment]::Exit(0) }
  'primary-and-rollback' {
    try { throw 'Original activation failed' } catch {
      $primary=$_; Save-SetupFailure $primary
      try { throw 'Independent rollback failed' } catch { Save-SetupCleanupFailure $_ }
      throw $primary
    }
  }
  default {
    $receipt=@{status='success';invocation=$Invocation;version='0.0.0';pob=$Pob;destination=$Destination;release='fixture';nonce='fresh-fixture';verifiedShortcut=(Join-Path $Pob 'Verified.lnk')}
    if ((Split-Path -Leaf $Pob) -eq 'wrong-receipt') { $receipt.invocation='another-invocation' }
    if ((Split-Path -Leaf $Pob) -eq 'missing-shortcut-receipt') { $receipt.Remove('verifiedShortcut') }
    [IO.File]::WriteAllText((Join-Path $Diagnostics 'success.json'),($receipt|ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  }
}
`);
    const archive=path.join(dir,'payload.zip'),exe=path.join(dir,'Setup.exe');
    await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('scripts/compress-package.ps1'),'-Source',source,'-Destination',archive]);
    await runProcess(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/platform:x64',`/out:${exe}`,`/resource:${archive},Payload.zip`,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll','/reference:System.Web.Extensions.dll',path.resolve('scripts/Installer.cs'),path.resolve('scripts/WindowsShortcut.cs')]);
    for(const mode of ['holding-pipes','exit-zero','wrong-receipt','missing-shortcut-receipt','wrong-shortcut-receipt','primary-and-rollback','success']) await t.test(mode,async()=>{
      const pob=path.join(dir,mode);await fs.mkdir(pob);await fs.writeFile(path.join(pob,'Path of Building.exe'),'owned fixture');
      const before=await fs.readdir(logs),started=Date.now();
      const selection=mode==='wrong-shortcut-receipt' ? ['--shortcut',path.join(pob,'Chosen.lnk')] : [];
      const operation=runProcess(exe,['--silent','--pob',pob,'--diagnostics',logs,...selection],{timeoutMs:10000});
      if(mode==='success') await operation;else await assert.rejects(operation);
      const added=(await fs.readdir(logs)).filter(name=>!before.includes(name));assert.equal(added.length,1);
      const diagnostic=path.join(logs,added[0]);
      const log=await fs.readFile(path.join(diagnostic,'setup.log'),'utf8');
      assert(log.includes('Invocation:') && log.includes(path.basename(dir)) && log.includes(mode),log.slice(-4000));
      if(mode==='holding-pipes') {
        holderPid=Number(await fs.readFile(path.join(diagnostic,'holder.pid'),'utf8'));
        assert(log.includes('Unique partial error without newline'),log);
        assert(log.includes('PowerShell exit: 19'),log);
        assert(log.includes('stderr EOF: False'),log);
        assert(Date.now()-started<8000,'Installer waited for a detached descendant EOF');
        process.kill(holderPid);holderPid=null;
      } else if(mode==='exit-zero') assert(log.includes('No verified installation receipt'),log);
      else if(mode==='wrong-receipt') assert(log.includes('does not match this setup invocation'),log);
      else if(mode==='missing-shortcut-receipt') assert(log.includes('did not identify a verified PoB shortcut'),log);
      else if(mode==='wrong-shortcut-receipt') assert(log.includes('did not verify the selected PoB shortcut'),log);
      else if(mode==='primary-and-rollback') {
        const failure=await readJson(path.join(diagnostic,'failure.json'));
        assert.equal(failure.error,'Original activation failed');assert.equal(failure.phase,'Fixture deployment');
        assert(failure.position && failure.stack);
        assert(log.includes('Independent rollback failed'));
      } else assert.equal((await readJson(path.join(diagnostic,'success.json'))).status,'success');
    });
  } finally {
    if(holderPid) try { process.kill(holderPid); } catch { }
    assert(path.basename(dir).startsWith('pa-setup-envelope-'));await fs.rm(dir,{recursive:true,force:true});
  }
});
