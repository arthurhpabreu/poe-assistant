import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const writes = new Map();
const lockDelays = [10, 20, 40, 80, 120, 180, 250, 350, 500];
async function retryFileOperation(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const transient = ['EBUSY', 'ETXTBSY'].includes(error.code) || process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code);
      if (!transient || attempt >= lockDelays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, lockDelays[attempt]));
    }
  }
}
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await retryFileOperation(() => fs.readFile(file, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback; throw e; }
}
export async function atomicWrite(file, value) {
  const destination = path.resolve(file);
  const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
  // Capture mutable UI state now, then commit writes in invocation order.
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const previous = writes.get(key);
  const pending = (previous || Promise.resolve()).catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const tmp = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await retryFileOperation(() => fs.writeFile(tmp, text, 'utf8'));
      // Never unlink the destination: readers must keep seeing the last valid file.
      await retryFileOperation(() => fs.rename(tmp, destination));
    } catch (error) {
      await retryFileOperation(() => fs.rm(tmp, { force: true })).catch(() => {});
      throw error;
    }
  });
  writes.set(key, pending);
  try { await pending; }
  finally { if (writes.get(key) === pending) writes.delete(key); }
}
export function scopedPath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes(':')) throw Error('Invalid relative path.');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw Error('Path is outside the installation.');
  return resolved;
}
export async function safeSource(root, relative) {
  const resolved = scopedPath(root, relative);
  const real = await fs.realpath(resolved);
  if (!real.startsWith(await fs.realpath(root) + path.sep)) throw Error('Link is outside the installation.');
  if (!/\.(lua|json|xml|txt|md)$/i.test(real)) throw Error('Source file type is not allowed.');
  return real;
}
