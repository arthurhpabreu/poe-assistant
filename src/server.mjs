import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat } from './agent.mjs';
import { atomicWrite, readJson, hash } from './files.mjs';
import { detectClis } from './cli.mjs';
import { installationVersion } from './knowledge.mjs';
import { browserLogin, checkAuth } from './auth.mjs';
import { modelCatalog } from './models.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionArg = process.argv.indexOf('--session');
const sessionFile = sessionArg >= 0 ? process.argv[sessionArg + 1] : path.join(root, '.pob-helper/session.json');
const session = await readJson(sessionFile);
if (!session?.id || !session?.runtime || !session?.install) throw Error('Run npm run install:addon first.');
const runtime = session.runtime;
await fs.mkdir(runtime, { recursive: true });
let lock;
try { lock = await fs.open(path.join(runtime, 'backend.lock'), 'wx'); }
catch {
  const pid = Number(await fs.readFile(path.join(runtime, 'backend.lock'), 'utf8').catch(() => '0'));
  if (pid > 0) { try { process.kill(pid, 0); process.exit(0); } catch { /* stale */ } }
  const previous = await readJson(path.join(runtime, 'heartbeat.json'));
  // A recent heartbeat cannot keep a known-dead process alive.
  if (!pid && previous && Date.now() - previous.time < 12_000) process.exit(0);
  await fs.rm(path.join(runtime, 'backend.lock'), { force: true });
  lock = await fs.open(path.join(runtime, 'backend.lock'), 'wx');
}
await lock.writeFile(String(process.pid));
const defaults = { provider: 'codex', model: '', effort: '', executable: '', research: true, access: 'full' };
let settings = { ...defaults, ...await readJson(path.join(root, '.pob-helper/settings.json'), {}) };
let ui = { protocol: 1, sessionId: session.id, messages: [], proposal: null, busy: false, status: 'Ready. Open a build and describe your goal.', settings, clis: await detectClis(), models: await modelCatalog() };
let modelsCheckedAt = Date.now();
const histories = new Map();
const instanceContexts = await readJson(path.join(runtime, 'loaded-contexts.json'), {});
let activeKey, activeController, loginController, lastUndo = null, processing = false;
let activityStatus = '', elapsedPublishedAt = 0;
// Keep the visible conversation/proposal across a backend restart for the same build.
const previousUi = await readJson(path.join(runtime, 'ui.json'));
const previousBuild = await readJson(path.join(runtime, 'snapshot.json'));
if (previousUi?.sessionId === session.id && previousUi.buildKey && (previousUi.buildKey === previousBuild?.buildKey && previousBuild.mode === 'BUILD' || previousBuild?.mode === 'CLOSED') && Array.isArray(previousUi.messages)) {
  activeKey = previousUi.buildKey;
  ui.messages = previousUi.messages.filter(message => ['user', 'assistant', 'system'].includes(message.role) && typeof message.text === 'string');
  histories.set(activeKey, ui.messages);
  if (!previousUi.busy && previousUi.proposal?.buildKey === activeKey) ui.proposal = previousUi.proposal;
  if (previousUi.busy) ui.messages.push({ role: 'system', text: 'The chat backend restarted before the response finished. Send your request again to continue.' });
  ui.status = ui.proposal ? 'Proposal restored. Review the changes before applying.' : 'Reconnected. Your conversation was preserved.';
}
const publish = async () => { ui.buildKey = activeKey; await atomicWrite(path.join(runtime, 'ui.json'), ui); };
const syncBusyMessage = 'Windows is using a chat file. Retrying the connection...';
async function reportError(error) {
  ui.status = ['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY'].includes(error.code) ? syncBusyMessage : error.message;
  try { await publish(); }
  catch (failure) { console.error('Chat status could not be saved:', failure.code || failure.message); }
}
function elapsedLabel() {
  const seconds = Math.max(0, Math.floor((Date.now() - ui.startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed`;
}
async function progress(status, details) {
  activityStatus = status;
  ui.status = ui.busy && ui.startedAt ? `${status} | ${elapsedLabel()}` : status;
  if (details?.message) ui.workMessage = details.message;
  await publish();
}
async function snapshotNow({ allowStale = false } = {}) {
  const snapshot = await readJson(path.join(runtime, 'snapshot.json'));
  if (!snapshot || snapshot.sessionId !== session.id || !allowStale && Date.now() - snapshot.timestamp > 15_000) throw Error('PoB is disconnected or its context is stale. Bring the PoB window to the foreground.');
  if (!snapshot.xml || snapshot.mode !== 'BUILD') throw Error('Open a build in PoB first.');
  if (!instanceContexts[snapshot.instanceId]) {
    instanceContexts[snapshot.instanceId] = (await installationVersion(session.install)).fingerprint;
    await atomicWrite(path.join(runtime, 'loaded-contexts.json'), instanceContexts);
  }
  return { ...snapshot, sourceFingerprint: instanceContexts[snapshot.instanceId] };
}
async function native(name, args, expected, signal) {
  const id = crypto.randomUUID();
  const command = { protocol: 1, sessionId: session.id, id, name, args, expectedBuildKey: expected.buildKey, expectedRevision: expected.revision, expectedXml: expected.revision ? undefined : expected.xml, deadline: Date.now() + 30_000 };
  await atomicWrite(path.join(runtime, 'command.json'), command);
  try {
    for (let i = 0; i < 300; i++) {
      signal?.throwIfAborted();
      const ack = await readJson(path.join(runtime, 'ack.json'));
      if (ack?.id === id && ack.sessionId === session.id) {
        if (ack.error) throw Error(ack.error);
        return ack.result;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('PoB did not respond within 30 seconds.');
  } finally { await fs.rm(path.join(runtime, 'command.json'), { force: true }); }
}
async function handle(request) {
  if (request.sessionId !== session.id || request.protocol !== 1 || !/^[\w-]{1,100}$/.test(request.id)) throw Error('Invalid protocol or request from another session.');
  if (request.type === 'cancel') { activeController?.abort(); loginController?.abort(); return; }
  if (request.type === 'login' || request.type === 'auth_status') {
    if (ui.busy || ui.authPending) throw Error('Wait for or cancel the current operation first.');
    if (request.settings) await handle({ ...request, type: 'settings' });
    if (request.type === 'auth_status') {
      ui.auth = await checkAuth(settings, { dir: runtime });
      ui.status = ui.auth.signedIn ? `${settings.provider}: signed in.` : `${settings.provider}: not signed in. Click Sign in to open your browser.`;
      await publish(); return;
    }
    const selected = { ...settings };
    const controller = new AbortController(); loginController = controller;
    ui.authPending = true; ui.status = 'Opening your browser. Complete sign-in there, then return to PoB.'; await publish();
    browserLogin(selected, { dir: runtime, signal: controller.signal }).then(state => {
      ui.auth = state; ui.status = `${selected.provider}: signed in. You can start chatting.`;
    }).catch(error => {
      ui.status = controller.signal.aborted ? 'Sign-in cancelled.' : error.message;
    }).finally(async () => { loginController = null; ui.authPending = false; await publish(); }).catch(reportError);
    return;
  }
  if (request.type === 'settings') {
    if (ui.busy || ui.authPending) throw Error('Wait for or cancel the current operation before changing the CLI.');
    const data = request.settings;
    if (!['codex', 'claude'].includes(data.provider)) throw Error('Invalid provider.');
    if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(data.effort || '')) throw Error('Invalid reasoning effort.');
    if (data.access && !['full', 'pob'].includes(data.access)) throw Error('Invalid access mode.');
    const model = String(data.model || '').trim().slice(0, 150);
    const modelSelections = {};
    for (const provider of ['codex', 'claude']) modelSelections[provider] = String(data.modelSelections?.[provider] ?? settings.modelSelections?.[provider] ?? (settings.provider === provider ? settings.model : '') ?? '').trim().slice(0, 150);
    modelSelections[data.provider] = model;
    settings = { provider: data.provider, model, modelSelections, effort: data.effort || '', executable: String(data.executable || '').slice(0, 1000), research: data.research !== false, access: data.access || settings.access || 'full' };
    await atomicWrite(path.join(root, '.pob-helper/settings.json'), settings);
    ui.settings = settings; ui.status = 'Ready. Tell me what you want to do.'; await publish(); return;
  }
  if (ui.busy || ui.authPending) throw Error('An operation is already running.');
  if (request.type === 'clear_chat') {
    if (request.buildKey !== activeKey) throw Error('The open build changed. Clear the chat again.');
    if (request.createdAt && Date.now() - request.createdAt > 120_000) throw Error('This clear request expired. Try again.');
    ui.messages = [];
    if (activeKey) histories.set(activeKey, ui.messages);
    ui.proposal = null;
    ui.chatClearedAt = Date.now();
    ui.status = 'Chat cleared. What would you like to do?';
    await publish(); return;
  }
  const snapshot = await snapshotNow();
  if (request.buildKey !== snapshot.buildKey) throw Error('This request belongs to a different open build. Submit it again.');
  if (request.type !== 'chat' && request.createdAt && Date.now() - request.createdAt > 120_000) throw Error('This queued request expired. Submit it again.');
  if (request.type === 'apply' || request.type === 'undo') {
    const proposal = request.type === 'apply' ? ui.proposal : lastUndo;
    if (!proposal) throw Error('No changes are available.');
    const currentVersion = await installationVersion(session.install);
    if (snapshot.pobVersion !== currentVersion.version || proposal.fingerprint && proposal.fingerprint !== currentVersion.fingerprint) throw Error('PoB was updated. Restart it and run a new analysis.');
    if (proposal.buildKey !== snapshot.buildKey || proposal.baseHash !== hash(snapshot.revision || snapshot.xml)) throw Error('The build changed. Run a new analysis before applying or undoing.');
    const backup = path.join(runtime, 'backups', `${Date.now()}-${request.type}.xml`);
    await atomicWrite(backup, snapshot.xml);
    const result = await native('apply', { xml: proposal.xml }, snapshot);
    if (!result.applied || result.buildKey !== snapshot.buildKey || !result.committedRevision) throw Error('PoB did not confirm the change. The backup was preserved.');
    lastUndo = request.type === 'undo' ? null : { xml: snapshot.xml, baseHash: hash(result.committedRevision), buildKey: result.buildKey, fingerprint: currentVersion.fingerprint };
    ui.proposal = null; ui.canUndo = !!lastUndo;
    ui.status = request.type === 'undo' ? 'Changes undone. The previous build state was restored.' : 'Changes applied to the open build. Use Ctrl+S in PoB to save the file.';
    ui.messages.push({ role: 'system', text: request.type === 'undo' ? 'The previous change was undone.' : 'Proposal applied. A recovery backup was saved.' });
    await publish(); return;
  }
  if (request.type !== 'chat') throw Error('Unknown request.');
  if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 12_000) throw Error('Invalid message (maximum 12,000 characters).');
  if (request.settings) await handle({ ...request, type: 'settings' });
  const key = snapshot.buildKey;
  if (!histories.has(key)) histories.set(key, []);
  const history = histories.get(key);
  const prior = history.slice();
  history.push({ role: 'user', text: request.text });
  ui.messages = history; ui.proposal = null; ui.busy = true;
  ui.startedAt = Date.now(); ui.workMessage = ''; activityStatus = 'Reading your build and request...';
  const controller = new AbortController(); activeController = controller;
  try {
    await publish();
    const result = await chat({ text: request.text, history: prior, snapshot, settings, install: session.install, dir: path.join(runtime, 'turns', request.id), signal: controller.signal, native, progress: (status, details) => { progress(status, details).catch(() => {}); } });
    controller.signal.throwIfAborted();
    const current = await snapshotNow({ allowStale: true });
    if (current.buildKey !== key) throw Error('You switched builds during analysis. The response was discarded.');
    const sourceText = result.sources.length ? '\n\nSources consulted:\n' + result.sources.join('\n') : '';
    history.push({ role: 'assistant', text: result.message + sourceText });
    if (result.candidate) ui.proposal = { title: result.proposalTitle || 'Suggested changes', xml: result.candidate, operations: result.operations, baseHash: hash(snapshot.revision || snapshot.xml), buildKey: key, fingerprint: result.version.fingerprint };
    ui.status = result.candidate ? 'Proposal ready. Review the changes before applying.' : 'Analysis complete.';
  } catch (error) { history.push({ role: 'system', text: controller.signal.aborted ? 'Analysis cancelled.' : error.message }); ui.status = 'See the message in the chat.'; }
  finally { activeController = null; ui.busy = false; ui.workMessage = ''; ui.lastCompletedRequest = request.id; if (activeKey === key) ui.messages = history; await publish(); }
}
async function tick() {
  if (Date.now() - modelsCheckedAt >= 30_000) {
    modelsCheckedAt = Date.now();
    const models = await modelCatalog();
    if (JSON.stringify(models) !== JSON.stringify(ui.models)) { ui.models = models; await publish(); }
  }
  await atomicWrite(path.join(runtime, 'heartbeat.json'), { sessionId: session.id, time: Date.now(), pid: process.pid });
  if (ui.busy && ui.startedAt && Date.now() - elapsedPublishedAt >= 10_000) {
    elapsedPublishedAt = Date.now(); ui.status = `${activityStatus || 'Working on your request...'} | ${elapsedLabel()}`; await publish();
  }
  if (ui.status === syncBusyMessage) { ui.status = ui.busy ? 'Working on your request...' : 'Connected. Ready for your next message.'; await publish(); }
  const live = await readJson(path.join(runtime, 'snapshot.json'));
  if (live?.instanceId && live.xml && !instanceContexts[live.instanceId]) {
    instanceContexts[live.instanceId] = (await installationVersion(session.install)).fingerprint;
    await atomicWrite(path.join(runtime, 'loaded-contexts.json'), instanceContexts);
  }
  if (live?.buildKey && activeKey !== live.buildKey) {
    activeController?.abort(); activeKey = live.buildKey;
    ui.messages = histories.get(activeKey) || []; ui.proposal = null; lastUndo = null; ui.canUndo = false;
    await publish();
  }
  const entries = (await fs.readdir(path.join(runtime, 'inbox'))).filter(name => /^[\w-]+\.json$/.test(name));
  const timestamps = await Promise.all(entries.map(async name => ({ name, time: (await fs.stat(path.join(runtime, 'inbox', name))).mtimeMs })));
  const files = timestamps.sort((a, b) => a.time - b.time).map(entry => entry.name);
  for (const file of files.slice(0, 10)) {
    const full = path.join(runtime, 'inbox', file);
    const stat = await fs.stat(full); if (stat.size > 100_000) { await fs.rm(full); continue; }
    const request = await readJson(full);
    if (!request) continue;
    if (request.type === 'cancel') { await fs.rm(full); await handle(request); continue; }
    if (processing) continue;
    await fs.rm(full);
    processing = true;
    handle(request).catch(reportError).finally(() => { processing = false; });
  }
}
await fs.mkdir(path.join(runtime, 'inbox'), { recursive: true });
await publish();
let ticking = false;
const timer = setInterval(() => { if (ticking) return; ticking = true; tick().catch(reportError).finally(() => { ticking = false; }); }, 400);
// The standalone entry point survives updates; never rewrite official PoB sources.
const lifecycleTimer = setInterval(async () => {
  try {
    if (await readJson(path.join(runtime, 'uninstalled.json'))) { await stop(); return; }
  } catch (error) { await reportError(error); }
}, 4000);
async function stop() { clearInterval(timer); clearInterval(lifecycleTimer); activeController?.abort(); loginController?.abort(); await lock.close(); await fs.rm(path.join(runtime, 'backend.lock'), { force: true }); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
