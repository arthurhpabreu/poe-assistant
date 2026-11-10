import { parseBuild } from './xml.mjs';
import fs from 'node:fs';
const released = JSON.parse(fs.readFileSync(new URL('./released-leagues.json', import.meta.url), 'utf8'));

export function leagueWindow(gameVersions, { now = Date.now(), evidence = released } = {}) {
  if (!Number.isFinite(now) || now < Date.parse(evidence.verifiedAt) || now >= Date.parse(evidence.validUntil)) throw Error('Released-league evidence has expired. Update PoE Assistant before creating or recommending builds; installed tree versions alone do not prove the current league.');
  const list = /treeVersionList\s*=\s*\{([\s\S]*?)\}/.exec(gameVersions)?.[1] || '';
  const installed = new Set([...list.matchAll(/"(\d+_\d+)"/g)].map(m => m[1]));
  const versions = [evidence.current,evidence.previous];
  if (versions.some(v => !installed.has(v))) throw Error('Cannot identify the current and previous league in installed PoB data. Update PoB.');
  return { current: versions[0], previous: versions[1], allowed: versions, patches: versions.map(v => v.replace('_','.')), verifiedAt: evidence.verifiedAt, validUntil: evidence.validUntil, evidence: evidence.evidence, rule: 'Only the current and previous released league; no legacy builds or legacy unique variants.' };
}
export function assertLeagueBuild(xml, policy) {
  const doc = parseBuild(xml);
  for (const spec of Array.from(doc.getElementsByTagName('Spec'))) {
    const version = spec.getAttribute('treeVersion');
    if (version && !policy.allowed.includes(version.replace(/_(?:ruthless|alternate).*$/, ''))) throw Error(`Legacy tree ${version} is blocked. Only ${policy.patches.join(' and ')} are allowed.`);
  }
}
export function sourceLeague(title, policy, { requireVersion = true } = {}) {
  const versions = [...String(title).matchAll(/\b(\d+)\.(\d+)(?:\.\d+[a-z]?)?/g)].map(m => `${m[1]}.${m[2]}`);
  if (versions.length && !versions.some(v => policy.patches.includes(v))) throw Error(`Legacy source is blocked: ${title}. Use ${policy.patches.join(' or ')}.`);
  if (requireVersion && !versions.some(v => policy.patches.includes(v))) throw Error('Source does not explicitly identify the current or previous league. It cannot be used as build evidence.');
  return { allowed: true, patches: versions.filter(v => policy.patches.includes(v)) };
}
