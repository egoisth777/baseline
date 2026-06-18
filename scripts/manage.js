#!/usr/bin/env node
// baseline — cross-platform installer / verifier / status / uninstaller for the
// baseline-recital UserPromptSubmit hook. Runs on Windows and Linux.
//
// Usage (run with node from the repo root):
//   node scripts/manage.js status      # report what's installed vs the repo source
//   node scripts/manage.js install     # deploy hook + seed baseline.md + wire settings
//   node scripts/manage.js verify      # functional check: does the wired hook fire on turn N?
//   node scripts/manage.js uninstall   # remove settings wiring + deployed hook (keeps baseline.md)
//   node scripts/manage.js help        # this help
//
// install runtime selection:
//   --runtime <prebuilt|build|js>   pick the hook runtime explicitly
//   --build                         alias for --runtime build
// Default when no flag is given: js. Native runtimes are opt-in; explicit native
// requests fail if the binary cannot be verified or built.
//
// Design notes:
// - There is ONE central install root, OMNE_HOME or ~/.omne. The canonical
//   deployed hook (.js + optional native exe) and the single editable
//   baseline.md live there. The repo is the source of truth for the hook .js;
//   install always overwrites the central .js from it.
// - Each agent's config dir (Claude: CLAUDE_CONFIG_DIR or ~/.claude) gets LINKS
//   back into the center: hooks/baseline-recital.js and baseline.md point at the
//   central copies. Editing ~/.omne/baseline.md changes the live rules when the
//   link layer can use symlink/hardlink; copy fallback is reported as degraded.
// - settings.json and .baseline-counters.json stay REAL, per-agent files: the
//   hook refuses a symlinked counter file (planted-link hardening), and settings
//   carry per-agent co-resident hooks. Neither is ever linked.
// - baseline.md is seeded from the template ONLY if no rules exist anywhere; an
//   existing real baseline.md in an agent dir is MIGRATED into the center (moved,
//   not clobbered) so operator-edited rules are never lost.
// - settings.json editing is surgical and idempotent. Our entry is recognised by
//   parsing its command and matching the agent's deployed JS or native path.
//   Co-resident UserPromptSubmit hooks are always preserved. JSON reserializes
//   with 2-space indent + trailing newline.
// - All paths are built with os/path (no hardcoded separators). The Node runtime
//   command uses process.execPath. Child processes are spawned with an args array
//   (no shell), so there is no platform-specific quoting to get wrong.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_N = 5;
const DEFAULT_PREFIX = 'LI BASELINE ALIGNED:';
const FALLBACK_RULES = [
  'File read/write/search -> subagent (cavecrew-investigator/builder, Explore), not inline. Save main ctx.'
];
const MAX_BASELINE_BYTES = 64 * 1024;
const MAX_RULES = 50;
const MAX_RULE_CHARS = 500;

// --- platform + path resolution -------------------------------------------

const isWin = process.platform === 'win32';
const homeDir = os.homedir();

// Repo root resolved relative to this file (scripts/ sits directly under root).
const repoRoot = path.resolve(__dirname, '..');

// Deployed native-exe basename differs by platform (.exe suffix on Windows only).
const exeExt = isWin ? '.exe' : '';

// Central install root: explicit override, else ~/.omne. The canonical deployed
// artifacts and the single editable baseline.md live here.
const centralRoot = process.env.OMNE_HOME || path.join(homeDir, '.omne');

const central = {
  root:     centralRoot,
  hooksDir: path.join(centralRoot, 'hooks'),
  hookJs:   path.join(centralRoot, 'hooks', 'baseline-recital.js'),
  hookExe:  path.join(centralRoot, 'hooks', 'baseline-recital' + exeExt),
  baseline: path.join(centralRoot, 'baseline.md'),
};

// Repo sources (the source of truth for what gets deployed).
const repo = {
  hookSourceJs:  path.join(repoRoot, 'scripts', 'baseline-recital.js'),
  hookSourceZig: path.join(repoRoot, 'scripts', 'baseline-recital.zig'),
  template:      path.join(repoRoot, 'assets', 'baseline.template.md'),
  binDir:        path.join(repoRoot, 'bin'),
  checksums:     path.join(repoRoot, 'bin', 'SHA256SUMS'),
};

// Map process.platform -> the platform key used in prebuilt binary filenames.
// Returns null for anything we don't ship a prebuilt for.
function platformKey() {
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'linux') return 'linux-x64';
  return null;
}

// Prebuilt binary filename in repo bin/ for a given platform key.
function prebuiltBinaryName(key) {
  return key === 'windows-x64' ? 'baseline-recital-windows-x64.exe' : 'baseline-recital-linux-x64';
}

// --- agent registry --------------------------------------------------------

// The set of agent harnesses we link into. Only Claude Code ships today; the
// shape is a list so new harnesses can be added in exactly one place. Each
// agent's configDir already honours its own env override.
function agentRegistry() {
  return [
    {
      name: 'claude-code',
      configDir: process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'),
    },
  ];
}

// Derive every per-agent path from its config dir. baseline.md / hookJs / hookExe
// are LINKS to the center; settings.json / counters are real per-agent files.
function agentPaths(agent) {
  const d = agent.configDir;
  return {
    name:     agent.name,
    configDir: d,
    settings: path.join(d, 'settings.json'),
    counters: path.join(d, '.baseline-counters.json'),
    baseline: path.join(d, 'baseline.md'),
    hooksDir: path.join(d, 'hooks'),
    hookJs:   path.join(d, 'hooks', 'baseline-recital.js'),
    hookExe:  path.join(d, 'hooks', 'baseline-recital' + exeExt),
  };
}

function allAgentPaths() {
  return agentRegistry().map(agentPaths);
}

function fail(message, code) {
  console.error('[baseline] ' + message);
  process.exit(code || 1);
}

// Quote a single arg for embedding in the settings.json command STRING. The
// harness parses this string into argv, so paths with spaces must be quoted.
const quoteArg = s => '"' + String(s).replace(/"/g, '\\"') + '"';

// --- file helpers ----------------------------------------------------------

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// Binary-safe copy: raw Buffers via temp + rename. A utf8 round-trip would
// corrupt a binary, so prebuilt-binary deploys MUST use this, not atomicWrite.
function copyBinary(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, fs.readFileSync(src)); // no encoding -> Buffer in, Buffer out
  fs.renameSync(tmp, dest);
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), missing: false, error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, value: null, missing: true, error: null };
    }
    return { ok: false, value: null, missing: false, error: e };
  }
}

function settingsShapeError(settings) {
  if (!settings) return null;
  if (typeof settings !== 'object' || Array.isArray(settings)) return 'root must be an object';
  if (settings.hooks == null) return null;
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return 'hooks must be an object';
  const groups = settings.hooks.UserPromptSubmit;
  if (groups == null) return null;
  if (!Array.isArray(groups)) return 'hooks.UserPromptSubmit must be an array';
  for (let i = 0; i < groups.length; i++) {
    const hooks = groups[i] && groups[i].hooks;
    if (hooks != null && !Array.isArray(hooks)) return 'hooks.UserPromptSubmit[' + i + '].hooks must be an array';
  }
  return null;
}

function settingsOrEmptyForWrite(ap) {
  const r = readJson(ap.settings);
  if (!r.ok) {
    throw new Error('refusing to rewrite invalid settings.json: ' + r.error.message);
  }
  const settings = r.value || {};
  const shapeError = settingsShapeError(settings);
  if (shapeError) {
    throw new Error('refusing to rewrite invalid settings.json: ' + shapeError);
  }
  return settings;
}

function settingsForRead(ap) {
  const r = readJson(ap.settings);
  if (!r.ok) return { settings: {}, error: r.error };
  const settings = r.value || {};
  const shapeError = settingsShapeError(settings);
  return shapeError
    ? { settings: {}, error: new Error(shapeError) }
    : { settings, error: null };
}

function fileSize(file) {
  try { return fs.statSync(file).size; }
  catch (e) { return 0; }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const aa = path.resolve(a);
  const bb = path.resolve(b);
  return isWin ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

// --- link layer (cross-platform) -------------------------------------------

// Remove a symlink, hardlink, or regular file at p. Refuses to remove a real
// directory — we never recursively delete an operator's directory to plant a
// link. Absent path is a no-op.
function removeIfLinkOrFile(p) {
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) { return; } // absent
  if (st.isDirectory() && !st.isSymbolicLink()) {
    throw new Error('refusing to replace a real directory with a link: ' + p);
  }
  fs.unlinkSync(p);
}

// Create a link at linkPath pointing into the central `target`. Tries the
// strongest mechanism the OS allows and reports which won:
//   symlink  — normal on POSIX; on Windows needs Developer Mode / privilege.
//   hardlink — same-volume fallback (Windows without privilege). Same inode, so
//              editing the center is still reflected. Re-made every install
//              because a central tmp+rename replaces the inode.
//   copy     — last resort (e.g. cross-volume). Edits will NOT propagate; the
//              caller surfaces this as a degraded mechanism.
function linkInto(target, linkPath) {
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
  copyBinary(target, linkPath);
  if (!isWin && path.basename(target) === 'baseline-recital' + exeExt) {
    try { fs.chmodSync(linkPath, 0o755); } catch (e) {}
  }
  return 'copy';
}

// Inspect linkPath relative to the central target. Returns { ok, mechanism }.
// mechanism: 'symlink' | 'hardlink' | 'copy' (ok=true) or
//            'missing' | 'broken' | 'wrong' | 'stale' (ok=false).
function linkState(linkPath, target) {
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

  // Regular file: a hardlink shares dev+ino with the target; a copy is just
  // byte-identical. Anything else is a stale/foreign file.
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

function describeLink(s) {
  if (s.ok) return 'OK (' + s.mechanism + (s.mechanism === 'copy' ? ' — degraded, edits will not propagate' : '') + ')';
  return s.mechanism.toUpperCase();
}

// Remove a per-agent link we created (symlink, or hardlink/copy of the central
// target). Refuses to delete a real, divergent file. Returns true if removed.
function removeOurLink(linkPath, target) {
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

// Link an agent's baseline.md to the center, but first preserve a real,
// divergent file (operator edits we are not migrating) as a .bak so we never
// silently destroy rules.
function linkBaselineSafe(ap) {
  let lst = null;
  try { lst = fs.lstatSync(ap.baseline); } catch (e) {}
  if (lst && !lst.isSymbolicLink() && lst.isFile() && !linkState(ap.baseline, central.baseline).ok) {
    try { fs.copyFileSync(ap.baseline, ap.baseline + '.bak'); } catch (e) {}
  }
  return linkInto(central.baseline, ap.baseline);
}

// --- command-string builders -----------------------------------------------

// settings.json command that runs an agent's native binary: just its quoted path.
function exeCommand(ap) {
  return quoteArg(ap.hookExe);
}

// settings.json command that runs the agent's Node .js hook: this Node binary
// (process.execPath) + the deployed .js, each quoted independently.
function jsCommand(ap) {
  return quoteArg(process.execPath) + ' ' + quoteArg(ap.hookJs);
}

function parseCommandLine(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const args = [];
  let cur = '';
  let quote = null;
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
      if (cur) {
        args.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  if (cur) args.push(cur);
  return args.length ? args : null;
}

// Identify whether a settings command string is ours, for a given agent. An
// exact match against that agent's deployed JS/native path makes it ours, so
// uninstall removes only our entry and install refreshes across runtime switches.
function commandInfo(command, ap) {
  const argv = parseCommandLine(command);
  if (!argv) return { runtime: 'unknown', argv: null, isOurs: false };
  if (argv.length === 1 && samePath(argv[0], ap.hookExe)) {
    return { runtime: 'native exe', argv, isOurs: true };
  }
  if (argv.length >= 2 && samePath(argv[1], ap.hookJs)) {
    return { runtime: 'node js', argv, isOurs: true };
  }
  return { runtime: 'unknown', argv, isOurs: false };
}

function runtimeFromCommand(command, ap) {
  return commandInfo(command, ap).runtime;
}

// --- settings.json surgery -------------------------------------------------

function findOurHook(settings, ap) {
  const groups = (settings.hooks && Array.isArray(settings.hooks.UserPromptSubmit)) ? settings.hooks.UserPromptSubmit : [];
  for (const group of groups) {
    for (const h of (Array.isArray(group.hooks) ? group.hooks : [])) {
      if (h && commandInfo(h.command, ap).isOurs) {
        return h;
      }
    }
  }
  return null;
}

// Ensure our hook is wired into hooks.UserPromptSubmit with the given command.
// Refreshes command/timeout/statusMessage if already present; otherwise appends
// to the first group's hooks (creating a group if none). Preserves co-residents.
function wireSettings(ap, command) {
  const settings = settingsOrEmptyForWrite(ap);
  settings.hooks = settings.hooks || {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];

  const existing = findOurHook(settings, ap);
  if (existing) {
    existing.command = command;
    existing.timeout = 5;
    existing.statusMessage = 'Baseline check...';
    atomicWrite(ap.settings, JSON.stringify(settings, null, 2) + '\n');
    return 'refreshed';
  }

  const entry = { type: 'command', command: command, timeout: 5, statusMessage: 'Baseline check...' };
  if (settings.hooks.UserPromptSubmit.length && settings.hooks.UserPromptSubmit[0].hooks) {
    settings.hooks.UserPromptSubmit[0].hooks.push(entry);
  } else {
    settings.hooks.UserPromptSubmit.push({ hooks: [entry] });
  }
  atomicWrite(ap.settings, JSON.stringify(settings, null, 2) + '\n');
  return 'added';
}

// Remove our hook entry and drop any group left empty. Other hooks untouched.
function unwireSettings(ap) {
  const settings = settingsOrEmptyForWrite(ap);
  if (!settings || !settings.hooks || !settings.hooks.UserPromptSubmit) return 'absent';
  let removed = false;
  for (const group of settings.hooks.UserPromptSubmit) {
    if (!group.hooks) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter(h => !(h && commandInfo(h.command, ap).isOurs));
    if (group.hooks.length !== before) removed = true;
  }
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(g => g.hooks && g.hooks.length);
  if (!settings.hooks.UserPromptSubmit.length) delete settings.hooks.UserPromptSubmit;
  atomicWrite(ap.settings, JSON.stringify(settings, null, 2) + '\n');
  return removed ? 'removed' : 'absent';
}

// --- native build (zig) ----------------------------------------------------

// Resolve a usable zig compiler: confirm by spawning `zig version`. Returns the
// invocable name on success, null if absent/broken. Never throws.
function findZig() {
  try {
    const r = spawnSync('zig', ['version'], { encoding: 'utf8' });
    const version = (r.stdout || '').trim();
    if (r.status === 0 && /^0\.16\./.test(version)) return 'zig';
  } catch (e) {}
  return null;
}

// Build the zig hook for the host target and deploy it to the central exe.
// Returns the deployed path on success, or null (with report.reason set) for any
// failure. Never throws.
function buildAndDeployExe(report) {
  report = report || {};
  let buildDir = null;
  try {
    if (!fs.existsSync(repo.hookSourceZig)) { report.reason = 'zig source not in repo (scripts/baseline-recital.zig)'; return null; }
    const zig = findZig();
    if (!zig) { report.reason = 'zig 0.16.x not found on PATH'; return null; }

    fs.mkdirSync(central.hooksDir, { recursive: true });

    // Zig 0.16 reliably emits the named host binary into cwd. Build in a temp
    // dir, then copy the single produced artifact into the central hooks dir.
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-recital-'));
    const built = path.join(buildDir, 'baseline-recital' + exeExt);
    const r = spawnSync(zig, [
      'build-exe', '-O', 'ReleaseSmall', '--name', 'baseline-recital', repo.hookSourceZig
    ], { cwd: buildDir, encoding: 'utf8' });

    if (r.status !== 0) {
      const err = ((r.stderr || (r.error && r.error.message) || '').toString().trim().split(/\r?\n/)[0]) || '(no stderr)';
      report.reason = 'zig build failed: ' + err;
      try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (e) {}
      buildDir = null;
      return null;
    }
    if (!fs.existsSync(built)) {
      report.reason = 'zig build produced no binary';
      try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (e) {}
      buildDir = null;
      return null;
    }

    copyBinary(built, central.hookExe);
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (e) {}
    buildDir = null;

    if (!isWin) { try { fs.chmodSync(central.hookExe, 0o755); } catch (e) {} }
    report.size = fileSize(central.hookExe);
    return central.hookExe;
  } catch (e) {
    if (buildDir) { try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (_) {} }
    report.reason = 'build error: ' + e.message;
    return null;
  }
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function loadChecksums() {
  const out = {};
  try {
    for (const raw of fs.readFileSync(repo.checksums, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
      if (m) out[m[2].trim()] = m[1].toLowerCase();
    }
  } catch (e) {}
  return out;
}

function expectedPrebuiltHash(name) {
  return loadChecksums()[name] || null;
}

function verifyPrebuilt(src, name, report) {
  const expected = expectedPrebuiltHash(name);
  if (!expected) {
    report.reason = 'missing checksum in bin/SHA256SUMS for ' + name;
    return false;
  }
  const actual = sha256File(src);
  if (actual !== expected) {
    report.reason = 'checksum mismatch for ' + name + ' (expected ' + expected + ', got ' + actual + ')';
    return false;
  }
  report.sha256 = actual;
  return true;
}

// Copy a platform-matched prebuilt binary from repo bin/ to the central exe.
// Returns the deployed path on success, or null (report.reason set) on any miss.
function deployPrebuiltExe(report) {
  report = report || {};
  try {
    const key = platformKey();
    if (!key) { report.reason = 'unsupported platform ' + process.platform; return null; }
    const name = prebuiltBinaryName(key);
    const src = path.join(repo.binDir, name);
    if (!fs.existsSync(src)) { report.reason = 'no prebuilt binary in bin/ for ' + key; return null; }
    if (!verifyPrebuilt(src, name, report)) return null;

    copyBinary(src, central.hookExe);
    if (!isWin) { try { fs.chmodSync(central.hookExe, 0o755); } catch (e) {} }
    report.size = fileSize(central.hookExe);
    return central.hookExe;
  } catch (e) {
    report.reason = 'prebuilt deploy error: ' + e.message;
    return null;
  }
}

// --- baseline.md parsing (shared by status/verify) -------------------------

// Parse baseline.md into { interval, prefix, rules }. Mirrors the hook's own
// tolerant parser: optional --- frontmatter (interval/prefix), body lines are
// rules (blank + #-comment lines dropped). interval defaults to 5.
function parseBaseline(raw) {
  if (typeof raw !== 'string') {
    return { interval: DEFAULT_N, prefix: DEFAULT_PREFIX, rules: FALLBACK_RULES.slice() };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BASELINE_BYTES) {
    return { interval: DEFAULT_N, prefix: DEFAULT_PREFIX, rules: FALLBACK_RULES.slice() };
  }
  let interval = DEFAULT_N;
  let prefix = DEFAULT_PREFIX;
  let body = raw;
  const fm = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === 'interval') {
        const n = parseInt(val, 10);
        if (Number.isFinite(n) && n > 0) interval = n;
      } else if (key === 'prefix') {
        prefix = val.replace(/^["']|["']$/g, '') || DEFAULT_PREFIX;
      }
    }
  }
  const rules = body
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .slice(0, MAX_RULES)
    .map(l => l.length > MAX_RULE_CHARS ? l.slice(0, MAX_RULE_CHARS) : l);
  if (!rules.length) return { interval, prefix, rules: FALLBACK_RULES.slice() };
  return { interval, prefix, rules };
}

// Read the central baseline.md (the single source of truth all agents link to).
function readBaselineRaw() {
  try {
    const st = fs.statSync(central.baseline);
    if (st.size > MAX_BASELINE_BYTES) return null;
    const raw = fs.readFileSync(central.baseline, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_BASELINE_BYTES) return null;
    return raw;
  } catch (e) {
    return null;
  }
}

function readInterval() {
  return parseBaseline(readBaselineRaw()).interval;
}

// --- commands --------------------------------------------------------------

// Decide and obtain a native binary per the requested runtime, or signal js.
// Returns { runtime: 'prebuilt'|'build'|'js', exePath, report }. The exe (if any)
// is deployed to the central hooks dir.
function resolveRuntime(requested) {
  const report = {};

  if (!requested || requested === 'js') {
    report.reason = requested === 'js' ? 'requested by --runtime js' : 'default safe runtime';
    return { runtime: 'js', exePath: null, report };
  }

  if (requested === 'prebuilt') {
    const exePath = deployPrebuiltExe(report);
    if (exePath) return { runtime: 'prebuilt', exePath, report };
    throw new Error('prebuilt runtime unavailable: ' + (report.reason || 'unknown error'));
  }

  if (requested === 'build') {
    const exePath = buildAndDeployExe(report);
    if (exePath) return { runtime: 'build', exePath, report };
    throw new Error('build runtime unavailable: ' + (report.reason || 'unknown error'));
  }

  throw new Error('unknown runtime "' + requested + '"');
}

// Establish the central baseline.md content exactly once. Precedence:
//   1. central already has a real baseline.md -> keep it (never clobber).
//   2. an agent has a real (non-link) baseline.md -> MIGRATE it (move to center).
//   3. otherwise seed from the repo template.
// Returns 'kept' | 'migrated' | 'seeded'.
function ensureCentralBaseline(agentsP) {
  if (fs.existsSync(central.baseline)) return 'kept';
  for (const ap of agentsP) {
    let st;
    try { st = fs.lstatSync(ap.baseline); }
    catch (e) { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue; // a link/non-file is not migratable rules
    const raw = fs.readFileSync(ap.baseline);
    fs.mkdirSync(path.dirname(central.baseline), { recursive: true });
    const tmp = central.baseline + '.tmp';
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, central.baseline);
    fs.unlinkSync(ap.baseline); // its place is taken by a link in the per-agent loop
    return 'migrated';
  }
  copyBinary(repo.template, central.baseline);
  return 'seeded';
}

function cmdInstall(opts) {
  const agentsP = allAgentPaths();

  // 1. Refuse before any deploy/migration if an agent settings file is invalid.
  for (const ap of agentsP) settingsOrEmptyForWrite(ap);

  // 2. ALWAYS deploy the canonical .js to the CENTER (overwrite; repo wins).
  fs.mkdirSync(central.hooksDir, { recursive: true });
  atomicWrite(central.hookJs, fs.readFileSync(repo.hookSourceJs, 'utf8'));

  // 3. Establish the single central baseline.md (seed/migrate/keep).
  const baselineState = ensureCentralBaseline(agentsP);

  // 4. Resolve the runtime; a native runtime deploys the exe into the center.
  const { runtime, exePath, report } = resolveRuntime(opts.runtime);
  const native = !!exePath;

  // 5. For each agent: link the center in, then wire settings to the agent's
  //    own (linked) hook path so CLAUDE_CONFIG_DIR-relative resolution holds.
  const perAgent = [];
  for (const ap of agentsP) {
    const jsMech = linkInto(central.hookJs, ap.hookJs);
    let exeMech = null;
    if (native) {
      exeMech = linkInto(central.hookExe, ap.hookExe);
    } else {
      removeIfLinkOrFile(ap.hookExe); // drop a stale native link on a js install
    }
    const baseMech = linkBaselineSafe(ap);
    const command = native ? exeCommand(ap) : jsCommand(ap);
    const wired = wireSettings(ap, command);
    perAgent.push({ name: ap.name, configDir: ap.configDir, jsMech, exeMech, baseMech, wired });
  }

  console.log('[baseline] install complete');
  console.log('  central     : ' + central.root);
  if (native) {
    const label = runtime === 'prebuilt' ? 'prebuilt native binary' : 'native binary (built locally with zig)';
    console.log('  runtime     : ' + label + ' (fast start)');
    console.log('  hook binary : ' + central.hookExe + ' (' + (report.size || fileSize(central.hookExe)) + ' bytes)');
  } else {
    console.log('  runtime     : node js' + (report.reason ? ' (' + report.reason + ')' : ''));
  }
  console.log('  hook .js    : ' + central.hookJs);
  console.log('  baseline.md : ' + central.baseline + ' (' + baselineState + ')');
  for (const a of perAgent) {
    const bits = ['baseline.md=' + a.baseMech, 'hook.js=' + a.jsMech];
    if (a.exeMech) bits.push('exe=' + a.exeMech);
    console.log('  agent ' + a.name + ' : settings ' + a.wired + '; links ' + bits.join(', ') + ' @ ' + a.configDir);
  }
  console.log('  next step   : open /hooks once (or restart) so Claude Code reloads settings.');
}

function cmdUninstall() {
  const agentsP = allAgentPaths();
  console.log('[baseline] uninstall');
  for (const ap of agentsP) {
    let wired;
    try { wired = unwireSettings(ap); }
    catch (e) { fail('uninstall: ' + e.message, 1); }
    const jsGone = removeOurLink(ap.hookJs, central.hookJs);
    const exeGone = removeOurLink(ap.hookExe, central.hookExe);
    const baseGone = removeOurLink(ap.baseline, central.baseline);
    console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
    console.log('    settings    : ' + wired);
    console.log('    hook .js    : ' + (jsGone ? 'unlinked' : 'absent'));
    console.log('    hook binary : ' + (exeGone ? 'unlinked' : 'absent'));
    console.log('    baseline.md : ' + (baseGone ? 'unlinked (central kept)' : 'left as-is'));
  }
  console.log('  central baseline.md : KEPT at ' + central.baseline + ' (delete by hand if you want it gone)');
}

function cmdStatus() {
  const agentsP = allAgentPaths();

  const jsExists = fs.existsSync(central.hookJs);
  let inSync = false;
  if (jsExists) {
    try { inSync = fs.readFileSync(central.hookJs, 'utf8') === fs.readFileSync(repo.hookSourceJs, 'utf8'); }
    catch (e) {}
  }
  const exeExists = fs.existsSync(central.hookExe);
  const exeSize = exeExists ? fileSize(central.hookExe) : 0;
  let exeSync = 'not present';
  if (exeExists) {
    try {
      const key = platformKey();
      const expected = key ? expectedPrebuiltHash(prebuiltBinaryName(key)) : null;
      const actual = sha256File(central.hookExe);
      exeSync = expected
        ? (actual === expected ? 'sha256 matches checked-in prebuilt' : 'sha256 DIFFERS from checked-in prebuilt')
        : 'sha256 ' + actual + ' (no checked-in prebuilt for this platform)';
    } catch (e) {
      exeSync = 'present, sha256 unavailable: ' + e.message;
    }
  }
  const baselineExists = fs.existsSync(central.baseline);

  console.log('[baseline] status');
  console.log('  central root   : ' + central.root);
  console.log('  hook .js       : ' + (jsExists
    ? 'present' + (inSync ? ' (byte-identical to repo source)' : ' (DIFFERS from repo source — run install to refresh)')
    : 'not present'));
  console.log('  hook binary    : ' + (exeExists ? 'present (' + exeSize + ' bytes; ' + exeSync + ')' : 'not present'));
  console.log('  baseline.md    : ' + (baselineExists ? 'present' : 'missing (install will seed it)'));

  for (const ap of agentsP) {
    const { settings, error } = settingsForRead(ap);
    const ourHook = error ? null : findOurHook(settings, ap);
    const wired = !!ourHook;
    const wiredRuntime = ourHook ? runtimeFromCommand(ourHook.command, ap) : 'none';
    console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
    if (error) console.log('    settings     : INVALID settings.json (' + error.message + ')');
    console.log('    settings     : ' + (wired ? 'wired (runtime: ' + wiredRuntime + ')' : 'not wired'));
    console.log('    hook .js     : ' + describeLink(linkState(ap.hookJs, central.hookJs)));
    console.log('    baseline.md  : ' + describeLink(linkState(ap.baseline, central.baseline)));
    if (wiredRuntime === 'native exe') {
      console.log('    hook binary  : ' + describeLink(linkState(ap.hookExe, central.hookExe)));
    }
  }

  if (baselineExists) {
    const { interval, prefix, rules } = parseBaseline(readBaselineRaw());
    console.log('  interval       : ' + interval + ' (recital fires every ' + interval + ' prompts)');
    console.log('  prefix         : ' + prefix);
    console.log('  rules          : ' + rules.length);
    rules.forEach((r, i) => console.log('    ' + (i + 1) + '. ' + r));
  }
}

// Functional check — drive the ACTUALLY-WIRED runtime (of the first agent) with
// synthetic stdin for `interval` prompts and confirm it stays silent until the
// Nth, then fires with additionalContext. Cleans the synthetic counter after.
function cmdVerify() {
  const ap = allAgentPaths()[0];
  const sr = settingsForRead(ap);
  if (sr.error) {
    console.log('[baseline] verify: FAIL — invalid settings.json: ' + sr.error.message);
    process.exit(1);
  }
  const ourHook = findOurHook(sr.settings, ap);
  if (!ourHook) {
    console.log('[baseline] verify: FAIL — no baseline hook wired in settings. Run install.');
    process.exit(1);
  }

  const info = commandInfo(ourHook.command, ap);
  const wiredRuntime = info.runtime;
  if (!info.argv) {
    console.log('[baseline] verify: FAIL — cannot parse wired command.');
    process.exit(1);
  }

  const runExe = info.argv[0];
  const runArgs = info.argv.slice(1);

  const interval = readInterval();
  const sid = 'baseline-verify-' + process.pid;

  let firedAt = 0;
  let firedText = '';
  let spawnErr = null;
  for (let i = 1; i <= interval; i++) {
    const r = spawnSync(runExe, runArgs, {
      input: JSON.stringify({ session_id: sid, prompt: 'verify ' + i }),
      encoding: 'utf8'
    });
    if (r.error) { spawnErr = r.error; break; }
    const out = (r.stdout || '').trim();
    if (out) { firedAt = i; firedText = out; }
  }

  // Clean our synthetic counter entry so verify never pollutes real session state.
  try {
    const cr = readJson(ap.counters);
    if (cr.ok && cr.value && typeof cr.value === 'object') {
      delete cr.value[sid];
      atomicWrite(ap.counters, JSON.stringify(cr.value));
    }
  } catch (e) {}

  const ok = !spawnErr && firedAt === interval && firedText.includes('additionalContext');
  console.log('[baseline] verify: ' + (ok ? 'PASS' : 'FAIL'));
  console.log('  runtime tested : ' + wiredRuntime);
  console.log('  interval       : ' + interval);
  console.log('  fired on turn  : ' + (firedAt || 'never'));
  if (spawnErr) console.log('  spawn error    : ' + spawnErr.message);
  else if (firedAt !== interval) console.log('  expected       : silent until turn ' + interval + ', then fire exactly once');
  else if (!firedText.includes('additionalContext')) console.log('  problem        : fired, but output had no additionalContext field');
  if (!ok) process.exit(1);
}

// Re-deploy the central hook + re-wire settings from the CURRENT repo source,
// keeping the runtime already in use (or --runtime <x> if given). Refreshes a
// stale central .js/binary and re-points the per-agent links. git pull is left
// to the wrapper script; this only redeploys what is on disk now.
function cmdUpdate(opts) {
  const ap0 = allAgentPaths()[0];
  const { settings } = settingsForRead(ap0);
  const ourHook = findOurHook(settings, ap0);
  const wiredRuntime = ourHook ? runtimeFromCommand(ourHook.command, ap0) : 'none';

  // A native install redeploys via the verified prebuilt; everything else is js.
  const runtime = opts.runtime || (wiredRuntime === 'native exe' ? 'prebuilt' : 'js');

  console.log('[baseline] update — redeploying from repo (was: ' + wiredRuntime + ', target runtime: ' + runtime + ')');
  console.log('');
  try {
    cmdInstall({ runtime });
  } catch (e) {
    if (runtime !== 'js' && /runtime unavailable/i.test(e.message)) {
      console.log('[baseline] update: ' + runtime + ' runtime unavailable (' + e.message + '); falling back to js.');
      console.log('');
      cmdInstall({ runtime: 'js' });
    } else {
      throw e;
    }
  }
}

// Inspect the installation and return a list of checks. Each: { name, level
// ('ok'|'warn'|'fail'), detail, fixable }. 'fixable' means `update`/install can
// repair it. Shared by `doctor` (report) and `doctor --fix` (repair + recheck).
function doctorChecks() {
  const checks = [];

  // Central source-of-truth checks.
  const jsExists = fs.existsSync(central.hookJs);
  if (!jsExists) {
    checks.push({ name: 'central hook .js', level: 'fail', detail: 'not deployed at ' + central.hookJs, fixable: true });
  } else {
    let inSync = false;
    try { inSync = fs.readFileSync(central.hookJs, 'utf8') === fs.readFileSync(repo.hookSourceJs, 'utf8'); } catch (e) {}
    checks.push(inSync
      ? { name: 'central hook .js', level: 'ok', detail: 'byte-identical to repo source' }
      : { name: 'central hook .js', level: 'warn', detail: 'DIFFERS from repo source (stale — update will refresh)', fixable: true });
  }

  const baselineExists = fs.existsSync(central.baseline);
  checks.push(baselineExists
    ? { name: 'central baseline.md', level: 'ok', detail: 'present at ' + central.baseline }
    : { name: 'central baseline.md', level: 'warn', detail: 'missing (install will seed from template)', fixable: true });

  // Per-agent checks.
  for (const ap of allAgentPaths()) {
    const sr = settingsForRead(ap);
    if (sr.error) {
      checks.push({ name: 'settings.json', level: 'fail', detail: 'invalid settings.json (' + sr.error.message + ') — fix by hand; install refuses to rewrite it', fixable: false });
    } else {
      checks.push({ name: 'settings.json', level: 'ok', detail: 'valid JSON' });
    }

    const ourHook = sr.error ? null : findOurHook(sr.settings, ap);
    if (ourHook) {
      checks.push({ name: 'settings wiring', level: 'ok', detail: 'hook wired (runtime: ' + runtimeFromCommand(ourHook.command, ap) + ')' });
    } else {
      checks.push({ name: 'settings wiring', level: sr.error ? 'warn' : 'fail', detail: sr.error ? 'cannot check (invalid settings)' : 'baseline hook NOT wired', fixable: !sr.error });
    }

    const js = linkState(ap.hookJs, central.hookJs);
    if (js.ok && js.mechanism !== 'copy') {
      checks.push({ name: 'hook .js', level: 'ok', detail: 'linked to center (' + js.mechanism + ')' });
    } else if (js.ok) {
      checks.push({ name: 'hook .js', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
    } else {
      checks.push({ name: 'hook .js', level: 'fail', detail: js.mechanism + ' — not linked to ' + central.hookJs, fixable: true });
    }

    const base = linkState(ap.baseline, central.baseline);
    if (base.ok && base.mechanism !== 'copy') {
      checks.push({ name: 'baseline.md', level: 'ok', detail: 'linked to center (' + base.mechanism + ')' });
    } else if (base.ok) {
      checks.push({ name: 'baseline.md', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
    } else if (!baselineExists) {
      checks.push({ name: 'baseline.md', level: 'warn', detail: 'central baseline missing — install will seed + link', fixable: true });
    } else {
      checks.push({ name: 'baseline.md', level: 'fail', detail: base.mechanism + ' — not linked to ' + central.baseline, fixable: true });
    }

    const wiredNative = ourHook && runtimeFromCommand(ourHook.command, ap) === 'native exe';
    if (wiredNative) {
      const exe = linkState(ap.hookExe, central.hookExe);
      if (exe.ok && exe.mechanism !== 'copy') {
        checks.push({ name: 'hook binary', level: 'ok', detail: 'linked to center (' + exe.mechanism + ')' });
      } else if (exe.ok) {
        checks.push({ name: 'hook binary', level: 'warn', detail: 'degraded copy (install will relink)', fixable: true });
      } else {
        checks.push({ name: 'hook binary', level: 'fail', detail: 'settings wired to native exe but link is ' + exe.mechanism, fixable: true });
      }
    } else {
      checks.push({ name: 'hook binary', level: 'ok', detail: 'not used (js runtime)' });
    }
  }

  return checks;
}

function printDoctorChecks(checks) {
  const mark = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };
  for (const c of checks) {
    console.log('  ' + (mark[c.level] || '[????]') + ' ' + c.name + ': ' + c.detail);
  }
}

function cmdDoctor(opts) {
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

  if (!opts.fix) {
    console.log('');
    console.log('[baseline] doctor: ' + problems.length + ' issue(s) found' +
      (fixable.length ? ', ' + fixable.length + ' auto-fixable — rerun with --fix.' : ' (none auto-fixable; see notes above).'));
    process.exit(1);
  }

  // --fix: re-deploy from repo, preserving the wired runtime, then re-scan.
  // Refuse to touch anything while settings.json is invalid.
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
    cmdUpdate({ runtime: opts.runtime });
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

function printHelp() {
  console.log('baseline — manage the baseline-recital hook (cross-platform: Windows + Linux)');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/manage.js status      Report what is installed vs the repo source.');
  console.log('  node scripts/manage.js install     Deploy the hook centrally, seed baseline.md, link agents, wire settings.json.');
  console.log('  node scripts/manage.js verify      Functionally test the wired hook (fires on turn N?).');
  console.log('  node scripts/manage.js update      Redeploy hook + settings from the repo, keeping the wired runtime.');
  console.log('  node scripts/manage.js doctor      Scan the installation and report health. --fix repairs it.');
  console.log('  node scripts/manage.js uninstall   Remove the settings wiring + per-agent links (keeps central baseline.md).');
  console.log('  node scripts/manage.js help        Show this help.');
  console.log('');
  console.log('install options:');
  console.log('  --runtime <prebuilt|build|js>   Choose the hook runtime.');
  console.log('                                    prebuilt: verify + copy matching binary from bin/.');
  console.log('                                    build:    compile scripts/baseline-recital.zig with Zig 0.16.x.');
  console.log('                                    js:       run the Node .js hook directly.');
  console.log('  --build                         Alias for --runtime build.');
  console.log('  (default)                       Use the canonical Node .js hook.');
  console.log('                                  Native options are opt-in and fail if unavailable.');
  console.log('');
  console.log('Central install root: OMNE_HOME if set, otherwise ~/.omne.');
  console.log('Agent config dir: CLAUDE_CONFIG_DIR if set, otherwise ~/.claude.');
}

// Parse install flags from argv (everything after the subcommand). cmd names the
// caller so a bad --runtime reports the right command in its error.
function parseInstallOpts(argv, cmd) {
  cmd = cmd || 'install';
  const opts = { runtime: null }; // null => js default
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build' || a === '-build') {
      opts.runtime = 'build';
    } else if (a === '--runtime' || a === '-runtime') {
      const v = (argv[i + 1] || '').toLowerCase();
      i++;
      if (v === 'prebuilt' || v === 'build' || v === 'js') opts.runtime = v;
      else fail(cmd + ': unknown --runtime "' + v + '" (use prebuilt|build|js).', 2);
    } else if (a.startsWith('--runtime=') || a.startsWith('-runtime=')) {
      const v = a.slice(a.indexOf('=') + 1).toLowerCase();
      if (v === 'prebuilt' || v === 'build' || v === 'js') opts.runtime = v;
      else fail(cmd + ': unknown --runtime "' + v + '" (use prebuilt|build|js).', 2);
    }
  }
  return opts;
}

// Parse doctor flags: --fix (repair) and the shared --runtime selector.
function parseDoctorOpts(argv) {
  const opts = parseInstallOpts(argv, 'doctor');
  opts.fix = argv.some(a => a === '--fix' || a === '-fix');
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
    try {
      cmdInstall(parseInstallOpts(process.argv.slice(3)));
    } catch (e) {
      fail('install: ' + e.message, 1);
    }
    break;
  case 'uninstall':
    try {
      cmdUninstall();
    } catch (e) {
      fail('uninstall: ' + e.message, 1);
    }
    break;
  case 'status':
    cmdStatus();
    break;
  case 'verify':
    cmdVerify();
    break;
  case 'update':
    try {
      cmdUpdate(parseInstallOpts(process.argv.slice(3), 'update'));
    } catch (e) {
      fail('update: ' + e.message, 1);
    }
    break;
  case 'doctor':
    cmdDoctor(parseDoctorOpts(process.argv.slice(3)));
    break;
  default:
    console.log('[baseline] unknown command "' + cmd + '".');
    printHelp();
    process.exit(2);
}
