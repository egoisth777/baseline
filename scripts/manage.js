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
// Default order when no flag is given: a prebuilt binary matching this platform
// (in the repo bin/) if present; else js. (--build additionally tries a local
// zig build, falling back to js if zig is missing or the build fails.)
//
// Design notes:
// - The repo is the source of truth. install deploys the hook into the Claude
//   config dir (CLAUDE_CONFIG_DIR or ~/.claude) and seeds baseline.md from the
//   template ONLY if absent (never clobbers operator-edited rules).
// - The .js hook is the portable source of truth AND fallback: install ALWAYS
//   deploys scripts/baseline-recital.js to hooks/, regardless of which runtime
//   is wired, so there is always a working reference copy.
// - A native runtime (prebuilt binary, or a fresh zig build) eliminates Node
//   process-boot latency on the hot path. Any failure to obtain a native binary
//   degrades to wiring the Node .js — never a hard error.
// - settings.json editing is surgical and idempotent. Our entry is recognised by
//   the substring "baseline-recital" in its .command, so it matches the .js and
//   the native form alike. Co-resident UserPromptSubmit hooks (e.g. caveman) are
//   always preserved. JSON reserializes with 2-space indent + trailing newline.
// - All paths are built with os/path (no hardcoded separators). The Node runtime
//   command uses process.execPath. Child processes are spawned with an args array
//   (no shell), so there is no platform-specific quoting to get wrong.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// --- platform + path resolution -------------------------------------------

const isWin = process.platform === 'win32';

// Base config dir: explicit override, else ~/.claude. Cross-platform via os/path.
const baseDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Repo root resolved relative to this file (scripts/ sits directly under root).
const repoRoot = path.resolve(__dirname, '..');

// Deployed native-exe basename differs by platform (.exe suffix on Windows only).
const exeExt = isWin ? '.exe' : '';

// Map process.platform -> the platform key used in prebuilt binary filenames.
// Returns null for anything we don't ship a prebuilt for (caller falls back to js).
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
};

// Prebuilt binary filename in repo bin/ for a given platform key.
function prebuiltBinaryName(key) {
  return key === 'windows-x64' ? 'baseline-recital-windows-x64.exe' : 'baseline-recital-linux-x64';
}

// Substring matched against an existing settings.json command to recognise our
// own hook entry. Extension/runtime-agnostic so it matches the deployed .js AND
// the deployed native binary — so install refreshes (never duplicates) the entry
// across a runtime switch, and uninstall removes whichever form is present.
const HOOK_STEM = 'baseline-recital';

// Quote a single arg for embedding in the settings.json command STRING. The
// harness parses this string into argv, so paths with spaces (or Windows
// backslashes) must be double-quoted. We always quote — harmless when unneeded.
const quoteArg = s => '"' + s + '"';

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
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
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

// --- settings.json surgery -------------------------------------------------

// Find our hook entry within hooks.UserPromptSubmit, if present. Loose match on
// the deployed-file stem so neither a node-path change nor a runtime switch makes
// a duplicate.
function findOurHook(settings) {
  const groups = (settings.hooks && settings.hooks.UserPromptSubmit) || [];
  for (const group of groups) {
    for (const h of (group.hooks || [])) {
      if (h && typeof h.command === 'string' && h.command.includes(HOOK_STEM)) {
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
  const settings = readJson(paths.settings) || {};
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
  const settings = readJson(paths.settings);
  if (!settings || !settings.hooks || !settings.hooks.UserPromptSubmit) return 'absent';
  let removed = false;
  for (const group of settings.hooks.UserPromptSubmit) {
    if (!group.hooks) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter(h => !(h && typeof h.command === 'string' && h.command.includes(HOOK_STEM)));
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
  if (typeof command !== 'string') return 'none';
  const nativeBase = 'baseline-recital' + exeExt;
  // On Windows the .exe suffix disambiguates from the .js. On Linux the native
  // binary has no extension, so treat "...baseline-recital.js" as js and any
  // other baseline-recital reference as the native binary.
  if (/baseline-recital\.js(["']|\s|$)/i.test(command)) return 'node js';
  if (isWin) return /baseline-recital\.exe/i.test(command) ? 'native exe' : 'node js';
  return command.includes(nativeBase) ? 'native exe' : 'node js';
}

// --- native build (zig) ----------------------------------------------------

// Resolve a usable zig compiler: confirm by spawning `zig version`. Returns the
// invocable name on success, null if absent/broken. Never throws.
function findZig() {
  try {
    const r = spawnSync('zig', ['version'], { encoding: 'utf8' });
    if (r.status === 0) return 'zig';
  } catch (e) {}
  return null;
}

// Build the zig hook for the host target and deploy it to hookDeployedExe.
// Returns the deployed path on success, or null (with report.reason set) for any
// failure — caller then falls back to js. Never throws.
function buildAndDeployExe(report) {
  report = report || {};
  try {
    if (!fs.existsSync(paths.hookSourceZig)) { report.reason = 'zig source not in repo (scripts/baseline-recital.zig)'; return null; }
    const zig = findZig();
    if (!zig) { report.reason = 'zig not found on PATH'; return null; }

    fs.mkdirSync(paths.hooksDir, { recursive: true });

    // Emit straight to the deployed path (host target). -femit-bin pins output
    // so we don't depend on cwd.
    const r = spawnSync(zig, [
      'build-exe', paths.hookSourceZig, '-O', 'ReleaseSmall', '-femit-bin=' + paths.hookDeployedExe
    ], { encoding: 'utf8' });

    if (r.status !== 0) {
      const err = ((r.stderr || (r.error && r.error.message) || '').toString().trim().split(/\r?\n/)[0]) || '(no stderr)';
      report.reason = 'zig build failed: ' + err;
      return null;
    }
    if (!fs.existsSync(paths.hookDeployedExe)) { report.reason = 'zig build produced no binary'; return null; }

    if (!isWin) { try { fs.chmodSync(paths.hookDeployedExe, 0o755); } catch (e) {} }
    report.size = fileSize(paths.hookDeployedExe);

    // Clean sidecar artifacts zig may drop next to the output (.pdb/.obj).
    const base = paths.hookDeployedExe.replace(/\.exe$/i, '');
    for (const f of [base + '.pdb', paths.hookDeployedExe + '.obj', base + '.obj', paths.hookDeployedExe + '.pdb']) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
    return paths.hookDeployedExe;
  } catch (e) {
    report.reason = 'build error: ' + e.message;
    return null;
  }
}

// Copy a platform-matched prebuilt binary from repo bin/ to hookDeployedExe.
// Returns the deployed path on success, or null (report.reason set) on any miss.
function deployPrebuiltExe(report) {
  report = report || {};
  try {
    const key = platformKey();
    if (!key) { report.reason = 'unsupported platform ' + process.platform; return null; }
    const src = path.join(paths.binDir, prebuiltBinaryName(key));
    if (!fs.existsSync(src)) { report.reason = 'no prebuilt binary in bin/ for ' + key; return null; }

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
  let interval = 5;
  let prefix = '(default)';
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
        prefix = val.replace(/^["']|["']$/g, '') || prefix;
      }
    }
  }
  const rules = body.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return { interval, prefix, rules };
}

// Read interval from baseline.md (default 5). Used by verify.
function readInterval() {
  try {
    const m = /interval:\s*(\d+)/.exec(fs.readFileSync(paths.baseline, 'utf8'));
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (e) {}
  return 5;
}

// --- commands --------------------------------------------------------------

// Decide and obtain a native binary per the requested runtime, or signal js.
// Returns { runtime: 'prebuilt'|'build'|'js', exePath, report }.
function resolveRuntime(requested) {
  const report = {};

  if (requested === 'js') {
    report.reason = 'requested by --runtime js';
    return { runtime: 'js', exePath: null, report };
  }

  if (requested === 'prebuilt') {
    const exePath = deployPrebuiltExe(report);
    if (exePath) return { runtime: 'prebuilt', exePath, report };
    return { runtime: 'js', exePath: null, report };
  }

  if (requested === 'build') {
    const exePath = buildAndDeployExe(report);
    if (exePath) return { runtime: 'build', exePath, report };
    return { runtime: 'js', exePath: null, report };
  }

  // Default (no flag): prefer a platform-matched prebuilt if it exists, else js.
  const pre = {};
  const exePath = deployPrebuiltExe(pre);
  if (exePath) return { runtime: 'prebuilt', exePath, report: pre };
  return { runtime: 'js', exePath: null, report: pre };
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
    let why = report.reason ? ' (reason: ' + report.reason + ')' : '';
    if (opts.runtime === 'build' || opts.runtime === 'prebuilt') {
      console.log('  runtime     : node js  [requested ' + opts.runtime + ' but fell back]' + why);
    } else {
      console.log('  runtime     : node js' + (report.reason ? ' (' + report.reason + ')' : ''));
    }
    console.log('  hook .js    : ' + paths.hookDeployedJs + ' (deployed, wired)');
  }
  console.log('  baseline.md : ' + paths.baseline + (seeded ? ' (seeded from template)' : ' (kept existing — not overwritten)'));
  console.log('  settings    : UserPromptSubmit hook ' + wired);
  console.log('  next step   : open /hooks once (or restart) so Claude Code reloads settings.');
}

function cmdUninstall() {
  const wired = unwireSettings();
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
  const settings = readJson(paths.settings) || {};
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
  const baselineExists = fs.existsSync(paths.baseline);

  console.log('[baseline] status');
  console.log('  config dir     : ' + baseDir);
  console.log('  settings wired : ' + (wired ? 'yes (runtime: ' + wiredRuntime + ')' : 'no'));
  console.log('  hook binary    : ' + (exeExists ? 'present (' + exeSize + ' bytes)' : 'not present'));
  console.log('  hook .js       : ' + (jsExists
    ? 'present' + (inSync ? ' (byte-identical to repo source)' : ' (DIFFERS from repo source — run install to refresh)')
    : 'not present'));
  console.log('  baseline.md    : ' + (baselineExists ? 'present' : 'missing (install will seed it)'));

  if (baselineExists) {
    const { interval, prefix, rules } = parseBaseline(fs.readFileSync(paths.baseline, 'utf8'));
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
  const settings = readJson(paths.settings) || {};
  const ourHook = findOurHook(settings);
  if (!ourHook) {
    console.log('[baseline] verify: FAIL — no baseline hook wired in settings. Run install.');
    process.exit(1);
  }

  const wiredRuntime = runtimeFromCommand(ourHook.command);

  // Build [exe, args] matching the wired runtime.
  let runExe, runArgs;
  if (wiredRuntime === 'native exe') {
    if (!fs.existsSync(paths.hookDeployedExe)) {
      console.log('[baseline] verify: FAIL — native binary wired but not deployed. Run install.');
      process.exit(1);
    }
    runExe = paths.hookDeployedExe;
    runArgs = [];
  } else {
    if (!fs.existsSync(paths.hookDeployedJs)) {
      console.log('[baseline] verify: FAIL — .js hook wired but not deployed. Run install.');
      process.exit(1);
    }
    runExe = process.execPath;
    runArgs = [paths.hookDeployedJs];
  }

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
    const c = readJson(paths.counters) || {};
    delete c[sid];
    atomicWrite(paths.counters, JSON.stringify(c));
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

// --- help / arg parsing -----------------------------------------------------

function printHelp() {
  console.log('baseline — manage the baseline-recital hook (cross-platform: Windows + Linux)');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/manage.js status      Report what is installed vs the repo source.');
  console.log('  node scripts/manage.js install     Deploy the hook, seed baseline.md, wire settings.json.');
  console.log('  node scripts/manage.js verify      Functionally test the wired hook (fires on turn N?).');
  console.log('  node scripts/manage.js uninstall   Remove the settings wiring + deployed hook (keeps baseline.md).');
  console.log('  node scripts/manage.js help        Show this help.');
  console.log('');
  console.log('install options:');
  console.log('  --runtime <prebuilt|build|js>   Choose the hook runtime.');
  console.log('                                    prebuilt: copy the matching binary from bin/.');
  console.log('                                    build:    compile scripts/baseline-recital.zig with zig.');
  console.log('                                    js:       run the Node .js hook directly.');
  console.log('  --build                         Alias for --runtime build.');
  console.log('  (default)                       Use a platform-matched prebuilt binary if present, else js.');
  console.log('                                  Any native option silently falls back to js if unavailable.');
  console.log('');
  console.log('Config dir: CLAUDE_CONFIG_DIR if set, otherwise ~/.claude.');
}

// Parse install flags from argv (everything after the subcommand).
function parseInstallOpts(argv) {
  const opts = { runtime: null }; // null => default order
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build') {
      opts.runtime = 'build';
    } else if (a === '--runtime') {
      const v = (argv[i + 1] || '').toLowerCase();
      i++;
      if (v === 'prebuilt' || v === 'build' || v === 'js') {
        opts.runtime = v;
      } else {
        console.log('[baseline] install: unknown --runtime "' + (argv[i] || '') + '" (use prebuilt|build|js). Using default.');
      }
    } else if (a.startsWith('--runtime=')) {
      const v = a.slice('--runtime='.length).toLowerCase();
      if (v === 'prebuilt' || v === 'build' || v === 'js') opts.runtime = v;
      else console.log('[baseline] install: unknown --runtime "' + v + '" (use prebuilt|build|js). Using default.');
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
    cmdInstall(parseInstallOpts(process.argv.slice(3)));
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
  default:
    console.log('[baseline] unknown command "' + cmd + '".');
    printHelp();
    process.exit(2);
}
