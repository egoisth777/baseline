#!/usr/bin/env node
"use strict";
// baseline — cross-platform installer / verifier / status / doctor / uninstaller
// for the baseline injection-routes dispatcher. Runs on Windows and Linux.
//
// Usage (run with node from the repo root):
//   node scripts/manage.js status              report what's installed vs the repo source + config
//   node scripts/manage.js install [--preset <name>] [--force]
//   node scripts/manage.js verify              functional check: does a route fire?
//   node scripts/manage.js update              redeploy from repo, re-sync hook wiring
//   node scripts/manage.js doctor [--fix]      validate config + wiring; --fix repairs
//   node scripts/manage.js uninstall           remove per-agent wiring + links (keeps central config)
//   node scripts/manage.js help
//
// Design notes:
// - Regenerable ARTIFACTS live in a per-skill install root, BASELINE_HOME or
//   ~/.baseline: the deployed dispatcher (hooks/baseline-recital.js) and the Claude
//   skill payload (skills/baseline/). The repo is the source of truth; install always
//   overwrites these from it.
// - The editable CONFIG folder (config.json + docs/) lives separately, wherever the
//   operator wants: BASELINE_CFG, else <install root>/cfg. <install root>/cfg is the
//   canonical path agents link to — a symlink to BASELINE_CFG when set, else a real
//   seeded folder. Config and artifacts never share a directory.
// - Each agent's config dir (Claude: CLAUDE_CONFIG_DIR or ~/.claude; Codex:
//   CODEX_HOME or ~/.codex) gets LINKS back into the center:
//   hooks/baseline-recital.js → install root; cfg/baseline → <install root>/cfg.
//   Editing the config folder changes live behavior for every wired agent
//   (when the link layer can use a symlink; copy fallback is degraded).
// - Hook config and .baseline-counters.json stay REAL, per-agent files. Hook
//   wiring is config-driven: install wires our one dispatcher command into EXACTLY
//   the events the config's routes use, and unwires events no route references, so
//   the high-frequency PreToolUse/PostToolUse hooks never spawn for nothing.
// - The config folder is seeded from a repo PRESET (presets/<name>/) and is never
//   clobbered without --force. There is no legacy baseline.md migration — the
//   system is pre-release and install seeds the new model fresh.
// - Native Zig runtime is PAUSED for the routes feature: the dispatcher
//   is Node-only for v1. `--runtime prebuilt|build` is refused.
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const os = require("os");
const child_process_1 = require("child_process");
// --- constants -------------------------------------------------------------
const SUPPORTED_EVENTS = ['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse'];
const SESSION_PHASES = ['startup', 'resume', 'clear', 'compact'];
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const KNOWN_ROUTE_KEYS = ['id', 'event', 'freq', 'cwd', 'doc'];
const DEFAULT_PRESET = 'default';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_DOC_BYTES = 64 * 1024;
const MAX_DOC_CHARS = 10_000;
const MAX_ROUTES = 64;
// Split a route event into its base event and optional SessionStart phase suffix, on
// the FIRST '.'. "SessionStart.compact" -> { base:'SessionStart', phase:'compact' };
// a bare "UserPromptSubmit" -> { base:'UserPromptSubmit' }.
function parseEvent(event) {
    const dot = event.indexOf('.');
    if (dot === -1)
        return { base: event };
    return { base: event.slice(0, dot), phase: event.slice(dot + 1) };
}
// --- platform + path resolution -------------------------------------------
const isWin = process.platform === 'win32';
const homeDir = os.homedir();
// Repo root resolved relative to this file (scripts/ sits directly under root).
const repoRoot = path.resolve(__dirname, '..');
// Install root: where baseline's REGENERABLE artifacts live (deployed dispatcher +
// Claude skill payload). Per-skill and self-contained: BASELINE_HOME, else ~/.baseline.
const installRoot = process.env.BASELINE_HOME || path.join(homeDir, '.baseline');
// `<installRoot>/cfg` is the canonical config path agents link to. When BASELINE_CFG is
// set it is a symlink to that external folder; otherwise it is a real seeded folder. An
// existing symlink is respected even when BASELINE_CFG is unset, so the env var is only
// needed to (re)point the config folder — not on every manager run.
const cfgLink = path.join(installRoot, 'cfg');
const cfgOverrideRaw = process.env.BASELINE_CFG ? path.resolve(process.env.BASELINE_CFG) : null;
// An override that points back at the default location is treated as no override
// (so we never create a self-referential cfg symlink).
const cfgOverride = (cfgOverrideRaw && !samePath(cfgOverrideRaw, cfgLink)) ? cfgOverrideRaw : null;
// Where the config FILES actually live (flat: config.json + docs/). Equals cfgLink for a
// local install; an external folder when BASELINE_CFG is set or cfg is already symlinked.
function resolveCfgReal() {
    if (cfgOverride)
        return cfgOverride;
    try {
        const st = fs.lstatSync(cfgLink);
        if (st.isSymbolicLink()) {
            const t = fs.readlinkSync(cfgLink);
            return path.isAbsolute(t) ? t : path.resolve(installRoot, t);
        }
    }
    catch (e) { /* absent → real default below */ }
    return cfgLink;
}
const cfgReal = resolveCfgReal();
// True when config is an external folder, so a destructive reseed (--force) must refuse
// rather than delete the operator's (likely version-controlled) config.
const configIsExternal = !samePath(cfgReal, cfgLink);
const central = {
    root: installRoot,
    hooksDir: path.join(installRoot, 'hooks'),
    hookJs: path.join(installRoot, 'hooks', 'baseline-recital.js'),
    cfgLink: cfgLink, // <installRoot>/cfg — what agents link to (real dir, or symlink to cfgReal)
    cfgDir: cfgReal, // the real config folder (flat: config.json + docs/)
    config: path.join(cfgReal, 'config.json'),
    docsDir: path.join(cfgReal, 'docs'),
    // Claude skills-dir plugin payload (skill-only; no hooks). Linked into each
    // skill-capable agent's skills dir so Claude recognizes baseline + loads its skill.
    skillDir: path.join(installRoot, 'skills', 'baseline'),
    skillManifest: path.join(installRoot, 'skills', 'baseline', '.claude-plugin', 'plugin.json'),
    skillMd: path.join(installRoot, 'skills', 'baseline', 'SKILL.md'),
};
const repo = {
    hookSourceJs: path.join(repoRoot, 'scripts', 'baseline-recital.js'),
    presetsDir: path.join(repoRoot, 'presets'),
    // Source of truth for the Claude plugin manifest, copied into the central skill payload.
    claudePluginManifest: path.join(repoRoot, '.claude-plugin', 'plugin.json'),
};
function agentRegistry() {
    return [
        {
            name: 'claude-code',
            configDir: process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'),
            settingsFile: 'settings.json',
            skillPlugin: true,
        },
        {
            name: 'codex',
            configDir: process.env.CODEX_HOME || path.join(homeDir, '.codex'),
            settingsFile: 'hooks.json',
            skillPlugin: false,
        },
    ];
}
// Derive every per-agent path. hookJs and cfgDir are LINKS to the center;
// hook config and counters are real per-agent files.
function agentPaths(agent) {
    const d = agent.configDir;
    return {
        name: agent.name,
        configDir: d,
        settings: path.join(d, agent.settingsFile),
        settingsLabel: agent.settingsFile,
        counters: path.join(d, '.baseline-counters.json'),
        hooksDir: path.join(d, 'hooks'),
        hookJs: path.join(d, 'hooks', 'baseline-recital.js'),
        cfgDir: path.join(d, 'cfg', 'baseline'),
        skillDir: agent.skillPlugin ? path.join(d, 'skills', 'baseline') : null,
    };
}
function allAgentPaths() {
    return agentRegistry().map(agentPaths);
}
function fail(message, code) {
    console.error('[baseline] ' + message);
    process.exit(code || 1);
}
// Quote a single arg for embedding in the hook config command STRING.
const quoteArg = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
// --- file helpers ----------------------------------------------------------
function atomicWrite(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
}
function copyFileAtomic(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, fs.readFileSync(src)); // Buffer in, Buffer out
    fs.renameSync(tmp, dest);
}
// Recursively copy a directory tree (used to deploy a preset and as the config
// link copy-fallback).
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory())
            copyDir(s, d);
        else
            fs.copyFileSync(s, d);
    }
}
function readJson(file) {
    try {
        return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), missing: false, error: null };
    }
    catch (e) {
        if (e && e.code === 'ENOENT') {
            return { ok: true, value: null, missing: true, error: null };
        }
        return { ok: false, value: null, missing: false, error: e };
    }
}
// Validate the hook config shape across EVERY supported event group, so a
// malformed hooks tree is never rewritten.
function settingsShapeError(settings) {
    if (!settings)
        return null;
    if (typeof settings !== 'object' || Array.isArray(settings))
        return 'root must be an object';
    if (settings.hooks == null)
        return null;
    if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))
        return 'hooks must be an object';
    for (const event of SUPPORTED_EVENTS) {
        const groups = settings.hooks[event];
        if (groups == null)
            continue;
        if (!Array.isArray(groups))
            return 'hooks.' + event + ' must be an array';
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            if (!group || typeof group !== 'object' || Array.isArray(group))
                return 'hooks.' + event + '[' + i + '] must be an object';
            if (!Array.isArray(group.hooks))
                return 'hooks.' + event + '[' + i + '].hooks must be an array';
        }
    }
    return null;
}
function settingsOrEmptyForWrite(ap) {
    const r = readJson(ap.settings);
    if (!r.ok) {
        throw new Error('refusing to rewrite invalid ' + ap.settingsLabel + ': ' + r.error.message);
    }
    const settings = r.value || {};
    const shapeError = settingsShapeError(settings);
    if (shapeError) {
        throw new Error('refusing to rewrite invalid ' + ap.settingsLabel + ': ' + shapeError);
    }
    return settings;
}
function settingsForRead(ap) {
    const r = readJson(ap.settings);
    if (!r.ok)
        return { settings: {}, error: r.error };
    const settings = r.value || {};
    const shapeError = settingsShapeError(settings);
    return shapeError
        ? { settings: {}, error: new Error(shapeError) }
        : { settings, error: null };
}
function samePath(a, b) {
    if (!a || !b)
        return false;
    const aa = path.resolve(a);
    const bb = path.resolve(b);
    return isWin ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}
// --- link layer (cross-platform) -------------------------------------------
// Remove a symlink or regular file at p. Refuses to remove a real directory.
function removeIfLinkOrFile(p) {
    let st;
    try {
        st = fs.lstatSync(p);
    }
    catch (e) {
        return;
    } // absent
    if (st.isDirectory() && !st.isSymbolicLink()) {
        throw new Error('refusing to replace a real directory with a link: ' + p);
    }
    fs.unlinkSync(p);
}
// Link a central FILE into linkPath: symlink, else hardlink, else copy. Copy is
// reported as degraded (central edits won't propagate through it).
function linkInto(target, linkPath) {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    removeIfLinkOrFile(linkPath);
    try {
        fs.symlinkSync(target, linkPath, isWin ? 'file' : undefined);
        return 'symlink';
    }
    catch (e) { /* fall through */ }
    try {
        fs.linkSync(target, linkPath);
        return 'hardlink';
    }
    catch (e) { /* fall through */ }
    copyFileAtomic(target, linkPath);
    return 'copy';
}
// Classify a per-agent FILE link relative to the central target.
function linkState(linkPath, target) {
    let lst;
    try {
        lst = fs.lstatSync(linkPath);
    }
    catch (e) {
        return { ok: false, mechanism: 'missing' };
    }
    if (lst.isSymbolicLink()) {
        let resolved;
        try {
            resolved = fs.readlinkSync(linkPath);
        }
        catch (e) {
            return { ok: false, mechanism: 'broken' };
        }
        const abs = path.isAbsolute(resolved) ? resolved : path.resolve(path.dirname(linkPath), resolved);
        return samePath(abs, target) ? { ok: true, mechanism: 'symlink' } : { ok: false, mechanism: 'wrong' };
    }
    try {
        const a = fs.statSync(linkPath);
        const b = fs.statSync(target);
        if (a.ino !== 0 && a.dev === b.dev && a.ino === b.ino)
            return { ok: true, mechanism: 'hardlink' };
    }
    catch (e) { /* target may be missing */ }
    try {
        if (fs.readFileSync(linkPath).equals(fs.readFileSync(target)))
            return { ok: true, mechanism: 'copy' };
    }
    catch (e) { /* unreadable */ }
    return { ok: false, mechanism: 'stale' };
}
function describeLink(s) {
    if (s.ok)
        return 'OK (' + s.mechanism + (s.mechanism === 'copy' ? ' — degraded, edits will not propagate' : '') + ')';
    return s.mechanism.toUpperCase();
}
// Remove a per-agent FILE link we created (symlink or matching copy/hardlink).
// Refuses to delete a real, divergent file.
function removeOurLink(linkPath, target) {
    let lst;
    try {
        lst = fs.lstatSync(linkPath);
    }
    catch (e) {
        return false;
    } // absent
    if (lst.isSymbolicLink()) {
        try {
            fs.unlinkSync(linkPath);
            return true;
        }
        catch (e) {
            return false;
        }
    }
    if (linkState(linkPath, target).ok) {
        try {
            fs.unlinkSync(linkPath);
            return true;
        }
        catch (e) {
            return false;
        }
    }
    return false; // real, divergent file — leave it
}
// --- directory link (a folder linked as a unit) ----------------------------
// Marker file inside a config folder / skill plugin dir, used to (a) recognize a
// baseline-managed directory as safe to replace and (b) byte-compare for copy detection.
const CONFIG_MARKER = 'config.json';
const SKILL_MARKER = path.join('.claude-plugin', 'plugin.json');
// Link a central FOLDER into linkPath: directory symlink, else a recursive copy
// (degraded — central edits won't propagate). A real directory at linkPath is
// replaced only when it looks like ours (contains the marker file).
function linkDirInto(target, linkPath, marker) {
    let lst = null;
    try {
        lst = fs.lstatSync(linkPath);
    }
    catch (e) { }
    if (lst) {
        if (lst.isSymbolicLink() || !lst.isDirectory()) {
            fs.unlinkSync(linkPath);
        }
        else {
            if (!fs.existsSync(path.join(linkPath, marker))) {
                throw new Error('refusing to replace a non-baseline directory with a link: ' + linkPath);
            }
            fs.rmSync(linkPath, { recursive: true, force: true });
        }
    }
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
        fs.symlinkSync(target, linkPath, isWin ? 'dir' : undefined);
        return 'symlink';
    }
    catch (e) { /* fall through */ }
    copyDir(target, linkPath);
    return 'copy';
}
// Classify a per-agent folder link relative to the central folder, comparing the
// marker file's bytes to tell a valid copy from a stale directory.
function dirLinkState(linkPath, target, marker) {
    let lst;
    try {
        lst = fs.lstatSync(linkPath);
    }
    catch (e) {
        return { ok: false, mechanism: 'missing' };
    }
    if (lst.isSymbolicLink()) {
        let resolved;
        try {
            resolved = fs.readlinkSync(linkPath);
        }
        catch (e) {
            return { ok: false, mechanism: 'broken' };
        }
        const abs = path.isAbsolute(resolved) ? resolved : path.resolve(path.dirname(linkPath), resolved);
        return samePath(abs, target) ? { ok: true, mechanism: 'symlink' } : { ok: false, mechanism: 'wrong' };
    }
    if (lst.isDirectory()) {
        try {
            if (fs.readFileSync(path.join(linkPath, marker)).equals(fs.readFileSync(path.join(target, marker)))) {
                return { ok: true, mechanism: 'copy' };
            }
        }
        catch (e) { /* unreadable */ }
        return { ok: false, mechanism: 'stale' };
    }
    return { ok: false, mechanism: 'stale' };
}
// Remove the per-agent folder link we created (symlink or matching copy).
function removeOurDirLink(linkPath, target, marker) {
    let lst;
    try {
        lst = fs.lstatSync(linkPath);
    }
    catch (e) {
        return false;
    }
    if (lst.isSymbolicLink()) {
        try {
            fs.unlinkSync(linkPath);
            return true;
        }
        catch (e) {
            return false;
        }
    }
    if (dirLinkState(linkPath, target, marker).ok) {
        try {
            fs.rmSync(linkPath, { recursive: true, force: true });
            return true;
        }
        catch (e) {
            return false;
        }
    }
    return false;
}
// --- command-string parsing ------------------------------------------------
// Hook config command that runs the agent's Node .js dispatcher.
function jsCommand(ap) {
    return quoteArg(process.execPath) + ' ' + quoteArg(ap.hookJs) + ' --agent-config ' + quoteArg(ap.configDir);
}
function parseCommandLine(command) {
    if (typeof command !== 'string' || !command.trim())
        return null;
    const args = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === '\\' && i + 1 < command.length && command[i + 1] === quote) {
                cur += command[++i];
            }
            else if (ch === quote) {
                quote = null;
            }
            else {
                cur += ch;
            }
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (/\s/.test(ch)) {
            if (cur) {
                args.push(cur);
                cur = '';
            }
        }
        else {
            cur += ch;
        }
    }
    if (quote)
        return null;
    if (cur)
        args.push(cur);
    return args.length ? args : null;
}
// A settings command is ours when it runs this agent's deployed dispatcher .js.
function isOurCommand(command, ap) {
    const argv = parseCommandLine(command);
    if (!argv)
        return false;
    return argv.length >= 2 && samePath(argv[1], ap.hookJs);
}
// --- hook config surgery (config-driven, across all events) -----------------
function findOurHookInGroups(groups, ap) {
    if (!Array.isArray(groups))
        return null;
    for (const group of groups) {
        for (const h of (Array.isArray(group.hooks) ? group.hooks : [])) {
            if (h && isOurCommand(h.command, ap))
                return h;
        }
    }
    return null;
}
function findOurCommand(settings, ap) {
    if (!settings.hooks)
        return null;
    for (const event of SUPPORTED_EVENTS) {
        const h = findOurHookInGroups(settings.hooks[event], ap);
        if (h)
            return h;
    }
    return null;
}
// Which supported events currently carry our hook.
function wiredEvents(settings, ap) {
    const out = [];
    if (!settings.hooks)
        return out;
    for (const event of SUPPORTED_EVENTS) {
        if (findOurHookInGroups(settings.hooks[event], ap))
            out.push(event);
    }
    return out;
}
// Wire our one dispatcher command into EXACTLY desiredEvents and unwire it from
// every other supported event. One settings read + write; preserves co-residents.
function syncWiring(ap, command, desiredEvents) {
    const settings = settingsOrEmptyForWrite(ap);
    settings.hooks = settings.hooks || {};
    const result = { wired: [], unwired: [] };
    for (const event of SUPPORTED_EVENTS) {
        const want = desiredEvents.indexOf(event) !== -1;
        const groups = settings.hooks[event];
        if (Array.isArray(groups)) {
            let removed = false;
            for (const group of groups) {
                const before = group.hooks.length;
                group.hooks = group.hooks.filter((h) => !(h && isOurCommand(h.command, ap)));
                if (group.hooks.length !== before)
                    removed = true;
            }
            settings.hooks[event] = groups.filter((g) => g.hooks && g.hooks.length);
            if (!settings.hooks[event].length)
                delete settings.hooks[event];
            if (removed && !want)
                result.unwired.push(event);
        }
        if (want) {
            settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
            const entry = { type: 'command', command, timeout: 5, statusMessage: 'Baseline check...' };
            settings.hooks[event].push({ hooks: [entry] });
            result.wired.push(event);
        }
    }
    if (settings.hooks && !Object.keys(settings.hooks).length)
        delete settings.hooks;
    atomicWrite(ap.settings, JSON.stringify(settings, null, 2) + '\n');
    return result;
}
// Remove our hook from every supported event (uninstall).
function unwireAll(ap) {
    return syncWiring(ap, jsCommand(ap), []).unwired;
}
// --- config loading / validation -------------------------------------------
// Resolve a route's `doc` against the central config dir; reject escapes.
function safeDocPath(doc) {
    if (typeof doc !== 'string' || !doc)
        return null;
    if (path.isAbsolute(doc))
        return null;
    const resolved = path.resolve(central.cfgDir, doc);
    const rel = path.relative(central.cfgDir, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
        return null;
    return resolved;
}
function pathInside(base, candidate) {
    const rel = path.relative(base, candidate);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
function safeRealDocPath(doc) {
    const p = safeDocPath(doc);
    if (!p)
        return null;
    try {
        const realBase = fs.realpathSync(central.cfgDir);
        const realDoc = fs.realpathSync(p);
        return pathInside(realBase, realDoc) ? p : null;
    }
    catch (e) {
        return null;
    }
}
// Load + validate the central config.json. Mirrors the dispatcher's fail-open
// selection, but also collects per-route issues so doctor/status can report them.
function loadCentralConfig() {
    const report = { present: false, fatal: null, routes: [], issues: [], desiredEvents: [] };
    let raw;
    try {
        const st = fs.statSync(central.config);
        report.present = true;
        if (st.size > MAX_CONFIG_BYTES) {
            report.fatal = 'config.json exceeds 64 KiB cap';
            return report;
        }
        raw = fs.readFileSync(central.config, 'utf8');
    }
    catch (e) {
        return report; // absent
    }
    let cfg;
    try {
        cfg = JSON.parse(raw);
    }
    catch (e) {
        report.fatal = 'config.json is not valid JSON';
        return report;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        report.fatal = 'config.json root must be an object';
        return report;
    }
    if (cfg.version === undefined)
        report.issues.push({ level: 'warn', msg: 'config.json has no "version"; assuming 1' });
    else if (cfg.version !== 1) {
        report.fatal = 'config.json version must be 1 (got ' + JSON.stringify(cfg.version) + ')';
        return report;
    }
    const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
    if (!Array.isArray(cfg.routes))
        report.issues.push({ level: 'warn', msg: 'config.json has no "routes" array; treating as empty' });
    if (routes.length > MAX_ROUTES) {
        report.fatal = 'config.json has ' + routes.length + ' routes (cap is ' + MAX_ROUTES + ')';
        return report;
    }
    const seen = {};
    for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        const where = 'route #' + (i + 1);
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
            report.issues.push({ level: 'fail', msg: where + ' is not an object' });
            continue;
        }
        const label = typeof r.id === 'string' ? '"' + r.id + '"' : where;
        if (typeof r.id !== 'string' || !SLUG.test(r.id)) {
            report.issues.push({ level: 'fail', msg: where + ' has an invalid id (must match ' + SLUG.source + ')' });
            continue;
        }
        if (seen[r.id]) {
            report.issues.push({ level: 'fail', msg: 'duplicate route id ' + label + ' (later occurrence skipped)' });
            continue;
        }
        if (typeof r.event !== 'string') {
            report.issues.push({ level: 'fail', msg: 'route ' + label + ' has unsupported event ' + JSON.stringify(r.event) });
            continue;
        }
        const ev = parseEvent(r.event);
        if (SUPPORTED_EVENTS.indexOf(ev.base) === -1 ||
            (ev.phase !== undefined && (ev.base !== 'SessionStart' || SESSION_PHASES.indexOf(ev.phase) === -1))) {
            report.issues.push({ level: 'fail', msg: 'route ' + label + ' has unsupported event ' + JSON.stringify(r.event) });
            continue;
        }
        const docPath = safeDocPath(r.doc);
        if (!docPath) {
            report.issues.push({ level: 'fail', msg: 'route ' + label + ' has an invalid or out-of-range doc ' + JSON.stringify(r.doc) });
            continue;
        }
        let freq = 1;
        if (r.freq !== undefined) {
            if (typeof r.freq !== 'number' || !Number.isInteger(r.freq) || r.freq < 1) {
                report.issues.push({ level: 'fail', msg: 'route ' + label + ' has a non-positive-integer freq' });
                continue;
            }
            freq = r.freq;
        }
        if (r.cwd !== undefined && typeof r.cwd !== 'string') {
            report.issues.push({ level: 'fail', msg: 'route ' + label + ' cwd must be a string' });
            continue;
        }
        // doc readability + size (a route past validation but whose doc is gone still fails doctor).
        try {
            const st = fs.statSync(docPath);
            if (!safeRealDocPath(r.doc)) {
                report.issues.push({ level: 'fail', msg: 'route ' + label + ' doc resolves outside the config folder: ' + r.doc });
            }
            if (st.size > MAX_DOC_BYTES)
                report.issues.push({ level: 'fail', msg: 'route ' + label + ' doc exceeds 64 KiB cap' });
            const body = fs.readFileSync(docPath, 'utf8');
            if (body.length > MAX_DOC_CHARS)
                report.issues.push({ level: 'fail', msg: 'route ' + label + ' doc exceeds 10,000 character context cap' });
        }
        catch (e) {
            report.issues.push({ level: 'fail', msg: 'route ' + label + ' doc not readable: ' + r.doc });
        }
        for (const key of Object.keys(r)) {
            if (KNOWN_ROUTE_KEYS.indexOf(key) === -1)
                report.issues.push({ level: 'warn', msg: 'route ' + label + ' has unrecognized key "' + key + '"' });
        }
        seen[r.id] = true;
        report.routes.push({ id: r.id, event: r.event, freq, cwd: r.cwd, doc: r.doc });
    }
    // Wiring is keyed by NATIVE event, so a phase suffix folds into its base: three
    // SessionStart.<phase> routes wire exactly one native SessionStart hook.
    const events = [];
    for (const r of report.routes) {
        const base = parseEvent(r.event).base;
        if (events.indexOf(base) === -1)
            events.push(base);
    }
    report.desiredEvents = events;
    return report;
}
// --- preset deployment -----------------------------------------------------
// Establish <installRoot>/cfg: a symlink to BASELINE_CFG when set, else a real folder.
// Respects an existing correct symlink. Refuses to clobber a real config dir when an
// override is set (a migration the operator must do deliberately). Returns the mechanism.
function ensureConfigLocation() {
    fs.mkdirSync(installRoot, { recursive: true });
    let lst = null;
    try {
        lst = fs.lstatSync(cfgLink);
    }
    catch (e) {
        lst = null;
    }
    if (cfgOverride) {
        fs.mkdirSync(cfgOverride, { recursive: true });
        if (lst && lst.isSymbolicLink()) {
            const t = fs.readlinkSync(cfgLink);
            const abs = path.isAbsolute(t) ? t : path.resolve(installRoot, t);
            if (samePath(abs, cfgOverride))
                return 'symlink';
            fs.unlinkSync(cfgLink); // re-point a stale symlink
        }
        else if (lst && lst.isDirectory()) {
            throw new Error(cfgLink + ' is a real directory but BASELINE_CFG points elsewhere (' +
                cfgOverride + '). Move its contents into BASELINE_CFG and delete ' + cfgLink + ', then re-run.');
        }
        else if (lst) {
            fs.unlinkSync(cfgLink); // stray file
        }
        fs.symlinkSync(cfgOverride, cfgLink, isWin ? 'dir' : undefined);
        return 'symlink';
    }
    // No override: cfg is a real folder (or an existing symlink we respect).
    if (lst && lst.isSymbolicLink())
        return 'symlink';
    fs.mkdirSync(cfgLink, { recursive: true });
    return 'dir';
}
// Establish the config folder contents. Keep an existing config unless --force; else
// deploy presets/<name>/ wholesale. Refuses --force on an external (tracked) config.
// Returns 'kept' | 'seeded' | 'replaced'.
function ensureCentralConfig(opts) {
    const exists = fs.existsSync(central.config);
    if (exists && !opts.force)
        return 'kept';
    if (exists && opts.force && configIsExternal) {
        throw new Error('refusing --force: config lives in an external folder (' + central.cfgDir +
            '). Reset it via git or edit it directly; --force will not delete tracked config.');
    }
    const presetSrc = path.join(repo.presetsDir, opts.preset);
    if (!fs.existsSync(path.join(presetSrc, 'config.json'))) {
        throw new Error('preset "' + opts.preset + '" not found (expected ' + path.join(presetSrc, 'config.json') + ')');
    }
    // Local --force replace clears the real folder first; external never reaches here.
    if (exists && !configIsExternal)
        fs.rmSync(central.cfgDir, { recursive: true, force: true });
    copyDir(presetSrc, central.cfgDir);
    return exists ? 'replaced' : 'seeded';
}
// --- Claude skills-dir plugin payload --------------------------------------
// The deployed SKILL.md is a thin wrapper: the payload is detached from the repo,
// so it records the repo root and points at the repo's canonical SKILL.md. Skill
// triggering uses the frontmatter description, so keep it rich. The wrapper carries
// no hooks — baseline's hook wiring lives in settings.json, managed by the installer.
function skillWrapper(repoRootPath) {
    return [
        '---',
        'name: baseline',
        'description: >-',
        '  Control surface for the baseline drift-correction system: a Claude Code/Codex',
        '  dispatcher that injects trusted docs at configurable hook events via',
        '  user-configurable injection routes in the baseline config folder (config.json +',
        '  docs/, at BASELINE_CFG, else <install root>/cfg). Use when the user asks to view,',
        '  edit, add, or remove baseline docs or routes; change an injection event,',
        '  frequency, or cwd scope; install, verify, check status, repair, or',
        '  uninstall the baseline hook; or manage the baseline config folder. Trigger on',
        '  phrases like "baseline status", "baseline rules", "baseline hook", "baseline',
        '  route", "change baseline frequency", or "make the agent recite X every N turns".',
        '---',
        '',
        '# baseline (Claude skill)',
        '',
        'Claude control surface for the **baseline** drift-correction system, installed as a',
        'skills-directory plugin (`baseline@skills-dir`). This skill only makes baseline',
        'discoverable; the hook wiring itself is managed by the baseline installer and is',
        'unaffected by this skill.',
        '',
        'baseline was installed from this repo:',
        '',
        '    ' + repoRootPath,
        '',
        'Before acting, read `' + path.join(repoRootPath, 'SKILL.md') + '` and follow it — it',
        'is the single source of truth for baseline usage, workflow, vocabulary, and',
        'verification. Run the manager from that repo root, e.g.:',
        '',
        '    node "' + path.join(repoRootPath, 'scripts', 'manage.js') + '" status',
        '',
        'Other commands: `install`, `update`, `verify`, `doctor` (add `--fix`), `uninstall`.',
        'If that path no longer exists (repo moved or deleted), re-run the baseline installer',
        'from the new location to refresh this skill.',
        '',
    ].join('\n');
}
// Deploy the Claude skills-dir plugin payload to the center: the manifest copied
// verbatim from the repo (single source of truth), plus a generated SKILL.md wrapper
// recording the current repo root. Always overwrites (repo wins), like the dispatcher.
function ensureCentralSkill() {
    if (!fs.existsSync(repo.claudePluginManifest)) {
        throw new Error('Claude plugin manifest missing at ' + repo.claudePluginManifest + ' — cannot deploy the skill plugin.');
    }
    atomicWrite(central.skillManifest, fs.readFileSync(repo.claudePluginManifest, 'utf8'));
    atomicWrite(central.skillMd, skillWrapper(repoRoot));
}
// --- commands --------------------------------------------------------------
function cmdInstall(opts) {
    const agentsP = allAgentPaths();
    // 1. Refuse before any deploy if an agent hook config file is invalid.
    for (const ap of agentsP)
        settingsOrEmptyForWrite(ap);
    // 2. ALWAYS deploy the canonical .js to the CENTER (overwrite; repo wins).
    if (!fs.existsSync(repo.hookSourceJs)) {
        fail('install: compiled dispatcher missing at ' + repo.hookSourceJs + ' — run `npm run build` first.', 1);
    }
    fs.mkdirSync(central.hooksDir, { recursive: true });
    atomicWrite(central.hookJs, fs.readFileSync(repo.hookSourceJs, 'utf8'));
    // 2b. Establish the config folder LOCATION (symlink to BASELINE_CFG, or a real dir).
    const cfgLocMech = ensureConfigLocation();
    // 3. Establish the config folder CONTENTS (seed/keep/replace).
    const configState = ensureCentralConfig(opts);
    // 3b. Deploy the Claude skills-dir plugin payload to the center (repo wins).
    ensureCentralSkill();
    // 4. Read the config to learn which events to wire.
    const cfg = loadCentralConfig();
    // 5. For each agent: link the center in, then wire hook config for the config's events.
    const perAgent = [];
    for (const ap of agentsP) {
        const jsMech = linkInto(central.hookJs, ap.hookJs);
        const cfgMech = linkDirInto(central.cfgLink, ap.cfgDir, CONFIG_MARKER);
        const skillMech = ap.skillDir ? linkDirInto(central.skillDir, ap.skillDir, SKILL_MARKER) : null;
        const command = jsCommand(ap);
        const sync = syncWiring(ap, command, cfg.desiredEvents);
        perAgent.push({ name: ap.name, configDir: ap.configDir, jsMech, cfgMech, skillMech, sync });
    }
    console.log('[baseline] install complete');
    console.log('  install root  : ' + central.root);
    console.log('  runtime       : node js');
    console.log('  dispatcher    : ' + central.hookJs);
    console.log('  config folder : ' + central.cfgDir + ' (' + configState + ', preset: ' + opts.preset + ')' +
        (configIsExternal ? ' [external; ' + central.cfgLink + ' (' + cfgLocMech + ') links to it]' : ''));
    console.log('  skill plugin  : ' + central.skillDir + ' (baseline@skills-dir; no hooks)');
    console.log('  routes        : ' + cfg.routes.length + (cfg.desiredEvents.length ? ' over [' + cfg.desiredEvents.join(', ') + ']' : ' (no events wired)'));
    if (cfg.fatal)
        console.log('  config WARNING: ' + cfg.fatal + ' — run doctor');
    for (const a of perAgent) {
        console.log('  agent ' + a.name + ' @ ' + a.configDir);
        console.log('    links       : dispatcher=' + a.jsMech + ', cfg=' + a.cfgMech + (a.skillMech ? ', skill=' + a.skillMech : ''));
        console.log('    wired       : ' + (a.sync.wired.length ? a.sync.wired.join(', ') : '(none)') +
            (a.sync.unwired.length ? '; unwired ' + a.sync.unwired.join(', ') : ''));
    }
    console.log('  next step     : open /hooks once in each agent (or restart) so hook config reloads.');
}
function cmdUninstall() {
    const agentsP = allAgentPaths();
    console.log('[baseline] uninstall');
    for (const ap of agentsP) {
        let unwired;
        try {
            unwired = unwireAll(ap);
        }
        catch (e) {
            fail('uninstall: ' + e.message, 1);
        }
        const jsGone = removeOurLink(ap.hookJs, central.hookJs);
        const cfgGone = removeOurDirLink(ap.cfgDir, central.cfgLink, CONFIG_MARKER);
        const skillGone = ap.skillDir ? removeOurDirLink(ap.skillDir, central.skillDir, SKILL_MARKER) : false;
        console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
        console.log('    ' + ap.settingsLabel.padEnd(12) + ': ' + (unwired.length ? 'unwired ' + unwired.join(', ') : 'nothing wired'));
        console.log('    dispatcher  : ' + (jsGone ? 'unlinked' : 'absent'));
        console.log('    cfg folder  : ' + (cfgGone ? 'unlinked (central kept)' : 'left as-is'));
        if (ap.skillDir)
            console.log('    skill plugin: ' + (skillGone ? 'unlinked (central kept)' : 'left as-is'));
    }
    console.log('  central config : KEPT at ' + central.cfgDir + ' (delete by hand if you want it gone)');
}
function cmdStatus() {
    const agentsP = allAgentPaths();
    const jsExists = fs.existsSync(central.hookJs);
    let inSync = false;
    if (jsExists) {
        try {
            inSync = fs.readFileSync(central.hookJs, 'utf8') === fs.readFileSync(repo.hookSourceJs, 'utf8');
        }
        catch (e) { }
    }
    const cfg = loadCentralConfig();
    console.log('[baseline] status');
    console.log('  install root   : ' + central.root);
    console.log('  dispatcher     : ' + (jsExists
        ? 'present' + (inSync ? ' (byte-identical to repo source)' : ' (DIFFERS from repo source — run install to refresh)')
        : 'not present'));
    console.log('  config folder  : ' + (cfg.present ? 'present at ' + central.cfgDir : 'missing (install will seed it)') +
        (configIsExternal ? ' [external; ' + central.cfgLink + ' → it]' : ''));
    const skillPresent = fs.existsSync(central.skillManifest) && fs.existsSync(central.skillMd);
    console.log('  skill plugin   : ' + (skillPresent ? 'present at ' + central.skillDir : 'not deployed (install will deploy it)'));
    if (cfg.fatal)
        console.log('  config         : INVALID — ' + cfg.fatal);
    console.log('  routes         : ' + cfg.routes.length);
    for (const r of cfg.routes) {
        const bits = ['event=' + r.event, 'freq=' + r.freq];
        if (r.cwd !== undefined)
            bits.push('cwd=' + r.cwd);
        bits.push('doc=' + r.doc);
        console.log('    ' + r.id + ': ' + bits.join(', '));
    }
    for (const issue of cfg.issues) {
        console.log('    [' + issue.level + '] ' + issue.msg);
    }
    for (const ap of agentsP) {
        const { settings, error } = settingsForRead(ap);
        console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
        if (error) {
            console.log('    ' + ap.settingsLabel.padEnd(13) + ': INVALID (' + error.message + ')');
        }
        else {
            const wired = wiredEvents(settings, ap);
            console.log('    ' + ap.settingsLabel.padEnd(13) + ': ' + (wired.length ? 'wired [' + wired.join(', ') + ']' : 'not wired'));
        }
        console.log('    dispatcher   : ' + describeLink(linkState(ap.hookJs, central.hookJs)));
        console.log('    cfg folder   : ' + describeLink(dirLinkState(ap.cfgDir, central.cfgLink, CONFIG_MARKER)));
        if (ap.skillDir)
            console.log('    skill plugin : ' + describeLink(dirLinkState(ap.skillDir, central.skillDir, SKILL_MARKER)));
    }
}
// Build synthetic hook stdin for a route's event so verify can drive the wired
// dispatcher and confirm a route fires.
function synthInput(route, sessionId, cwd) {
    const { base, phase } = parseEvent(route.event);
    const data = { session_id: sessionId, hook_event_name: base, cwd };
    if (base === 'SessionStart')
        data.source = phase || 'startup';
    if (base === 'PreToolUse' || base === 'PostToolUse')
        data.tool_name = 'Bash';
    return JSON.stringify(data);
}
// Functional check — drive the ACTUALLY-WIRED dispatcher (of the first agent) with
// synthetic stdin for `freq` invocations of one route's event, and confirm it stays
// silent until the freq-th, then fires with additionalContext.
function cmdVerify() {
    const ap = allAgentPaths()[0];
    const sr = settingsForRead(ap);
    if (sr.error) {
        console.log('[baseline] verify: FAIL — invalid ' + ap.settingsLabel + ': ' + sr.error.message);
        process.exit(1);
    }
    const cfg = loadCentralConfig();
    if (!cfg.routes.length) {
        console.log('[baseline] verify: FAIL — config has no valid routes' + (cfg.fatal ? ' (' + cfg.fatal + ')' : '') + '.');
        process.exit(1);
    }
    // Prefer a UserPromptSubmit route (no phase, fires every turn — deterministic); else the first.
    const route = cfg.routes.filter(r => r.event === 'UserPromptSubmit')[0] || cfg.routes[0];
    const ourHook = findOurHookInGroups(sr.settings.hooks && sr.settings.hooks[route.event], ap);
    if (!ourHook) {
        console.log('[baseline] verify: FAIL — no baseline hook wired for ' + route.event + '. Run install.');
        process.exit(1);
    }
    const argv = parseCommandLine(ourHook.command);
    if (!argv) {
        console.log('[baseline] verify: FAIL — cannot parse wired command.');
        process.exit(1);
    }
    const cwd = route.cwd || process.cwd();
    const sid = 'baseline-verify-' + process.pid;
    let firedAt = 0;
    let firedText = '';
    let spawnErr = null;
    for (let i = 1; i <= route.freq; i++) {
        const r = (0, child_process_1.spawnSync)(argv[0], argv.slice(1), { input: synthInput(route, sid, cwd), encoding: 'utf8' });
        if (r.error) {
            spawnErr = r.error;
            break;
        }
        const out = (r.stdout || '').trim();
        if (out) {
            firedAt = i;
            firedText = out;
        }
    }
    // Clean our synthetic counter entry so verify never pollutes real session state.
    try {
        const cr = readJson(ap.counters);
        if (cr.ok && cr.value && typeof cr.value === 'object') {
            delete cr.value[sid + ':' + route.id];
            atomicWrite(ap.counters, JSON.stringify(cr.value));
        }
    }
    catch (e) { }
    const ok = !spawnErr && firedAt === route.freq && firedText.includes('additionalContext');
    console.log('[baseline] verify: ' + (ok ? 'PASS' : 'FAIL'));
    console.log('  route tested  : ' + route.id + ' (' + route.event + ', freq ' + route.freq + ')');
    console.log('  fired on turn : ' + (firedAt || 'never'));
    if (spawnErr)
        console.log('  spawn error   : ' + spawnErr.message);
    else if (firedAt !== route.freq)
        console.log('  expected      : silent until turn ' + route.freq + ', then fire once');
    else if (!firedText.includes('additionalContext'))
        console.log('  problem       : fired, but output had no additionalContext field');
    if (!ok)
        process.exit(1);
}
// Re-deploy the central dispatcher + re-sync hook wiring from the CURRENT repo
// source and central config. Keeps the existing config folder (no preset reseed).
function cmdUpdate() {
    console.log('[baseline] update — redeploying dispatcher + re-syncing wiring from current config');
    console.log('');
    cmdInstall({ preset: DEFAULT_PRESET, force: false });
}
// Inspect the installation and return a list of checks.
function doctorChecks() {
    const checks = [];
    const jsExists = fs.existsSync(central.hookJs);
    if (!jsExists) {
        checks.push({ name: 'central dispatcher', level: 'fail', detail: 'not deployed at ' + central.hookJs, fixable: true });
    }
    else {
        let inSync = false;
        try {
            inSync = fs.readFileSync(central.hookJs, 'utf8') === fs.readFileSync(repo.hookSourceJs, 'utf8');
        }
        catch (e) { }
        checks.push(inSync
            ? { name: 'central dispatcher', level: 'ok', detail: 'byte-identical to repo source' }
            : { name: 'central dispatcher', level: 'warn', detail: 'DIFFERS from repo source (stale — update will refresh)', fixable: true });
    }
    const cfg = loadCentralConfig();
    if (!cfg.present) {
        checks.push({ name: 'config.json', level: 'warn', detail: 'missing (install will seed a preset)', fixable: true });
    }
    else if (cfg.fatal) {
        checks.push({ name: 'config.json', level: 'fail', detail: cfg.fatal, fixable: false });
    }
    else {
        checks.push({ name: 'config.json', level: 'ok', detail: 'valid; ' + cfg.routes.length + ' route(s) over [' + cfg.desiredEvents.join(', ') + ']' });
    }
    for (const issue of cfg.issues) {
        checks.push({ name: 'route', level: issue.level, detail: issue.msg, fixable: false });
    }
    // Config location: an external config must be reachable via the <installRoot>/cfg symlink.
    if (configIsExternal) {
        let okLink = false;
        try {
            const st = fs.lstatSync(central.cfgLink);
            if (st.isSymbolicLink()) {
                const t = fs.readlinkSync(central.cfgLink);
                const abs = path.isAbsolute(t) ? t : path.resolve(installRoot, t);
                okLink = samePath(abs, central.cfgDir);
            }
        }
        catch (e) { /* missing */ }
        checks.push(okLink
            ? { name: 'config location', level: 'ok', detail: 'external — ' + central.cfgLink + ' → ' + central.cfgDir }
            : { name: 'config location', level: 'fail', detail: central.cfgLink + ' does not link to ' + central.cfgDir + ' (run install)', fixable: true });
    }
    // Central Claude skill plugin payload.
    if (!fs.existsSync(central.skillManifest) || !fs.existsSync(central.skillMd)) {
        checks.push({ name: 'skill plugin', level: 'warn', detail: 'central payload not deployed at ' + central.skillDir + ' (install will deploy it)', fixable: true });
    }
    else if (fs.existsSync(repo.claudePluginManifest)) {
        let manifestSync = false;
        try {
            manifestSync = fs.readFileSync(central.skillManifest, 'utf8') === fs.readFileSync(repo.claudePluginManifest, 'utf8');
        }
        catch (e) { }
        let pathFresh = false;
        try {
            pathFresh = fs.readFileSync(central.skillMd, 'utf8').includes(repoRoot);
        }
        catch (e) { }
        if (manifestSync && pathFresh) {
            checks.push({ name: 'skill plugin', level: 'ok', detail: 'central payload deployed; recorded repo root current' });
        }
        else {
            checks.push({ name: 'skill plugin', level: 'warn', detail: (!manifestSync ? 'manifest differs from repo source' : 'recorded repo root is stale') + ' (update will refresh)', fixable: true });
        }
    }
    else {
        checks.push({ name: 'skill plugin', level: 'ok', detail: 'central payload deployed' });
    }
    for (const ap of allAgentPaths()) {
        const sr = settingsForRead(ap);
        if (sr.error) {
            checks.push({ name: 'hook config', level: 'fail', detail: ap.name + ' ' + ap.settingsLabel + ' invalid (' + sr.error.message + ') — fix by hand; install refuses to rewrite it', fixable: false });
            continue;
        }
        checks.push({ name: 'hook config', level: 'ok', detail: ap.name + ' ' + ap.settingsLabel + ' valid JSON' });
        const wired = wiredEvents(sr.settings, ap);
        const missing = cfg.desiredEvents.filter(e => wired.indexOf(e) === -1);
        const stale = wired.filter(e => cfg.desiredEvents.indexOf(e) === -1);
        if (!missing.length && !stale.length) {
            checks.push({ name: 'hook wiring', level: cfg.desiredEvents.length ? 'ok' : 'warn',
                detail: cfg.desiredEvents.length ? 'wired for exactly [' + wired.join(', ') + ']' : 'no routes → nothing wired (expected)' });
        }
        else {
            const parts = [];
            if (missing.length)
                parts.push('missing [' + missing.join(', ') + ']');
            if (stale.length)
                parts.push('stale [' + stale.join(', ') + ']');
            checks.push({ name: 'hook wiring', level: 'fail', detail: 'wiring drift: ' + parts.join('; '), fixable: true });
        }
        const js = linkState(ap.hookJs, central.hookJs);
        if (js.ok && js.mechanism !== 'copy')
            checks.push({ name: 'dispatcher link', level: 'ok', detail: 'linked to center (' + js.mechanism + ')' });
        else if (js.ok)
            checks.push({ name: 'dispatcher link', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
        else
            checks.push({ name: 'dispatcher link', level: 'fail', detail: js.mechanism + ' — not linked to ' + central.hookJs, fixable: true });
        const cl = dirLinkState(ap.cfgDir, central.cfgLink, CONFIG_MARKER);
        if (cl.ok && cl.mechanism !== 'copy')
            checks.push({ name: 'config link', level: 'ok', detail: 'linked to center (' + cl.mechanism + ')' });
        else if (cl.ok)
            checks.push({ name: 'config link', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
        else if (!cfg.present)
            checks.push({ name: 'config link', level: 'warn', detail: 'central config missing — install will seed + link', fixable: true });
        else
            checks.push({ name: 'config link', level: 'fail', detail: cl.mechanism + ' — not linked to ' + central.cfgLink, fixable: true });
        if (ap.skillDir) {
            const sl = dirLinkState(ap.skillDir, central.skillDir, SKILL_MARKER);
            if (sl.ok && sl.mechanism !== 'copy')
                checks.push({ name: 'skill link', level: 'ok', detail: ap.name + ' linked to center (' + sl.mechanism + ')' });
            else if (sl.ok)
                checks.push({ name: 'skill link', level: 'warn', detail: ap.name + ' degraded copy (edits will not propagate; install will relink)', fixable: true });
            else if (!fs.existsSync(central.skillManifest))
                checks.push({ name: 'skill link', level: 'warn', detail: ap.name + ' central skill missing — install will deploy + link', fixable: true });
            else
                checks.push({ name: 'skill link', level: 'fail', detail: ap.name + ' ' + sl.mechanism + ' — not linked to ' + central.skillDir, fixable: true });
        }
    }
    return checks;
}
function printDoctorChecks(checks) {
    const mark = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };
    for (const c of checks) {
        console.log('  ' + (mark[c.level] || '[????]') + ' ' + c.name + ': ' + c.detail);
    }
}
function cmdDoctor(fix) {
    console.log('[baseline] doctor — scanning installation');
    console.log('  install root : ' + central.root);
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
    if (!fix) {
        console.log('');
        console.log('[baseline] doctor: ' + problems.length + ' issue(s) found' +
            (fixable.length ? ', ' + fixable.length + ' auto-fixable — rerun with --fix.' : ' (none auto-fixable; see notes above).'));
        process.exit(1);
    }
    // --fix: refuse while hook config is invalid; else redeploy via update + rescan.
    if (checks.some(c => c.name === 'hook config' && c.level === 'fail')) {
        console.log('');
        console.log('[baseline] doctor: hook config is invalid — fix it by hand first, then rerun --fix. Nothing was changed.');
        process.exit(1);
    }
    if (!fixable.length) {
        console.log('');
        console.log('[baseline] doctor: nothing auto-fixable. Manual action needed for the issues above.');
        process.exit(1);
    }
    console.log('');
    console.log('[baseline] doctor --fix: repairing via update...');
    console.log('');
    try {
        cmdUpdate();
    }
    catch (e) {
        fail('doctor --fix: ' + e.message, 1);
    }
    console.log('');
    console.log('[baseline] doctor: re-scanning after fix...');
    console.log('');
    checks = doctorChecks();
    printDoctorChecks(checks);
    const remaining = checks.filter(c => c.level !== 'ok');
    console.log('');
    if (remaining.length) {
        console.log('[baseline] doctor: ' + remaining.length + ' issue(s) remain after fix — manual action needed.');
        process.exit(1);
    }
    console.log('[baseline] doctor: installation repaired.');
}
// --- help / arg parsing -----------------------------------------------------
function printHelp() {
    console.log('baseline — manage the injection-routes dispatcher (cross-platform: Windows + Linux)');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/manage.js status                  Report what is installed vs the repo source + config.');
    console.log('  node scripts/manage.js install [--preset <n>]  Deploy the dispatcher, seed the config preset, link agents, wire hook config.');
    console.log('  node scripts/manage.js verify                  Functionally test a wired route (does it fire?).');
    console.log('  node scripts/manage.js update                  Redeploy dispatcher + re-sync hook wiring from current config.');
    console.log('  node scripts/manage.js doctor [--fix]          Validate config + wiring and report health; --fix repairs it.');
    console.log('  node scripts/manage.js uninstall               Remove per-agent wiring + links (keeps the central config folder).');
    console.log('  node scripts/manage.js help                    Show this help.');
    console.log('');
    console.log('install options:');
    console.log('  --preset <minimal|default>   Which repo preset to seed when no config folder exists. Default: minimal.');
    console.log('  --force                      Replace an existing central config folder with the preset (DESTRUCTIVE — user edits lost).');
    console.log('');
    console.log('Native Zig runtime is paused for the routes feature; the dispatcher is Node-only in v1.');
    console.log('A Claude skills-dir plugin (baseline@skills-dir) is deployed + linked so Claude recognizes baseline; it carries no hooks.');
    console.log('Install root (artifacts): BASELINE_HOME if set, otherwise ~/.baseline.');
    console.log('Config folder (routes + docs): BASELINE_CFG if set, otherwise <install root>/cfg.');
    console.log('Claude config dir: CLAUDE_CONFIG_DIR if set, otherwise ~/.claude.');
    console.log('Codex config dir: CODEX_HOME if set, otherwise ~/.codex.');
}
function parseInstallOpts(argv, cmd) {
    cmd = cmd || 'install';
    const opts = { preset: DEFAULT_PRESET, force: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--preset' || a === '-preset') {
            opts.preset = argv[i + 1] || '';
            i++;
            if (!opts.preset)
                fail(cmd + ': --preset needs a value (e.g. minimal|default).', 2);
        }
        else if (a.startsWith('--preset=')) {
            opts.preset = a.slice(a.indexOf('=') + 1);
            if (!opts.preset)
                fail(cmd + ': --preset needs a value (e.g. minimal|default).', 2);
        }
        else if (a === '--force' || a === '-force') {
            opts.force = true;
        }
        else if (a === '--runtime' || a === '-runtime' || a.startsWith('--runtime=') || a === '--build' || a === '-build') {
            fail(cmd + ': native runtime is paused for the routes feature; the dispatcher is Node-only in v1.', 2);
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
        try {
            cmdInstall(parseInstallOpts(process.argv.slice(3)));
        }
        catch (e) {
            fail('install: ' + e.message, 1);
        }
        break;
    case 'uninstall':
        try {
            cmdUninstall();
        }
        catch (e) {
            fail('uninstall: ' + e.message, 1);
        }
        break;
    case 'status':
        cmdStatus();
        break;
    case 'verify':
        cmdVerify();
        break;
    case 'update':
        try {
            parseInstallOpts(process.argv.slice(3), 'update'); // reject native flags
            cmdUpdate();
        }
        catch (e) {
            fail('update: ' + e.message, 1);
        }
        break;
    case 'doctor':
        parseInstallOpts(process.argv.slice(3), 'doctor'); // reject native flags
        cmdDoctor(process.argv.slice(3).some(a => a === '--fix' || a === '-fix'));
        break;
    default:
        console.log('[baseline] unknown command "' + cmd + '".');
        printHelp();
        process.exit(2);
}
