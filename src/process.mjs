import { spawn } from 'node:child_process';

async function terminateTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('close', code => { if (code) child.kill(); resolve(); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

// Own the AbortSignal so descendants are terminated before the CLI itself exits.
export async function runProcess(command, args, { cwd, input = '', signal, timeoutMs = 0, maxOutput = 12_000_000, captureOutput = true, onLine = () => {} } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw Error('Invalid process timeout. Use 0 for no deadline.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '', stderr = '', buffer = '', bytes = 0, failure, termination, discardingLine = false;
    const fail = error => { if (!failure) { failure = error; termination = terminateTree(child); } };
    const abort = () => fail(Object.assign(Error('CLI request cancelled.'), { name: 'AbortError' }));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => fail(Error('The CLI operation timed out.')), timeoutMs) : null;
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.stdout.on('data', data => {
      bytes += data.length;
      if (maxOutput > 0 && bytes > maxOutput) { fail(Error('The CLI exceeded the output limit.')); return; }
      if (captureOutput) stdout += data.toString();
      buffer += data.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (discardingLine) { discardingLine = false; continue; }
        if (line.length <= 1_000_000) try { onLine(line); } catch { /* progress is best effort */ }
      }
      if (buffer.length > 1_000_000) { buffer = ''; discardingLine = true; }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', async code => {
      cleanup(); if (termination) await termination;
      if (failure) reject(failure);
      else if (code !== 0) reject(Error(`CLI exited with code ${code}: ${stderr.slice(-1800) || stdout.slice(-1800)}`));
      else resolve(stdout);
    });
    if (signal?.aborted) abort();
  });
}
