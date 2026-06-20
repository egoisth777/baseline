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
// routes matching the (event, matcher, cwd), bumps each one's per-route counter,
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
// Events this dispatcher can inject standing context into.
const SUPPORTED_EVENTS = ['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse'];
// Route id shape — keys the counter and labels the route in status/doctor.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
// Drop counter entries untouched for longer than this (stale sessions).
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_DOC_BYTES = 64 * 1024;
const MAX_COUNTER_BYTES = 1024 * 1024;
const MAX_ROUTES = 64;
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// The agent's config folder links back to the central cfg/baseline, so reading
// here is transparently reading the central config — the dispatcher knows nothing
// about OMNE_HOME.
const cfgDir = path.join(claudeDir, 'cfg', 'baseline');
const configPath = path.join(cfgDir, 'config.json');
const counterPath = path.join(claudeDir, '.baseline-counters.json');
// Resolve a route's `doc` against the config dir and require it to stay inside
// cfg/baseline. Doc bytes are trusted context, so this is a trust boundary:
// reject absolute paths and `..` escapes. Returns the absolute path or null.
function safeDocPath(doc) {
    if (typeof doc !== 'string' || !doc)
        return null;
    if (path.isAbsolute(doc))
        return null;
    const resolved = path.resolve(cfgDir, doc);
    const rel = path.relative(cfgDir, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
        return null;
    return resolved;
}
// Load and validate config.json into the routes the dispatcher will act on.
// Fail-open: any fatal problem (missing/oversize/malformed config, bad version,
// over-cap route count) returns [] so the hook injects nothing. Individual bad
// routes are skipped in isolation; a duplicate id keeps the first occurrence.
function loadValidRoutes() {
    let raw;
    try {
        const st = fs.statSync(configPath);
        if (st.size > MAX_CONFIG_BYTES)
            return [];
        raw = fs.readFileSync(configPath, 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES)
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
    if (routes.length > MAX_ROUTES)
        return [];
    const seen = {};
    const out = [];
    for (const r of routes) {
        if (!r || typeof r !== 'object')
            continue;
        if (typeof r.id !== 'string' || !SLUG.test(r.id))
            continue;
        if (seen[r.id])
            continue; // duplicate id — first wins, never double-count
        if (typeof r.event !== 'string' || SUPPORTED_EVENTS.indexOf(r.event) === -1)
            continue;
        if (!safeDocPath(r.doc))
            continue;
        let freq = 1;
        if (r.freq !== undefined) {
            if (typeof r.freq !== 'number' || !Number.isInteger(r.freq) || r.freq < 1)
                continue;
            freq = r.freq;
        }
        if (r.matcher !== undefined && typeof r.matcher !== 'string')
            continue;
        if (r.cwd !== undefined && typeof r.cwd !== 'string')
            continue;
        seen[r.id] = true;
        out.push({ id: r.id, event: r.event, matcher: r.matcher, freq, cwd: r.cwd, doc: r.doc });
    }
    return out;
}
// Does this route's matcher accept the invocation? Polymorphic by event:
//   UserPromptSubmit         — matcher ignored, always matches.
//   SessionStart             — exact-equality against stdin `source` (lifecycle phase).
//   PreToolUse/PostToolUse   — unanchored, case-sensitive regex over the tool name.
// Omitted matcher means "match all".
function matcherMatches(route, data) {
    if (route.matcher === undefined)
        return true;
    if (route.event === 'UserPromptSubmit')
        return true;
    if (route.event === 'SessionStart')
        return data.source === route.matcher;
    const tool = typeof data.tool_name === 'string' ? data.tool_name : '';
    try {
        return new RegExp(route.matcher).test(tool);
    }
    catch (e) {
        return false;
    }
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
    const p = safeDocPath(doc);
    if (!p)
        return null;
    try {
        const st = fs.statSync(p);
        if (st.size > MAX_DOC_BYTES)
            return null;
        const body = fs.readFileSync(p, 'utf8');
        if (Buffer.byteLength(body, 'utf8') > MAX_DOC_BYTES)
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
        return (obj && typeof obj === 'object') ? obj : {};
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
        const tmp = counterPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(counters), 'utf8');
        fs.renameSync(tmp, counterPath); // atomic replace
    }
    catch (e) {
        // Best-effort; never break the agent over counter I/O.
    }
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
        if (typeof event !== 'string' || SUPPORTED_EVENTS.indexOf(event) === -1)
            return;
        // Select the routes this invocation activates (event + matcher + cwd).
        const selected = loadValidRoutes().filter(r => r.event === event && matcherMatches(r, data) && cwdMatches(r, data));
        if (!selected.length)
            return;
        const now = Date.now();
        const counters = readCounters();
        // Prune stale sessions so the map can't grow without bound.
        for (const key of Object.keys(counters)) {
            const entry = counters[key];
            if (!entry || typeof entry.ts !== 'number' || (now - entry.ts) > PRUNE_MS) {
                delete counters[key];
            }
        }
        // Bump each selected route's per-route counter; collect the ones now due. The
        // counter domain is "matching invocations", so only selected routes count.
        const due = [];
        for (const r of selected) {
            const key = sessionId + ':' + r.id;
            const prev = counters[key] && typeof counters[key].count === 'number' ? counters[key].count : 0;
            const count = prev + 1;
            counters[key] = { count: count, ts: now };
            if (count % r.freq === 0)
                due.push(r);
        }
        writeCounters(counters);
        if (!due.length)
            return;
        // Concatenate the due doc bodies in config routes[] order (selected/due both
        // preserve it), joined by a blank line, with no headers or route-id labels —
        // labels would break verbatim injection.
        const bodies = [];
        for (const r of due) {
            const body = readDoc(r.doc);
            if (body !== null)
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
