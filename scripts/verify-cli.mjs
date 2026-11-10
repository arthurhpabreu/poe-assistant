import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCli } from '../src/cli.mjs';
import { responseSchema } from '../src/agent.mjs';
import { readJson } from '../src/files.mjs';

const arg = process.argv.indexOf('--provider');
const provider = arg >= 0 ? process.argv[arg + 1] : 'codex';
const session = await readJson('.pob-helper/session.json');
const configured = await readJson('.pob-helper/settings.json', {});
const settings = { ...configured, provider, executable: configured.provider === provider ? configured.executable : '' };
const dir = path.join(session.runtime, 'verification', `cli-${provider}-${crypto.randomUUID()}`);
const result = await runCli({ settings, dir, schema: responseSchema, prompt: 'This is a CLI integration test. Do not call any native tool or access files. Return only the required structured JSON: message "PoB Helper CLI connected", tools [], operations [], proposalTitle "", sources [].' });
if (!result.message || result.tools?.length || result.operations?.length) throw Error('Unexpected protocol.');
console.log(JSON.stringify({ provider, message: result.message, protocol: 'passed' }));
