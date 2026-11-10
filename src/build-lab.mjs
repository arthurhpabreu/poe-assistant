import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { atomicWrite, hash, readJson, scopedPath } from './files.mjs';
import { applyOperations, parseBuild } from './xml.mjs';
import { installationVersion } from './knowledge.mjs';
import { runProcess } from './process.mjs';
import { leagueWindow, assertLeagueBuild } from './league-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function calculationHash(xml) {
  const doc = parseBuild(xml);
  for (const tag of ['Notes', 'PlayerStat', 'MinionStat', 'FullDPSSkill']) for (const node of Array.from(doc.getElementsByTagName(tag))) node.parentNode.removeChild(node);
  for (const node of Array.from(doc.getElementsByTagName('Build'))) node.removeAttribute('viewMode');
  return hash(new XMLSerializer().serializeToString(doc));
}
export function rankCandidates(base, candidates, { objective = 'FullDPS', minimums = {}, maximums = {} } = {}) {
  if (typeof objective !== 'string' || objective.length > 100) throw Error('Invalid objective stat.');
  for (const limits of [minimums, maximums]) {
    if (!limits || Array.isArray(limits) || typeof limits !== 'object' || Object.keys(limits).length > 30 || Object.values(limits).some(v => !Number.isFinite(v))) throw Error('Constraints must map stat names to finite numbers.');
  }
  return candidates.map(candidate => {
    const output = candidate.report?.output || {}, violations = [];
    if (candidate.error) violations.push(candidate.error);
    violations.push(...(candidate.report?.validation?.errors || []));
    for (const [key, limit] of Object.entries(minimums)) if (!Number.isFinite(output[key]) || output[key] < limit) violations.push(`${key} must be >= ${limit}; measured ${output[key] ?? 'unavailable'}`);
    for (const [key, limit] of Object.entries(maximums)) if (!Number.isFinite(output[key]) || output[key] > limit) violations.push(`${key} must be <= ${limit}; measured ${output[key] ?? 'unavailable'}`);
    const delta = {}; for (const [key,value] of Object.entries(output)) if (Number.isFinite(value) && Number.isFinite(base.output[key])) delta[key] = value - base.output[key];
    return { ...candidate, delta, feasible: !violations.length, violations, score: Number.isFinite(output[objective]) ? output[objective] : null };
  }).sort((a,b) => Number(b.feasible) - Number(a.feasible) || (b.score ?? -Infinity) - (a.score ?? -Infinity));
}
export function validateLoadedBuild(requestedXml, normalizedXml, report) {
  const requested = parseBuild(requestedXml), normalized = parseBuild(normalizedXml), errors = [];
  const requestedSpecs = Array.from(requested.getElementsByTagName('Spec')), loadedSpecs = Array.from(normalized.getElementsByTagName('Spec'));
  for (let i = 0; i < requestedSpecs.length; i++) {
    const spec = requestedSpecs[i], loaded = loadedSpecs[i];
    if (!loaded) { errors.push(`Tree set ${i + 1} was not loaded.`); continue; }
    for (const attr of ['treeVersion','classId','ascendClassId','secondaryAscendClassId']) if (spec.hasAttribute(attr) && spec.getAttribute(attr) !== loaded.getAttribute(attr)) errors.push(`PoB changed tree ${i + 1} ${attr} during loading.`);
    const loadedNodes = new Set((loaded.getAttribute('nodes') || '').split(',').filter(Boolean));
    for (const id of (spec.getAttribute('nodes') || '').split(',').filter(Boolean)) if (!loadedNodes.has(id)) errors.push(`Passive ${id} was not retained in tree ${i + 1}.`);
    const wantedMasteries = spec.getAttribute('masteryEffects') || '';
    const actualMasteries = new Set((loaded.getAttribute('masteryEffects') || '').match(/\{\d+,\d+\}/g) || []);
    for (const mastery of wantedMasteries.match(/\{\d+,\d+\}/g) || []) if (!actualMasteries.has(mastery)) errors.push(`Mastery ${mastery} was not retained in tree ${i + 1}.`);
  }
  const build = requested.getElementsByTagName('Build')[0];
  if (build.hasAttribute('level') && Number(build.getAttribute('level')) !== report.level) errors.push('Character level was changed during loading/automatic level estimation. Disable automatic level mode if a fixed level is intended.');
  return errors;
}

// Copy only files named by the installed official manifest: never settings,
// auth stores, builds, native runtime config, update staging or addon launchers.
export async function prepareEngine(install, cacheDir, version, signal) {
  const destination = path.join(cacheDir, version.fingerprint.slice(0,16));
  if (destination.length > 155) throw Error('The isolated PoB engine path is too long for its native file I/O. Install PoE Assistant in a shorter directory.');
  const ready = await readJson(path.join(destination, 'assistant-engine.json'));
  if (ready?.fingerprint === version.fingerprint && Array.isArray(ready.files)) {
    for (const [name,digest] of ready.files) {
      signal?.throwIfAborted();
      if (hash(await fs.readFile(scopedPath(destination,name))) !== digest) throw Error('The isolated engine was modified. Remove this session engine cache and retry.');
    }
    return destination;
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const stage = destination + '-' + crypto.randomUUID();
  await fs.mkdir(stage);
  try {
    const manifest = await fs.readFile(path.join(install, 'manifest.xml'), 'utf8');
    const doc = new DOMParser().parseFromString(manifest, 'text/xml');
    const names = new Set(['manifest.xml', ...Array.from(doc.getElementsByTagName('File')).map(node => node.getAttribute('name').replaceAll('{space}', ' '))]);
    const allowed = /^(?:(?:Modules|Classes|Data|TreeData|Assets|SimpleGraphic|lua)\/.+|[^/]+\.(?:dll|exe|lua|xml|txt|md))$/i;
    const digests = [];
    for (const name of names) {
      signal?.throwIfAborted();
      if (!allowed.test(name) || /(?:^|\/)(?:settings\.(?:xml|json)|imgui\.ini|SimpleGraphic\.cfg|first\.run|installed\.cfg)$/i.test(name)) continue;
      const source = scopedPath(install, name), target = scopedPath(stage, name);
      const real = await fs.realpath(source);
      if (!real.startsWith(await fs.realpath(install) + path.sep)) throw Error('Engine source link escapes installation.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      if (/\.(lua|json|xml|dll|exe)$/i.test(name)) digests.push([name, hash(await fs.readFile(target))]);
    }
    await fs.access(path.join(stage, 'Path of Building.exe'));
    await fs.access(path.join(stage, 'GameVersions.lua'));
    if ((await installationVersion(install)).fingerprint !== version.fingerprint) throw Error('PoB changed while the calculator engine was copied.');
    await atomicWrite(path.join(stage, 'assistant-engine.json'), { fingerprint: version.fingerprint, digest: hash(JSON.stringify(digests)), files: digests });
    await fs.rename(stage, destination);
    return destination;
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}

function workerLauncher(engine, runDir) {
  const literal = value => JSON.stringify(value.replaceAll('\\', '/'));
  return `#@ SimpleGraphic
local workerDir = ${literal(runDir)}
local originalPLoad = PLoadModule
local function finish(result)
 local json = require('dkjson')
 local file = assert(io.open(workerDir .. '/result.json', 'wb'))
 file:write(json.encode(result)); file:close()
end
PLoadModule = function(name, ...)
 local err, object = originalPLoad(name, ...)
 if name == 'Modules/Main' and not err and object then
  PLoadModule = originalPLoad
  local init = object.Init
  object.SaveSettings = function() end
  object.Shutdown = function() end
  object.CanExit = function() return true end
  object.ChangeUserPath = function(self)
   self.userPath = workerDir .. '/user/'
   self.defaultBuildPath = self.userPath .. 'Builds/'
   self.buildPath = self.defaultBuildPath
  end
  object.Init = function(self)
   arg = {}; self.disableDevAutoSave = true
   local ok, failure = pcall(function()
    init(self)
    self.disableDevAutoSave = true; self.newMode = nil; self.mode = 'BUILD'
    local input = assert(io.open(workerDir .. '/build.xml', 'rb'))
    local xml = input:read('*a'); input:close()
    local build = self.modes.BUILD
    build:Init(nil, 'PoE Assistant candidate', xml, false, nil)
    assert(build.savers and build.targetVersion == liveTargetVersion and build.calcsTab.mainEnv and not self.newMode, 'Build initialization failed or requires conversion.')
    assert(#self.popups == 0, 'Build initialization opened an error or conversion dialog.')
    local lab = assert(loadfile(${literal(path.join(root, 'addon/BuildLab.lua'))}))()
    local inspections = {}
    local inspectFile = io.open(workerDir .. '/inspect.json', 'rb')
    if inspectFile then
     local requests = require('dkjson').decode(inspectFile:read('*a')); inspectFile:close()
     for _, request in ipairs(requests) do inspections[#inspections + 1] = lab.catalog(build, request) end
    end
    finish({ ok = true, report = lab.report(build), inspections = inspections, normalizedXml = build:SaveDB('Candidate validation') })
   end)
   if not ok then finish({ ok = false, error = tostring(failure) }) end
   launch.assistantFinished = true
  end
 end
 return err, object
end
assert(loadfile(${literal(path.join(engine, 'Launch.lua'))}))()
launch.CheckForUpdate = function() end
launch.ApplyUpdate = function() error('Updates are disabled in the isolated calculator.') end
launch.OnExit = function() end
launch.CanExit = function() return true end
launch.ShowErrMsg = function(self, format, ...)
 finish({ ok = false, error = string.format(format, ...) }); self.assistantFinished = true
end
launch.OnFrame = function(self)
 if self.assistantFinished then Exit() end
end
`;
}

export async function calculateBuild({ engine, xml, dir, signal, inspections }) {
  parseBuild(xml);
  await fs.mkdir(path.join(dir, 'user', 'Builds'), { recursive: true });
  await atomicWrite(path.join(dir, 'build.xml'), xml);
  if (inspections) await atomicWrite(path.join(dir,'inspect.json'),inspections);
  const launcher = path.join(engine, `AssistantWorker-${crypto.randomUUID()}.lua`);
  await atomicWrite(launcher, workerLauncher(engine, dir));
  try {
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/run-worker.ps1'), '-Executable', path.join(engine, 'Path of Building.exe'), '-Script', launcher, '-Directory', engine], { cwd: engine, signal, timeoutMs: 180_000 });
  } finally { await fs.rm(launcher, { force: true }); }
  const result = await readJson(path.join(dir, 'result.json'));
  if (!result?.ok || !result.report?.output) throw Error(result?.error || 'The isolated PoB calculator did not return a result.');
  result.report.validation ||= { errors: [] };
  result.report.validation.errors.push(...validateLoadedBuild(xml,result.normalizedXml,result.report));
  return result;
}

export async function evaluateBuilds({ args, snapshot, install, dir, cacheDir = path.join(dir, 'engine-cache'), signal, version, progress = () => {} }) {
  const candidates = args.candidates || (args.operations ? [{ label: args.label || 'Candidate', operations: args.operations }] : []);
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 8) throw Error('Compare 1 to 8 complete candidates per call.');
  const xmls = candidates.map(candidate => ({ label: String(candidate.label || 'Candidate').slice(0, 120), xml: applyOperations(snapshot.xml, candidate.operations) }));
  progress('Preparing an isolated copy of the current PoB calculator...');
  version ||= await installationVersion(install);
  const policy = leagueWindow(version.gameVersions);
  assertLeagueBuild(snapshot.xml, policy);
  for (const candidate of xmls) assertLeagueBuild(candidate.xml, policy);
  const engine = await prepareEngine(install, cacheDir, version, signal);
  const batchDir = path.join(engine, 'requests', crypto.randomUUID().slice(0,12));
  progress('Calculating the original build in isolation...');
  const base = await calculateBuild({ engine, xml: snapshot.xml, dir: path.join(batchDir, 'base'), signal });
  const reports = [];
  for (let i = 0; i < xmls.length; i++) {
    signal?.throwIfAborted();
    progress(`Calculating candidate ${i + 1} of ${xmls.length}...`);
    try {
      const result = await calculateBuild({ engine, xml: xmls[i].xml, dir: path.join(batchDir, String(i)), signal });
      reports.push({ label: xmls[i].label, xmlHash: hash(xmls[i].xml), calculationHash: calculationHash(xmls[i].xml), report: result.report });
    } catch(error) { signal?.throwIfAborted(); reports.push({ label: xmls[i].label, xmlHash: hash(xmls[i].xml), error: error.message }); }
  }
  if ((await installationVersion(install)).fingerprint !== version.fingerprint) throw Error('PoB changed during candidate calculation. Restart PoB.');
  const ranked = rankCandidates(base.report, reports, args);
  const result = { baseHash: hash(snapshot.xml), fingerprint: version.fingerprint, objective: args.objective || 'FullDPS', minimums: args.minimums || {}, maximums: args.maximums || {}, base: base.report, candidates: ranked,
    note: 'Ranked only among measured candidates. A missing objective stat is not zero. Configuration differences are included explicitly. No global optimum is claimed.' };
  await atomicWrite(path.join(batchDir, 'comparison.json'), result);
  return result;
}
