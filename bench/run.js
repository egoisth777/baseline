#!/usr/bin/env node
'use strict';
// baseline benchmark harness (R-013). Zero dependencies — Node built-ins only. NOT wired
// into `npm test` (cold-start timing is noisy); run it deliberately.
//
// Races the real baseline dispatcher against minimal JS / Python / TS reference hooks
// doing the SAME injection task (read config, match event, read doc, print
// additionalContext), reporting cold-start p50/p95 latency and peak RSS (where the
// platform can measure it), and enforcing provisional budgets on --check.
//
//   node bench/run.js            full run: measure, write bench/results.{md,json}
//   node bench/run.js --smoke    shape check: run each impl once, verify output, no timing
//   node bench/run.js --check    measure, then fail if baseline-node exceeds bench/budgets.json
//
// A fair "baseline" wants the native engine (R-009); until it lands these are Node-path
// numbers and the budgets in bench/budgets.json are PROVISIONAL.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const SMOKE = args.indexOf('--smoke') !== -1;
const CHECK = args.indexOf('--check') !== -1;
const N = Number(process.env.BENCH_N || (SMOKE ? 1 : 20));
const WARMUP = SMOKE ? 0 : Number(process.env.BENCH_WARMUP || 3);

const DOC_MARKER = 'BASELINE-BENCH-DOC';
const DOC_BODY = [
  '# ' + DOC_MARKER,
  '',
  'Restate the standing rules before continuing:',
  '- route file and shell operations through subagents;',
  '- keep docs short and trusted;',
  '- recite this block verbatim so drift surfaces.',
  ''
].join('\n');

// A temp fixture laid out exactly as the dispatcher expects: CLAUDE_CONFIG_DIR/cfg/baseline/
// with config.json + docs/. The reference hooks read the same config via BENCH_CONFIG.
function setupFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-bench-'));
  const cfgBaseline = path.join(dir, 'cfg', 'baseline');
  fs.mkdirSync(path.join(cfgBaseline, 'docs'), { recursive: true });
  const configPath = path.join(cfgBaseline, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    routes: [{ id: 'bench', event: 'UserPromptSubmit', freq: 1, doc: 'docs/bench.md' }]
  }, null, 2));
  fs.writeFileSync(path.join(cfgBaseline, 'docs', 'bench.md'), DOC_BODY);
  return { dir, configPath };
}

const fixture = setupFixture();
const HOOK_INPUT = JSON.stringify({ session_id: 'bench', hook_event_name: 'UserPromptSubmit', cwd: fixture.dir });

// The native prebuilt shipped for this platform, or null where none exists (mirrors
// manage.js nativePrebuiltName). The baseline-native lane skips-with-notice elsewhere.
function nativePrebuiltName() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'baseline-recital-windows-x64.exe';
  if (process.platform === 'linux' && process.arch === 'x64') return 'baseline-recital-linux-x64';
  return null;
}

function detectPython() {
  // Per the toolchain probe, `python3` may be a Windows Store stub — try `python`, then `py -3`.
  for (const cand of [['python'], ['py', '-3']]) {
    const r = spawnSync(cand[0], cand.slice(1).concat(['--version']), { encoding: 'utf8' });
    if (!r.error && r.status === 0) return cand;
  }
  return null;
}

function detectTs(scriptTs) {
  try { require.resolve('tsx', { paths: [REPO] }); return { cmd: process.execPath, args: ['--import', 'tsx', scriptTs], note: 'tsx' }; } catch (e) { /* not installed */ }
  try { require.resolve('ts-node', { paths: [REPO] }); return { cmd: process.execPath, args: ['-r', 'ts-node/register', scriptTs], note: 'ts-node' }; } catch (e) { /* not installed */ }
  return null;
}

// baseline-node + ref-node are required; python/ts are optional (skip-with-notice).
function buildImpls() {
  const impls = [];
  impls.push({
    name: 'baseline-node', required: true,
    cmd: process.execPath, args: [path.join(REPO, 'scripts', 'baseline-recital.js')],
    env: { CLAUDE_CONFIG_DIR: fixture.dir },
    note: 'the real dispatcher (counters + lock + caps)'
  });
  // The native Zig dispatcher (R-009) doing the SAME task — the hook hot path. Optional:
  // skips-with-notice on a platform with no shipped prebuilt.
  const nativeName = nativePrebuiltName();
  const nativeBin = nativeName ? path.join(REPO, 'bin', nativeName) : null;
  impls.push(nativeBin && fs.existsSync(nativeBin)
    ? { name: 'baseline-native', required: false, cmd: nativeBin, args: ['--agent-config', fixture.dir], env: {}, note: 'the native Zig dispatcher (R-009) — same routes/counters/lock/caps' }
    : { name: 'baseline-native', required: false, skipped: 'no native prebuilt for ' + process.platform + '-' + process.arch });
  impls.push({
    name: 'ref-node', required: true,
    cmd: process.execPath, args: [path.join(__dirname, 'refs', 'node-min.js')],
    env: { BENCH_CONFIG: fixture.configPath }, note: 'minimal plain-node hook'
  });
  const py = detectPython();
  impls.push(py
    ? { name: 'ref-python', required: false, cmd: py[0], args: py.slice(1).concat([path.join(__dirname, 'refs', 'python-min.py')]), env: { BENCH_CONFIG: fixture.configPath }, note: 'minimal python hook (' + py.join(' ') + ')' }
    : { name: 'ref-python', required: false, skipped: 'python / py -3 not found on PATH' });
  const ts = detectTs(path.join(__dirname, 'refs', 'ts-min.ts'));
  impls.push(ts
    ? { name: 'ref-ts', required: false, cmd: ts.cmd, args: ts.args, env: { BENCH_CONFIG: fixture.configPath }, note: 'TS at runtime via ' + ts.note + ' (measures transpile-on-start)' }
    : { name: 'ref-ts', required: false, skipped: 'no tsx / ts-node available (TS-at-runtime needs one)' });
  return impls;
}

function runOnce(impl) {
  return spawnSync(impl.cmd, impl.args, { input: HOOK_INPUT, encoding: 'utf8', env: Object.assign({}, process.env, impl.env || {}) });
}

function outputOk(out) {
  try {
    const obj = JSON.parse((out || '').trim());
    return !!(obj.hookSpecificOutput && typeof obj.hookSpecificOutput.additionalContext === 'string'
      && obj.hookSpecificOutput.additionalContext.indexOf(DOC_MARKER) !== -1);
  } catch (e) { return false; }
}

function pctile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// Near-peak RSS: prefer the impl's own cross-platform self-report (`##RSS:<bytes>` on
// stderr — works on Windows too); fall back to `/usr/bin/time` on POSIX for impls that
// don't self-report (the real dispatcher). null where neither is available (e.g.
// baseline-node on Windows) — reported honestly as "n/a", never as a passing measurement.
function measureRss(impl) {
  const self = runOnce(impl);
  const sm = (self.stderr || '').match(/##RSS:(\d+)/);
  if (sm) return Number(sm[1]);
  if (process.platform !== 'win32') {
    for (const v of [{ pre: ['-v'], re: /Maximum resident set size \(kbytes\):\s*(\d+)/, scale: 1024 },
                     { pre: ['-l'], re: /(\d+)\s+maximum resident set size/, scale: 1 }]) {
      const r = spawnSync('/usr/bin/time', v.pre.concat([impl.cmd], impl.args), {
        input: HOOK_INPUT, encoding: 'utf8', env: Object.assign({}, process.env, impl.env || {})
      });
      if (r.error) continue;
      const m = (r.stderr || '').match(v.re);
      if (m) return Number(m[1]) * v.scale;
    }
  }
  return null;
}

function measure(impl) {
  if (impl.skipped) return impl;
  for (let i = 0; i < WARMUP; i++) runOnce(impl);
  const samples = [];
  let firstOut = null;
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const r = runOnce(impl);
    const t1 = process.hrtime.bigint();
    if (r.error) return Object.assign({}, impl, { error: String((r.error && r.error.message) || r.error) });
    if (firstOut === null) firstOut = (r.stdout || '').trim();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return Object.assign({}, impl, {
    ok: outputOk(firstOut), p50: pctile(samples, 50), p95: pctile(samples, 95),
    rssBytes: measureRss(impl), n: N
  });
}

function fmtMs(x) { return x == null ? 'n/a' : x.toFixed(1); }
function fmtRss(x) { return x == null ? 'n/a' : (x / 1048576).toFixed(1) + ' MiB'; }
function cleanup() { try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }

function sanitize(r) {
  return {
    name: r.name, required: !!r.required, skipped: r.skipped || null, error: r.error || null,
    ok: r.skipped ? null : !!r.ok, p50: r.p50 == null ? null : r.p50, p95: r.p95 == null ? null : r.p95,
    rssBytes: r.rssBytes == null ? null : r.rssBytes, note: r.note || null
  };
}

function writeResults(results) {
  const stamp = new Date().toISOString();
  const machine = { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length };
  fs.writeFileSync(path.join(__dirname, 'results.json'),
    JSON.stringify({ generatedAt: stamp, machine, n: N, results: results.map(sanitize) }, null, 2) + '\n');

  const lines = [];
  lines.push('# Benchmark results');
  lines.push('');
  lines.push('Generated ' + stamp + ' on ' + machine.platform + '/' + machine.arch + ', Node ' + machine.node
    + ', ' + machine.cpus + ' CPUs, N=' + N + ' cold-start runs each (regenerate with `npm run bench`).');
  lines.push('');
  lines.push('Each implementation runs the SAME injection task — read config, match the event, read the doc, print '
    + '`additionalContext`. `baseline-node` is the real dispatcher (counters + lock + caps); the refs are minimal.');
  lines.push('');
  lines.push('| impl | p50 (ms) | p95 (ms) | peak RSS | notes |');
  lines.push('|------|---------:|---------:|---------:|-------|');
  for (const r of results) {
    if (r.skipped) { lines.push('| ' + r.name + ' | — | — | — | SKIPPED: ' + r.skipped + ' |'); continue; }
    if (r.error) { lines.push('| ' + r.name + ' | — | — | — | ERROR: ' + r.error + ' |'); continue; }
    lines.push('| ' + r.name + ' | ' + fmtMs(r.p50) + ' | ' + fmtMs(r.p95) + ' | ' + fmtRss(r.rssBytes) + ' | '
      + (r.ok ? '' : '**OUTPUT MISMATCH** ') + (r.note || '') + ' |');
  }
  lines.push('');
  if (process.platform === 'win32') {
    lines.push('> Peak RSS is not measured on Windows (no portable child-peak-RSS probe); it is reported on Linux/macOS via `/usr/bin/time`.');
    lines.push('');
  }
  lines.push('Budgets live in `bench/budgets.json`; `npm run bench:check` fails when `baseline-node` exceeds them. '
    + 'The enforced gate is the Node-path `baseline-node` budget (**PROVISIONAL**); `baseline-native` (R-009, the hook hot path) is reported here for comparison. Final budgets pinned on a CI reference platform remain pending.');
  lines.push('');
  fs.writeFileSync(path.join(__dirname, 'results.md'), lines.join('\n'));
}

function enforceBudgets(results) {
  let budgets;
  try { budgets = JSON.parse(fs.readFileSync(path.join(__dirname, 'budgets.json'), 'utf8')); }
  catch (e) { process.stderr.write('bench:check — cannot read bench/budgets.json (' + e.message + '); run `npm run bench` and seed budgets first.\n'); return 1; }
  const baseline = results.find((r) => r.name === 'baseline-node');
  if (!baseline || baseline.error || baseline.p95 == null) { process.stderr.write('bench:check — no baseline-node measurement.\n'); return 1; }
  let bad = false;
  if (budgets.latencyP95Ms != null) {
    const ok = baseline.p95 <= budgets.latencyP95Ms;
    process.stdout.write('bench:check latency p95 ' + baseline.p95.toFixed(1) + ' ms vs budget ' + budgets.latencyP95Ms + ' ms — ' + (ok ? 'OK' : 'BREACH') + '\n');
    if (!ok) bad = true;
  }
  if (budgets.peakRssBytes != null) {
    if (baseline.rssBytes == null) {
      process.stdout.write('bench:check peak RSS not measurable on this platform; skipping RSS gate (never a false green).\n');
    } else {
      const ok = baseline.rssBytes <= budgets.peakRssBytes;
      process.stdout.write('bench:check peak RSS ' + (baseline.rssBytes / 1048576).toFixed(1) + ' MiB vs budget ' + (budgets.peakRssBytes / 1048576).toFixed(1) + ' MiB — ' + (ok ? 'OK' : 'BREACH') + '\n');
      if (!ok) bad = true;
    }
  } else {
    process.stdout.write('bench:check RSS budget not pinned yet (TODO after native engine); skipping RSS gate.\n');
  }

  // Native hot-path budgets (R-009, decision #18). Enforced where the native lane ran and
  // its numbers are obtainable; skip-with-notice when the lane skipped (no prebuilt for this
  // platform) or its peak RSS is n/a (e.g. Windows) — never a false green.
  const native = results.find((r) => r.name === 'baseline-native');
  const nb = budgets.native;
  if (nb && native && !native.skipped && !native.error) {
    if (nb.latencyP95Ms != null && native.p95 != null) {
      const ok = native.p95 <= nb.latencyP95Ms;
      process.stdout.write('bench:check native latency p95 ' + native.p95.toFixed(1) + ' ms vs budget ' + nb.latencyP95Ms + ' ms — ' + (ok ? 'OK' : 'BREACH') + '\n');
      if (!ok) bad = true;
    }
    if (nb.peakRssBytes != null) {
      if (native.rssBytes == null) {
        process.stdout.write('bench:check native peak RSS not measurable on this platform; skipping native RSS gate (never a false green).\n');
      } else {
        const ok = native.rssBytes <= nb.peakRssBytes;
        process.stdout.write('bench:check native peak RSS ' + (native.rssBytes / 1048576).toFixed(1) + ' MiB vs budget ' + (nb.peakRssBytes / 1048576).toFixed(1) + ' MiB — ' + (ok ? 'OK' : 'BREACH') + '\n');
        if (!ok) bad = true;
      }
    }
  } else if (nb) {
    process.stdout.write('bench:check native lane not measured here (no prebuilt for this platform); skipping native gates.\n');
  }
  return bad ? 1 : 0;
}

const results = buildImpls().map(measure);

if (SMOKE) {
  const summary = results.map((r) => ({ name: r.name, required: !!r.required, skipped: r.skipped || null, ok: r.skipped ? null : !!r.ok, error: r.error || null }));
  const failed = results.filter((r) => r.required && !r.skipped && (!r.ok || r.error));
  cleanup();
  process.stdout.write(JSON.stringify({ smoke: true, platform: process.platform, impls: summary }) + '\n');
  process.exit(failed.length ? 1 : 0);
}

writeResults(results);
for (const r of results) {
  if (r.skipped) process.stdout.write('  ' + r.name + ': SKIPPED (' + r.skipped + ')\n');
  else if (r.error) process.stdout.write('  ' + r.name + ': ERROR (' + r.error + ')\n');
  else process.stdout.write('  ' + r.name + ': p50=' + fmtMs(r.p50) + 'ms p95=' + fmtMs(r.p95) + 'ms rss=' + fmtRss(r.rssBytes) + (r.ok ? '' : '  [OUTPUT MISMATCH]') + '\n');
}
process.stdout.write('wrote bench/results.md and bench/results.json\n');

let code = 0;
if (CHECK) code = enforceBudgets(results);
cleanup();
process.exit(code);
