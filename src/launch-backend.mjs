// Fixed native entry: PoB starts bundled Node directly, without a shell or
// PowerShell execution-policy dependency. No provider/auth environment changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readJson } from './files.mjs';

const index = process.argv.indexOf('--session');
if (index < 0 || !process.argv[index + 1]) throw Error('Specify the installed session.');
const sessionFile = path.resolve(process.argv[index + 1]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let session = await readJson(sessionFile);
if (!/^pobhelper-[\w-]+$/.test(session?.id || '')) throw Error('Invalid assistant session.');
const state = path.dirname(sessionFile), destination = path.dirname(state);
const verificationComplete = () => session.verification && readJson(path.join(state, 'verification-complete.json'));
if (await verificationComplete()) process.exit(0);
if (session.direct) {
  session = { ...session, root, state, destination, runtime: path.join(state, 'sessions', session.id),
    install: path.resolve(destination, session.installRelative || '..'), node: process.execPath };
  await atomicWrite(sessionFile, session);
}
const runtime = session.runtime;
const lock = path.join(runtime, 'backend.lock'), shutdown = path.join(runtime, 'shutdown.json');
const heartbeatFile = path.join(runtime, 'heartbeat.json');
const alive = pid => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await fs.mkdir(runtime, { recursive: true });
try {
  const marker = await readJson(shutdown);
  if (marker) {
    if (marker.sessionId !== session.id) throw Error('Shutdown marker belongs to another session.');
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      const pid = Number(await fs.readFile(lock, 'utf8').catch(() => '0'));
      if (!pid || !alive(pid)) { await fs.rm(lock, { force: true }); break; }
      await sleep(100);
    }
    if (await fs.stat(lock).catch(() => null)) throw Error('The previous assistant is still stopping. Reopen PoB in a moment.');
    await fs.rm(shutdown, { force: true });
  }
  const before = await readJson(heartbeatFile);
  const lockedPid = Number(await fs.readFile(lock, 'utf8').catch(() => '0'));
  if (before?.sessionId === session.id && before.pid === lockedPid && Date.now() - before.time < 12000 && alive(lockedPid)) {
    await fs.rm(path.join(runtime, 'backend-start-error.json'), { force: true }); process.exit(0);
  }
  if (lockedPid && !alive(lockedPid)) await fs.rm(lock, { force: true });
  if (await verificationComplete()) process.exit(0);
  const output = await fs.open(path.join(runtime, 'backend-output.log'), 'a');
  const error = await fs.open(path.join(runtime, 'backend-error.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(root, 'src/server.mjs'), '--session', sessionFile], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output.fd, error.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await output.close(); await error.close(); }
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    if (await verificationComplete()) process.exit(0);
    const beat = await readJson(heartbeatFile);
    if (beat?.sessionId === session.id && Date.now() - beat.time < 3000 && alive(beat.pid)) {
      await fs.rm(path.join(runtime, 'backend-start-error.json'), { force: true }); process.exit(0);
    }
    await sleep(100);
  }
  throw Error('Assistant did not start. See backend-error.log.');
} catch (error) {
  await atomicWrite(path.join(runtime, 'backend-start-error.json'), { time: Date.now(), error: error.message });
  console.error(error.message); process.exitCode = 1;
}
