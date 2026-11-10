// Full inbox -> agent -> CLI -> tools -> proposal -> native apply/undo verification.
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, readJson } from '../src/files.mjs';
import { parseBuild } from '../src/xml.mjs';

const session = await readJson('.pob-helper/session.json');
const live = await readJson(path.join(session.runtime, 'snapshot.json'));
if (!live?.xml || Date.now() - live.timestamp > 12_000) throw Error('Open a build using the PoB Helper shortcut.');
const initialNotes = parseBuild(live.xml).getElementsByTagName('Notes')[0]?.textContent.trim();
const mutations = process.argv.includes('--mutations');
if (mutations && (live.fileName || live.level !== 1 || initialNotes)) throw Error('The mutation test requires a new level-1 build with no notes.');
async function send(type, data = {}) {
  const id = crypto.randomUUID();
  await atomicWrite(path.join(session.runtime, 'inbox', `${id}.json`), { protocol: 1, sessionId: session.id, id, type, buildKey: live.buildKey, createdAt: Date.now(), ...data });
  return id;
}
async function waitFor(check, timeout = 180_000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const ui = await readJson(path.join(session.runtime, 'ui.json'));
    if (ui && check(ui)) return ui;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('Agent verification timed out.');
}
const priorUi = await readJson(path.join(session.runtime, 'ui.json'));
const previousCount = priorUi.messages.length;
const requestId = await send('chat', { text: 'Integration test: read the COMPLETE live build XML with read_build. State only my class, level and calculated Life. Propose ONLY setting Notes to "Assistant connected". Do not change any other field. Do not use web research.' });
const ui = await waitFor(ui => !ui.busy && ui.lastCompletedRequest === requestId);
if (!ui.proposal || !ui.messages.some(m => m.role === 'assistant')) throw Error(`Agent did not produce a proposal: ${JSON.stringify(ui.messages.slice(-2))}`);
const proposedNotes = parseBuild(ui.proposal.xml).getElementsByTagName('Notes')[0]?.textContent.trim();
if (proposedNotes !== 'Assistant connected') throw Error('Unexpected proposal.');
console.log(JSON.stringify({ stage: 'agent', answer: ui.messages.filter(m => m.role === 'assistant').at(-1)?.text, operations: ui.proposal.operations }));
if (mutations) {
  await send('apply');
  await waitFor(ui => !ui.proposal && ui.canUndo, 40_000);
  const applied = await readJson(path.join(session.runtime, 'snapshot.json'));
  if (parseBuild(applied.xml).getElementsByTagName('Notes')[0]?.textContent.trim() !== 'Assistant connected') throw Error('Proposal was not applied.');
  const beforeUndo = (await readJson(path.join(session.runtime, 'ui.json'))).messages.length;
  await send('undo');
  await waitFor(ui => ui.messages.length > beforeUndo && ui.messages.at(-1)?.text.includes('undone'), 40_000);
  const restored = await readJson(path.join(session.runtime, 'snapshot.json'));
  if (parseBuild(restored.xml).getElementsByTagName('Notes')[0]?.textContent.trim() !== initialNotes) throw Error('Undo did not restore the note.');
  console.log('Agent proposal -> Apply -> Undo: passed against real CLI and PoB.');
}
