import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectClis } from './cli.mjs';

export function authInvocation(settings, executable, action) {
  if (!['codex', 'claude'].includes(settings.provider)) throw Error('Invalid provider.');
  if (!path.isAbsolute(executable) || !/\.(exe|m?js)$/i.test(executable)) throw Error('Choose an absolute CLI .exe or .js entry point.');
  const args = settings.provider === 'codex'
    ? action === 'status' ? ['login', 'status'] : ['login']
    : action === 'status' ? ['auth', 'status', '--json'] : ['auth', 'login', '--claudeai'];
  return /\.m?js$/i.test(executable) ? { command: process.execPath, args: [executable, ...args] } : { command: executable, args };
}
async function runAuth(settings, action, { dir, signal, timeout = 15_000 } = {}) {
  const executable = settings.executable || (await detectClis())[settings.provider];
  if (!executable) throw Error('CLI not found. Set its executable path in Settings.');
  const call = authInvocation(settings, executable, action);
  return new Promise((resolve, reject) => {
    const child = spawn(call.command, call.args, { cwd: dir, shell: false, windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    // Never publish or log OAuth URLs, codes, tokens, account details or raw auth output.
    if (action === 'status') child.stdout.on('data', data => { output = (output + data).slice(-40_000); });
    else child.stdout.resume();
    child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(Error(action === 'status' ? 'Login status timed out.' : 'Sign-in timed out. Click Sign in to try again.')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
export async function checkAuth(settings, options = {}) {
  const result = await runAuth(settings, 'status', options);
  let signedIn = result.code === 0;
  if (settings.provider === 'claude') {
    try { signedIn = JSON.parse(result.output).loggedIn === true; } catch { signedIn = false; }
  }
  return { provider: settings.provider, signedIn, checkedAt: Date.now() };
}
export async function browserLogin(settings, options = {}) {
  // Called ONLY after the user clicks Sign in. The CLI opens the system browser
  // and owns its native OAuth callback and credential storage. No logout/profile switch.
  const result = await runAuth(settings, 'login', { ...options, timeout: 600_000 });
  if (result.code !== 0) throw Error('Sign-in did not complete. Click Sign in to try again.');
  const state = await checkAuth(settings, options);
  if (!state.signedIn) throw Error('The CLI has not confirmed sign-in. Try again.');
  return state;
}
