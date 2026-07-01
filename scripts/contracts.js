"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ROUTES = exports.MAX_DOC_CHARS = exports.MAX_DOC_BYTES = exports.MAX_CONFIG_BYTES = exports.SLUG = exports.SESSION_PHASES = exports.SUPPORTED_EVENTS = void 0;
exports.parseEvent = parseEvent;
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
