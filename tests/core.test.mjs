import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyOperations, parseBuild } from '../src/xml.mjs';
import { invocation, extractClaude } from '../src/cli.mjs';
import { scopedPath, safeSource, atomicWrite, readJson, hash } from '../src/files.mjs';
import { researchUrl } from '../src/knowledge.mjs';
import { compatible, removeHook, bootstrap } from '../scripts/install.mjs';
import { chat as realChat } from '../src/agent.mjs';
import { calculationHash } from '../src/build-lab.mjs';
const chat = options => realChat({ evaluateCandidates: async ({ args, snapshot, version }) => ({ baseHash: hash(snapshot.xml), fingerprint: version.fingerprint, objective: 'TotalDPS', base: { output: { Life: 1000 } }, candidates: (args.candidates || [{ operations: args.operations }]).map(candidate => { const xml = applyOperations(snapshot.xml,candidate.operations); return { xmlHash: hash(xml), calculationHash: calculationHash(xml), report: { output: { Life: 1100 }, validation: { errors: [] } }, feasible: true }; }) }), ...options });
import fengari from 'fengari';
import { authInvocation, checkAuth, browserLogin } from '../src/auth.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { modelCatalog } from '../src/models.mjs';
import { runProcess } from '../src/process.mjs';

const build = '<PathOfBuilding><Build targetVersion="3_0" level="90"/><Tree activeSpec="1"><Spec nodes="1,2"/></Tree><Items><Item id="1">old</Item><Item id="2">keep</Item></Items><Skills><Skill><Gem level="20"/></Skill></Skills><Config/><Notes>original</Notes></PathOfBuilding>';
test('atomic writes stay ordered and recover after a failed write', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-atomic-'));
  try {
    const file = path.join(dir, 'state.json');
    await Promise.all(Array.from({ length: 40 }, (_, index) => atomicWrite(file, { index, payload: 'x'.repeat(2000) })));
    assert.equal((await readJson(file)).index, 39);
    const blocked = path.join(dir, 'directory'); await fs.mkdir(blocked);
    await assert.rejects(atomicWrite(blocked, { value: 'cannot replace a directory' }));
    await fs.rmdir(blocked); await atomicWrite(blocked, { recovered: true });
    assert.equal((await readJson(blocked)).recovered, true);
    assert(!(await fs.readdir(dir)).some(file => file.endsWith('.tmp')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('Windows reader locks are retried without deleting the last valid status file', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-reader-lock-'));
  let reader, completed;
  try {
    const file = path.join(dir, 'heartbeat.json'); await atomicWrite(file, { value: 'original' });
    const literal = file.replaceAll("'", "''");
    const script = `$f=[IO.File]::Open('${literal}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Dispose()`;
    reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let timer;
    try {
      await new Promise((resolve, reject) => {
        // Cold Windows runners can spend several seconds loading PowerShell.
        // This bounds helper startup only; the held-lock assertions below are
        // unchanged and still verify that the original file is never deleted.
        timer = setTimeout(() => reject(Error('Reader lock setup timed out.')), 15000);
        reader.stdout.on('data', data => { if (data.toString().includes('LOCKED')) resolve(); });
        reader.once('error', reject);
        reader.once('exit', code => { if (code !== null) reject(Error(`Reader exited before release: ${code}`)); });
      });
    } finally { clearTimeout(timer); }
    completed = Promise.all([atomicWrite(file, { value: 'first' }), atomicWrite(file, { value: 'latest' })]);
    completed.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal((await readJson(file)).value, 'original', 'the existing file was removed while locked');
    assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length, 1, 'same-file writes were not serialized');
    reader.stdin.end('\n'); await once(reader, 'exit');
    await completed;
    assert.equal((await readJson(file)).value, 'latest');
    assert(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
  } finally {
    if (reader && reader.exitCode === null && reader.signalCode === null) { reader.kill(); await once(reader, 'exit'); }
    if (completed) await completed.catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('model catalog exposes visible model metadata and survives an absent or malformed cache', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-models-'));
  try {
    assert.deepEqual((await modelCatalog({ codexHome: dir })).codex, []);
    await fs.writeFile(path.join(dir, 'models_cache.json'), JSON.stringify({ identity: 'private-metadata', models: [
      { slug: 'hidden', visibility: 'hide' }, { slug: 'second', display_name: 'Second', visibility: 'list', priority: 2, privateField: 'omit' },
      { slug: 'first', display_name: 'First', visibility: 'list', priority: 1 }, { slug: 'first', visibility: 'list' }, null, { slug: 'bad\nmodel', visibility: 'list' },
    ] }));
    const models = await modelCatalog({ codexHome: dir });
    assert.deepEqual(models.codex, [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }]);
    assert.deepEqual(models.claude.map(m => m.id), ['sonnet', 'opus', 'haiku']);
    await fs.writeFile(path.join(dir, 'models_cache.json'), 'broken');
    assert.deepEqual((await modelCatalog({ codexHome: dir })).codex, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('targeted operations preserve unrelated item sets, skills and sections', () => {
  const result = applyOperations(build, [
    { type: 'set_attribute', path: 'PathOfBuilding/Build/@level', value: '95' },
    { type: 'set_text', path: 'PathOfBuilding/Items/Item[@id="1"]', value: 'Rarity: Rare\nSome Item\n+10 to Strength' },
    { type: 'append_xml', path: 'PathOfBuilding/Config', value: '<Input name="enemyIsBoss" string="Pinnacle"/>' },
  ]);
  const doc = parseBuild(result);
  assert.equal(doc.getElementsByTagName('Build')[0].getAttribute('level'), '95');
  assert.equal(doc.getElementsByTagName('Item')[1].textContent, 'keep');
  assert.equal(doc.getElementsByTagName('Gem')[0].getAttribute('level'), '20');
  assert.equal(doc.getElementsByTagName('Notes')[0].textContent, 'original');
  assert.equal(doc.getElementsByTagName('Input')[0].getAttribute('string'), 'Pinnacle');
});
test('ambiguous selectors, malformed XML, external entities and version swaps are rejected', () => {
  assert.throws(() => applyOperations(build, [{ type: 'set_text', path: 'PathOfBuilding/Items/Item', value: 'x' }]));
  assert.throws(() => parseBuild('<!DOCTYPE PathOfBuilding [<!ENTITY x SYSTEM "file:///x">]><PathOfBuilding><Build/></PathOfBuilding>'));
  assert.throws(() => parseBuild('<PathOfBuilding><Build></PathOfBuilding>'));
  assert.throws(() => applyOperations(build, [{ type: 'set_attribute', path: 'PathOfBuilding/Build/@targetVersion', value: '2_0' }]));
  assert.throws(() => applyOperations(build, [{ type: 'remove', path: 'PathOfBuilding/Build', value: '' }]));
});
test('replace and remove affect only selected sections; import cannot trigger a remote fetch', () => {
  const result = applyOperations(build, [{ type: 'replace_xml', path: 'PathOfBuilding/Notes', value: '<Notes>updated &amp; valid</Notes>' }, { type: 'remove', path: 'PathOfBuilding/Items/Item[@id="1"]', value: '' }]);
  assert.equal(parseBuild(result).getElementsByTagName('Notes')[0].textContent, 'updated & valid');
  assert.equal(parseBuild(result).getElementsByTagName('Item').length, 1);
  assert.equal(parseBuild(build.replace('<Config/>', '<Config/><Import importLink="https://bad.example/"/>')).getElementsByTagName('Import').length, 0);
});
test('full access enables local tools while research and PoB-only calls stay restricted', () => {
  const chosen = 'model; echo compromised';
  const codex = invocation({ provider: 'codex', model: chosen, effort: 'high' }, path.resolve('codex.exe'), 'schema', 'result');
  assert(codex.args.includes(chosen)); assert(codex.args.includes('danger-full-access')); assert(codex.args.includes('--ephemeral'));
  assert(codex.args.includes('approval_policy="never"'));
  assert.equal(codex.args[codex.args.indexOf('unified_exec') - 1], '--enable');
  assert.equal(codex.args[codex.args.indexOf('code_mode_host') - 1], '--enable');
  const claude = invocation({ provider: 'claude' }, path.resolve('claude.exe'), 'schema', 'result');
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], 'default');
  assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert(claude.args.includes('--safe-mode')); assert(claude.args.includes('--strict-mcp-config'));
  assert(claude.args.includes('--no-session-persistence'));
  for (const provider of ['codex', 'claude']) {
    const research = invocation({ provider, access: 'full', webSearchOnly: true }, path.resolve(`${provider}.exe`), 'schema', 'result');
    const restricted = invocation({ provider, access: 'pob' }, path.resolve(`${provider}.exe`), 'schema', 'result');
    if (provider === 'codex') {
      assert(research.args.includes('read-only')); assert(restricted.args.includes('read-only'));
      assert.equal(research.args[research.args.indexOf('unified_exec') - 1], '--disable');
    } else {
      assert.equal(research.args[research.args.indexOf('--tools') + 1], 'WebSearch');
      assert.equal(restricted.args[restricted.args.indexOf('--tools') + 1], '');
      assert.equal(research.args[research.args.indexOf('--permission-mode') + 1], 'dontAsk');
    }
  }
  assert.throws(() => invocation({ provider: 'codex' }, 'codex.cmd', 's', 'r'));
  assert.deepEqual(extractClaude(JSON.stringify({ structured_output: { message: 'ok' } })), { message: 'ok' });
});
test('local processes can work outside their cwd and cancellation stops descendants', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-process-'));
  let descendant;
  try {
    const cwd = path.join(dir, 'worker'); await fs.mkdir(cwd);
    const file = path.join(dir, 'outside-worker.txt');
    await runProcess(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],"local access verified")', file], { cwd });
    assert.equal(await fs.readFile(file, 'utf8'), 'local access verified');
    const controller = new AbortController();
    const code = 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)';
    await assert.rejects(runProcess(process.execPath, ['-e', code], { cwd, signal: controller.signal, onLine: line => { descendant = Number(line); controller.abort(); } }), /cancelled/);
    assert(descendant > 0);
    assert.throws(() => process.kill(descendant, 0), /ESRCH/);
    await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(2000));setInterval(()=>{},1000)'], { cwd, maxOutput: 100 }), /output limit/);
  } finally {
    if (descendant) { try { process.kill(descendant); } catch { /* already stopped */ } }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('unlimited CLI work keeps running and long event streams do not accumulate output', async () => {
  const output = await runProcess(process.execPath, ['-e', 'setTimeout(()=>console.log("finished"),180)'], { timeoutMs: 0 });
  assert.match(output, /finished/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timed out/);
  let finished = false;
  const events = await runProcess(process.execPath, ['-e', 'for(let n=0;n<210;n++)process.stdout.write("x".repeat(65536));console.log("\\nfinished");'], { captureOutput: false, maxOutput: 0, onLine: line => { if (line === 'finished') finished = true; } });
  assert.equal(events, ''); assert(finished, 'progress stopped after a large event stream');
});
test('source paths and evidence domains reject traversal, credentials and network pivots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-source-'));
  try {
    await fs.writeFile(path.join(dir, 'test.lua'), 'return 1');
    assert.equal(await safeSource(dir, 'test.lua'), await fs.realpath(path.join(dir, 'test.lua')));
    assert.throws(() => scopedPath(dir, '../secrets'));
    assert.throws(() => scopedPath(dir, 'C:\\Windows\\file'));
    for (const url of ['http://reddit.com/x', 'https://127.0.0.1/', 'https://reddit.com.evil.example/', 'https://user@reddit.com/', 'https://reddit.com:1234/']) assert.throws(() => researchUrl(url));
    assert.equal(researchUrl('https://www.pathofexile.com/forum/view-thread/1').hostname, 'www.pathofexile.com');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('addon compiles as Lua and hook is removable without overwriting newer source', async () => {
  const source = await fs.readFile('addon/PobHelper.lua', 'utf8');
  const L = fengari.lauxlib.luaL_newstate();
  const code = fengari.lauxlib.luaL_loadstring(L, fengari.to_luastring(source));
  assert.equal(code, 0, code ? fengari.to_jsstring(fengari.lua.lua_tostring(L, -1)) : '');
  fengari.lua.lua_close(L);
  const original = 'function main:Init() end\nfunction main:OnFrame() self.inputEvents = {}; GetVirtualScreenSize() end\nreturn main\n';
  assert(compatible(original)); assert(!compatible('return main'));
  const removed = removeHook(original.replace('return main', '\n-- POB_HELPER_BEGIN\nold\n-- POB_HELPER_END\nreturn main'));
  assert(!removed.includes('POB_HELPER')); assert(compatible(removed));
  const launcher = bootstrap({ id: 'test-session', root: process.cwd(), runtime: path.join(process.cwd(), '.pob-helper/test'), install: path.resolve('test-install') });
  const L2 = fengari.lauxlib.luaL_newstate();
  const compiled = fengari.lauxlib.luaL_loadstring(L2, fengari.to_luastring(launcher.replace(/^#[^\n]*\n/, '')));
  assert.equal(compiled, 0, compiled ? fengari.to_jsstring(fengari.lua.lua_tostring(L2, -1)) : '');
  fengari.lua.lua_close(L2);
});
test('native transaction restores a build when the first calculation frame fails and clamps model limits', async () => {
  const source = await fs.readFile('addon/PobHelper.lua', 'utf8');
  const harness = await fs.readFile('tests/native-harness.lua', 'utf8');
  const L = fengari.lauxlib.luaL_newstate(); fengari.lualib.luaL_openlibs(L);
  const code = fengari.lauxlib.luaL_dostring(L, fengari.to_luastring(`addon = (function() ${source} end)()\n${harness}`));
  assert.equal(code, 0, code ? fengari.to_jsstring(fengari.lua.lua_tostring(L, -1)) : '');
  fengari.lua.lua_close(L);
});
test('agent reads the complete build and uses real native tools before proposing, citing only fetched sources', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-agent-'));
  try {
    await fs.writeFile(path.join(dir, 'manifest.xml'), '<PoBVersion><Version number="2.67.2"/></PoBVersion>');
    await fs.writeFile(path.join(dir, 'GameVersions.lua'), 'liveTargetVersion = "3_0"; treeVersionList = {"3_28","3_29"}');
    let calls = 0, evaluated = false;
    const result = await chat({
      text: 'improve this build', history: [], snapshot: { xml: build, pobVersion: '2.67.2' }, settings: { research: false }, install: dir, dir,
      progress: () => {}, native: async name => { evaluated = name === 'evaluate'; return { base: { Life: 1000 }, candidate: { Life: 1100 } }; },
      invoke: async ({ prompt }) => {
        calls++;
        if (calls === 1) return { message: '', tools: [{ name: 'read_build', arguments: '{}' }, { name: 'evaluate', arguments: '{"addNodes":[3]}' }], operations: [] };
        assert(prompt.includes('original')); assert(prompt.includes('1100'));
        return { message: 'Proposal', tools: [], operations: [{ type: 'set_attribute', path: 'PathOfBuilding/Build/@level', value: '91' }], sources: ['https://invented.example'], proposalTitle: 'Level' };
      },
    });
    assert(evaluated); assert.equal(calls, 3); assert.equal(result.sources.length, 0); assert.match(result.candidate, /level="91"/); assert(result.validation);
    await assert.rejects(chat({ text: 'x', history: [], snapshot: { xml: build, pobVersion: 'old' }, settings: {}, install: dir, dir, progress() {} }), /updated/);
    await assert.rejects(chat({ text: 'x', history: [], snapshot: { xml: build }, settings: {}, install: dir, dir, progress() {}, invoke: async () => ({ message: 'x', tools: [], operations: [{ type: 'set_text', path: 'PathOfBuilding/Notes', value: 'x' }], sources: [] }) }), /without reading/);
    await assert.rejects(chat({ text: 'x', history: [], snapshot: { xml: build }, settings: {}, install: dir, dir, progress() {}, invoke: async () => {
      await fs.appendFile(path.join(dir, 'GameVersions.lua'), '\n-- an update happened while the CLI was thinking');
      return { message: '', tools: [{ name: 'read_build', arguments: '{}' }], operations: [] };
    } }), /updated during analysis/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('browser sign-in delegates to the selected CLI and keeps account details out of addon state', async () => {
  const codex = authInvocation({ provider: 'codex' }, path.resolve('codex.exe'), 'login');
  assert.deepEqual(codex.args, ['login']); assert(!codex.args.includes('--device-auth'));
  const claude = authInvocation({ provider: 'claude' }, path.resolve('claude.exe'), 'login');
  assert.deepEqual(claude.args, ['auth', 'login', '--claudeai']);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-auth-test-'));
  try {
    const executable = path.join(dir, 'fake-cli.mjs');
    await fs.writeFile(executable, `import fs from 'node:fs'; fs.appendFileSync('calls.txt',process.argv.slice(2).join(' ')+'\\n'); if(process.argv.includes('status'))console.log(JSON.stringify({loggedIn:true,email:'private@example.invalid'}));`);
    const settings = { provider: 'claude', executable };
    const status = await checkAuth(settings, { dir }); assert.equal(status.signedIn, true); assert(!('email' in status));
    const signedIn = await browserLogin(settings, { dir }); assert(signedIn.signedIn);
    assert.match(await fs.readFile(path.join(dir, 'calls.txt'), 'utf8'), /auth login --claudeai/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('long analyses continue beyond ten rounds, archive older results and preserve working notes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-long-analysis-'));
  try {
    await fs.writeFile(path.join(dir, 'manifest.xml'), '<PoBVersion><Version number="2.67.2"/></PoBVersion>');
    await fs.writeFile(path.join(dir, 'GameVersions.lua'), 'liveTargetVersion = "3_0"; treeVersionList = {"3_28","3_29"}');
    let calls = 0, nativeCalls = 0;
    const result = await chat({ text: 'create a complete physical Cyclone build', history: [], snapshot: { xml: build, pobVersion: '2.67.2' }, settings: { research: false }, install: dir, dir, progress() {},
      native: async () => ++nativeCalls === 1 ? { payload: 'A'.repeat(30000) } : { measuredLife: 1100 },
      invoke: async ({ prompt }) => {
        calls++; assert(prompt.length < 240000, 'recent context grew without a bound');
        if (calls === 1) return { message: 'I am comparing complete build options.', workSummary: 'Goal: physical Cyclone; compare damage and defense; useful evidence tool-2.', tools: [{ name: 'read_build', arguments: '{}' }, { name: 'tree', arguments: '{}' }], operations: [] };
        assert(prompt.includes('Goal: physical Cyclone'), 'an omitted summary erased working notes');
        assert(prompt.includes('original'), 'complete build context was lost');
        if (calls < 14) return { message: '', tools: [{ name: 'evaluate', arguments: '{}' }], operations: [] };
        if (calls === 14) {
          assert(!prompt.includes('A'.repeat(20000)), 'old unbounded output stayed in the prompt');
          return { message: '', tools: [{ name: 'read_tool_result', arguments: '{"id":"tool-2","start":0,"count":8000}' }], operations: [] };
        }
        if (calls === 15) {
          assert(prompt.includes('A'.repeat(1000)), 'an older result could not be retrieved');
          return { message: '', tools: [{ name: 'read_tool_result', arguments: '{"id":"../other-request"}' }], operations: [] };
        }
        assert(prompt.includes('Unknown result ID for this request'));
        return { message: 'Complete build proposal.', tools: [], operations: [{ type: 'set_attribute', path: 'PathOfBuilding/Build/@level', value: '91' }], sources: [] };
      },
    });
    assert.equal(calls, 17); assert.match(result.candidate, /level="91"/);
    assert.equal((await readJson(path.join(dir, 'tool-results/tool-2.json'))).payload.length, 30000);
    assert.equal((await readJson(path.join(dir, 'checkpoint.json'))).workSummary.includes('physical Cyclone'), true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('Cancel is respected during native tools and before accepting a final proposal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-cancel-analysis-'));
  try {
    await fs.writeFile(path.join(dir, 'manifest.xml'), '<PoBVersion><Version number="2.67.2"/></PoBVersion>');
    await fs.writeFile(path.join(dir, 'GameVersions.lua'), 'liveTargetVersion = "3_0"; treeVersionList = {"3_28","3_29"}');
    const base = { text: 'x', history: [], snapshot: { xml: build }, settings: {}, install: dir, dir, progress() {} };
    const nativeCancel = new AbortController();
    await assert.rejects(chat({ ...base, signal: nativeCancel.signal, invoke: async () => ({ message: '', tools: [{ name: 'tree', arguments: '{}' }], operations: [] }), native: async () => { nativeCancel.abort(); throw Error('cancel native call'); } }), error => error.name === 'AbortError');
    const finalCancel = new AbortController(); let round = 0;
    await assert.rejects(chat({ ...base, signal: finalCancel.signal, invoke: async () => {
      if (!round++) return { message: '', tools: [{ name: 'read_build', arguments: '{}' }], operations: [] };
      finalCancel.abort(); return { message: 'Late proposal', tools: [], operations: [{ type: 'set_attribute', path: 'PathOfBuilding/Build/@level', value: '91' }] };
    } }), error => error.name === 'AbortError');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('backend restarts after a crash with a fresh heartbeat and preserves the same-build conversation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pobhelper-restart-'));
  const sessionFile = path.join(dir, 'session.json');
  await fs.writeFile(sessionFile, JSON.stringify({ id: 'restart-test', runtime: dir, install: dir }));
  const children = [];
  async function start() {
    const child = spawn(process.execPath, [path.resolve('src/server.mjs'), '--session', sessionFile], { windowsHide: true, stdio: 'ignore' });
    children.push(child);
    for (let i = 0; i < 60; i++) {
      const beat = await fs.readFile(path.join(dir, 'heartbeat.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (beat?.pid === child.pid) return child;
      if (child.exitCode !== null) throw Error('Backend exited before writing a heartbeat.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Backend startup timed out.');
  }
  try {
    await atomicWrite(path.join(dir, 'snapshot.json'), { sessionId: 'restart-test', buildKey: 'saved-build', mode: 'BUILD', xml: build });
    await atomicWrite(path.join(dir, 'ui.json'), { sessionId: 'restart-test', buildKey: 'saved-build', busy: false, messages: [{ role: 'assistant', text: 'Keep this answer.' }], proposal: { title: 'Saved proposal', buildKey: 'saved-build', xml: build, operations: [] } });
    const first = await start();
    assert.equal((await readJson(path.join(dir, 'ui.json'))).messages[0].text, 'Keep this answer.');
    first.kill('SIGKILL'); await once(first, 'exit');
    const second = await start(); assert.notEqual(second.pid, first.pid);
    const restored = await readJson(path.join(dir, 'ui.json'));
    assert.equal(restored.messages[0].text, 'Keep this answer.');
    assert.equal(restored.proposal.title, 'Saved proposal');
    second.kill('SIGKILL'); await once(second, 'exit');
    const closedSnapshot = { sessionId: 'restart-test', mode: 'CLOSED' };
    await atomicWrite(path.join(dir, 'snapshot.json'), closedSnapshot);
    const closed = await start();
    assert.equal((await readJson(path.join(dir, 'ui.json'))).messages[0].text, 'Keep this answer.');
    const originalSettings = restored.settings;
    await atomicWrite(path.join(dir, 'inbox/clear-test.json'), { protocol: 1, sessionId: 'restart-test', id: 'clear-test', type: 'clear_chat', buildKey: 'saved-build', createdAt: Date.now() });
    let cleared;
    for (let i = 0; i < 60; i++) {
      cleared = await readJson(path.join(dir, 'ui.json'));
      if (cleared?.chatClearedAt) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(cleared.chatClearedAt, 'clear chat was not acknowledged');
    assert.deepEqual(cleared.messages, []); assert.equal(cleared.proposal, null);
    assert.deepEqual(cleared.settings, originalSettings);
    assert.deepEqual(await readJson(path.join(dir, 'snapshot.json')), closedSnapshot);
    closed.kill('SIGKILL'); await once(closed, 'exit');
    await start();
    const fresh = await readJson(path.join(dir, 'ui.json'));
    assert.deepEqual(fresh.messages, []); assert.equal(fresh.proposal, null);
  } finally {
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(async child => { child.kill('SIGKILL'); await once(child, 'exit'); }));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
