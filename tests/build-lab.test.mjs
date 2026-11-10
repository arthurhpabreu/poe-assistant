import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fengari from 'fengari';
import { calculationHash, rankCandidates, prepareEngine, validateLoadedBuild } from '../src/build-lab.mjs';
import { hash } from '../src/files.mjs';
import { applyOperations } from '../src/xml.mjs';
import { chat } from '../src/agent.mjs';
import { leagueWindow, assertLeagueBuild, sourceLeague } from '../src/league-policy.mjs';
import { newerVersion } from '../src/updates.mjs';
import { runProcess } from '../src/process.mjs';

const xml='<PathOfBuilding><Build targetVersion="3_0" level="90"/><Tree><Spec treeVersion="3_29"/></Tree><Notes>Keep</Notes></PathOfBuilding>';
const policy=leagueWindow('treeVersionList={"3_27","3_28","3_28_ruthless","3_29"}');
test('league window rejects legacy trees and guides, allows current and previous only',()=>{
  assert.deepEqual(policy.allowed,['3_29','3_28']);
  assert.doesNotThrow(()=>assertLeagueBuild(xml,policy));
  assert.doesNotThrow(()=>assertLeagueBuild(xml.replace('3_29','3_28'),policy));
  assert.throws(()=>assertLeagueBuild(xml.replace('3_29','3_27'),policy),/Legacy/);
  assert.throws(()=>sourceLeague('[3.27] Arc build',policy),/Legacy/);
  assert.throws(()=>sourceLeague('Arc build guide',policy),/explicitly/);
  assert(sourceLeague('[3.29] Arc build',policy).allowed);
  assert.throws(()=>leagueWindow('bad'),/Cannot identify/);
  assert.throws(()=>leagueWindow('treeVersionList={"3_28","3_29","3_30"}',{now:Date.parse('2026-11-13T00:00:00Z')}),/expired/);
  assert.deepEqual(leagueWindow('treeVersionList={"3_28","3_29","3_30"}').allowed,['3_29','3_28'],'An unreleased preview changed the allowed leagues.');
});
test('a detached managed backend cannot hold its exited launcher pipe open forever',async()=>{
  let descendant;
  try {
    const start=Date.now();
    const source='const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:["ignore",1,2]});console.log(c.pid);c.unref();';
    const output=await runProcess(process.execPath,['-e',source],{timeoutMs:6000,onLine:line=>{descendant=Number(line);}});
    assert(descendant>0);assert(output.includes(String(descendant)));assert(Date.now()-start<5000);
  }finally{if(descendant)try{process.kill(descendant);}catch{}}
});
test('notes-only exemption cannot hide changed calculations in a replace_build',()=>{
  assert.equal(calculationHash(xml),calculationHash(xml.replace('Keep','Changed')));
  assert.notEqual(calculationHash(xml),calculationHash(xml.replace('level="90"','level="100"')));
  assert(validateLoadedBuild(xml,xml,{level:1}).some(error=>error.includes('automatic level')));
});
test('ranking excludes broken/missing defense constraints and does not treat a missing objective as zero',()=>{
  const results=rankCandidates({output:{TotalDPS:100,Life:4000}},[
    {label:'glass',report:{output:{TotalDPS:300,Life:1000}}},
    {label:'usable',report:{output:{TotalDPS:200,Life:4200}}},
    {label:'unknown',report:{output:{TotalDPS:500}}},
    {label:'broken',report:{output:{TotalDPS:600,Life:5000},validation:{errors:['Disconnected']}}},
    {label:'missingDps',report:{output:{Life:4500}}},
  ],{objective:'TotalDPS',minimums:{Life:4000}});
  assert.equal(results[0].label,'usable'); assert.equal(results[0].delta.TotalDPS,100);
  assert.equal(results.find(r=>r.label==='broken').feasible,false);
  assert.equal(results.find(r=>r.label==='unknown').feasible,false);
  assert.equal(results.find(r=>r.label==='missingDps').score,null);
});
test('full candidate validation is exact, engine-bound and shown to the model before acceptance',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'poe-lab-agent-')); let evaluations=0,calls=0;
  const op={type:'set_attribute',path:'PathOfBuilding/Build/@level',value:'91'};
  try {
    await fs.writeFile(path.join(dir,'manifest.xml'),'<PoBVersion><Version number="test"/></PoBVersion>');
    await fs.writeFile(path.join(dir,'GameVersions.lua'),'treeVersionList={"3_28","3_29"}');
    const result=await chat({text:'optimize',history:[],snapshot:{xml},settings:{research:false},install:dir,dir,progress(){},
      evaluateCandidates:async({snapshot,version,args})=>{evaluations++; assert.deepEqual(args.operations,[op]); return {baseHash:hash(snapshot.xml),fingerprint:version.fingerprint,base:{output:{Life:100}},candidates:[{xmlHash:hash(applyOperations(xml,[op])),report:{output:{Life:110},validation:{errors:[]}},feasible:true}]};},
      invoke:async({prompt})=>{ calls++;
        if(calls===1)return {message:'',tools:[{name:'read_build',arguments:'{}'}],operations:[]};
        if(calls===3) assert(prompt.includes('"Life":110'));
        return {message:'Measured',tools:[],operations:[op],sources:[]};
      }});
    assert.equal(evaluations,1); assert.equal(calls,3); assert(result.validation);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('isolated engine copy never includes personal settings even if a manifest lists them',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'poe-engine-'));
  try{
    const install=path.join(dir,'pob'); await fs.mkdir(install);
    const manifest='<PoBVersion><Version number="test"/><File name="GameVersions.lua"/><File name="Path{space}of{space}Building.exe"/><File name="Settings.xml"/><File name="SimpleGraphic.cfg"/><File name="../outside.dll"/></PoBVersion>';
    await fs.writeFile(path.join(install,'manifest.xml'),manifest); await fs.writeFile(path.join(install,'GameVersions.lua'),'treeVersionList={"3_28","3_29"}');
    await fs.writeFile(path.join(install,'Path of Building.exe'),'fixture'); await fs.writeFile(path.join(install,'Settings.xml'),'private'); await fs.writeFile(path.join(install,'SimpleGraphic.cfg'),'personal');
    const {installationVersion}=await import('../src/knowledge.mjs');const version=await installationVersion(install);
    const engine=await prepareEngine(install,path.join(dir,'engines'),version);
    assert.equal(await fs.readFile(path.join(engine,'Path of Building.exe'),'utf8'),'fixture');
    await assert.rejects(fs.access(path.join(engine,'Settings.xml')));await assert.rejects(fs.access(path.join(engine,'SimpleGraphic.cfg')));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('build lab Lua parses and release version ordering rejects malformed metadata',async()=>{
  const source=await fs.readFile('addon/BuildLab.lua','utf8');const L=fengari.lauxlib.luaL_newstate();
  const code=fengari.lauxlib.luaL_loadstring(L,fengari.to_luastring(source));assert.equal(code,0,code?fengari.to_jsstring(fengari.lua.lua_tostring(L,-1)):'');fengari.lua.lua_close(L);
  assert(newerVersion('0.3.0','0.2.9'));assert(!newerVersion('0.2.0','0.2.0'));assert(!newerVersion('0.1.9','0.2.0'));assert.throws(()=>newerVersion('../bad','0.2.0'));
});
