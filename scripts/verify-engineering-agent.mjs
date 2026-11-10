import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { atomicWrite,readJson } from '../src/files.mjs';
const arg=process.argv.indexOf('--session');
if(arg<0)throw Error('Specify an isolated test --session file.');
const session=await readJson(process.argv[arg+1]);
let snapshot;
for(const deadline=Date.now()+30000;Date.now()<deadline;){
  snapshot=await readJson(path.join(session.runtime,'snapshot.json'));
  if(snapshot?.xml&&snapshot.mode==='BUILD'&&Date.now()-snapshot.timestamp<10000)break;
  await new Promise(resolve=>setTimeout(resolve,250));
}
if(!snapshot?.xml || snapshot.fileName || snapshot.level!==1)throw Error('Use a fresh unsaved level-1 test build.');
const id=crypto.randomUUID();
await atomicWrite(path.join(session.runtime,'inbox',id+'.json'),{protocol:1,sessionId:session.id,id,type:'chat',buildKey:snapshot.buildKey,createdAt:Date.now(),text:'Teste de integração: use read_build, catalog da skill Arc com detalhes, catalog do único Blackheart atual com detalhes e inspect_calcs. Depois compare com evaluate_build duas candidatas completas: defina characterLevelAutoMode=false e mude o nível da build para 2 e para 3 respectivamente; objective Life. Preserve o restante. Proponha a candidata com maior Life usando exatamente as operações medidas. Explique os valores reais. Não aplique, não salve, não pesquise na web, não use ferramentas nativas de shell. Isto é um smoke test do protocolo, não uma build de jogo.'});
let ui;
for(const deadline=Date.now()+600000;Date.now()<deadline;){
  ui=await readJson(path.join(session.runtime,'ui.json'));
  if(ui?.lastCompletedRequest===id&&!ui.busy)break;
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert(ui?.proposal?.validation,'The agent did not return an actually measured proposal: '+JSON.stringify(ui?.messages?.slice(-2)));
assert.equal(ui.proposal.validation.report.level,3);
assert.equal((await readJson(path.join(session.runtime,'snapshot.json'))).level,1,'The smoke test mutated the open build.');
console.log(JSON.stringify({measuredLevel:ui.proposal.validation.report.level,life:ui.proposal.validation.report.output.Life,answer:ui.messages.filter(m=>m.role==='assistant').at(-1)?.text,applied:false}));
