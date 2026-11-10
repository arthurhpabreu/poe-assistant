// Integration verification against an already open PoB; no model or mock calculator.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, readJson, hash } from '../src/files.mjs';
import { applyOperations, parseBuild } from '../src/xml.mjs';

const session = await readJson('.pob-helper/session.json');
if (!session) throw Error('Addon is not installed.');
const snapshotFile = path.join(session.runtime, 'snapshot.json');
async function command(name, args, expected = null) {
  expected ||= await readJson(snapshotFile);
  if (!expected?.xml || Date.now() - expected.timestamp > 10_000) throw Error('Open a build in PoB.');
  const id = crypto.randomUUID();
  await atomicWrite(path.join(session.runtime, 'command.json'), { protocol: 1, sessionId: session.id, id, name, args, expectedXml: expected.xml, expectedBuildKey: expected.buildKey, deadline: Date.now() + 25_000 });
  try {
    for (let i = 0; i < 250; i++) {
      const ack = await readJson(path.join(session.runtime, 'ack.json'));
      if (ack?.id === id) { if (ack.error) throw Error(ack.error); return ack.result; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('PoB timed out.');
  } finally { await fs.rm(path.join(session.runtime, 'command.json'), { force: true }); }
}
const original = await readJson(snapshotFile);
const tree = await command('tree', { query: 'life', limit: 5 });
if (!tree.nodes.length) throw Error('No passive nodes were returned.');
const node = tree.nodes.find(node => node.type !== 'Mastery');
const evaluation = await command('evaluate', { addNodes: [node.id] });
if (!Number.isFinite(evaluation.base.Life) || !Number.isFinite(evaluation.candidate.Life)) throw Error('Calculator did not return Life.');
console.log(JSON.stringify({ tree: tree.treeVersion, node: node.id, name: node.name, baseLife: evaluation.base.Life, candidateLife: evaluation.candidate.Life, source: 'real PoB calculator' }));
const item = await command('evaluate', { slot: 'Ring 1', itemText: 'Rarity: Rare\nHelper Verification\nCoral Ring\nItem Level: 80\n+30 to maximum Life\n+40 to maximum Life' });
console.log(JSON.stringify({ itemBaseLife: item.base.Life, itemCandidateLife: item.candidate.Life }));
if (process.argv.includes('--mutations')) {
  const live = await readJson(snapshotFile);
  const originalNotes = parseBuild(live.xml).getElementsByTagName('Notes')[0]?.textContent.trim();
  await atomicWrite(path.join(session.runtime, 'verification', 'before.xml'), live.xml);
  const xml = applyOperations(live.xml, [{ type: 'set_text', path: 'PathOfBuilding/Notes', value: 'PoB Helper integration verification' }]);
  try {
    await command('apply', { xml }, live);
    const after = await readJson(snapshotFile);
    if (parseBuild(after.xml).getElementsByTagName('Notes')[0]?.textContent.trim() !== 'PoB Helper integration verification') throw Error('Note was not applied.');
    // Stale proposals must fail even though the build name did not change.
    let rejected = false; try { await command('apply', { xml }, live); } catch (e) { rejected = /changed/.test(e.message); }
    if (!rejected) throw Error('Stale proposal was not rejected.');
    await command('apply', { xml: live.xml });
    const restored = await readJson(snapshotFile);
    if (parseBuild(restored.xml).getElementsByTagName('Notes')[0]?.textContent.trim() !== originalNotes) throw Error('Note was not restored.');
    console.log('Apply, stale rejection and restore: passed. Original file was not saved.');
    await atomicWrite(path.join(session.runtime, 'verification', 'result.json'), { time: new Date().toISOString(), tree: tree.treeVersion, node: node.id, baseLife: evaluation.base.Life, candidateLife: evaluation.candidate.Life, itemBaseLife: item.base.Life, itemCandidateLife: item.candidate.Life, mutationAndRestore: true, originalHash: hash(original.xml), restoredHash: hash(restored.xml) });
  } catch (e) {
    await command('apply', { xml: live.xml }).catch(() => {});
    throw e;
  }
}
