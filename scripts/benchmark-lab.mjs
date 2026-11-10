import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { evaluateBuilds } from '../src/build-lab.mjs';
import { atomicWrite } from '../src/files.mjs';

// Synthetic fixture only: never reads or changes a user's open/saved build.
const label = process.argv[process.argv.indexOf('--label') + 1] || 'benchmark';
if (!/^[a-z0-9-]+$/i.test(label)) throw Error('Invalid benchmark label.');
const install = process.env.POB_INSTALL || path.join(process.env.APPDATA, 'Path of Building Community');
const state = path.join(process.env.LOCALAPPDATA, 'PoE Assistant', 'benchmarks', crypto.randomUUID().slice(0,8));
const dir = path.join(state, 'benchmarks', label);
const cacheDir = path.join(state, 'benchmark-engines');
const xml = '<PathOfBuilding><Build level="90" characterLevelAutoMode="false" targetVersion="3_0" className="Witch" ascendClassName="None" mainSocketGroup="1"/><Tree activeSpec="1"><Spec treeVersion="3_29" classId="3" ascendClassId="0" nodes=""/></Tree><Items activeItemSet="1"><Item id="1">Rarity: RARE\nBenchmark amulet\nLapis Amulet\nImplicits: 0\n+200 to Intelligence</Item><ItemSet id="1"><Slot name="Amulet" itemId="1"/></ItemSet></Items><Skills><Skill enabled="true" slot="Weapon 1" mainActiveSkill="1"><Gem nameSpec="Arc" level="20" quality="20" enabled="true"/></Skill></Skills><Config/><Notes/></PathOfBuilding>';
const args = { objective: 'TotalDPS', candidates: [
  { label: 'Arc 21', operations: [{ type: 'set_attribute', path: 'PathOfBuilding/Skills/Skill/Gem/@level', value: '21' }] },
  { label: 'Controlled Destruction', operations: [{ type: 'append_xml', path: 'PathOfBuilding/Skills/Skill', value: '<Gem nameSpec="Controlled Destruction" level="20" quality="20" enabled="true"/>' }] },
] };
const evaluationCache = new Map(), runs = [];
for (let pass = 0; pass < 2; pass++) {
  const start = performance.now();
  const result = await evaluateBuilds({ install, dir, snapshot: { xml }, args, cacheDir, evaluationCache: process.argv.includes('--no-cache') ? new Map() : evaluationCache });
  assert.equal(result.base.validation.errors.length, 0, 'The benchmark baseline must pass validation.');
  assert(result.candidates.every(candidate => candidate.feasible), 'Benchmark candidates must pass validation.');
  assert(result.candidates.every(candidate => !candidate.error && candidate.report.output.TotalDPS > result.base.output.TotalDPS));
  const run = { pass, ms: Math.round(performance.now() - start), timings: result.timings, baseline: result.base.output.TotalDPS, candidates: result.candidates.map(candidate => ({ label: candidate.label, dps: candidate.report.output.TotalDPS })) };
  runs.push(run); console.log(JSON.stringify(run));
}
assert.deepEqual(runs[0].candidates, runs[1].candidates);
await fs.mkdir(dir, { recursive: true });
await atomicWrite(path.join(dir, 'benchmark.json'), { label, runs });
