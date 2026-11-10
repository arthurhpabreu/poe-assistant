import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, readJson } from './files.mjs';

export async function nativeCommand({ runtime, sessionId, name, args, expected, signal, onDispatch, timeoutMs = name === 'apply' ? 120_000 : 30_000 }) {
  const id = crypto.randomUUID(), deadline = Date.now() + timeoutMs;
  const command = { protocol: 1, sessionId, id, name, args, expectedBuildKey: expected.buildKey, expectedInstanceId: expected.instanceId,
    expectedRevision: expected.revision, expectedXml: expected.revision ? undefined : expected.xml, deadline };
  if (name === 'apply') await fs.mkdir(path.join(runtime, 'receipts'), { recursive: true });
  await onDispatch?.(command);
  await atomicWrite(path.join(runtime, 'command.json'), command);
  try {
    do {
      signal?.throwIfAborted();
      const ack = await readJson(path.join(runtime, 'ack.json'));
      if (ack?.id === id && ack.sessionId === sessionId) {
        if (ack.error) { const error = Error(ack.error); error.code = 'NATIVE_REJECTED'; throw error; }
        return ack.result;
      }
      // A durable receipt is immutable: never infer a commit from a later,
      // potentially manually edited snapshot when an acknowledgement is lost.
      if (name === 'apply') {
        const receipt = await readJson(path.join(runtime, 'receipts', id + '.json'));
        if (receipt?.id === id && receipt.sessionId === sessionId && receipt.instanceId === expected.instanceId && receipt.buildKey === expected.buildKey) {
          if (receipt.error) { const error = Error(receipt.error); error.code = 'NATIVE_REJECTED'; throw error; }
          if (receipt.result?.applied && receipt.result.committedRevision) return { ...receipt.result, reconciled: true };
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    } while (Date.now() < deadline);
    const error = Error(name === 'apply'
      ? 'PoB did not confirm the application. Its outcome is unknown; the proposal was disabled to prevent a duplicate application. Check the open build and recovery backup before starting a new analysis.'
      : 'PoB did not respond. Bring its window to the foreground and try again.');
    error.code = name === 'apply' ? 'APPLY_UNCONFIRMED' : 'NATIVE_TIMEOUT';
    throw error;
  } catch (failure) {
    if (name !== 'apply') throw failure;
    // Explicit native rejection is known to have rolled back/not committed.
    if (failure.code === 'NATIVE_REJECTED') throw failure;
    const receipt = await readJson(path.join(runtime, 'receipts', id + '.json')).catch(() => null);
    if (receipt?.id === id && receipt.sessionId === sessionId && receipt.instanceId === expected.instanceId && receipt.buildKey === expected.buildKey) {
      if (receipt.error) throw Error(receipt.error);
      if (receipt.result?.applied && receipt.result.committedRevision) return { ...receipt.result, reconciled: true };
    }
    const error = Error('PoB application could not be confirmed. Do not retry this proposal; check the open build and recovery backup. ' + failure.message);
    error.code = 'APPLY_UNCONFIRMED'; throw error;
  } finally {
    // A cleanup failure must never replace a confirmed commit result.
    try {
      const current = await readJson(path.join(runtime, 'command.json'));
      if (current?.id === id) await fs.rm(path.join(runtime, 'command.json'), { force: true });
    } catch { /* The unique command ID prevents replay. */ }
  }
}
