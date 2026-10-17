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
import * as crypto from 'crypto';
import { isUtf8 } from 'buffer';
import {
  CONFIG_DIR,
  CONFIG_FILE,
  COUNTER_FILE,
  COUNTER_KEY_SEPARATOR,
  DIAGNOSTICS_ENV,
  DOCUMENT_SEPARATOR,
  LOCK_RETRY_MS,
  LOCK_SUFFIX,
  MAX_COMBINED_CONTEXT_CHARS,
  MAX_CONFIG_BYTES,
  MAX_COUNTER_BYTES,
  MAX_DOC_BYTES,
  MAX_DOC_CHARS,
  MAX_LOCK_WAIT_MS,
  MAX_ROUTES,
  MAX_STDIN_BYTES,
  OUTPUT_CONTEXT_FIELD,
  OUTPUT_EVENT_FIELD,
  OUTPUT_OUTER_FIELD,
  PRUNE_MS,
  Route,
  SLUG,
  STALE_LOCK_MS,
  SUPPORTED_EVENTS,
  cwdMatches as matchCwd,
  eventMatches as matchEvent,
  isSupportedRouteEvent,
  safeDocPath,
  safeRealDocPath,
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

function argValue(name: string): string | null {
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1] || null;
    if (arg.startsWith(name + '=')) return arg.slice(name.length + 1) || null;
  }
  return null;
}

const agentDir =
  argValue('--agent-config') ||
  process.env.BASELINE_AGENT_CONFIG_DIR ||
  process.env.CLAUDE_CONFIG_DIR ||
  process.env.CODEX_HOME ||
  path.join(os.homedir(), '.claude');
// The agent's config folder links back to <install root>/cfg, so reading here is
// transparently reading the configured config folder — the dispatcher resolves only
// via the agent dir and knows nothing about BASELINE_HOME / BASELINE_CFG.
const cfgDir = path.join(agentDir, CONFIG_DIR);
const configPath = path.join(cfgDir, CONFIG_FILE);
const counterPath = path.join(agentDir, COUNTER_FILE);
const counterLockPath = counterPath + LOCK_SUFFIX;

function diagnose(code: string): void {
  if (process.env[DIAGNOSTICS_ENV] !== '1') return;
  try { process.stderr.write('baseline: ' + code + '\n'); } catch (e) {}
}

interface ValidConfig {
  routes: Route[];
}

// Load and validate config.json into the routes the dispatcher will act on. Fail-open:
// any fatal problem (missing/oversize/malformed config, bad version, over-cap route
// count) returns no routes so the hook injects nothing. Individual bad routes are
// skipped in isolation; a duplicate id keeps the first occurrence.
function loadValidConfig(): ValidConfig {
  const empty: ValidConfig = { routes: [] };
  let raw: string;
  try {
    const st = fs.statSync(configPath);
    if (st.size > MAX_CONFIG_BYTES) { diagnose('CONFIG_TOO_LARGE'); return empty; }
    raw = fs.readFileSync(configPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) { diagnose('CONFIG_TOO_LARGE'); return empty; }
  } catch (e) {
    diagnose('CONFIG_READ');
    return empty;
  }

  let cfg: any;
  try { cfg = JSON.parse(raw); } catch (e) { diagnose('CONFIG_INVALID'); return empty; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { diagnose('CONFIG_INVALID'); return empty; }
  // version: missing => assume 1; any value other than 1 => inject nothing.
  if (cfg.version !== undefined && cfg.version !== 1) { diagnose('CONFIG_VERSION'); return empty; }

  const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
  if (routes.length > MAX_ROUTES) { diagnose('CONFIG_ROUTES_CAP'); return empty; }

  const seen = new Set<string>();
  const out: Route[] = [];
  for (const r of routes) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.id !== 'string' || !SLUG.test(r.id)) continue;
    if (seen.has(r.id)) continue; // duplicate id — first wins, never double-count
    if (typeof r.event !== 'string') continue;
    if (!isSupportedRouteEvent(r.event)) continue;
    if (!safeDocPath(r.doc, cfgDir)) continue;
    let freq = 1;
    if (r.freq !== undefined) {
      if (typeof r.freq !== 'number' || !Number.isInteger(r.freq) || r.freq < 1) continue;
      freq = r.freq;
    }
    if (r.cwd !== undefined && typeof r.cwd !== 'string') continue;
    seen.add(r.id);
    out.push({ id: r.id, event: r.event, freq, cwd: r.cwd, doc: r.doc });
  }
  return { routes: out };
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
interface DocRead {
  body: string | null;
  invalidUtf8: boolean;
}

async function readDocAsync(doc: string): Promise<DocRead> {
  const p = safeRealDocPath(doc, cfgDir);
  if (!p) return { body: null, invalidUtf8: false };
  try {
    const st = await fs.promises.stat(p);
    if (st.size > MAX_DOC_BYTES) return { body: null, invalidUtf8: false };
    const bytes = await fs.promises.readFile(p);
    if (bytes.length > MAX_DOC_BYTES) return { body: null, invalidUtf8: false };
    if (!isUtf8(bytes)) return { body: null, invalidUtf8: true };
    const body = bytes.toString('utf8');
    if (body.length > MAX_DOC_CHARS) return { body: null, invalidUtf8: false };
    return { body, invalidUtf8: false };
  } catch (e) {
    return { body: null, invalidUtf8: false };
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

function counterDestinationSafe(): boolean {
  try {
    const st = fs.lstatSync(counterPath);
    return st.isFile() && !st.isSymbolicLink();
  } catch (e: any) {
    return !!e && e.code === 'ENOENT';
  }
}

function writeCounters(counters: Counters): void {
  if (!counterDestinationSafe()) { diagnose('COUNTER_DESTINATION'); return; }
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
    (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
  const body = JSON.stringify(counters);

  for (let attempt = 0; attempt < 8; attempt++) {
    const tmp = counterPath + '.' + crypto.randomBytes(16).toString('hex') + '.tmp';
    let fd: number | null = null;
    let created = false;
    try {
      fd = fs.openSync(tmp, flags, 0o600);
      created = true;
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      if (!counterDestinationSafe()) { diagnose('COUNTER_DESTINATION'); return; }
      fs.renameSync(tmp, counterPath);
      created = false;
      return;
    } catch (e: any) {
      if (!e || e.code !== 'EEXIST') diagnose('COUNTER_IO');
      if (!e || e.code !== 'EEXIST') return;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
      if (created) { try { fs.unlinkSync(tmp); } catch (e) {} }
    }
  }
  diagnose('COUNTER_TEMP_COLLISION');
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

const chunks: Buffer[] = [];
let inputBytes = 0;
let inputTooLarge = false;
process.stdin.on('data', chunk => {
  inputBytes += chunk.length;
  if (inputBytes > MAX_STDIN_BYTES) {
    inputTooLarge = true;
    chunks.length = 0;
    return;
  }
  chunks.push(chunk);
});
process.stdin.on('end', async () => {
  try {
    if (inputTooLarge) { diagnose('INPUT_TOO_LARGE'); return; }
    const input = Buffer.concat(chunks).toString('utf8');
    const data: HookInput = JSON.parse(input);
    const sessionId = data.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      diagnose('INPUT_SESSION');
      return; // No stable string key → nothing to count.
    }

    const event = data.hook_event_name;
    if (typeof event !== 'string' || SUPPORTED_EVENTS.indexOf(event) === -1) { diagnose('INPUT_EVENT'); return; }

    // Select the routes this invocation activates (event name + cwd).
    const config = loadValidConfig();
    const selected = config.routes.filter(r =>
      eventMatches(r, data) && cwdMatches(r, data));
    if (!selected.length) return;

    const due: Route[] = [];
    if (!acquireCounterLock()) { diagnose('COUNTER_LOCK'); return; }
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
        const key = sessionId + COUNTER_KEY_SEPARATOR + r.id;
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
    // which read finishes first. No headers, route-id labels, or replacement pass: every
    // accepted body is injected byte-for-byte as read from its static doc.
    const rawBodies = await Promise.all(due.map(r => readDocAsync(r.doc)));
    if (rawBodies.some(result => result.invalidUtf8)) {
      diagnose('DOC_INVALID_UTF8');
      return;
    }
    const bodies: string[] = [];
    for (let i = 0; i < due.length; i++) {
      const body = rawBodies[i].body;
      if (body === null) continue;
      const joined = bodies.length ? bodies.join(DOCUMENT_SEPARATOR) + DOCUMENT_SEPARATOR + body : body;
      if (joined.length <= MAX_COMBINED_CONTEXT_CHARS) bodies.push(body);
    }
    if (!bodies.length) return;

    process.stdout.write(JSON.stringify({
      [OUTPUT_OUTER_FIELD]: {
        [OUTPUT_EVENT_FIELD]: event,
        [OUTPUT_CONTEXT_FIELD]: bodies.join(DOCUMENT_SEPARATOR)
      }
    }));
  } catch (e) {
    // Silent fail — a hook error must never block the agent.
    diagnose('INTERNAL');
  }
});
