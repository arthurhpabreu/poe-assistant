import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { evaluateBuilds, calculateBuild } from '../src/build-lab.mjs';
import { atomicWrite, hash } from '../src/files.mjs';

const install = process.env.POB_INSTALL || path.join(process.env.APPDATA, 'Path of Building Community');
const dir = path.resolve('.pob-helper/lab-verification');
const xml = '<PathOfBuilding><Build level="90" targetVersion="3_0" className="Witch" ascendClassName="None" mainSocketGroup="1"/><Tree activeSpec="1"><Spec treeVersion="3_29" classId="3" ascendClassId="0" nodes=""/></Tree><Items/><Skills><Skill enabled="true" slot="Weapon 1" mainActiveSkill="1"><Gem nameSpec="Arc" level="20" quality="20" enabled="true"/></Skill></Skills><Config/><Notes/></PathOfBuilding>';
const official = ['Modules/Main.lua','Launch.lua','manifest.xml','SimpleGraphic/SimpleGraphic.cfg','imgui.ini'];
async function fingerprints() { return Promise.all(official.map(async name => [name, await fs.readFile(path.join(install,name)).then(hash).catch(() => null)])); }
const before = await fingerprints();
const result = await evaluateBuilds({ install, dir, snapshot: { xml }, args: { objective: 'TotalDPS', candidates: [
  { label: 'Level 21 Arc', operations: [{ type: 'set_attribute', path: 'PathOfBuilding/Skills/Skill/Gem/@level', value: '21' }] },
  { label: 'Controlled Destruction', operations: [{ type: 'append_xml', path: 'PathOfBuilding/Skills/Skill', value: '<Gem nameSpec="Controlled Destruction" level="20" quality="20" enabled="true"/>' }] },
] }, progress: console.log });
const engine = path.join(dir,'engine-cache',result.fingerprint.slice(0,16));
const autoLevel=await calculateBuild({engine,xml:xml.replace('<Build ','<Build characterLevelAutoMode="true" '),dir:path.join(dir,'auto-level')});
assert.equal(autoLevel.report.level,1);
assert.equal(autoLevel.report.output.Life,60,'Automatic level settlement left stale calculator values.');
assert(autoLevel.report.validation.errors.some(error=>error.includes('automatic level')));
const inspection = await calculateBuild({engine,xml,dir:path.join(dir,'catalog'),inspections:[{kind:'skill',query:'Arc',exact:true,details:true},{kind:'unique',query:'Blackheart',exact:true,details:true},{kind:'unique',query:'Mjölner',exact:true,details:true}]});
assert(inspection.inspections[0].results[0].details.description);
assert(inspection.inspections[1].results[0].itemText.includes('Blackheart'));
assert(!inspection.inspections[1].results[0].itemText.includes('Selected Version:'),'Legacy version selectors were exposed.');
const uniqueText=inspection.inspections[1].results[0].itemText;
const equipped=xml.replace('<Items/>','<Items><Item id="1">'+uniqueText.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</Item><ItemSet id="1"><Slot name="Ring 1" itemId="1"/></ItemSet></Items>');
const realUnique=await calculateBuild({engine,xml:equipped,dir:path.join(dir,'unique-valid')});
assert.equal(realUnique.report.items.find(i=>i.name==='Blackheart').currentUniqueVerified,true);
const fake=equipped.replace('</Item>','\n+9999 to maximum Life</Item>');
const fakeUnique=await calculateBuild({engine,xml:fake,dir:path.join(dir,'unique-fake')});
assert(fakeUnique.report.validation.errors.some(error=>error.includes('Unique modifier')),'Fabricated unique mods were not rejected.');
const badRoll=await calculateBuild({engine,xml:equipped.replace('{range:0.5}','{range:999}'),dir:path.join(dir,'unique-bad-roll')});
assert(badRoll.report.validation.errors.some(error=>error.includes('roll range')),'Impossible roll metadata was not rejected.');
assert.deepEqual(await fingerprints(), before, 'The installed PoB was modified by the calculator worker.');
assert(Number.isFinite(result.base.output.Life));
assert(result.base.output.TotalDPS > 0, 'Arc was not resolved by the real calculator.');
assert(result.candidates.every(c => !c.error && c.report.output.TotalDPS > result.base.output.TotalDPS), 'Candidates did not calculate higher real DPS.');
await atomicWrite(path.join(dir,'verified.json'), result);
console.log(JSON.stringify({ baseDps: result.base.output.TotalDPS, candidates: result.candidates.map(c => ({ label: c.label, dps: c.report.output.TotalDPS, delta: c.delta.TotalDPS, warnings: c.report.warnings })), officialFilesPreserved: true, currentUniqueVerified:true, fabricatedUniqueRejected:true, catalogs:inspection.inspections.map(c=>({kind:c.kind,query:c.query,total:c.total})) }));
