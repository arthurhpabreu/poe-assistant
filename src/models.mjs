import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Only model metadata is read. Authentication and CLI configuration stay untouched.
export async function modelCatalog({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  const codex = [];
  try {
    const file = path.join(codexHome, 'models_cache.json');
    if ((await fs.stat(file)).size > 2_000_000) throw Error('Model cache is too large.');
    const cache = JSON.parse(await fs.readFile(file, 'utf8'));
    const seen = new Set();
    for (const model of (Array.isArray(cache.models) ? cache.models : []).slice().sort((a, b) => (a?.priority ?? 999) - (b?.priority ?? 999))) {
      if (!model || model.visibility !== 'list' || typeof model.slug !== 'string' || !/^[\w.:[\]-]{1,150}$/.test(model.slug) || seen.has(model.slug)) continue;
      seen.add(model.slug);
      codex.push({ id: model.slug, label: String(model.display_name || model.slug).replace(/[\x00-\x1f\x7f^]/g, '').slice(0, 80) });
      if (codex.length >= 50) break;
    }
  } catch { /* A fresh CLI may have no cache yet. Default and Custom remain available. */ }
  // Stable Claude Code aliases resolve through the user's installed CLI/account.
  return { codex, claude: [{ id: 'sonnet', label: 'Sonnet (latest)' }, { id: 'opus', label: 'Opus (latest)' }, { id: 'haiku', label: 'Haiku (latest)' }] };
}
