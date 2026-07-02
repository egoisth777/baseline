#!/usr/bin/env node
// baseline — injection-routes dispatcher (canonical source).
//
// Problem it solves: across a long session the agent drifts from standing rules.
// baseline periodically injects small, trusted docs into model context at chosen
// hook events so drift surfaces in the recited text and self-corrects.
//
// This one dispatcher is wired into every event a route uses. On each invocation
// it reads the hook event from stdin, loads cfg/baseline/config.json, selects the
// routes matching the (event, cwd), bumps each one's per-route counter,
// and injects the docs that are due — verbatim, with NO wrapper added by code.
//
// Nothing operator-tunable is hardcoded here. Routes live in config.json; the
// injected text lives in docs/*.md. This file carries ZERO baked content: if the
// config or docs are gone, it injects nothing and exits clean. `doctor` reports
// the fault. A hook error must never block the agent (fail-open).
//
// Counting is keyed by session_id from the hook stdin payload, composited with the
// route id ("<session>:<routeId>") so each route counts independently.
//
// Deployed to <agent>/hooks/baseline-recital.js by manage.js; the agent's
// cfg/baseline/ folder links back to the central config. Edit the TypeScript
// source in src/, run the build, then re-run `node scripts/manage.js install`.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MAX_CONFIG_BYTES,
  MAX_DOC_BYTES,
  MAX_DOC_CHARS,
  MAX_ROUTES,
  Route,
  SESSION_PHASES,
  SLUG,
  SUPPORTED_EVENTS,
  VarMap,
  applyTemplate,
  cwdMatches as matchCwd,
  eventMatches as matchEvent,
  mergeVars,
  parseEvent,
  safeDocPath,
  safeRealDocPath,
  sanitizeVars,
} from './contracts';

interface CounterEntry {
  count: number;
  ts: number;
}

type Counters = { [key: string]: CounterEntry };

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  source?: string;
}

// Drop counter entries untouched for longer than this (stale sessions).
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_COUNTER_BYTES = 1024 * 1024;
const MAX_LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 5000;

function argValue(name: string): string | null {
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1] || null;
    if (arg.startsWith(name + '=')) return arg.slice(name.length + 1) || null;
  }
  return null;
}

const agentDir =
  process.env.BASELINE_AGENT_CONFIG_DIR ||
  argValue('--agent-config') ||
  process.env.CLAUDE_CONFIG_DIR ||
  process.env.CODEX_HOME ||
  path.join(os.homedir(), '.claude');
// The agent's config folder links back to <install root>/cfg, so reading here is
// transparently reading the configured config folder — the dispatcher resolves only
// via the agent dir and knows nothing about BASELINE_HOME / BASELINE_CFG.
const cfgDir = path.join(agentDir, 'cfg', 'baseline');
const configPath = path.join(cfgDir, 'config.json');
const counterPath = path.join(agentDir, '.baseline-counters.json');
const counterLockPath = counterPath + '.lock';

interface ValidConfig {
  routes: Route[];
  vars: VarMap; // config-level template vars (a route's own vars override these)
}

// Load and validate config.json into the routes the dispatcher will act on, plus the
// config-level template vars. Fail-open: any fatal problem (missing/oversize/malformed
// config, bad version, over-cap route count) returns no routes so the hook injects
// nothing. Individual bad routes are skipped in isolation; a duplicate id keeps the
// first occurrence. Malformed `vars` are dropped (never fatal) — configs without vars
// behave byte-identically to before templating existed.
function loadValidConfig(): ValidConfig {
  const empty: ValidConfig = { routes: [], vars: {} };
  let raw: string;
  try {
    const st = fs.statSync(configPath);
    if (st.size > MAX_CONFIG_BYTES) return empty;
    raw = fs.readFileSync(configPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) return empty;
  } catch (e) {
    return empty;
  }

  let cfg: any;
  try { cfg = JSON.parse(raw); } catch (e) { return empty; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return empty;
  // version: missing => assume 1; any value other than 1 => inject nothing.
  if (cfg.version !== undefined && cfg.version !== 1) return empty;

  const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
  if (routes.length > MAX_ROUTES) return empty;

  const configVars = sanitizeVars(cfg.vars, 'config');
  const seen: { [id: string]: true } = {};
  const out: Route[] = [];
  for (const r of routes) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.id !== 'string' || !SLUG.test(r.id)) continue;
    if (seen[r.id]) continue; // duplicate id — first wins, never double-count
    if (typeof r.event !== 'string') continue;
    const ev = parseEvent(r.event);
    if (SUPPORTED_EVENTS.indexOf(ev.base) === -1) continue;
    if (ev.phase !== undefined && (ev.base !== 'SessionStart' || SESSION_PHASES.indexOf(ev.phase) === -1)) continue;
    if (!safeDocPath(r.doc, cfgDir)) continue;
    let freq = 1;
    if (r.freq !== undefined) {
      if (typeof r.freq !== 'number' || !Number.isInteger(r.freq) || r.freq < 1) continue;
      freq = r.freq;
    }
    if (r.cwd !== undefined && typeof r.cwd !== 'string') continue;
    const vars = sanitizeVars(r.vars, 'route ' + r.id);
    seen[r.id] = true;
    out.push({ id: r.id, event: r.event, freq, cwd: r.cwd, doc: r.doc, vars });
  }
  return { routes: out, vars: configVars };
}

// Selection predicates delegate to the shared contract matchers so the dispatcher and
// `dispatch simulate` agree exactly. The event name is the sole moment-resolver (base
// event + optional SessionStart phase vs stdin `source`); cwd is a normalized
// path-boundary prefix, case-insensitive on Windows; an omitted cwd matches any dir.
function eventMatches(route: Route, data: HookInput): boolean {
  return matchEvent(route.event, data.hook_event_name, data.source);
}

function cwdMatches(route: Route, data: HookInput): boolean {
  return matchCwd(route.cwd, data.cwd, process.platform === 'win32');
}

// Read a route's doc, bounded. Returns the verbatim body, or null to skip (missing,
// unreadable, over-cap, or — defensively — out of range). The content read is async so
// several due docs can be read concurrently (R-011); the path-safety realpath check
// stays synchronous, and the byte/char caps are unchanged.
async function readDocAsync(doc: string): Promise<string | null> {
  const p = safeRealDocPath(doc, cfgDir);
  if (!p) return null;
  try {
    const st = await fs.promises.stat(p);
    if (st.size > MAX_DOC_BYTES) return null;
    const body = await fs.promises.readFile(p, 'utf8');
    if (Buffer.byteLength(body, 'utf8') > MAX_DOC_BYTES) return null;
    if (body.length > MAX_DOC_CHARS) return null;
    return body;
  } catch (e) {
    return null;
  }
}

// Refuse to follow a symlink at the counter path (basic hardening — never read or
// write through a link an attacker may have planted in place of our state file).
function readCounters(): Counters {
  try {
    const st = fs.lstatSync(counterPath);
    if (st.isSymbolicLink()) return {};
    if (st.size > MAX_COUNTER_BYTES) return {};
    const obj = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeCounters(counters: Counters): void {
  try {
    const st = fs.lstatSync(counterPath);
    if (st.isSymbolicLink()) return;
  } catch (e) {
    // ENOENT — fine, file will be created.
  }
  try {
    const tmp = counterPath + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(counters), 'utf8');
    fs.renameSync(tmp, counterPath); // atomic replace
  } catch (e) {
    // Best-effort; never break the agent over counter I/O.
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireCounterLock(): boolean {
  const start = Date.now();
  while ((Date.now() - start) <= MAX_LOCK_WAIT_MS) {
    try {
      fs.mkdirSync(counterLockPath);
      return true;
    } catch (e: any) {
      if (!e || e.code !== 'EEXIST') return false;
      try {
        const st = fs.statSync(counterLockPath);
        if ((Date.now() - st.mtimeMs) > STALE_LOCK_MS) fs.rmSync(counterLockPath, { recursive: true, force: true });
      } catch (staleErr) {
        // Another process may have removed it.
      }
      sleep(LOCK_RETRY_MS);
    }
  }
  return false;
}

function releaseCounterLock(): void {
  try { fs.rmdirSync(counterLockPath); } catch (e) {}
}

let input = '';
let inputBytes = 0;
let inputTooLarge = false;
process.stdin.on('data', chunk => {
  inputBytes += chunk.length;
  if (inputBytes > MAX_STDIN_BYTES) {
    inputTooLarge = true;
    input = '';
    return;
  }
  input += chunk;
});
process.stdin.on('end', async () => {
  try {
    if (inputTooLarge) return;
    const data: HookInput = JSON.parse(input);
    const sessionId = data.session_id;
    if (!sessionId) return; // No stable key → nothing to count.

    const event = data.hook_event_name;
    if (typeof event !== 'string' || SUPPORTED_EVENTS.indexOf(event) === -1) return;

    // Select the routes this invocation activates (event name + cwd).
    const config = loadValidConfig();
    const selected = config.routes.filter(r =>
      eventMatches(r, data) && cwdMatches(r, data));
    if (!selected.length) return;

    const due: Route[] = [];
    if (!acquireCounterLock()) return;
    try {
      const now = Date.now();
      const counters = readCounters();

      // Prune stale sessions so the map can't grow without bound.
      for (const key of Object.keys(counters)) {
        const entry = counters[key];
        if (!entry || typeof entry.ts !== 'number' || (now - entry.ts) > PRUNE_MS) {
          delete counters[key];
        }
      }

      // Bump each selected route's per-route counter; collect the ones now due.
      // The counter domain is "matching invocations", so only selected routes count.
      for (const r of selected) {
        const key = sessionId + ':' + r.id;
        const prev = counters[key] && typeof counters[key].count === 'number' ? counters[key].count : 0;
        const count = prev + 1;
        counters[key] = { count: count, ts: now };
        if (count % r.freq === 0) due.push(r);
      }
      writeCounters(counters);
    } finally {
      releaseCounterLock();
    }

    if (!due.length) return;

    // Read the due docs CONCURRENTLY (R-011), then assemble strictly in config routes[]
    // order — Promise.all preserves input order, so output is deterministic regardless of
    // which read finishes first. No headers or route-id labels (they would break verbatim
    // injection). Each body is templated at injection time ({{name}} resolved
    // deterministically) before the combined-context cap, so the cap bounds the text
    // actually injected.
    const now = new Date();
    const cwd = typeof data.cwd === 'string' ? data.cwd : '';
    const rawBodies = await Promise.all(due.map(r => readDocAsync(r.doc)));
    const bodies: string[] = [];
    for (let i = 0; i < due.length; i++) {
      const raw = rawBodies[i];
      if (raw === null) continue;
      const body = applyTemplate(raw, {
        event, cwd, home: os.homedir(), now, env: process.env, vars: mergeVars(config.vars, due[i].vars)
      });
      const joined = bodies.length ? bodies.join('\n\n') + '\n\n' + body : body;
      if (joined.length <= MAX_DOC_CHARS) bodies.push(body);
    }
    if (!bodies.length) return;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: bodies.join('\n\n')
      }
    }));
  } catch (e) {
    // Silent fail — a hook error must never block the agent.
  }
});
