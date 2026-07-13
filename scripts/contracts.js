"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ROUTES = exports.MAX_DOC_CHARS = exports.MAX_DOC_BYTES = exports.MAX_CONFIG_BYTES = exports.SLUG = exports.ROUTE_KEYS = exports.SESSION_PHASES = exports.SUPPORTED_EVENTS = void 0;
exports.parseEvent = parseEvent;
exports.isSupportedRouteEvent = isSupportedRouteEvent;
exports.eventMatches = eventMatches;
exports.cwdMatches = cwdMatches;
exports.safeDocPath = safeDocPath;
exports.pathInside = pathInside;
exports.safeRealDocPath = safeRealDocPath;
const fs = require("fs");
const path = require("path");
// Events this dispatcher can inject standing context into.
exports.SUPPORTED_EVENTS = ['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse'];
// SessionStart lifecycle phases. An event may name one via a "SessionStart.<phase>"
// suffix; the phase then resolves against the hook stdin `source`.
exports.SESSION_PHASES = ['startup', 'resume', 'clear', 'compact'];
// Exact config-schema-v1 route keys. This is internal implementation source, not a
// public package API.
exports.ROUTE_KEYS = ['id', 'event', 'freq', 'cwd', 'doc'];
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
// A valid route event is one supported base event, optionally with a recognized
// SessionStart phase. Other base-event suffixes are invalid.
function isSupportedRouteEvent(event) {
    const { base, phase } = parseEvent(event);
    if (exports.SUPPORTED_EVENTS.indexOf(base) === -1)
        return false;
    return phase === undefined || (base === 'SessionStart' && exports.SESSION_PHASES.indexOf(phase) !== -1);
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
