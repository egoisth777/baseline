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
// - The repo is the source of truth. install deploys the hook into the Claude
//   config dir (CLAUDE_CONFIG_DIR or ~/.claude) and seeds baseline.md from the
//   template ONLY if absent (never clobbers operator-edited rules).
// - The .js hook is the portable source of truth: install ALWAYS
//   deploys scripts/baseline-recital.js to hooks/, regardless of which runtime
//   is wired, so there is always a working reference copy.
// - A native runtime (prebuilt binary, or a fresh zig build) eliminates Node
//   process-boot latency on the hot path. Because native hooks execute on every
//   prompt, they are opt-in and verified before wiring.
// - settings.json editing is surgical and idempotent. Our entry is recognised by
//   parsing its command and matching the deployed JS or native path exactly.
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

// Base config dir: explicit override, else ~/.claude. Cross-platform via os/path.
const baseDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Repo root resolved relative to this file (scripts/ sits directly under root).
const repoRoot = path.resolve(__dirname, '..');

// Deployed native-exe basename differs by platform (.exe suffix on Windows only).
const exeExt = isWin ? '.exe' : '';

// Map process.platform -> the platform key used in prebuilt binary filenames.
// Returns null for anything we don't ship a prebuilt for.
function platformKey() {
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'linux') return 'linux-x64';
  return null;
}

const paths = {
  settings:        path.join(baseDir, 'settings.json'),
  hooksDir:        path.join(baseDir, 'hooks'),
  hookDeployedJs:  path.join(baseDir, 'hooks', 'baseline-recital.js'),
  hookDeployedExe: path.join(baseDir, 'hooks', 'baseline-recital' + exeExt),
  baseline:        path.join(baseDir, 'baseline.md'),
  counters:        path.join(baseDir, '.baseline-counters.json'),
  hookSourceJs:    path.join(repoRoot, 'scripts', 'baseline-recital.js'),
  hookSourceZig:   path.join(repoRoot, 'scripts', 'baseline-recital.zig'),
  template:        path.join(repoRoot, 'assets', 'baseline.template.md'),
  binDir:          path.join(repoRoot, 'bin'),
  checksums:       path.join(repoRoot, 'bin', 'SHA256SUMS'),
};

// Prebuilt binary filename in repo bin/ for a given platform key.
function prebuiltBinaryName(key) {
  return key === 'windows-x64' ? 'baseline-recital-windows-x64.exe' : 'baseline-recital-linux-x64';
}

// Existing settings commands are parsed into argv before hook identity checks.
// Exact deployed JS/native path matches refresh the entry across runtime
// switches and let uninstall remove only our own hook.
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

function settingsOrEmptyForWrite() {
  const r = readJson(paths.settings);
  if (!r.ok) {
    throw new Error('refusing to rewrite invalid settings.json: ' + r.error.message);
  }
  return r.value || {};
}

function settingsForRead() {
  const r = readJson(paths.settings);
  if (!r.ok) return { settings: {}, error: r.error };
  return { settings: r.value || {}, error: null };
}

function fileSize(file) {
  try { return fs.statSync(file).size; }
  catch (e) { return 0; }
}

// --- command-string builders -----------------------------------------------

// settings.json command that runs the deployed native binary: just its quoted path.
function exeCommand() {
  return quoteArg(paths.hookDeployedExe);
}

// settings.json command that runs the deployed Node .js hook: this Node binary
// (process.execPath) + the deployed .js, each quoted independently.
function jsCommand() {
  return quoteArg(process.execPath) + ' ' + quoteArg(paths.hookDeployedJs);
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

function samePath(a, b) {
  if (!a || !b) return false;
  const aa = path.resolve(a);
  const bb = path.resolve(b);
  return isWin ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

function commandInfo(command) {
  const argv = parseCommandLine(command);
  if (!argv) return { runtime: 'unknown', argv: null, isOurs: false };
  if (argv.length === 1 && samePath(argv[0], paths.hookDeployedExe)) {
    return { runtime: 'native exe', argv, isOurs: true };
  }
  if (argv.length >= 2 && samePath(argv[1], paths.hookDeployedJs)) {
    return { runtime: 'node js', argv, isOurs: true };
  }
  return { runtime: 'unknown', argv, isOurs: false };
}

// --- settings.json surgery -------------------------------------------------

// Find our hook entry within hooks.UserPromptSubmit, if present. The command is
// parsed and matched against the deployed JS/native path.
function findOurHook(settings) {
  const groups = (settings.hooks && settings.hooks.UserPromptSubmit) || [];
  for (const group of groups) {
    for (const h of (group.hooks || [])) {
      if (h && commandInfo(h.command).isOurs) {
        return h;
      }
    }
  }
  return null;
}

// Ensure our hook is wired into hooks.UserPromptSubmit with the given command.
// Refreshes command/timeout/statusMessage if already present; otherwise appends
// to the first group's hooks (creating a group if none). Preserves co-residents.
function wireSettings(command) {
  const settings = settingsOrEmptyForWrite();
  settings.hooks = settings.hooks || {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];

  const existing = findOurHook(settings);
  if (existing) {
    existing.command = command;
    existing.timeout = 5;
    existing.statusMessage = 'Baseline check...';
    atomicWrite(paths.settings, JSON.stringify(settings, null, 2) + '\n');
    return 'refreshed';
  }

  const entry = { type: 'command', command: command, timeout: 5, statusMessage: 'Baseline check...' };
  // Prefer the first existing group so we share it with any co-resident hook.
  if (settings.hooks.UserPromptSubmit.length && settings.hooks.UserPromptSubmit[0].hooks) {
    settings.hooks.UserPromptSubmit[0].hooks.push(entry);
  } else {
    settings.hooks.UserPromptSubmit.push({ hooks: [entry] });
  }
  atomicWrite(paths.settings, JSON.stringify(settings, null, 2) + '\n');
  return 'added';
}

// Remove our hook entry and drop any group left empty. Other hooks untouched.
function unwireSettings() {
  const r = readJson(paths.settings);
  if (!r.ok) throw new Error('refusing to rewrite invalid settings.json: ' + r.error.message);
  const settings = r.value;
  if (!settings || !settings.hooks || !settings.hooks.UserPromptSubmit) return 'absent';
  let removed = false;
  for (const group of settings.hooks.UserPromptSubmit) {
    if (!group.hooks) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter(h => !(h && commandInfo(h.command).isOurs));
    if (group.hooks.length !== before) removed = true;
  }
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(g => g.hooks && g.hooks.length);
  if (!settings.hooks.UserPromptSubmit.length) delete settings.hooks.UserPromptSubmit;
  atomicWrite(paths.settings, JSON.stringify(settings, null, 2) + '\n');
  return removed ? 'removed' : 'absent';
}

// Infer which runtime a wired command string drives, for status/verify. A
// reference to the native binary basename means native; otherwise node+js.
function runtimeFromCommand(command) {
  return commandInfo(command).runtime;
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

// Build the zig hook for the host target and deploy it to hookDeployedExe.
// Returns the deployed path on success, or null (with report.reason set) for any
// failure. Never throws.
function buildAndDeployExe(report) {
  report = report || {};
  let buildDir = null;
  try {
    if (!fs.existsSync(paths.hookSourceZig)) { report.reason = 'zig source not in repo (scripts/baseline-recital.zig)'; return null; }
    const zig = findZig();
    if (!zig) { report.reason = 'zig 0.16.x not found on PATH'; return null; }

    fs.mkdirSync(paths.hooksDir, { recursive: true });

    // Zig 0.16 reliably emits the named host binary into cwd. Build in a temp
    // dir, then copy the single produced artifact into the Claude hooks dir.
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-recital-'));
    const built = path.join(buildDir, 'baseline-recital' + exeExt);
    const r = spawnSync(zig, [
      'build-exe', '-O', 'ReleaseSmall', '--name', 'baseline-recital', paths.hookSourceZig
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

    fs.copyFileSync(built, paths.hookDeployedExe);
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (e) {}
    buildDir = null;

    if (!isWin) { try { fs.chmodSync(paths.hookDeployedExe, 0o755); } catch (e) {} }
    report.size = fileSize(paths.hookDeployedExe);
    return paths.hookDeployedExe;
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
    for (const raw of fs.readFileSync(paths.checksums, 'utf8').split(/\r?\n/)) {
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

// Copy a platform-matched prebuilt binary from repo bin/ to hookDeployedExe.
// Returns the deployed path on success, or null (report.reason set) on any miss.
function deployPrebuiltExe(report) {
  report = report || {};
  try {
    const key = platformKey();
    if (!key) { report.reason = 'unsupported platform ' + process.platform; return null; }
    const name = prebuiltBinaryName(key);
    const src = path.join(paths.binDir, name);
    if (!fs.existsSync(src)) { report.reason = 'no prebuilt binary in bin/ for ' + key; return null; }
    if (!verifyPrebuilt(src, name, report)) return null;

    copyBinary(src, paths.hookDeployedExe);
    if (!isWin) { try { fs.chmodSync(paths.hookDeployedExe, 0o755); } catch (e) {} }
    report.size = fileSize(paths.hookDeployedExe);
    return paths.hookDeployedExe;
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

function readBaselineRaw() {
  try {
    const st = fs.statSync(paths.baseline);
    if (st.size > MAX_BASELINE_BYTES) return null;
    const raw = fs.readFileSync(paths.baseline, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_BASELINE_BYTES) return null;
    return raw;
  } catch (e) {
    return null;
  }
}

// Read interval from baseline.md (default 5). Used by verify.
function readInterval() {
  return parseBaseline(readBaselineRaw()).interval;
}

// --- commands --------------------------------------------------------------

// Decide and obtain a native binary per the requested runtime, or signal js.
// Returns { runtime: 'prebuilt'|'build'|'js', exePath, report }.
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

function cmdInstall(opts) {
  // 1. ALWAYS deploy the .js (portable fallback + reference) — overwrite; repo wins.
  atomicWrite(paths.hookDeployedJs, fs.readFileSync(paths.hookSourceJs, 'utf8'));

  // 2. Seed baseline.md only if missing — never clobber edited rules.
  let seeded = false;
  if (!fs.existsSync(paths.baseline)) {
    atomicWrite(paths.baseline, fs.readFileSync(paths.template, 'utf8'));
    seeded = true;
  }

  // 3. Resolve the runtime and obtain a native binary if applicable.
  const { runtime, exePath, report } = resolveRuntime(opts.runtime);
  const command = exePath ? exeCommand() : jsCommand();

  // 4. Wire settings.json with the chosen command.
  const wired = wireSettings(command);

  console.log('[baseline] install complete');
  if (exePath) {
    const label = runtime === 'prebuilt' ? 'prebuilt native binary' : 'native binary (built locally with zig)';
    console.log('  runtime     : ' + label + ' (fast start)');
    console.log('  hook binary : ' + paths.hookDeployedExe + ' (' + (report.size || fileSize(paths.hookDeployedExe)) + ' bytes, wired)');
    console.log('  hook .js    : ' + paths.hookDeployedJs + ' (also deployed, as fallback/reference)');
  } else {
    console.log('  runtime     : node js' + (report.reason ? ' (' + report.reason + ')' : ''));
    console.log('  hook .js    : ' + paths.hookDeployedJs + ' (deployed, wired)');
  }
  console.log('  baseline.md : ' + paths.baseline + (seeded ? ' (seeded from template)' : ' (kept existing — not overwritten)'));
  console.log('  settings    : UserPromptSubmit hook ' + wired);
  console.log('  next step   : open /hooks once (or restart) so Claude Code reloads settings.');
}

function cmdUninstall() {
  let wired;
  try {
    wired = unwireSettings();
  } catch (e) {
    fail('uninstall: ' + e.message, 1);
  }
  let jsGone = false, exeGone = false;
  try { fs.unlinkSync(paths.hookDeployedJs); jsGone = true; } catch (e) {}
  try { fs.unlinkSync(paths.hookDeployedExe); exeGone = true; } catch (e) {}
  console.log('[baseline] uninstall');
  console.log('  settings    : ' + wired);
  console.log('  hook .js    : ' + (jsGone ? 'deleted' : 'absent'));
  console.log('  hook binary : ' + (exeGone ? 'deleted' : 'absent'));
  console.log('  baseline.md : KEPT at ' + paths.baseline + ' (delete by hand if you want it gone)');
}

function cmdStatus() {
  const { settings, error } = settingsForRead();
  const ourHook = findOurHook(settings);
  const wired = !!ourHook;
  const wiredRuntime = ourHook ? runtimeFromCommand(ourHook.command) : 'none';

  const jsExists = fs.existsSync(paths.hookDeployedJs);
  let inSync = false;
  if (jsExists) {
    try {
      inSync = fs.readFileSync(paths.hookDeployedJs, 'utf8') === fs.readFileSync(paths.hookSourceJs, 'utf8');
    } catch (e) {}
  }
  const exeExists = fs.existsSync(paths.hookDeployedExe);
  const exeSize = exeExists ? fileSize(paths.hookDeployedExe) : 0;
  let exeSync = 'not present';
  if (exeExists) {
    try {
      const key = platformKey();
      const expected = key ? expectedPrebuiltHash(prebuiltBinaryName(key)) : null;
      const actual = sha256File(paths.hookDeployedExe);
      exeSync = expected
        ? (actual === expected ? 'sha256 matches checked-in prebuilt' : 'sha256 DIFFERS from checked-in prebuilt')
        : 'sha256 ' + actual + ' (no checked-in prebuilt for this platform)';
    } catch (e) {
      exeSync = 'present, sha256 unavailable: ' + e.message;
    }
  }
  const baselineExists = fs.existsSync(paths.baseline);

  console.log('[baseline] status');
  console.log('  config dir     : ' + baseDir);
  if (error) console.log('  settings       : INVALID JSON (' + error.message + ')');
  console.log('  settings wired : ' + (wired ? 'yes (runtime: ' + wiredRuntime + ')' : 'no'));
  console.log('  hook binary    : ' + (exeExists ? 'present (' + exeSize + ' bytes; ' + exeSync + ')' : 'not present'));
  console.log('  hook .js       : ' + (jsExists
    ? 'present' + (inSync ? ' (byte-identical to repo source)' : ' (DIFFERS from repo source — run install to refresh)')
    : 'not present'));
  console.log('  baseline.md    : ' + (baselineExists ? 'present' : 'missing (install will seed it)'));

  if (baselineExists) {
    const { interval, prefix, rules } = parseBaseline(readBaselineRaw());
    console.log('  interval       : ' + interval + ' (recital fires every ' + interval + ' prompts)');
    console.log('  prefix         : ' + prefix);
    console.log('  rules          : ' + rules.length);
    rules.forEach((r, i) => console.log('    ' + (i + 1) + '. ' + r));
  }
}

// Functional check — drive the ACTUALLY-WIRED runtime with synthetic stdin for
// `interval` prompts and confirm it stays silent until the Nth, then fires with
// additionalContext. Cleans the synthetic counter afterwards. Spawns with an
// args array (no shell) so it is cross-platform.
function cmdVerify() {
  const sr = settingsForRead();
  if (sr.error) {
    console.log('[baseline] verify: FAIL — invalid settings.json: ' + sr.error.message);
    process.exit(1);
  }
  const settings = sr.settings;
  const ourHook = findOurHook(settings);
  if (!ourHook) {
    console.log('[baseline] verify: FAIL — no baseline hook wired in settings. Run install.');
    process.exit(1);
  }

  const info = commandInfo(ourHook.command);
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
    const cr = readJson(paths.counters);
    if (cr.ok && cr.value && typeof cr.value === 'object') {
      delete cr.value[sid];
      atomicWrite(paths.counters, JSON.stringify(cr.value));
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

// Map the runtime reported by commandInfo() back to an install runtime token.
// 'native exe' was deployed from a prebuilt/built binary; redeploying it from a
// fresh checkout is best done via the verified prebuilt for this platform.
function installRuntimeForWired(wiredRuntime) {
  if (wiredRuntime === 'native exe') return 'prebuilt';
  return 'js';
}

// Re-deploy the hook + re-wire settings from the CURRENT repo source, keeping
// the runtime already in use (or --runtime <x> if given). Refreshes a stale
// deployed .js/binary after the repo files change. git pull is left to the
// wrapper script; this only redeploys what is on disk now.
function cmdUpdate(opts) {
  const { settings } = settingsForRead();
  const ourHook = findOurHook(settings);
  const wiredRuntime = ourHook ? runtimeFromCommand(ourHook.command) : 'none';

  let runtime = opts.runtime;
  if (!runtime) runtime = ourHook ? installRuntimeForWired(wiredRuntime) : 'js';

  console.log('[baseline] update — redeploying from repo (was: ' + wiredRuntime + ', target runtime: ' + runtime + ')');
  console.log('');
  try {
    cmdInstall({ runtime });
  } catch (e) {
    // Native redeploy can fail on a host without the prebuilt/zig — fall back to
    // the always-available js runtime rather than leaving the user broken.
    if (runtime !== 'js') {
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
  const sr = settingsForRead();
  const settings = sr.settings;

  if (sr.error) {
    checks.push({ name: 'settings.json', level: 'fail', detail: 'INVALID JSON (' + sr.error.message + ') — fix by hand; install refuses to rewrite it', fixable: false });
  } else {
    checks.push({ name: 'settings.json', level: 'ok', detail: 'valid JSON' });
  }

  const ourHook = sr.error ? null : findOurHook(settings);
  if (ourHook) {
    checks.push({ name: 'settings wiring', level: 'ok', detail: 'hook wired (runtime: ' + runtimeFromCommand(ourHook.command) + ')' });
  } else {
    checks.push({ name: 'settings wiring', level: sr.error ? 'warn' : 'fail', detail: sr.error ? 'cannot check (invalid settings)' : 'baseline hook NOT wired', fixable: !sr.error });
  }

  const jsExists = fs.existsSync(paths.hookDeployedJs);
  if (!jsExists) {
    checks.push({ name: 'hook .js', level: 'fail', detail: 'not deployed at ' + paths.hookDeployedJs, fixable: true });
  } else {
    let inSync = false;
    try { inSync = fs.readFileSync(paths.hookDeployedJs, 'utf8') === fs.readFileSync(paths.hookSourceJs, 'utf8'); } catch (e) {}
    checks.push(inSync
      ? { name: 'hook .js', level: 'ok', detail: 'byte-identical to repo source' }
      : { name: 'hook .js', level: 'warn', detail: 'DIFFERS from repo source (stale — update will refresh)', fixable: true });
  }

  const exeExists = fs.existsSync(paths.hookDeployedExe);
  const wiredNative = ourHook && runtimeFromCommand(ourHook.command) === 'native exe';
  if (exeExists) {
    const key = platformKey();
    const expected = key ? expectedPrebuiltHash(prebuiltBinaryName(key)) : null;
    let actual = null;
    try { actual = sha256File(paths.hookDeployedExe); } catch (e) {}
    if (expected && actual === expected) {
      checks.push({ name: 'hook binary', level: 'ok', detail: 'sha256 matches checked-in prebuilt' });
    } else if (expected) {
      checks.push({ name: 'hook binary', level: 'warn', detail: 'sha256 DIFFERS from checked-in prebuilt (update will refresh)', fixable: true });
    } else {
      checks.push({ name: 'hook binary', level: 'warn', detail: 'present, no checked-in prebuilt for this platform to compare', fixable: false });
    }
  } else if (wiredNative) {
    checks.push({ name: 'hook binary', level: 'fail', detail: 'settings wired to native exe but binary is MISSING', fixable: true });
  } else {
    checks.push({ name: 'hook binary', level: 'ok', detail: 'not present (js runtime — expected)' });
  }

  const baselineExists = fs.existsSync(paths.baseline);
  checks.push(baselineExists
    ? { name: 'baseline.md', level: 'ok', detail: 'present at ' + paths.baseline }
    : { name: 'baseline.md', level: 'warn', detail: 'missing (install will seed from template)', fixable: true });

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
  console.log('  config dir : ' + baseDir);
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
  const left = checks.filter(c => c.level === 'fail');
  console.log('');
  if (left.length) {
    console.log('[baseline] doctor: ' + left.length + ' issue(s) remain after fix — manual action needed.');
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
  console.log('  node scripts/manage.js install     Deploy the hook, seed baseline.md, wire settings.json.');
  console.log('  node scripts/manage.js verify      Functionally test the wired hook (fires on turn N?).');
  console.log('  node scripts/manage.js update      Redeploy hook + settings from the repo, keeping the wired runtime.');
  console.log('  node scripts/manage.js doctor      Scan the installation and report health. --fix repairs it.');
  console.log('  node scripts/manage.js uninstall   Remove the settings wiring + deployed hook (keeps baseline.md).');
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
  console.log('Config dir: CLAUDE_CONFIG_DIR if set, otherwise ~/.claude.');
}

// Parse install flags from argv (everything after the subcommand).
function parseInstallOpts(argv) {
  const opts = { runtime: null }; // null => js default
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build' || a === '-build') {
      opts.runtime = 'build';
    } else if (a === '--runtime' || a === '-runtime') {
      const v = (argv[i + 1] || '').toLowerCase();
      i++;
      if (v === 'prebuilt' || v === 'build' || v === 'js') {
        opts.runtime = v;
      } else {
        fail('install: unknown --runtime "' + (argv[i] || '') + '" (use prebuilt|build|js).', 2);
      }
    } else if (a.startsWith('--runtime=') || a.startsWith('-runtime=')) {
      const v = a.slice(a.indexOf('=') + 1).toLowerCase();
      if (v === 'prebuilt' || v === 'build' || v === 'js') opts.runtime = v;
      else fail('install: unknown --runtime "' + v + '" (use prebuilt|build|js).', 2);
    }
  }
  return opts;
}

// Parse doctor flags: --fix (repair) and the shared --runtime selector.
function parseDoctorOpts(argv) {
  const opts = parseInstallOpts(argv);
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
    cmdUninstall();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'verify':
    cmdVerify();
    break;
  case 'update':
    try {
      cmdUpdate(parseInstallOpts(process.argv.slice(3)));
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
