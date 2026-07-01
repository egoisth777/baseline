#!/usr/bin/env node
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const os = require("os");
const contracts_1 = require("./contracts");
// Drop counter entries untouched for longer than this (stale sessions).
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_COUNTER_BYTES = 1024 * 1024;
const MAX_LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 5000;
function argValue(name) {
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === name)
            return process.argv[i + 1] || null;
        if (arg.startsWith(name + '='))
            return arg.slice(name.length + 1) || null;
    }
    return null;
}
const agentDir = process.env.BASELINE_AGENT_CONFIG_DIR ||
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
// Load and validate config.json into the routes the dispatcher will act on.
// Fail-open: any fatal problem (missing/oversize/malformed config, bad version,
// over-cap route count) returns [] so the hook injects nothing. Individual bad
// routes are skipped in isolation; a duplicate id keeps the first occurrence.
function loadValidRoutes() {
    let raw;
    try {
        const st = fs.statSync(configPath);
        if (st.size > contracts_1.MAX_CONFIG_BYTES)
            return [];
        raw = fs.readFileSync(configPath, 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > contracts_1.MAX_CONFIG_BYTES)
            return [];
    }
    catch (e) {
        return [];
    }
    let cfg;
    try {
        cfg = JSON.parse(raw);
    }
    catch (e) {
        return [];
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))
        return [];
    // version: missing => assume 1; any value other than 1 => inject nothing.
    if (cfg.version !== undefined && cfg.version !== 1)
        return [];
    const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
    if (routes.length > contracts_1.MAX_ROUTES)
        return [];
    const seen = {};
    const out = [];
    for (const r of routes) {
        if (!r || typeof r !== 'object')
            continue;
        if (typeof r.id !== 'string' || !contracts_1.SLUG.test(r.id))
            continue;
        if (seen[r.id])
            continue; // duplicate id — first wins, never double-count
        if (typeof r.event !== 'string')
            continue;
        const ev = (0, contracts_1.parseEvent)(r.event);
        if (contracts_1.SUPPORTED_EVENTS.indexOf(ev.base) === -1)
            continue;
        if (ev.phase !== undefined && (ev.base !== 'SessionStart' || contracts_1.SESSION_PHASES.indexOf(ev.phase) === -1))
            continue;
        if (!(0, contracts_1.safeDocPath)(r.doc, cfgDir))
            continue;
        let freq = 1;
        if (r.freq !== undefined) {
            if (typeof r.freq !== 'number' || !Number.isInteger(r.freq) || r.freq < 1)
                continue;
            freq = r.freq;
        }
        if (r.cwd !== undefined && typeof r.cwd !== 'string')
            continue;
        seen[r.id] = true;
        out.push({ id: r.id, event: r.event, freq, cwd: r.cwd, doc: r.doc });
    }
    return out;
}
// Does this route's event name accept the invocation? The event is the sole
// moment-resolver: its base must equal the native hook event, and a SessionStart
// phase suffix (when present) must equal the stdin `source` lifecycle phase. A bare
// event (no phase) matches every phase of its base event.
function eventMatches(route, data) {
    const { base, phase } = (0, contracts_1.parseEvent)(route.event);
    if (base !== data.hook_event_name)
        return false;
    return phase === undefined || data.source === phase;
}
// Is the session working directory at or under the route's cwd scope? Normalized
// prefix match on path boundaries (/foo must not match /foobar), case-insensitive
// on Windows. Omitted cwd means "any directory".
function cwdMatches(route, data) {
    if (route.cwd === undefined)
        return true;
    const sessionCwd = typeof data.cwd === 'string' ? data.cwd : '';
    if (!sessionCwd)
        return false;
    let base = path.resolve(route.cwd);
    let here = path.resolve(sessionCwd);
    if (process.platform === 'win32') {
        base = base.toLowerCase();
        here = here.toLowerCase();
    }
    if (base === here)
        return true;
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return here.startsWith(prefix);
}
// Read a route's doc, bounded. Returns the verbatim body, or null to skip (missing,
// unreadable, over-cap, or — defensively — out of range).
function readDoc(doc) {
    const p = (0, contracts_1.safeRealDocPath)(doc, cfgDir);
    if (!p)
        return null;
    try {
        const st = fs.statSync(p);
        if (st.size > contracts_1.MAX_DOC_BYTES)
            return null;
        const body = fs.readFileSync(p, 'utf8');
        if (Buffer.byteLength(body, 'utf8') > contracts_1.MAX_DOC_BYTES)
            return null;
        if (body.length > contracts_1.MAX_DOC_CHARS)
            return null;
        return body;
    }
    catch (e) {
        return null;
    }
}
// Refuse to follow a symlink at the counter path (basic hardening — never read or
// write through a link an attacker may have planted in place of our state file).
function readCounters() {
    try {
        const st = fs.lstatSync(counterPath);
        if (st.isSymbolicLink())
            return {};
        if (st.size > MAX_COUNTER_BYTES)
            return {};
        const obj = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    }
    catch (e) {
        return {};
    }
}
function writeCounters(counters) {
    try {
        const st = fs.lstatSync(counterPath);
        if (st.isSymbolicLink())
            return;
    }
    catch (e) {
        // ENOENT — fine, file will be created.
    }
    try {
        const tmp = counterPath + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(counters), 'utf8');
        fs.renameSync(tmp, counterPath); // atomic replace
    }
    catch (e) {
        // Best-effort; never break the agent over counter I/O.
    }
}
function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function acquireCounterLock() {
    const start = Date.now();
    while ((Date.now() - start) <= MAX_LOCK_WAIT_MS) {
        try {
            fs.mkdirSync(counterLockPath);
            return true;
        }
        catch (e) {
            if (!e || e.code !== 'EEXIST')
                return false;
            try {
                const st = fs.statSync(counterLockPath);
                if ((Date.now() - st.mtimeMs) > STALE_LOCK_MS)
                    fs.rmSync(counterLockPath, { recursive: true, force: true });
            }
            catch (staleErr) {
                // Another process may have removed it.
            }
            sleep(LOCK_RETRY_MS);
        }
    }
    return false;
}
function releaseCounterLock() {
    try {
        fs.rmdirSync(counterLockPath);
    }
    catch (e) { }
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
process.stdin.on('end', () => {
    try {
        if (inputTooLarge)
            return;
        const data = JSON.parse(input);
        const sessionId = data.session_id;
        if (!sessionId)
            return; // No stable key → nothing to count.
        const event = data.hook_event_name;
        if (typeof event !== 'string' || contracts_1.SUPPORTED_EVENTS.indexOf(event) === -1)
            return;
        // Select the routes this invocation activates (event name + cwd).
        const selected = loadValidRoutes().filter(r => eventMatches(r, data) && cwdMatches(r, data));
        if (!selected.length)
            return;
        const due = [];
        if (!acquireCounterLock())
            return;
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
                if (count % r.freq === 0)
                    due.push(r);
            }
            writeCounters(counters);
        }
        finally {
            releaseCounterLock();
        }
        if (!due.length)
            return;
        // Concatenate the due doc bodies in config routes[] order (selected/due both
        // preserve it), joined by a blank line, with no headers or route-id labels —
        // labels would break verbatim injection.
        const bodies = [];
        for (const r of due) {
            const body = readDoc(r.doc);
            if (body === null)
                continue;
            const joined = bodies.length ? bodies.join('\n\n') + '\n\n' + body : body;
            if (joined.length <= contracts_1.MAX_DOC_CHARS)
                bodies.push(body);
        }
        if (!bodies.length)
            return;
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: event,
                additionalContext: bodies.join('\n\n')
            }
        }));
    }
    catch (e) {
        // Silent fail — a hook error must never block the agent.
    }
});
