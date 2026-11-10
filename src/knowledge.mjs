import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DOMParser } from '@xmldom/xmldom';
import { safeSource, hash } from './files.mjs';

const allowedHosts = ['pathofexile.com', 'www.pathofexile.com', 'reddit.com', 'www.reddit.com', 'old.reddit.com', 'poewiki.net', 'www.poewiki.net', 'github.com', 'raw.githubusercontent.com'];
export function researchUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHosts.includes(url.hostname)) throw Error('Use HTTPS URLs from the official forum, Reddit, PoE Wiki or GitHub.');
  return url;
}
export function isResearchResult(value) {
  try {
    const url = researchUrl(value);
    return /pathofexile\.com$/.test(url.hostname) && /^\/forum\/view-thread\//i.test(url.pathname)
      || /reddit\.com$/.test(url.hostname) && /^\/r\/pathofexile(?:builds)?\/comments\//i.test(url.pathname)
      || /poewiki\.net$/.test(url.hostname) && /^\/wiki\//.test(url.pathname) && !/\/(Path_of_Exile_Wiki|Main_Page)$/i.test(url.pathname);
  } catch { return false; }
}
async function fetchBounded(url, validateRedirect = researchUrl) {
  for (let count = 0; count < 4; count++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'PobHelper/0.1 (local build research)' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) { url = validateRedirect(new URL(response.headers.get('location'), url).href); continue; }
    if (!response.ok) throw Error(`Source returned HTTP ${response.status}; content was not verified.`);
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 2_000_000) throw Error('Source is too large.'); chunks.push(chunk); }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw Error('Too many redirects.');
}
export async function fetchEvidence(value) {
  const url = researchUrl(value);
  const raw = await fetchBounded(url);
  const content = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  if (content.length < 250 || /blocked by network security|you.ve been blocked|captcha|access denied/i.test(content.slice(0, 1200))) throw Error('The source blocked access or did not provide verifiable content.');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/<[^>]+>/g, ' ').replaceAll('&amp;', '&').trim() || '';
  return { url: url.href, title, fetchedAt: new Date().toISOString(), untrustedEvidence: true, content: content.slice(0, 18_000), truncated: content.length > 18_000 };
}
export async function searchEvidence(query) {
  if (typeof query !== 'string' || query.length > 300) throw Error('Invalid search query.');
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('format', 'rss');
  url.searchParams.set('q', `${query} (site:pathofexile.com/forum OR site:reddit.com/r/pathofexile OR site:poewiki.net)`);
  const raw = await fetchBounded(url, value => { const u = new URL(value); if (u.protocol !== 'https:' || !['www.bing.com', 'bing.com'].includes(u.hostname)) throw Error('Invalid search redirect.'); return u; });
  const doc = new DOMParser().parseFromString(raw, 'text/xml');
  const results = Array.from(doc.getElementsByTagName('item')).map(item => ({ title: item.getElementsByTagName('title')[0]?.textContent, url: item.getElementsByTagName('link')[0]?.textContent, excerpt: item.getElementsByTagName('description')[0]?.textContent })).filter(item => isResearchResult(item.url));
  if (results.length) return results.slice(0, 8);
  const fallback = new URL('https://html.duckduckgo.com/html/');
  fallback.searchParams.set('q', `${query} (site:pathofexile.com/forum OR site:reddit.com/r/pathofexile OR site:poewiki.net)`);
  const html = await fetchBounded(fallback, value => { const u = new URL(value); if (u.protocol !== 'https:' || !['html.duckduckgo.com', 'duckduckgo.com'].includes(u.hostname)) throw Error('Invalid search redirect.'); return u; });
  for (const match of html.matchAll(/<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /href=["']([^"']+)["']/.exec(match[1])?.[1]?.replaceAll('&amp;', '&');
    if (!href) continue;
    const link = new URL(href, fallback);
    const candidate = link.searchParams.get('uddg') || link.href;
    if (isResearchResult(candidate)) results.push({ title: match[2].replace(/<[^>]*>/g, ''), url: candidate, excerpt: 'Read this source with fetch_web to verify it.' });
  }
  if (!results.length) throw Error('Public search returned no verifiable sources. Try different terms or provide the thread URL.');
  return results.slice(0, 8);
}
export async function installationVersion(install) {
  const manifest = await fs.readFile(path.join(install, 'manifest.xml'), 'utf8');
  const game = await fs.readFile(path.join(install, 'GameVersions.lua'), 'utf8');
  const stamps = [];
  // Check every code/data file used by PoB, including changes before manifest commit.
  for (const folder of ['Modules', 'Classes', 'Data', 'TreeData']) {
    const base = path.join(install, folder);
    let entries; try { entries = await fs.readdir(base, { recursive: true, withFileTypes: true }); } catch(e) { if(e.code === 'ENOENT') continue; throw e; }
    const sources = entries.filter(entry => entry.isFile() && /\.(lua|json|xml)$/i.test(entry.name));
    for (let offset = 0; offset < sources.length; offset += 64) {
      const batch = await Promise.all(sources.slice(offset, offset + 64).map(async entry => {
        const file = path.join(entry.parentPath, entry.name), stat = await fs.stat(file);
        return `${path.relative(install, file)}:${stat.size}:${stat.mtimeMs}`;
      }));
      stamps.push(...batch);
    }
  }
  stamps.sort();
  return { version: /<Version[^>]*number="([^"]+)/.exec(manifest)?.[1] || 'unknown', fingerprint: hash(manifest + game + stamps.join('\n')), gameVersions: game.slice(0, 10_000) };
}
export async function readSource(install, args) {
  const file = await safeSource(install, args.path);
  const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
  const start = Math.max(1, Number(args.start) || 1), count = Math.min(200, Math.max(1, Number(args.count) || 100));
  return { path: args.path, totalLines: lines.length, content: lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line}`).join('\n'), currentInstalledSource: true };
}
export async function searchSource(install, args) {
  const scope = ['Modules', 'Classes', 'Data', 'TreeData'].includes(args.scope) ? args.scope : 'Modules';
  if (typeof args.query !== 'string' || !args.query.length || args.query.length > 150) throw Error('Invalid query.');
  return new Promise((resolve, reject) => {
    const child = spawn('rg', ['-n', '-i', '-F', '--max-count', '4', '--glob', '*.lua', '--glob', '!ModCache.lua', '--', args.query, path.join(install, scope)], { shell: false, windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 30_000) child.kill(); });
    child.stderr.on('data', data => { error += data; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); if (code > 1) reject(Error(error || 'Local search failed.')); else resolve({ scope, query: args.query, matches: output.replaceAll(install + path.sep, '').slice(0, 24_000), truncated: output.length > 24_000 }); });
  }).catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    const base = path.join(install, scope), matches = [];
    const entries = await fs.readdir(base, { recursive: true, withFileTypes: true });
    let size = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.lua') || entry.name === 'ModCache.lua') continue;
      const file = path.join(entry.parentPath, entry.name);
      const relative = path.relative(install, file), safe = await safeSource(install, relative);
      const lines = (await fs.readFile(safe, 'utf8')).split(/\r?\n/); let hits = 0;
      for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(args.query.toLowerCase())) {
        const line = `${relative}:${i + 1}:${lines[i]}`; matches.push(line); size += line.length;
        if (++hits >= 4 || size > 24000) break;
      }
      if (size > 24000) break;
    }
    return { scope, query: args.query, matches: matches.join('\n').slice(0,24000), truncated: size > 24000 };
  });
}
