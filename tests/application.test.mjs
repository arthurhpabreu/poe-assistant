import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWrite, readJson, hash } from '../src/files.mjs';
import { nativeCommand } from '../src/native-bridge.mjs';
import { evaluateBuilds } from '../src/build-lab.mjs';

async function until(read, predicate, timeout = 10_000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error('Timed out waiting for the test condition.');
}
test('lost acknowledgement uses the immutable receipt, never later snapshot edits', async () => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'poe-receipt-'));
  const expected = { instanceId: 'window', buildKey: 'build', revision: 'before' };
  try {
    const pending = nativeCommand({ runtime, sessionId: 'test', name: 'apply', args: { xml: 'candidate' }, expected, timeoutMs: 1500 });
    const command = await until(() => readJson(path.join(runtime, 'command.json')), value => value?.id);
    await atomicWrite(path.join(runtime, 'snapshot.json'), { ...expected, revision: 'manual edit', appliedCommandId: command.id });
    await atomicWrite(path.join(runtime, 'receipts', command.id + '.json'), { id: command.id, sessionId: 'test', instanceId: 'wrong-window', buildKey: 'build', result: { applied: true, committedRevision: 'wrong' } });
    await new Promise(resolve => setTimeout(resolve, 130));
    await fs.rm(path.join(runtime, 'command.json')); await fs.mkdir(path.join(runtime, 'command.json'));
    await atomicWrite(path.join(runtime, 'receipts', command.id + '.json'), { id: command.id, sessionId: 'test', instanceId: 'window', buildKey: 'build', result: { applied: true, buildKey: 'build', committedRevision: 'actual commit' } });
    const result = await pending;
    assert.equal(result.committedRevision, 'actual commit'); assert(result.reconciled);
    await fs.rm(path.join(runtime, 'command.json'), { recursive: true });
    await assert.rejects(nativeCommand({ runtime, sessionId: 'test', name: 'apply', args: {}, expected, timeoutMs: 150 }), error => error.code === 'APPLY_UNCONFIRMED');
  } finally { await fs.rm(runtime, { recursive: true, force: true }); }
});

test('complete measurements reuse exact candidates and baseline, rerank constraints and invalidate changed engines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poe-cache-'));
  let calls = 0;
  try {
    const install = path.join(dir, 'pob'); await fs.mkdir(install);
    await fs.writeFile(path.join(install, 'manifest.xml'), '<PoBVersion><Version number="test"/><File name="GameVersions.lua"/><File name="Path{space}of{space}Building.exe"/></PoBVersion>');
    await fs.writeFile(path.join(install, 'GameVersions.lua'), 'treeVersionList={"3_28","3_29"}');
    await fs.writeFile(path.join(install, 'Path of Building.exe'), 'fixture');
    const xml = '<PathOfBuilding><Build level="90" targetVersion="3_0"/><Tree><Spec treeVersion="3_29"/></Tree></PathOfBuilding>';
    const candidate = { label: 'Level 91', operations: [{ type: 'set_attribute', path: 'PathOfBuilding/Build/@level', value: '91' }] };
    const evaluationCache = new Map();
    const input = { snapshot: { xml }, install, dir, cacheDir: path.join(dir, 'engines'), evaluationCache, calculate: async ({ xml, signal }) => {
      calls++; signal?.throwIfAborted(); return { normalizedXml: xml, report: { output: { Life: Number(/level="(\d+)"/.exec(xml)[1]) }, validation: { errors: [] } } };
    } };
    const first = await evaluateBuilds({ ...input, args: { candidates: [candidate, candidate], objective: 'Life' } });
    assert.equal(calls, 2); assert.equal(first.timings.cacheHits, 1);
    first.candidates[0].report.output.Life = 999;
    const second = await evaluateBuilds({ ...input, args: { candidates: [candidate], objective: 'Life', minimums: { Life: 95 } } });
    assert.equal(calls, 2); assert.equal(second.candidates[0].score, 91); assert(!second.candidates[0].feasible);
    await fs.appendFile(path.join(install, 'GameVersions.lua'), '\n-- updated data');
    await evaluateBuilds({ ...input, args: { candidates: [candidate], objective: 'Life' } });
    assert.equal(calls, 4, 'A changed engine reused old evidence.');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(evaluateBuilds({ ...input, args: { candidates: [candidate] }, signal: controller.signal }), error => error.name === 'AbortError');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Apply reports stale proposals, commits once, and Undo cannot overwrite subsequent manual edits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poe-apply-'));
  let child;
  try {
    const xml = '<PathOfBuilding><Build level="1" targetVersion="3_0"/><Tree><Spec treeVersion="3_29"/></Tree></PathOfBuilding>';
    const sessionId = 'apply-test', buildKey = 'build', instanceId = 'window';
    await atomicWrite(path.join(dir, 'session.json'), { id: sessionId, runtime: dir, install: dir, state: dir });
    await fs.writeFile(path.join(dir, 'manifest.xml'), '<PoBVersion><Version number="test"/></PoBVersion>');
    await fs.writeFile(path.join(dir, 'GameVersions.lua'), 'treeVersionList={"3_28","3_29"}');
    const snapshot = { sessionId, buildKey, instanceId, timestamp: Date.now(), mode: 'BUILD', xml, revision: 'before', pobVersion: 'test' };
    await atomicWrite(path.join(dir, 'snapshot.json'), snapshot);
    await atomicWrite(path.join(dir, 'ui.json'), { sessionId, buildKey, messages: [], proposal: { id: 'proposal', buildKey, baseHash: hash('before'), xml: xml.replace('level="1"', 'level="2"') } });
    child = spawn(process.execPath, [path.resolve('src/server.mjs'), '--session', path.join(dir, 'session.json')], { windowsHide: true, stdio: 'ignore' });
    await until(() => readJson(path.join(dir, 'heartbeat.json')), beat => beat?.pid === child.pid);
    const request = async (id, type, proposalId) => atomicWrite(path.join(dir, 'inbox', id + '.json'), { protocol: 1, sessionId, id, type, proposalId, buildKey, createdAt: Date.now() });
    const completed = id => until(() => readJson(path.join(dir, 'ui.json')), ui => ui?.lastRequest?.id === id && ui.lastRequest.state !== 'running');
    await request('stale', 'apply', 'wrong');
    assert.equal((await completed('stale')).lastRequest.state, 'failed');
    assert.equal(await readJson(path.join(dir, 'command.json')), null);
    await request('apply', 'apply', 'proposal');
    const command = await until(() => readJson(path.join(dir, 'command.json')), value => value?.name === 'apply');
    assert((await readJson(path.join(dir, 'ui.json'))).busy);
    await atomicWrite(path.join(dir, 'snapshot.json'), { ...snapshot, revision: 'committed', xml: command.args.xml, timestamp: Date.now() });
    child.kill(); await until(async () => child.exitCode !== null || child.signalCode !== null, Boolean);
    await atomicWrite(path.join(dir, 'receipts', command.id + '.json'), { id: command.id, sessionId, instanceId, buildKey, result: { applied: true, buildKey, committedRevision: 'committed' } });
    child = spawn(process.execPath, [path.resolve('src/server.mjs'), '--session', path.join(dir, 'session.json')], { windowsHide: true, stdio: 'ignore' });
    await until(() => readJson(path.join(dir, 'heartbeat.json')), beat => beat?.pid === child.pid);
    const applied = await completed('apply'); assert(applied.canUndo); assert(!applied.busy); assert.equal(applied.proposal, null); assert(applied.messages.some(message => message.text.includes('Recovered')));
    await request('duplicate', 'apply', 'proposal');
    const duplicate = await completed('duplicate'); assert.equal(duplicate.lastRequest.state, 'failed'); assert(duplicate.messages.at(-1).text.includes('No changes'));
    await atomicWrite(path.join(dir, 'snapshot.json'), { ...snapshot, revision: 'manual edit', timestamp: Date.now() });
    await request('undo', 'undo', applied.undoId);
    const undo = await completed('undo'); assert.equal(undo.lastRequest.state, 'failed'); assert(undo.messages.at(-1).text.includes('build changed'));
    assert.equal(await readJson(path.join(dir, 'command.json')), null);
  } finally {
    if (child) { child.kill(); await until(async () => child.exitCode !== null || child.signalCode !== null, Boolean).catch(() => {}); }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
