#!/usr/bin/env node
// baseline — cross-platform installer / verifier / status / doctor / uninstaller
// for the baseline injection-routes dispatcher. Runs on Windows and Linux.
//
// Usage (run with node from the repo root):
//   node scripts/manage.js status              report what's installed vs the repo source + config
//   node scripts/manage.js install [--preset <name>] [--force]
//   node scripts/manage.js verify              functional check: does a route fire?
//   node scripts/manage.js update              redeploy from repo, re-sync settings wiring
//   node scripts/manage.js doctor [--fix]      validate config + wiring; --fix repairs
//   node scripts/manage.js uninstall           remove per-agent wiring + links (keeps central config)
//   node scripts/manage.js help
//
// Design notes:
// - There is ONE central install root, OMNE_HOME or ~/.omne. The canonical
//   deployed dispatcher (hooks/baseline-recital.js) and the editable config folder
//   (cfg/baseline/: config.json + docs/) live there. The repo is the source of
//   truth for the .js; install always overwrites the central .js from it.
// - Each agent's config dir (Claude: CLAUDE_CONFIG_DIR or ~/.claude) gets LINKS
//   back into the center: hooks/baseline-recital.js and cfg/baseline/ point at the
//   central copies. Editing ~/.omne/cfg/baseline/* changes live behavior for every
//   wired agent (when the link layer can use a symlink; copy fallback is degraded).
// - settings.json and .baseline-counters.json stay REAL, per-agent files. Settings
//   wiring is config-driven: install wires our one dispatcher command into EXACTLY
//   the events the config's routes use, and unwires events no route references, so
//   the high-frequency PreToolUse/PostToolUse hooks never spawn for nothing.
// - The config folder is seeded from a repo PRESET (presets/<name>/) and is never
//   clobbered without --force. There is no legacy baseline.md migration — the
//   system is pre-release and install seeds the new model fresh.
// - Native Zig runtime is PAUSED for the routes feature (ADR-0001): the dispatcher
//   is Node-only for v1. `--runtime prebuilt|build` is refused.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

// --- types -----------------------------------------------------------------

interface AgentPaths {
  name: string;
  configDir: string;
  settings: string;
  counters: string;
  hooksDir: string;
  hookJs: string;
  cfgDir: string;
}

interface ReadJsonResult {
  ok: boolean;
  value: any;
  missing: boolean;
  error: Error | null;
}

interface HookEntry {
  type: string;
  command: string;
  timeout: number;
  statusMessage: string;
}

interface LinkState {
  ok: boolean;
  mechanism: string;
}

interface Route {
  id: string;
  event: string;
  matcher?: string;
  freq: number;
  cwd?: string;
  doc: string;
}

interface RouteIssue {
  level: 'fail' | 'warn';
  msg: string;
}

interface ConfigReport {
  present: boolean;
  fatal: string | null;     // config-level fault — the dispatcher injects nothing
  routes: Route[];          // valid, deduped routes
  issues: RouteIssue[];     // per-route fail/warn findings (for doctor)
  desiredEvents: string[];  // unique events the valid routes use
}

type CheckLevel = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  fixable?: boolean;
}

interface InstallOpts {
  preset: string;
  force: boolean;
}

// --- constants -------------------------------------------------------------

const SUPPORTED_EVENTS = ['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse'];
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const KNOWN_ROUTE_KEYS = ['id', 'event', 'matcher', 'freq', 'cwd', 'doc'];
const DEFAULT_PRESET = 'minimal';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_DOC_BYTES = 64 * 1024;
const MAX_ROUTES = 64;

// --- platform + path resolution -------------------------------------------

const isWin = process.platform === 'win32';
const homeDir = os.homedir();

// Repo root resolved relative to this file (scripts/ sits directly under root).
const repoRoot = path.resolve(__dirname, '..');

// Central install root: explicit override, else ~/.omne.
const centralRoot = process.env.OMNE_HOME || path.join(homeDir, '.omne');

const central = {
  root:     centralRoot,
  hooksDir: path.join(centralRoot, 'hooks'),
  hookJs:   path.join(centralRoot, 'hooks', 'baseline-recital.js'),
  cfgDir:   path.join(centralRoot, 'cfg', 'baseline'),
  config:   path.join(centralRoot, 'cfg', 'baseline', 'config.json'),
  docsDir:  path.join(centralRoot, 'cfg', 'baseline', 'docs'),
};

const repo = {
  hookSourceJs: path.join(repoRoot, 'scripts', 'baseline-recital.js'),
  presetsDir:   path.join(repoRoot, 'presets'),
};

// --- agent registry --------------------------------------------------------

type Agent = Pick<AgentPaths, 'name' | 'configDir'>;

function agentRegistry(): Agent[] {
  return [
    {
      name: 'claude-code',
      configDir: process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'),
    },
  ];
}

// Derive every per-agent path. hookJs and cfgDir are LINKS to the center;
// settings.json and counters are real per-agent files.
function agentPaths(agent: Agent): AgentPaths {
  const d = agent.configDir;
  return {
    name:      agent.name,
    configDir: d,
    settings:  path.join(d, 'settings.json'),
    counters:  path.join(d, '.baseline-counters.json'),
    hooksDir:  path.join(d, 'hooks'),
    hookJs:    path.join(d, 'hooks', 'baseline-recital.js'),
    cfgDir:    path.join(d, 'cfg', 'baseline'),
  };
}

function allAgentPaths(): AgentPaths[] {
  return agentRegistry().map(agentPaths);
}

function fail(message: string, code?: number): never {
  console.error('[baseline] ' + message);
  process.exit(code || 1);
}

// Quote a single arg for embedding in the settings.json command STRING.
const quoteArg = (s: string): string => '"' + String(s).replace(/"/g, '\\"') + '"';

// --- file helpers ----------------------------------------------------------

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function copyFileAtomic(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, fs.readFileSync(src)); // Buffer in, Buffer out
  fs.renameSync(tmp, dest);
}

// Recursively copy a directory tree (used to deploy a preset and as the config
// link copy-fallback).
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readJson(file: string): ReadJsonResult {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), missing: false, error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, value: null, missing: true, error: null };
    }
    return { ok: false, value: null, missing: false, error: e };
  }
}

// Validate the settings.json shape across EVERY supported event group, so a
// malformed hooks tree is never rewritten.
function settingsShapeError(settings: any): string | null {
  if (!settings) return null;
  if (typeof settings !== 'object' || Array.isArray(settings)) return 'root must be an object';
  if (settings.hooks == null) return null;
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return 'hooks must be an object';
  for (const event of SUPPORTED_EVENTS) {
    const groups = settings.hooks[event];
    if (groups == null) continue;
    if (!Array.isArray(groups)) return 'hooks.' + event + ' must be an array';
    for (let i = 0; i < groups.length; i++) {
      const hooks = groups[i] && groups[i].hooks;
      if (hooks != null && !Array.isArray(hooks)) return 'hooks.' + event + '[' + i + '].hooks must be an array';
    }
  }
  return null;
}

function settingsOrEmptyForWrite(ap: AgentPaths): any {
  const r = readJson(ap.settings);
  if (!r.ok) {
    throw new Error('refusing to rewrite invalid settings.json: ' + r.error!.message);
  }
  const settings = r.value || {};
  const shapeError = settingsShapeError(settings);
  if (shapeError) {
    throw new Error('refusing to rewrite invalid settings.json: ' + shapeError);
  }
  return settings;
}

function settingsForRead(ap: AgentPaths): { settings: any; error: Error | null } {
  const r = readJson(ap.settings);
  if (!r.ok) return { settings: {}, error: r.error };
  const settings = r.value || {};
  const shapeError = settingsShapeError(settings);
  return shapeError
    ? { settings: {}, error: new Error(shapeError) }
    : { settings, error: null };
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aa = path.resolve(a);
  const bb = path.resolve(b);
  return isWin ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

// --- link layer (cross-platform) -------------------------------------------

// Remove a symlink or regular file at p. Refuses to remove a real directory.
function removeIfLinkOrFile(p: string): void {
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) { return; } // absent
  if (st.isDirectory() && !st.isSymbolicLink()) {
    throw new Error('refusing to replace a real directory with a link: ' + p);
  }
  fs.unlinkSync(p);
}

// Link a central FILE into linkPath: symlink, else hardlink, else copy. Copy is
// reported as degraded (central edits won't propagate through it).
function linkInto(target: string, linkPath: string): string {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  removeIfLinkOrFile(linkPath);
  try {
    fs.symlinkSync(target, linkPath, isWin ? 'file' : undefined);
    return 'symlink';
  } catch (e) { /* fall through */ }
  try {
    fs.linkSync(target, linkPath);
    return 'hardlink';
  } catch (e) { /* fall through */ }
  copyFileAtomic(target, linkPath);
  return 'copy';
}

// Classify a per-agent FILE link relative to the central target.
function linkState(linkPath: string, target: string): LinkState {
  let lst;
  try { lst = fs.lstatSync(linkPath); }
  catch (e) { return { ok: false, mechanism: 'missing' }; }

  if (lst.isSymbolicLink()) {
    let resolved;
    try { resolved = fs.readlinkSync(linkPath); }
    catch (e) { return { ok: false, mechanism: 'broken' }; }
    const abs = path.isAbsolute(resolved) ? resolved : path.resolve(path.dirname(linkPath), resolved);
    return samePath(abs, target) ? { ok: true, mechanism: 'symlink' } : { ok: false, mechanism: 'wrong' };
  }

  try {
    const a = fs.statSync(linkPath);
    const b = fs.statSync(target);
    if (a.ino !== 0 && a.dev === b.dev && a.ino === b.ino) return { ok: true, mechanism: 'hardlink' };
  } catch (e) { /* target may be missing */ }
  try {
    if (fs.readFileSync(linkPath).equals(fs.readFileSync(target))) return { ok: true, mechanism: 'copy' };
  } catch (e) { /* unreadable */ }
  return { ok: false, mechanism: 'stale' };
}

function describeLink(s: LinkState): string {
  if (s.ok) return 'OK (' + s.mechanism + (s.mechanism === 'copy' ? ' — degraded, edits will not propagate' : '') + ')';
  return s.mechanism.toUpperCase();
}

// Remove a per-agent FILE link we created (symlink or matching copy/hardlink).
// Refuses to delete a real, divergent file.
function removeOurLink(linkPath: string, target: string): boolean {
  let lst;
  try { lst = fs.lstatSync(linkPath); }
  catch (e) { return false; } // absent
  if (lst.isSymbolicLink()) {
    try { fs.unlinkSync(linkPath); return true; } catch (e) { return false; }
  }
  if (linkState(linkPath, target).ok) {
    try { fs.unlinkSync(linkPath); return true; } catch (e) { return false; }
  }
  return false; // real, divergent file — leave it
}

// --- config-folder link (a directory, linked as a unit) --------------------

// Link the central cfg/baseline FOLDER into linkPath: directory symlink, else a
// recursive copy (degraded — central edits won't propagate). A real directory at
// linkPath is replaced only when it looks like our managed config (has config.json).
function linkConfigInto(target: string, linkPath: string): string {
  let lst = null;
  try { lst = fs.lstatSync(linkPath); } catch (e) {}
  if (lst) {
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      fs.unlinkSync(linkPath);
    } else {
      if (!fs.existsSync(path.join(linkPath, 'config.json'))) {
        throw new Error('refusing to replace a non-baseline directory with a link: ' + linkPath);
      }
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(target, linkPath, isWin ? 'dir' : undefined);
    return 'symlink';
  } catch (e) { /* fall through */ }
  copyDir(target, linkPath);
  return 'copy';
}

// Classify the per-agent config-folder link relative to the central folder.
function configLinkState(linkPath: string, target: string): LinkState {
  let lst;
  try { lst = fs.lstatSync(linkPath); }
  catch (e) { return { ok: false, mechanism: 'missing' }; }
  if (lst.isSymbolicLink()) {
    let resolved;
    try { resolved = fs.readlinkSync(linkPath); }
    catch (e) { return { ok: false, mechanism: 'broken' }; }
    const abs = path.isAbsolute(resolved) ? resolved : path.resolve(path.dirname(linkPath), resolved);
    return samePath(abs, target) ? { ok: true, mechanism: 'symlink' } : { ok: false, mechanism: 'wrong' };
  }
  if (lst.isDirectory()) {
    try {
      if (fs.readFileSync(path.join(linkPath, 'config.json')).equals(fs.readFileSync(path.join(target, 'config.json')))) {
        return { ok: true, mechanism: 'copy' };
      }
    } catch (e) { /* unreadable */ }
    return { ok: false, mechanism: 'stale' };
  }
  return { ok: false, mechanism: 'stale' };
}

// Remove the per-agent config link we created (symlink or matching copy).
function removeOurConfigLink(linkPath: string, target: string): boolean {
  let lst;
  try { lst = fs.lstatSync(linkPath); }
  catch (e) { return false; }
  if (lst.isSymbolicLink()) {
    try { fs.unlinkSync(linkPath); return true; } catch (e) { return false; }
  }
  if (configLinkState(linkPath, target).ok) {
    try { fs.rmSync(linkPath, { recursive: true, force: true }); return true; } catch (e) { return false; }
  }
  return false;
}

// --- command-string parsing ------------------------------------------------

// settings.json command that runs the agent's Node .js dispatcher.
function jsCommand(ap: AgentPaths): string {
  return quoteArg(process.execPath) + ' ' + quoteArg(ap.hookJs);
}

function parseCommandLine(command: unknown): string[] | null {
  if (typeof command !== 'string' || !command.trim()) return null;
  const args: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && i + 1 < command.length && command[i + 1] === quote) {
        cur += command[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { args.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  if (cur) args.push(cur);
  return args.length ? args : null;
}

// A settings command is ours when it runs this agent's deployed dispatcher .js.
function isOurCommand(command: unknown, ap: AgentPaths): boolean {
  const argv = parseCommandLine(command);
  if (!argv) return false;
  return argv.length >= 2 && samePath(argv[1], ap.hookJs);
}

// --- settings.json surgery (config-driven, across all events) --------------

function findOurHookInGroups(groups: any, ap: AgentPaths): HookEntry | null {
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    for (const h of (Array.isArray(group.hooks) ? group.hooks : [])) {
      if (h && isOurCommand(h.command, ap)) return h;
    }
  }
  return null;
}

function findOurCommand(settings: any, ap: AgentPaths): HookEntry | null {
  if (!settings.hooks) return null;
  for (const event of SUPPORTED_EVENTS) {
    const h = findOurHookInGroups(settings.hooks[event], ap);
    if (h) return h;
  }
  return null;
}

// Which supported events currently carry our hook.
function wiredEvents(settings: any, ap: AgentPaths): string[] {
  const out: string[] = [];
  if (!settings.hooks) return out;
  for (const event of SUPPORTED_EVENTS) {
    if (findOurHookInGroups(settings.hooks[event], ap)) out.push(event);
  }
  return out;
}

// Wire our one dispatcher command into EXACTLY desiredEvents and unwire it from
// every other supported event. One settings read + write; preserves co-residents.
function syncWiring(ap: AgentPaths, command: string, desiredEvents: string[]): { wired: string[]; unwired: string[] } {
  const settings = settingsOrEmptyForWrite(ap);
  settings.hooks = settings.hooks || {};
  const result = { wired: [] as string[], unwired: [] as string[] };

  for (const event of SUPPORTED_EVENTS) {
    const want = desiredEvents.indexOf(event) !== -1;
    if (want) {
      settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      const existing = findOurHookInGroups(settings.hooks[event], ap);
      if (existing) {
        existing.command = command;
        existing.timeout = 5;
        existing.statusMessage = 'Baseline check...';
      } else {
        const entry: HookEntry = { type: 'command', command, timeout: 5, statusMessage: 'Baseline check...' };
        if (settings.hooks[event].length && settings.hooks[event][0].hooks) {
          settings.hooks[event][0].hooks.push(entry);
        } else {
          settings.hooks[event].push({ hooks: [entry] });
        }
      }
      result.wired.push(event);
    } else {
      const groups = settings.hooks[event];
      if (!Array.isArray(groups)) continue;
      let removed = false;
      for (const group of groups) {
        if (!Array.isArray(group.hooks)) continue;
        const before = group.hooks.length;
        group.hooks = group.hooks.filter((h: any) => !(h && isOurCommand(h.command, ap)));
        if (group.hooks.length !== before) removed = true;
      }
      settings.hooks[event] = groups.filter((g: any) => g.hooks && g.hooks.length);
      if (!settings.hooks[event].length) delete settings.hooks[event];
      if (removed) result.unwired.push(event);
    }
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  atomicWrite(ap.settings, JSON.stringify(settings, null, 2) + '\n');
  return result;
}

// Remove our hook from every supported event (uninstall).
function unwireAll(ap: AgentPaths): string[] {
  return syncWiring(ap, jsCommand(ap), []).unwired;
}

// --- config loading / validation -------------------------------------------

// Resolve a route's `doc` against the central config dir; reject escapes.
function safeDocPath(doc: string): string | null {
  if (typeof doc !== 'string' || !doc) return null;
  if (path.isAbsolute(doc)) return null;
  const resolved = path.resolve(central.cfgDir, doc);
  const rel = path.relative(central.cfgDir, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

// Load + validate the central config.json. Mirrors the dispatcher's fail-open
// selection, but also collects per-route issues so doctor/status can report them.
function loadCentralConfig(): ConfigReport {
  const report: ConfigReport = { present: false, fatal: null, routes: [], issues: [], desiredEvents: [] };

  let raw: string;
  try {
    const st = fs.statSync(central.config);
    report.present = true;
    if (st.size > MAX_CONFIG_BYTES) { report.fatal = 'config.json exceeds 64 KiB cap'; return report; }
    raw = fs.readFileSync(central.config, 'utf8');
  } catch (e) {
    return report; // absent
  }

  let cfg: any;
  try { cfg = JSON.parse(raw); } catch (e) { report.fatal = 'config.json is not valid JSON'; return report; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { report.fatal = 'config.json root must be an object'; return report; }
  if (cfg.version === undefined) report.issues.push({ level: 'warn', msg: 'config.json has no "version"; assuming 1' });
  else if (cfg.version !== 1) { report.fatal = 'config.json version must be 1 (got ' + JSON.stringify(cfg.version) + ')'; return report; }

  const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
  if (!Array.isArray(cfg.routes)) report.issues.push({ level: 'warn', msg: 'config.json has no "routes" array; treating as empty' });
  if (routes.length > MAX_ROUTES) { report.fatal = 'config.json has ' + routes.length + ' routes (cap is ' + MAX_ROUTES + ')'; return report; }

  const seen: { [id: string]: true } = {};
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const where = 'route #' + (i + 1);
    if (!r || typeof r !== 'object' || Array.isArray(r)) { report.issues.push({ level: 'fail', msg: where + ' is not an object' }); continue; }
    const label = typeof r.id === 'string' ? '"' + r.id + '"' : where;
    if (typeof r.id !== 'string' || !SLUG.test(r.id)) { report.issues.push({ level: 'fail', msg: where + ' has an invalid id (must match ' + SLUG.source + ')' }); continue; }
    if (seen[r.id]) { report.issues.push({ level: 'fail', msg: 'duplicate route id ' + label + ' (later occurrence skipped)' }); continue; }
    if (typeof r.event !== 'string' || SUPPORTED_EVENTS.indexOf(r.event) === -1) { report.issues.push({ level: 'fail', msg: 'route ' + label + ' has unsupported event ' + JSON.stringify(r.event) }); continue; }
    const docPath = safeDocPath(r.doc);
    if (!docPath) { report.issues.push({ level: 'fail', msg: 'route ' + label + ' has an invalid or out-of-range doc ' + JSON.stringify(r.doc) }); continue; }
    let freq = 1;
    if (r.freq !== undefined) {
      if (typeof r.freq !== 'number' || !Number.isInteger(r.freq) || r.freq < 1) { report.issues.push({ level: 'fail', msg: 'route ' + label + ' has a non-positive-integer freq' }); continue; }
      freq = r.freq;
    }
    if (r.matcher !== undefined && typeof r.matcher !== 'string') { report.issues.push({ level: 'fail', msg: 'route ' + label + ' matcher must be a string' }); continue; }
    if (r.cwd !== undefined && typeof r.cwd !== 'string') { report.issues.push({ level: 'fail', msg: 'route ' + label + ' cwd must be a string' }); continue; }
    if ((r.event === 'PreToolUse' || r.event === 'PostToolUse') && typeof r.matcher === 'string') {
      try { new RegExp(r.matcher); } catch (e) { report.issues.push({ level: 'fail', msg: 'route ' + label + ' matcher is not a valid regex' }); continue; }
    }
    // doc readability + size (a route past validation but whose doc is gone still fails doctor).
    try {
      const st = fs.statSync(docPath);
      if (st.size > MAX_DOC_BYTES) report.issues.push({ level: 'fail', msg: 'route ' + label + ' doc exceeds 64 KiB cap' });
    } catch (e) {
      report.issues.push({ level: 'fail', msg: 'route ' + label + ' doc not readable: ' + r.doc });
    }
    for (const key of Object.keys(r)) {
      if (KNOWN_ROUTE_KEYS.indexOf(key) === -1) report.issues.push({ level: 'warn', msg: 'route ' + label + ' has unrecognized key "' + key + '"' });
    }
    seen[r.id] = true;
    report.routes.push({ id: r.id, event: r.event, matcher: r.matcher, freq, cwd: r.cwd, doc: r.doc });
  }

  const events: string[] = [];
  for (const r of report.routes) if (events.indexOf(r.event) === -1) events.push(r.event);
  report.desiredEvents = events;
  return report;
}

// --- preset deployment -----------------------------------------------------

// Establish the central config folder. Keep an existing one unless --force; else
// deploy presets/<name>/ wholesale. Returns 'kept' | 'seeded' | 'replaced'.
function ensureCentralConfig(opts: InstallOpts): string {
  const exists = fs.existsSync(central.config);
  if (exists && !opts.force) return 'kept';

  const presetSrc = path.join(repo.presetsDir, opts.preset);
  if (!fs.existsSync(path.join(presetSrc, 'config.json'))) {
    throw new Error('preset "' + opts.preset + '" not found (expected ' + path.join(presetSrc, 'config.json') + ')');
  }
  if (exists) fs.rmSync(central.cfgDir, { recursive: true, force: true });
  copyDir(presetSrc, central.cfgDir);
  return exists ? 'replaced' : 'seeded';
}

// --- commands --------------------------------------------------------------

function cmdInstall(opts: InstallOpts): void {
  const agentsP = allAgentPaths();

  // 1. Refuse before any deploy if an agent settings file is invalid.
  for (const ap of agentsP) settingsOrEmptyForWrite(ap);

  // 2. ALWAYS deploy the canonical .js to the CENTER (overwrite; repo wins).
  if (!fs.existsSync(repo.hookSourceJs)) {
    fail('install: compiled dispatcher missing at ' + repo.hookSourceJs + ' — run `npm run build` first.', 1);
  }
  fs.mkdirSync(central.hooksDir, { recursive: true });
  atomicWrite(central.hookJs, fs.readFileSync(repo.hookSourceJs, 'utf8'));

  // 3. Establish the central config folder (seed/keep/replace).
  const configState = ensureCentralConfig(opts);

  // 4. Read the config to learn which events to wire.
  const cfg = loadCentralConfig();

  // 5. For each agent: link the center in, then wire settings for the config's events.
  const perAgent = [];
  for (const ap of agentsP) {
    const jsMech = linkInto(central.hookJs, ap.hookJs);
    const cfgMech = linkConfigInto(central.cfgDir, ap.cfgDir);
    const command = jsCommand(ap);
    const sync = syncWiring(ap, command, cfg.desiredEvents);
    perAgent.push({ name: ap.name, configDir: ap.configDir, jsMech, cfgMech, sync });
  }

  console.log('[baseline] install complete');
  console.log('  central       : ' + central.root);
  console.log('  runtime       : node js');
  console.log('  dispatcher    : ' + central.hookJs);
  console.log('  config folder : ' + central.cfgDir + ' (' + configState + ', preset: ' + opts.preset + ')');
  console.log('  routes        : ' + cfg.routes.length + (cfg.desiredEvents.length ? ' over [' + cfg.desiredEvents.join(', ') + ']' : ' (no events wired)'));
  if (cfg.fatal) console.log('  config WARNING: ' + cfg.fatal + ' — run doctor');
  for (const a of perAgent) {
    console.log('  agent ' + a.name + ' @ ' + a.configDir);
    console.log('    links       : dispatcher=' + a.jsMech + ', cfg=' + a.cfgMech);
    console.log('    wired       : ' + (a.sync.wired.length ? a.sync.wired.join(', ') : '(none)') +
      (a.sync.unwired.length ? '; unwired ' + a.sync.unwired.join(', ') : ''));
  }
  console.log('  next step     : open /hooks once (or restart) so Claude Code reloads settings.');
}

function cmdUninstall(): void {
  const agentsP = allAgentPaths();
  console.log('[baseline] uninstall');
  for (const ap of agentsP) {
    let unwired;
    try { unwired = unwireAll(ap); }
    catch (e) { fail('uninstall: ' + e.message, 1); }
    const jsGone = removeOurLink(ap.hookJs, central.hookJs);
    const cfgGone = removeOurConfigLink(ap.cfgDir, central.cfgDir);
    console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
    console.log('    settings    : ' + (unwired.length ? 'unwired ' + unwired.join(', ') : 'nothing wired'));
    console.log('    dispatcher  : ' + (jsGone ? 'unlinked' : 'absent'));
    console.log('    cfg folder  : ' + (cfgGone ? 'unlinked (central kept)' : 'left as-is'));
  }
  console.log('  central config : KEPT at ' + central.cfgDir + ' (delete by hand if you want it gone)');
}

function cmdStatus(): void {
  const agentsP = allAgentPaths();

  const jsExists = fs.existsSync(central.hookJs);
  let inSync = false;
  if (jsExists) {
    try { inSync = fs.readFileSync(central.hookJs, 'utf8') === fs.readFileSync(repo.hookSourceJs, 'utf8'); }
    catch (e) {}
  }
  const cfg = loadCentralConfig();

  console.log('[baseline] status');
  console.log('  central root   : ' + central.root);
  console.log('  dispatcher     : ' + (jsExists
    ? 'present' + (inSync ? ' (byte-identical to repo source)' : ' (DIFFERS from repo source — run install to refresh)')
    : 'not present'));
  console.log('  config folder  : ' + (cfg.present ? 'present at ' + central.cfgDir : 'missing (install will seed it)'));
  if (cfg.fatal) console.log('  config         : INVALID — ' + cfg.fatal);
  console.log('  routes         : ' + cfg.routes.length);
  for (const r of cfg.routes) {
    const bits = ['event=' + r.event, 'freq=' + r.freq];
    if (r.matcher !== undefined) bits.push('matcher=' + r.matcher);
    if (r.cwd !== undefined) bits.push('cwd=' + r.cwd);
    bits.push('doc=' + r.doc);
    console.log('    ' + r.id + ': ' + bits.join(', '));
  }
  for (const issue of cfg.issues) {
    console.log('    [' + issue.level + '] ' + issue.msg);
  }

  for (const ap of agentsP) {
    const { settings, error } = settingsForRead(ap);
    console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
    if (error) {
      console.log('    settings     : INVALID settings.json (' + error.message + ')');
    } else {
      const wired = wiredEvents(settings, ap);
      console.log('    settings     : ' + (wired.length ? 'wired [' + wired.join(', ') + ']' : 'not wired'));
    }
    console.log('    dispatcher   : ' + describeLink(linkState(ap.hookJs, central.hookJs)));
    console.log('    cfg folder   : ' + describeLink(configLinkState(ap.cfgDir, central.cfgDir)));
  }
}

// Build synthetic hook stdin for a route's event so verify can drive the wired
// dispatcher and confirm a route fires.
function synthInput(route: Route, sessionId: string, cwd: string): string {
  const data: any = { session_id: sessionId, hook_event_name: route.event, cwd };
  if (route.event === 'SessionStart') data.source = route.matcher || 'startup';
  if (route.event === 'PreToolUse' || route.event === 'PostToolUse') {
    data.tool_name = (route.matcher && /^[A-Za-z0-9_]+$/.test(route.matcher)) ? route.matcher : 'Bash';
  }
  return JSON.stringify(data);
}

// Functional check — drive the ACTUALLY-WIRED dispatcher (of the first agent) with
// synthetic stdin for `freq` invocations of one route's event, and confirm it stays
// silent until the freq-th, then fires with additionalContext.
function cmdVerify(): void {
  const ap = allAgentPaths()[0];
  const sr = settingsForRead(ap);
  if (sr.error) {
    console.log('[baseline] verify: FAIL — invalid settings.json: ' + sr.error.message);
    process.exit(1);
  }
  const ourHook = findOurCommand(sr.settings, ap);
  if (!ourHook) {
    console.log('[baseline] verify: FAIL — no baseline hook wired in settings. Run install.');
    process.exit(1);
  }
  const argv = parseCommandLine(ourHook.command);
  if (!argv) {
    console.log('[baseline] verify: FAIL — cannot parse wired command.');
    process.exit(1);
  }

  const cfg = loadCentralConfig();
  if (!cfg.routes.length) {
    console.log('[baseline] verify: FAIL — config has no valid routes' + (cfg.fatal ? ' (' + cfg.fatal + ')' : '') + '.');
    process.exit(1);
  }
  // Prefer a UserPromptSubmit route (matcher-free, deterministic); else the first.
  const route = cfg.routes.filter(r => r.event === 'UserPromptSubmit')[0] || cfg.routes[0];
  const cwd = route.cwd || process.cwd();
  const sid = 'baseline-verify-' + process.pid;

  let firedAt = 0;
  let firedText = '';
  let spawnErr: Error | null = null;
  for (let i = 1; i <= route.freq; i++) {
    const r = spawnSync(argv[0], argv.slice(1), { input: synthInput(route, sid, cwd), encoding: 'utf8' });
    if (r.error) { spawnErr = r.error; break; }
    const out = (r.stdout || '').trim();
    if (out) { firedAt = i; firedText = out; }
  }

  // Clean our synthetic counter entry so verify never pollutes real session state.
  try {
    const cr = readJson(ap.counters);
    if (cr.ok && cr.value && typeof cr.value === 'object') {
      delete cr.value[sid + ':' + route.id];
      atomicWrite(ap.counters, JSON.stringify(cr.value));
    }
  } catch (e) {}

  const ok = !spawnErr && firedAt === route.freq && firedText.includes('additionalContext');
  console.log('[baseline] verify: ' + (ok ? 'PASS' : 'FAIL'));
  console.log('  route tested  : ' + route.id + ' (' + route.event + ', freq ' + route.freq + ')');
  console.log('  fired on turn : ' + (firedAt || 'never'));
  if (spawnErr) console.log('  spawn error   : ' + spawnErr.message);
  else if (firedAt !== route.freq) console.log('  expected      : silent until turn ' + route.freq + ', then fire once');
  else if (!firedText.includes('additionalContext')) console.log('  problem       : fired, but output had no additionalContext field');
  if (!ok) process.exit(1);
}

// Re-deploy the central dispatcher + re-sync settings wiring from the CURRENT repo
// source and central config. Keeps the existing config folder (no preset reseed).
function cmdUpdate(): void {
  console.log('[baseline] update — redeploying dispatcher + re-syncing wiring from current config');
  console.log('');
  cmdInstall({ preset: DEFAULT_PRESET, force: false });
}

// Inspect the installation and return a list of checks.
function doctorChecks(): Check[] {
  const checks: Check[] = [];

  const jsExists = fs.existsSync(central.hookJs);
  if (!jsExists) {
    checks.push({ name: 'central dispatcher', level: 'fail', detail: 'not deployed at ' + central.hookJs, fixable: true });
  } else {
    let inSync = false;
    try { inSync = fs.readFileSync(central.hookJs, 'utf8') === fs.readFileSync(repo.hookSourceJs, 'utf8'); } catch (e) {}
    checks.push(inSync
      ? { name: 'central dispatcher', level: 'ok', detail: 'byte-identical to repo source' }
      : { name: 'central dispatcher', level: 'warn', detail: 'DIFFERS from repo source (stale — update will refresh)', fixable: true });
  }

  const cfg = loadCentralConfig();
  if (!cfg.present) {
    checks.push({ name: 'config.json', level: 'warn', detail: 'missing (install will seed a preset)', fixable: true });
  } else if (cfg.fatal) {
    checks.push({ name: 'config.json', level: 'fail', detail: cfg.fatal, fixable: false });
  } else {
    checks.push({ name: 'config.json', level: 'ok', detail: 'valid; ' + cfg.routes.length + ' route(s) over [' + cfg.desiredEvents.join(', ') + ']' });
  }
  for (const issue of cfg.issues) {
    checks.push({ name: 'route', level: issue.level, detail: issue.msg, fixable: false });
  }

  for (const ap of allAgentPaths()) {
    const sr = settingsForRead(ap);
    if (sr.error) {
      checks.push({ name: 'settings.json', level: 'fail', detail: 'invalid settings.json (' + sr.error.message + ') — fix by hand; install refuses to rewrite it', fixable: false });
      continue;
    }
    checks.push({ name: 'settings.json', level: 'ok', detail: 'valid JSON' });

    const wired = wiredEvents(sr.settings, ap);
    const missing = cfg.desiredEvents.filter(e => wired.indexOf(e) === -1);
    const stale = wired.filter(e => cfg.desiredEvents.indexOf(e) === -1);
    if (!missing.length && !stale.length) {
      checks.push({ name: 'settings wiring', level: cfg.desiredEvents.length ? 'ok' : 'warn',
        detail: cfg.desiredEvents.length ? 'wired for exactly [' + wired.join(', ') + ']' : 'no routes → nothing wired (expected)' });
    } else {
      const parts = [];
      if (missing.length) parts.push('missing [' + missing.join(', ') + ']');
      if (stale.length) parts.push('stale [' + stale.join(', ') + ']');
      checks.push({ name: 'settings wiring', level: 'fail', detail: 'wiring drift: ' + parts.join('; '), fixable: true });
    }

    const js = linkState(ap.hookJs, central.hookJs);
    if (js.ok && js.mechanism !== 'copy') checks.push({ name: 'dispatcher link', level: 'ok', detail: 'linked to center (' + js.mechanism + ')' });
    else if (js.ok) checks.push({ name: 'dispatcher link', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
    else checks.push({ name: 'dispatcher link', level: 'fail', detail: js.mechanism + ' — not linked to ' + central.hookJs, fixable: true });

    const cl = configLinkState(ap.cfgDir, central.cfgDir);
    if (cl.ok && cl.mechanism !== 'copy') checks.push({ name: 'config link', level: 'ok', detail: 'linked to center (' + cl.mechanism + ')' });
    else if (cl.ok) checks.push({ name: 'config link', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
    else if (!cfg.present) checks.push({ name: 'config link', level: 'warn', detail: 'central config missing — install will seed + link', fixable: true });
    else checks.push({ name: 'config link', level: 'fail', detail: cl.mechanism + ' — not linked to ' + central.cfgDir, fixable: true });
  }

  return checks;
}

function printDoctorChecks(checks: Check[]): void {
  const mark: { [level: string]: string } = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };
  for (const c of checks) {
    console.log('  ' + (mark[c.level] || '[????]') + ' ' + c.name + ': ' + c.detail);
  }
}

function cmdDoctor(fix: boolean): void {
  console.log('[baseline] doctor — scanning installation');
  console.log('  central root : ' + central.root);
  console.log('');
  let checks = doctorChecks();
  printDoctorChecks(checks);

  const problems = checks.filter(c => c.level !== 'ok');
  const fixable = problems.filter(c => c.fixable);

  if (!problems.length) {
    console.log('');
    console.log('[baseline] doctor: healthy.');
    return;
  }

  if (!fix) {
    console.log('');
    console.log('[baseline] doctor: ' + problems.length + ' issue(s) found' +
      (fixable.length ? ', ' + fixable.length + ' auto-fixable — rerun with --fix.' : ' (none auto-fixable; see notes above).'));
    process.exit(1);
  }

  // --fix: refuse while settings.json is invalid; else redeploy via update + rescan.
  if (checks.some(c => c.name === 'settings.json' && c.level === 'fail')) {
    console.log('');
    console.log('[baseline] doctor: settings.json is invalid JSON — fix it by hand first, then rerun --fix. Nothing was changed.');
    process.exit(1);
  }
  if (!fixable.length) {
    console.log('');
    console.log('[baseline] doctor: nothing auto-fixable. Manual action needed for the issues above.');
    process.exit(1);
  }
  console.log('');
  console.log('[baseline] doctor --fix: repairing via update...');
  console.log('');
  try {
    cmdUpdate();
  } catch (e) {
    fail('doctor --fix: ' + e.message, 1);
  }
  console.log('');
  console.log('[baseline] doctor: re-scanning after fix...');
  console.log('');
  checks = doctorChecks();
  printDoctorChecks(checks);
  const remaining = checks.filter(c => c.level !== 'ok');
  console.log('');
  if (remaining.length) {
    console.log('[baseline] doctor: ' + remaining.length + ' issue(s) remain after fix — manual action needed.');
    process.exit(1);
  }
  console.log('[baseline] doctor: installation repaired.');
}

// --- help / arg parsing -----------------------------------------------------

function printHelp(): void {
  console.log('baseline — manage the injection-routes dispatcher (cross-platform: Windows + Linux)');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/manage.js status                  Report what is installed vs the repo source + config.');
  console.log('  node scripts/manage.js install [--preset <n>]  Deploy the dispatcher, seed the config preset, link agents, wire settings.');
  console.log('  node scripts/manage.js verify                  Functionally test a wired route (does it fire?).');
  console.log('  node scripts/manage.js update                  Redeploy dispatcher + re-sync settings wiring from current config.');
  console.log('  node scripts/manage.js doctor [--fix]          Validate config + wiring and report health; --fix repairs it.');
  console.log('  node scripts/manage.js uninstall               Remove per-agent wiring + links (keeps the central config folder).');
  console.log('  node scripts/manage.js help                    Show this help.');
  console.log('');
  console.log('install options:');
  console.log('  --preset <minimal|default>   Which repo preset to seed when no config folder exists. Default: minimal.');
  console.log('  --force                      Replace an existing central config folder with the preset (DESTRUCTIVE — user edits lost).');
  console.log('');
  console.log('Native Zig runtime is paused for the routes feature (ADR-0001); the dispatcher is Node-only in v1.');
  console.log('Central install root: OMNE_HOME if set, otherwise ~/.omne.');
  console.log('Agent config dir: CLAUDE_CONFIG_DIR if set, otherwise ~/.claude.');
}

function parseInstallOpts(argv: string[], cmd?: string): InstallOpts {
  cmd = cmd || 'install';
  const opts: InstallOpts = { preset: DEFAULT_PRESET, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset' || a === '-preset') {
      opts.preset = argv[i + 1] || '';
      i++;
      if (!opts.preset) fail(cmd + ': --preset needs a value (e.g. minimal|default).', 2);
    } else if (a.startsWith('--preset=')) {
      opts.preset = a.slice(a.indexOf('=') + 1);
      if (!opts.preset) fail(cmd + ': --preset needs a value (e.g. minimal|default).', 2);
    } else if (a === '--force' || a === '-force') {
      opts.force = true;
    } else if (a === '--runtime' || a === '-runtime' || a.startsWith('--runtime=') || a === '--build' || a === '-build') {
      fail(cmd + ': native runtime is paused for the routes feature (ADR-0001); the dispatcher is Node-only in v1.', 2);
    }
  }
  return opts;
}

// --- entry point ------------------------------------------------------------

const cmd = (process.argv[2] || '').toLowerCase();

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(0);
}

switch (cmd) {
  case 'install':
    try { cmdInstall(parseInstallOpts(process.argv.slice(3))); }
    catch (e) { fail('install: ' + e.message, 1); }
    break;
  case 'uninstall':
    try { cmdUninstall(); }
    catch (e) { fail('uninstall: ' + e.message, 1); }
    break;
  case 'status':
    cmdStatus();
    break;
  case 'verify':
    cmdVerify();
    break;
  case 'update':
    try {
      parseInstallOpts(process.argv.slice(3), 'update'); // reject native flags
      cmdUpdate();
    } catch (e) { fail('update: ' + e.message, 1); }
    break;
  case 'doctor':
    parseInstallOpts(process.argv.slice(3), 'doctor'); // reject native flags
    cmdDoctor(process.argv.slice(3).some(a => a === '--fix' || a === '-fix'));
    break;
  default:
    console.log('[baseline] unknown command "' + cmd + '".');
    printHelp();
    process.exit(2);
}
