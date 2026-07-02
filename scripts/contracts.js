"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PROVIDERS = exports.deterministicProvider = exports.MAX_ROUTES = exports.MAX_DOC_CHARS = exports.MAX_DOC_BYTES = exports.MAX_CONFIG_BYTES = exports.SLUG = exports.SESSION_PHASES = exports.SUPPORTED_EVENTS = void 0;
exports.parseEvent = parseEvent;
exports.eventMatches = eventMatches;
exports.cwdMatches = cwdMatches;
exports.safeDocPath = safeDocPath;
exports.pathInside = pathInside;
exports.safeRealDocPath = safeRealDocPath;
exports.mergeVars = mergeVars;
exports.applyTemplate = applyTemplate;
exports.sanitizeVars = sanitizeVars;
const fs = require("fs");
const path = require("path");
// Events this dispatcher can inject standing context into.
exports.SUPPORTED_EVENTS = ['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse'];
// SessionStart lifecycle phases. An event may name one via a "SessionStart.<phase>"
// suffix; the phase then resolves against the hook stdin `source`.
exports.SESSION_PHASES = ['startup', 'resume', 'clear', 'compact'];
// Route id shape — keys the counter and labels the route in status/doctor.
exports.SLUG = /^[a-z0-9][a-z0-9-]*$/;
exports.MAX_CONFIG_BYTES = 64 * 1024;
exports.MAX_DOC_BYTES = 64 * 1024;
exports.MAX_DOC_CHARS = 10_000;
exports.MAX_ROUTES = 64;
// Split a route event into its base event and optional SessionStart phase suffix, on
// the FIRST '.'. "SessionStart.compact" -> { base:'SessionStart', phase:'compact' };
// a bare "UserPromptSubmit" -> { base:'UserPromptSubmit' }.
function parseEvent(event) {
    const dot = event.indexOf('.');
    if (dot === -1)
        return { base: event };
    return { base: event.slice(0, dot), phase: event.slice(dot + 1) };
}
// Event-name match: the route's base event equals the native hook event, and any
// SessionStart phase suffix equals the stdin `source` (a bare event matches every
// phase). Shared by the dispatcher and `dispatch simulate` so a simulation selects
// exactly what a real invocation would.
function eventMatches(routeEvent, hookEventName, source) {
    const { base, phase } = parseEvent(routeEvent);
    if (base !== hookEventName)
        return false;
    return phase === undefined || source === phase;
}
// cwd scope match: normalized path-boundary prefix (/foo must not match /foobar),
// case-insensitive on Windows. An omitted route cwd matches any directory.
function cwdMatches(routeCwd, sessionCwd, isWin) {
    if (routeCwd === undefined)
        return true;
    const sessionRaw = typeof sessionCwd === 'string' ? sessionCwd : '';
    if (!sessionRaw)
        return false;
    let base = path.resolve(routeCwd);
    let here = path.resolve(sessionRaw);
    if (isWin) {
        base = base.toLowerCase();
        here = here.toLowerCase();
    }
    if (base === here)
        return true;
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return here.startsWith(prefix);
}
// Resolve a route's `doc` against a config dir; reject escapes.
function safeDocPath(doc, cfgDir) {
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
function pathInside(base, candidate) {
    const rel = path.relative(base, candidate);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
function safeRealDocPath(doc, cfgDir) {
    const p = safeDocPath(doc, cfgDir);
    if (!p)
        return null;
    try {
        const realBase = fs.realpathSync(cfgDir);
        const realDoc = fs.realpathSync(p);
        return pathInside(realBase, realDoc) ? p : null;
    }
    catch (e) {
        return null;
    }
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
// The ONE provider registered this cycle: pure, deterministic built-ins. A future
// local-model ("ultrafast inference") provider would attach to DEFAULT_PROVIDERS behind
// this same {{...}} syntax — but enabling any non-deterministic provider requires a goal
// decision superseding decision #5 (no model calls). Do not register a second provider
// here without that decision.
exports.deterministicProvider = {
    resolve(token, ctx) {
        switch (token) {
            case 'event': return ctx.event;
            case 'cwd': return ctx.cwd;
            case 'home': return ctx.home;
            case 'date': return ctx.now.getFullYear() + '-' + pad2(ctx.now.getMonth() + 1) + '-' + pad2(ctx.now.getDate());
            case 'time': return pad2(ctx.now.getHours()) + ':' + pad2(ctx.now.getMinutes());
        }
        if (token.indexOf('env.') === 0) {
            const v = ctx.env[token.slice(4)];
            return v === undefined ? '' : v;
        }
        return undefined;
    }
};
exports.DEFAULT_PROVIDERS = [exports.deterministicProvider];
// Token charset kept deliberately narrow (letters, digits, _, ., -) so stray "{{" in
// prose is left alone and there is no escaping to reason about this cycle.
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
// Merge user vars with config-then-route precedence (route wins). Exposed for tests.
function mergeVars(configVars, routeVars) {
    return Object.assign({}, configVars || {}, routeVars || {});
}
// Resolve one token: user vars first (they override built-ins, per decision #18), then
// each provider in order. Returns undefined when nothing resolves it.
function resolveToken(token, ctx, providers) {
    if (Object.prototype.hasOwnProperty.call(ctx.vars, token))
        return ctx.vars[token];
    for (const p of providers) {
        const v = p.resolve(token, ctx);
        if (v !== undefined)
            return v;
    }
    return undefined;
}
// Replace every {{token}} in `body`. Unknown tokens are left byte-for-byte verbatim.
function applyTemplate(body, ctx, providers = exports.DEFAULT_PROVIDERS) {
    return body.replace(TOKEN_RE, (match, token) => {
        const v = resolveToken(token, ctx, providers);
        return v === undefined ? match : v;
    });
}
// Validate/sanitize a raw `vars` value into a VarMap of string→string entries only.
// Fail-open like route validation: a non-object yields {}; non-string values are
// dropped. `onIssue`, when given, collects human messages for doctor.
function sanitizeVars(raw, where, onIssue) {
    const out = {};
    if (raw === undefined)
        return out;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        if (onIssue)
            onIssue(where + ' "vars" must be an object of string values; ignoring it');
        return out;
    }
    for (const k of Object.keys(raw)) {
        const v = raw[k];
        if (typeof v === 'string')
            out[k] = v;
        else if (onIssue)
            onIssue(where + ' var "' + k + '" must be a string; skipped');
    }
    return out;
}
