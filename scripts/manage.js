#!/usr/bin/env node
"use strict";
// baseline — cross-platform installer / verifier / status / doctor / uninstaller
// for the baseline injection-routes dispatcher. Runs on Windows and Linux.
//
// Usage (run with node from the repo root):
//   node scripts/manage.js status              report what's installed vs the repo source + config
//   node scripts/manage.js install [--preset <name>] [--force] [--agents <a,b>]
//   node scripts/manage.js verify              functional check: does a route fire?
//   node scripts/manage.js update              redeploy from repo, re-sync hook wiring
//   node scripts/manage.js doctor [--fix]      validate config + wiring; --fix repairs
//   node scripts/manage.js uninstall           remove per-agent wiring + links (keeps central config)
//   node scripts/manage.js help
//
// Design notes:
// - Regenerable ARTIFACTS live in a per-skill install root, BASELINE_HOME or
//   ~/.baseline: the deployed dispatcher (hooks/baseline-recital.js + hooks/contracts.js), installed
//   manager/source artifacts (scripts/), Claude skill payload (skills/baseline/),
//   and Codex plugin payload (codex-plugin/baseline/). The repo is the source of
//   truth; install always overwrites these from it.
// - The editable CONFIG folder (config.json + docs/) lives separately, wherever the
//   operator wants: BASELINE_CFG, else <install root>/cfg. <install root>/cfg is the
//   canonical path agents link to — a symlink to BASELINE_CFG when set, else a real
//   seeded folder. Config and artifacts never share a directory.
// - Each agent's config dir (Claude: CLAUDE_CONFIG_DIR or ~/.claude; Codex:
//   CODEX_HOME or ~/.codex) gets LINKS back into the center:
//   hooks/baseline-recital.js + hooks/contracts.js → install root; cfg/baseline → <install root>/cfg.
//   Claude also gets skills/baseline → <install root>/skills/baseline; Codex gets
//   plugins/cache/baseline/baseline/local → <install root>/codex-plugin/baseline
//   plus an empty [plugins."baseline@baseline"] table in config.toml.
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
const readline = require("readline");
const child_process_1 = require("child_process");
const contracts_1 = require("./contracts");
// --- constants -------------------------------------------------------------
const KNOWN_ROUTE_KEYS = ['id', 'event', 'freq', 'cwd', 'doc'];
const DEFAULT_PRESET = 'default';
const CODEX_MARKETPLACE = 'baseline';
const CODEX_PLUGIN = 'baseline';
const CODEX_PLUGIN_VERSION = 'local';
const CODEX_PLUGIN_KEY = CODEX_PLUGIN + '@' + CODEX_MARKETPLACE;
const CODEX_PLUGIN_TABLE = '[plugins."' + CODEX_PLUGIN_KEY + '"]';
// --- platform + path resolution -------------------------------------------
const isWin = process.platform === 'win32';
const homeDir = os.homedir();
// Repo root resolved relative to this file (scripts/ sits directly under root).
const repoRoot = path.resolve(__dirname, '..');
function inferInstalledRootFromManagerLocation() {
    const candidate = path.resolve(__dirname, '..');
    const expectedManager = path.join(candidate, 'scripts', 'manage.js');
    const sourceManager = path.join(candidate, 'src', 'manage.ts');
    if (!samePath(__filename, expectedManager))
        return null;
    if (fs.existsSync(sourceManager))
        return null;
    return candidate;
}
// Install root: where baseline's REGENERABLE artifacts live (deployed dispatcher +
// Claude skill payload). Per-skill and self-contained: BASELINE_HOME, else an
// installed manager's own root, else ~/.baseline for source-repo development.
const installRoot = process.env.BASELINE_HOME
    ? path.resolve(process.env.BASELINE_HOME)
    : (inferInstalledRootFromManagerLocation() || path.join(homeDir, '.baseline'));
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
    hookContractsJs: path.join(installRoot, 'hooks', 'contracts.js'),
    cfgLink: cfgLink, // <installRoot>/cfg — what agents link to (real dir, or symlink to cfgReal)
    cfgDir: cfgReal, // the real config folder (flat: config.json + docs/)
    config: path.join(cfgReal, 'config.json'),
    docsDir: path.join(cfgReal, 'docs'),
    // Installed manager/source artifacts. A generated control surface points here
    // for normal use so it survives a moved/deleted source checkout.
    managerDir: path.join(installRoot, 'scripts'),
    managerJs: path.join(installRoot, 'scripts', 'manage.js'),
    managerHookSourceJs: path.join(installRoot, 'scripts', 'baseline-recital.js'),
    managerContractsJs: path.join(installRoot, 'scripts', 'contracts.js'),
    installedClaudeManifest: path.join(installRoot, '.claude-plugin', 'plugin.json'),
    installedCodexManifest: path.join(installRoot, '.codex-plugin', 'plugin.json'),
    installedPresetsDir: path.join(installRoot, 'presets'),
    // Claude skills-dir plugin payload (skill-only; no hooks). Linked into each
    // skill-capable agent's skills dir so Claude recognizes baseline + loads its skill.
    skillDir: path.join(installRoot, 'skills', 'baseline'),
    skillManifest: path.join(installRoot, 'skills', 'baseline', '.claude-plugin', 'plugin.json'),
    skillMd: path.join(installRoot, 'skills', 'baseline', 'SKILL.md'),
    // Codex plugin payload copied/linked into CODEX_HOME's plugin cache and
    // activated through config.toml.
    codexPluginDir: path.join(installRoot, 'codex-plugin', 'baseline'),
    codexPluginManifest: path.join(installRoot, 'codex-plugin', 'baseline', '.codex-plugin', 'plugin.json'),
    codexPluginSkillMd: path.join(installRoot, 'codex-plugin', 'baseline', 'skills', 'baseline', 'SKILL.md'),
};
const repo = {
    managerSourceJs: path.join(repoRoot, 'scripts', 'manage.js'),
    hookSourceJs: path.join(repoRoot, 'scripts', 'baseline-recital.js'),
    contractsSourceJs: path.join(repoRoot, 'scripts', 'contracts.js'),
    presetsDir: path.join(repoRoot, 'presets'),
    // Source of truth for plugin manifests, copied into installed control-surface payloads.
    claudePluginManifest: path.join(repoRoot, '.claude-plugin', 'plugin.json'),
    codexPluginManifest: path.join(repoRoot, '.codex-plugin', 'plugin.json'),
};
function agentRegistry() {
    return [
        {
            name: 'claude-code',
            configDir: process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'),
            settingsFile: 'settings.json',
            skillPlugin: true,
            codexPlugin: false,
        },
        {
            name: 'codex',
            configDir: process.env.CODEX_HOME || path.join(homeDir, '.codex'),
            settingsFile: 'hooks.json',
            skillPlugin: false,
            codexPlugin: true,
        },
    ];
}
// Derive every per-agent path. hookJs/hookContractsJs and cfgDir are LINKS to
// the center; hook config and counters are real per-agent files. Codex plugin
// activation additionally needs a cache root and config.toml table.
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
        hookContractsJs: path.join(d, 'hooks', 'contracts.js'),
        cfgDir: path.join(d, 'cfg', 'baseline'),
        skillDir: agent.skillPlugin ? path.join(d, 'skills', 'baseline') : null,
        codexPluginDir: agent.codexPlugin ? path.join(d, 'plugins', 'cache', CODEX_MARKETPLACE, CODEX_PLUGIN, CODEX_PLUGIN_VERSION) : null,
        codexConfigToml: agent.codexPlugin ? path.join(d, 'config.toml') : null,
    };
}
function allAgentPaths() {
    return agentRegistry().map(agentPaths);
}
// --- agent detection + recorded selection (state.json) ---------------------
// Detect which agents are present by config-dir existence (D2). Selection is STRICTLY
// limited to this set — install never wires an agent whose config dir is absent.
function detectedAgents() {
    return allAgentPaths().filter(ap => fs.existsSync(ap.configDir));
}
// The persisted record of which agents this install wired (D5), under the install root.
function stateFile() {
    return path.join(central.root, 'state.json');
}
// Read the recorded agent set, or null when absent/empty/corrupt so callers fall back
// to inference or detection rather than wiring nothing.
function readRecordedAgents() {
    const r = readJson(stateFile());
    if (!r.ok || r.missing)
        return null;
    const v = r.value;
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.agents))
        return null;
    const names = v.agents.filter((x) => typeof x === 'string');
    return names.length ? names : null;
}
// Persist the selected agent set as { "agents": [...] } via the atomic writer (D5).
function writeRecordedAgents(names) {
    atomicWrite(stateFile(), JSON.stringify({ agents: names }, null, 2) + '\n');
}
// Infer the agent set from what is currently wired (D6 migration): an agent counts as
// wired when our dispatcher command is present in its (readable) settings.
function inferWiredAgentNames() {
    const out = [];
    for (const ap of allAgentPaths()) {
        const { settings, error } = settingsForRead(ap);
        if (error)
            continue;
        if (findOurCommand(settings, ap))
            out.push(ap.name);
    }
    return out;
}
// The agent set a post-install command (uninstall/doctor) operates on: the recorded set
// wins; else infer from currently-wired; else fall back to all agents (D6).
function scopedAgentNames() {
    const recorded = readRecordedAgents();
    if (recorded)
        return recorded;
    const inferred = inferWiredAgentNames();
    if (inferred.length)
        return inferred;
    return allAgentPaths().map(ap => ap.name);
}
// Parse a --agents comma list into trimmed, non-empty names. An empty value is an error.
function parseAgentList(value, cmd) {
    const names = value.split(',').map(s => s.trim()).filter(Boolean);
    if (!names.length)
        fail(cmd + ': --agents needs at least one agent name (e.g. claude-code,codex).', 2);
    return names;
}
// Interactive multi-select over the detected agents (D3) — only reached when stdin is a
// TTY and neither --agents nor --force was given. A blank answer selects all detected;
// numbers (or names) pick a subset.
function promptAgentSelection(detected) {
    return new Promise((resolve) => {
        const all = detected.map(ap => ap.name);
        console.log('[baseline] multiple agents detected. Select which to wire:');
        detected.forEach((ap, i) => console.log('  ' + (i + 1) + ') ' + ap.name + '  (' + ap.configDir + ')'));
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Enter numbers or names (comma-separated), or blank for all: ', (answer) => {
            rl.close();
            const tokens = (answer || '').split(',').map(s => s.trim()).filter(Boolean);
            if (!tokens.length) {
                resolve(all);
                return;
            }
            const picked = [];
            for (const tok of tokens) {
                let name = null;
                const idx = Number(tok);
                if (Number.isInteger(idx) && idx >= 1 && idx <= detected.length)
                    name = detected[idx - 1].name;
                else if (all.indexOf(tok) !== -1)
                    name = tok;
                if (name && picked.indexOf(name) === -1)
                    picked.push(name);
            }
            resolve(picked.length ? picked : all);
        });
    });
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
// Recursively copy a directory tree (used to deploy a preset/artifact payload and
// as the config/plugin link copy-fallback).
function copyDir(src, dest) {
    if (samePath(src, dest))
        return;
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
    for (const event of contracts_1.SUPPORTED_EVENTS) {
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
// Marker files inside managed config/control-surface folders, used to (a)
// recognize a baseline-managed directory as safe to replace and (b) byte-compare
// for copy detection.
const CONFIG_MARKER = 'config.json';
const SKILL_MARKER = path.join('.claude-plugin', 'plugin.json');
const CODEX_PLUGIN_MARKER = path.join('.codex-plugin', 'plugin.json');
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
function splitTomlLines(content) {
    const eol = content.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    const normalized = content.replace(/\r\n/g, '\n');
    if (normalized === '')
        return { lines: [], eol };
    const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
    return { lines: body === '' ? [] : body.split('\n'), eol };
}
function joinTomlLines(lines, eol) {
    return lines.length ? lines.join(eol) + eol : '';
}
function tomlLineCommentStart(line) {
    let quote = null;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote === '"') {
            if (escaped) {
                escaped = false;
            }
            else if (ch === '\\') {
                escaped = true;
            }
            else if (ch === '"') {
                quote = null;
            }
            continue;
        }
        if (quote === "'") {
            if (ch === "'")
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (ch === '#') {
            return i;
        }
    }
    return -1;
}
function tomlTableHeader(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('['))
        return null;
    const comment = tomlLineCommentStart(trimmed);
    const header = (comment === -1 ? trimmed : trimmed.slice(0, comment).trim());
    const array = header.startsWith('[[');
    const openLen = array ? 2 : 1;
    let quote = null;
    let escaped = false;
    for (let i = openLen; i < header.length; i++) {
        const ch = header[i];
        if (quote === '"') {
            if (escaped) {
                escaped = false;
            }
            else if (ch === '\\') {
                escaped = true;
            }
            else if (ch === '"') {
                quote = null;
            }
            continue;
        }
        if (quote === "'") {
            if (ch === "'")
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (array) {
            if (ch !== ']' || header[i + 1] !== ']')
                continue;
            const closeEnd = i + 2;
            return header.slice(closeEnd).trim() === ''
                ? { name: header.slice(openLen, i).trim(), array }
                : null;
        }
        if (ch === ']') {
            const closeEnd = i + 1;
            return header.slice(closeEnd).trim() === ''
                ? { name: header.slice(openLen, i).trim(), array }
                : null;
        }
    }
    return null;
}
function tomlTableName(line) {
    const table = tomlTableHeader(line);
    return table ? table.name : null;
}
function tomlOrdinaryTableName(line) {
    const table = tomlTableHeader(line);
    return table && !table.array ? table.name : null;
}
function isCodexPluginActivationName(name) {
    return name === 'plugins."' + CODEX_PLUGIN_KEY + '"' || name === "plugins.'" + CODEX_PLUGIN_KEY + "'";
}
function findCodexPluginActivationSection(lines) {
    for (let i = 0; i < lines.length; i++) {
        const name = tomlOrdinaryTableName(lines[i]);
        if (!name || !isCodexPluginActivationName(name))
            continue;
        let end = i + 1;
        while (end < lines.length && tomlTableName(lines[end]) === null)
            end++;
        return { start: i, end };
    }
    return null;
}
function codexPluginActivationState(configToml) {
    let content;
    try {
        content = fs.readFileSync(configToml, 'utf8');
    }
    catch (e) {
        if (e && e.code === 'ENOENT')
            return { ok: false, mechanism: 'missing' };
        return { ok: false, mechanism: 'unreadable' };
    }
    return findCodexPluginActivationSection(splitTomlLines(content).lines)
        ? { ok: true, mechanism: 'present' }
        : { ok: false, mechanism: 'inactive' };
}
function ensureCodexPluginActivation(configToml) {
    let content = '';
    let existed = true;
    try {
        content = fs.readFileSync(configToml, 'utf8');
    }
    catch (e) {
        if (e && e.code === 'ENOENT')
            existed = false;
        else
            throw e;
    }
    const parsed = splitTomlLines(content);
    if (findCodexPluginActivationSection(parsed.lines))
        return 'present';
    if (parsed.lines.length && parsed.lines[parsed.lines.length - 1].trim() !== '') {
        parsed.lines.push('');
    }
    parsed.lines.push(CODEX_PLUGIN_TABLE);
    atomicWrite(configToml, joinTomlLines(parsed.lines, parsed.eol));
    return existed ? 'added' : 'created';
}
function removeCodexPluginActivation(configToml) {
    let content;
    try {
        content = fs.readFileSync(configToml, 'utf8');
    }
    catch (e) {
        if (e && e.code === 'ENOENT')
            return 'absent';
        throw e;
    }
    const parsed = splitTomlLines(content);
    const section = findCodexPluginActivationSection(parsed.lines);
    if (!section)
        return 'absent';
    const next = parsed.lines.slice(0, section.start).concat(parsed.lines.slice(section.end));
    atomicWrite(configToml, joinTomlLines(next, parsed.eol));
    return 'removed';
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
    for (const event of contracts_1.SUPPORTED_EVENTS) {
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
    for (const event of contracts_1.SUPPORTED_EVENTS) {
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
    for (const event of contracts_1.SUPPORTED_EVENTS) {
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
// Load + validate the central config.json. Mirrors the dispatcher's fail-open
// selection, but also collects per-route issues so doctor/status can report them.
function loadCentralConfig() {
    const report = { present: false, fatal: null, routes: [], issues: [], desiredEvents: [] };
    let raw;
    try {
        const st = fs.statSync(central.config);
        report.present = true;
        if (st.size > contracts_1.MAX_CONFIG_BYTES) {
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
    if (routes.length > contracts_1.MAX_ROUTES) {
        report.fatal = 'config.json has ' + routes.length + ' routes (cap is ' + contracts_1.MAX_ROUTES + ')';
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
        if (typeof r.id !== 'string' || !contracts_1.SLUG.test(r.id)) {
            report.issues.push({ level: 'fail', msg: where + ' has an invalid id (must match ' + contracts_1.SLUG.source + ')' });
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
        const ev = (0, contracts_1.parseEvent)(r.event);
        if (contracts_1.SUPPORTED_EVENTS.indexOf(ev.base) === -1 ||
            (ev.phase !== undefined && (ev.base !== 'SessionStart' || contracts_1.SESSION_PHASES.indexOf(ev.phase) === -1))) {
            report.issues.push({ level: 'fail', msg: 'route ' + label + ' has unsupported event ' + JSON.stringify(r.event) });
            continue;
        }
        const docPath = (0, contracts_1.safeDocPath)(r.doc, central.cfgDir);
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
            if (!(0, contracts_1.safeRealDocPath)(r.doc, central.cfgDir)) {
                report.issues.push({ level: 'fail', msg: 'route ' + label + ' doc resolves outside the config folder: ' + r.doc });
            }
            if (st.size > contracts_1.MAX_DOC_BYTES)
                report.issues.push({ level: 'fail', msg: 'route ' + label + ' doc exceeds 64 KiB cap' });
            const body = fs.readFileSync(docPath, 'utf8');
            if (body.length > contracts_1.MAX_DOC_CHARS)
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
        const base = (0, contracts_1.parseEvent)(r.event).base;
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
// --- installed control-surface payloads -------------------------------------
function copyFileIfDifferent(src, dest) {
    if (samePath(src, dest))
        return;
    copyFileAtomic(src, dest);
}
function sameFileContents(left, right) {
    try {
        return fs.readFileSync(left).equals(fs.readFileSync(right));
    }
    catch (e) {
        return false;
    }
}
// Deploy the small set of source artifacts an installed control surface needs to
// keep working even when the original checkout moves: the manager, dispatcher,
// shared contracts, manifests, and presets. When the manager is run from the
// install root these paths are already identical, so this is a no-op.
function ensureInstalledManagerArtifacts() {
    if (!fs.existsSync(repo.managerSourceJs)) {
        throw new Error('manager artifact missing at ' + repo.managerSourceJs + ' — run `npm run build` first.');
    }
    if (!fs.existsSync(repo.hookSourceJs)) {
        throw new Error('compiled dispatcher missing at ' + repo.hookSourceJs + ' — run `npm run build` first.');
    }
    if (!fs.existsSync(repo.contractsSourceJs)) {
        throw new Error('compiled contracts missing at ' + repo.contractsSourceJs + ' — run `npm run build` first.');
    }
    if (!fs.existsSync(repo.claudePluginManifest)) {
        throw new Error('Claude plugin manifest missing at ' + repo.claudePluginManifest + ' — cannot deploy the skill plugin.');
    }
    if (!fs.existsSync(repo.codexPluginManifest)) {
        throw new Error('Codex plugin manifest missing at ' + repo.codexPluginManifest + ' — cannot deploy the Codex plugin.');
    }
    if (!fs.existsSync(repo.presetsDir)) {
        throw new Error('preset directory missing at ' + repo.presetsDir + ' — cannot seed installs from this manager.');
    }
    copyFileIfDifferent(repo.managerSourceJs, central.managerJs);
    copyFileIfDifferent(repo.hookSourceJs, central.managerHookSourceJs);
    copyFileIfDifferent(repo.contractsSourceJs, central.managerContractsJs);
    copyFileIfDifferent(repo.claudePluginManifest, central.installedClaudeManifest);
    copyFileIfDifferent(repo.codexPluginManifest, central.installedCodexManifest);
    copyDir(repo.presetsDir, central.installedPresetsDir);
}
// The deployed SKILL.md is self-contained enough for normal operation: it points
// at installed disk artifacts under <installRoot>, not the source checkout's root
// SKILL.md. The source path is recorded only as provenance for source development.
function installedControlSurfaceSkill(host, repoRootPath) {
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
        '# baseline (' + host + ' control surface)',
        '',
        'Use the installed baseline manager and artifacts. Do not assume the original source',
        'checkout still exists; it is only recorded below for source-development refreshes.',
        '',
        'Install root:',
        '',
        '    ' + central.root,
        '',
        'Config folder (routes + injected docs):',
        '',
        '    ' + central.cfgDir,
        '',
        'Manager commands:',
        '',
        '    node "' + central.managerJs + '" status',
        '    node "' + central.managerJs + '" install',
        '    node "' + central.managerJs + '" update',
        '    node "' + central.managerJs + '" verify',
        '    node "' + central.managerJs + '" doctor',
        '    node "' + central.managerJs + '" doctor --fix',
        '    node "' + central.managerJs + '" uninstall',
        '',
        'Normal edits:',
        '',
        '- Change injected text in `' + central.docsDir + '`.',
        '- Change routes in `' + central.config + '`; rerun `install`/`update` when the',
        '  route event set changes so hook wiring stays exact.',
        '- After hook-config changes, open `/hooks` once in each agent or restart it.',
        '',
        'Codex plugin activation managed by `install`/`update`:',
        '',
        '    cache: $CODEX_HOME/plugins/cache/' + CODEX_MARKETPLACE + '/' + CODEX_PLUGIN + '/' + CODEX_PLUGIN_VERSION,
        '    config: ' + CODEX_PLUGIN_TABLE,
        '',
        'Source checkout recorded for provenance/source refresh only:',
        '',
        '    ' + repoRootPath,
        '',
        "If you need to refresh from a different checkout, run that checkout's",
        '`node scripts/manage.js install` or `update`; otherwise use the installed manager',
        'above.',
        '',
    ].join('\n');
}
// Deploy the Claude skills-dir plugin payload to the center: the manifest copied
// verbatim from the repo (single source of truth), plus a generated SKILL.md that
// uses installed artifacts for normal operation. Always overwrites (repo wins),
// like the dispatcher.
function ensureCentralSkill() {
    if (!fs.existsSync(repo.claudePluginManifest)) {
        throw new Error('Claude plugin manifest missing at ' + repo.claudePluginManifest + ' — cannot deploy the skill plugin.');
    }
    atomicWrite(central.skillManifest, fs.readFileSync(repo.claudePluginManifest, 'utf8'));
    atomicWrite(central.skillMd, installedControlSurfaceSkill('Claude', repoRoot));
}
// Deploy the central Codex plugin payload. Codex itself loads from
// CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>, so selected agents
// receive a managed link/copy from this root plus a config.toml activation table.
function ensureCentralCodexPlugin() {
    if (!fs.existsSync(repo.codexPluginManifest)) {
        throw new Error('Codex plugin manifest missing at ' + repo.codexPluginManifest + ' — cannot deploy the Codex plugin.');
    }
    atomicWrite(central.codexPluginManifest, fs.readFileSync(repo.codexPluginManifest, 'utf8'));
    atomicWrite(central.codexPluginSkillMd, installedControlSurfaceSkill('Codex', repoRoot));
}
function ensureCodexPluginForAgent(ap) {
    if (!ap.codexPluginDir || !ap.codexConfigToml)
        return null;
    const cacheMech = linkDirInto(central.codexPluginDir, ap.codexPluginDir, CODEX_PLUGIN_MARKER);
    const activation = ensureCodexPluginActivation(ap.codexConfigToml);
    return { cacheMech, activation };
}
// --- commands --------------------------------------------------------------
async function cmdInstall(opts) {
    // 0. Detect agents by config-dir existence; selection is strictly limited to these (D2).
    const detected = detectedAgents();
    if (!detected.length) {
        const looked = allAgentPaths().map(ap => ap.name + ' (' + ap.configDir + ')').join(', ');
        fail('no supported agents detected — looked for ' + looked +
            '. Create one of these config dirs (or install the agent), then re-run.', 1);
    }
    const detectedNames = detected.map(ap => ap.name);
    // Resolve the SELECTED agent names.
    let selected;
    if (opts.agents && opts.agents.length) {
        // Explicit --agents (or update/uninstall passing a recorded set): every name must be
        // a detected agent — an unknown OR not-detected name is a hard error (D1).
        const requested = opts.agents;
        for (const name of requested) {
            if (detectedNames.indexOf(name) !== -1)
                continue;
            const known = agentRegistry().some(a => a.name === name);
            if (!known) {
                fail('unknown agent "' + name + '" (known agents: ' + agentRegistry().map(a => a.name).join(', ') + ').', 2);
            }
            fail('agent "' + name + '" is not detected (no config dir at ' +
                agentPaths(agentRegistry().find(a => a.name === name)).configDir + '). Detected: ' + detectedNames.join(', ') + '.', 2);
        }
        selected = requested.filter((n, i) => requested.indexOf(n) === i);
    }
    else {
        const recorded = readRecordedAgents();
        if (recorded) {
            // Re-install/update path: honor the recorded set, intersected with detection so a
            // now-absent agent is never wired (D2/D6). A recorded agent that is no longer
            // detected is dropped GRACEFULLY with a notice (not silent, not a hard error — the
            // hard error is reserved for an explicit --agents, D1); the narrowed set is then
            // re-persisted below.
            for (const n of recorded) {
                if (detectedNames.indexOf(n) === -1) {
                    console.log('[baseline] recorded agent "' + n + '" no longer detected (config dir absent) — dropped from selection');
                }
            }
            selected = recorded.filter(n => detectedNames.indexOf(n) !== -1);
        }
        else if (process.stdin.isTTY && !opts.force) {
            selected = await promptAgentSelection(detected);
        }
        else {
            // --force or non-TTY: all detected, no prompt (D3).
            selected = detectedNames.slice();
        }
    }
    const selectedSet = new Set(selected);
    const agentsP = detected.filter(ap => selectedSet.has(ap.name));
    // 1. Refuse before any deploy if a SELECTED agent's hook config file is invalid.
    for (const ap of agentsP)
        settingsOrEmptyForWrite(ap);
    // 2. ALWAYS deploy the canonical .js to the CENTER (overwrite; repo wins).
    if (!fs.existsSync(repo.hookSourceJs)) {
        fail('install: compiled dispatcher missing at ' + repo.hookSourceJs + ' — run `npm run build` first.', 1);
    }
    if (!fs.existsSync(repo.contractsSourceJs)) {
        fail('install: compiled contracts missing at ' + repo.contractsSourceJs + ' — run `npm run build` first.', 1);
    }
    fs.mkdirSync(central.hooksDir, { recursive: true });
    atomicWrite(central.hookJs, fs.readFileSync(repo.hookSourceJs, 'utf8'));
    copyFileIfDifferent(repo.contractsSourceJs, central.hookContractsJs);
    // 2b. Deploy installed manager/source artifacts used by generated control surfaces.
    try {
        ensureInstalledManagerArtifacts();
    }
    catch (e) {
        fail('install: ' + e.message, 1);
    }
    // 3. Establish the config folder LOCATION (symlink to BASELINE_CFG, or a real dir).
    const cfgLocMech = ensureConfigLocation();
    // 4. Establish the config folder CONTENTS (seed/keep/replace).
    const configState = ensureCentralConfig(opts);
    // 5. Deploy control-surface plugin payloads to the center (repo wins).
    ensureCentralSkill();
    ensureCentralCodexPlugin();
    // 6. Read the config to learn which events to wire.
    const cfg = loadCentralConfig();
    // 7. Persist the selected agent set so update/doctor/uninstall scope to it (D5).
    if (selected.length)
        writeRecordedAgents(selected);
    // 8. For each agent: link the center in, then wire hook config for the config's
    // events. Codex also gets its plugin cache materialized and config.toml activated.
    const perAgent = [];
    for (const ap of agentsP) {
        const jsMech = linkInto(central.hookJs, ap.hookJs);
        const contractsMech = linkInto(central.hookContractsJs, ap.hookContractsJs);
        const cfgMech = linkDirInto(central.cfgLink, ap.cfgDir, CONFIG_MARKER);
        const skillMech = ap.skillDir ? linkDirInto(central.skillDir, ap.skillDir, SKILL_MARKER) : null;
        const codexPlugin = ensureCodexPluginForAgent(ap);
        const command = jsCommand(ap);
        const sync = syncWiring(ap, command, cfg.desiredEvents);
        perAgent.push({ name: ap.name, configDir: ap.configDir, jsMech, contractsMech, cfgMech, skillMech, codexPlugin, sync });
    }
    console.log('[baseline] install complete');
    console.log('  install root  : ' + central.root);
    console.log('  runtime       : node js');
    console.log('  manager       : ' + central.managerJs);
    console.log('  dispatcher    : ' + central.hookJs);
    console.log('  config folder : ' + central.cfgDir + ' (' + configState + ', preset: ' + opts.preset + ')' +
        (configIsExternal ? ' [external; ' + central.cfgLink + ' (' + cfgLocMech + ') links to it]' : ''));
    console.log('  claude skill  : ' + central.skillDir + ' (baseline@skills-dir; no hooks)');
    console.log('  codex plugin  : ' + central.codexPluginDir + ' (' + CODEX_PLUGIN_KEY + ', version ' + CODEX_PLUGIN_VERSION + ')');
    console.log('  routes        : ' + cfg.routes.length + (cfg.desiredEvents.length ? ' over [' + cfg.desiredEvents.join(', ') + ']' : ' (no events wired)'));
    if (cfg.fatal)
        console.log('  config WARNING: ' + cfg.fatal + ' — run doctor');
    for (const a of perAgent) {
        console.log('  agent ' + a.name + ' @ ' + a.configDir);
        console.log('    links       : dispatcher=' + a.jsMech + ', contracts=' + a.contractsMech + ', cfg=' + a.cfgMech + (a.skillMech ? ', skill=' + a.skillMech : '') +
            (a.codexPlugin ? ', codex-cache=' + a.codexPlugin.cacheMech + ', codex-config=' + a.codexPlugin.activation : ''));
        console.log('    wired       : ' + (a.sync.wired.length ? a.sync.wired.join(', ') : '(none)') +
            (a.sync.unwired.length ? '; unwired ' + a.sync.unwired.join(', ') : ''));
    }
    console.log('  next step     : open /hooks once in each agent (or restart) so hook config reloads.');
}
function cmdUninstall() {
    // Operate on the recorded set (D6); fall back to inferred-from-wired, then all.
    const scoped = new Set(scopedAgentNames());
    const agentsP = allAgentPaths().filter(ap => scoped.has(ap.name));
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
        const contractsGone = removeOurLink(ap.hookContractsJs, central.hookContractsJs);
        const cfgGone = removeOurDirLink(ap.cfgDir, central.cfgLink, CONFIG_MARKER);
        const skillGone = ap.skillDir ? removeOurDirLink(ap.skillDir, central.skillDir, SKILL_MARKER) : false;
        const codexCacheGone = ap.codexPluginDir ? removeOurDirLink(ap.codexPluginDir, central.codexPluginDir, CODEX_PLUGIN_MARKER) : false;
        const codexActivation = ap.codexConfigToml ? removeCodexPluginActivation(ap.codexConfigToml) : 'absent';
        console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
        console.log('    ' + ap.settingsLabel.padEnd(12) + ': ' + (unwired.length ? 'unwired ' + unwired.join(', ') : 'nothing wired'));
        console.log('    dispatcher  : ' + (jsGone ? 'unlinked' : 'absent'));
        console.log('    contracts   : ' + (contractsGone ? 'unlinked' : 'absent'));
        console.log('    cfg folder  : ' + (cfgGone ? 'unlinked (central kept)' : 'left as-is'));
        if (ap.skillDir)
            console.log('    skill plugin: ' + (skillGone ? 'unlinked (central kept)' : 'left as-is'));
        if (ap.codexPluginDir)
            console.log('    codex cache : ' + (codexCacheGone ? 'removed (central kept)' : 'left as-is'));
        if (ap.codexConfigToml)
            console.log('    codex config: ' + (codexActivation === 'removed' ? 'removed ' + CODEX_PLUGIN_TABLE : 'no managed entry'));
    }
    console.log('  central config : KEPT at ' + central.cfgDir + ' (delete by hand if you want it gone)');
    console.log('  central payloads: KEPT under ' + central.root + ' (delete by hand if you want them gone)');
}
function cmdStatus() {
    const agentsP = allAgentPaths();
    const dispatcherPresent = fs.existsSync(central.hookJs) && fs.existsSync(central.hookContractsJs);
    const inSync = dispatcherPresent &&
        sameFileContents(central.hookJs, repo.hookSourceJs) &&
        sameFileContents(central.hookContractsJs, repo.contractsSourceJs);
    const cfg = loadCentralConfig();
    console.log('[baseline] status');
    console.log('  install root   : ' + central.root);
    console.log('  dispatcher     : ' + (dispatcherPresent
        ? 'present' + (inSync ? ' (byte-identical to repo source)' : ' (DIFFERS from repo source — run install to refresh)')
        : 'not present'));
    console.log('  config folder  : ' + (cfg.present ? 'present at ' + central.cfgDir : 'missing (install will seed it)') +
        (configIsExternal ? ' [external; ' + central.cfgLink + ' → it]' : ''));
    const managerPresent = fs.existsSync(central.managerJs) && fs.existsSync(central.managerHookSourceJs) && fs.existsSync(central.managerContractsJs);
    console.log('  manager        : ' + (managerPresent ? 'present at ' + central.managerJs : 'not deployed (install will deploy it)'));
    const skillPresent = fs.existsSync(central.skillManifest) && fs.existsSync(central.skillMd);
    console.log('  claude skill   : ' + (skillPresent ? 'present at ' + central.skillDir : 'not deployed (install will deploy it)'));
    const codexPluginPresent = fs.existsSync(central.codexPluginManifest) && fs.existsSync(central.codexPluginSkillMd);
    console.log('  codex plugin   : ' + (codexPluginPresent ? 'present at ' + central.codexPluginDir : 'not deployed (install will deploy it)'));
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
        console.log('    contracts    : ' + describeLink(linkState(ap.hookContractsJs, central.hookContractsJs)));
        console.log('    cfg folder   : ' + describeLink(dirLinkState(ap.cfgDir, central.cfgLink, CONFIG_MARKER)));
        if (ap.skillDir)
            console.log('    skill plugin : ' + describeLink(dirLinkState(ap.skillDir, central.skillDir, SKILL_MARKER)));
        if (ap.codexPluginDir && ap.codexConfigToml) {
            const cache = dirLinkState(ap.codexPluginDir, central.codexPluginDir, CODEX_PLUGIN_MARKER);
            const activation = codexPluginActivationState(ap.codexConfigToml);
            console.log('    codex cache  : ' + describeLink(cache));
            console.log('    codex config : ' + (activation.ok ? 'OK (' + CODEX_PLUGIN_TABLE + ' in config.toml)' : activation.mechanism.toUpperCase() + ' (' + CODEX_PLUGIN_TABLE + ' absent)'));
        }
    }
}
// Build synthetic hook stdin for a route's event so verify can drive the wired
// dispatcher and confirm a route fires.
function synthInput(route, sessionId, cwd) {
    const { base, phase } = (0, contracts_1.parseEvent)(route.event);
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
async function cmdUpdate() {
    console.log('[baseline] update — redeploying dispatcher + re-syncing wiring from current config');
    console.log('');
    // Ensure the recorded set exists (D6): a legacy install with no record infers it from
    // the currently-wired agents and persists it, so the set is never silently lost. We
    // then run install with NO explicit agents, so cmdInstall's recorded path narrows the
    // set against detection GRACEFULLY (drop-with-notice + re-persist) rather than the
    // explicit --agents hard-fail (D1), which is reserved for user-supplied selections.
    if (!readRecordedAgents()) {
        const inferred = inferWiredAgentNames();
        if (inferred.length)
            writeRecordedAgents(inferred);
    }
    await cmdInstall({ preset: DEFAULT_PRESET, force: false });
}
// Inspect the installation and return a list of checks.
function doctorChecks() {
    const checks = [];
    const dispatcherPresent = fs.existsSync(central.hookJs) && fs.existsSync(central.hookContractsJs);
    if (!dispatcherPresent) {
        checks.push({ name: 'central dispatcher', level: 'fail', detail: 'not fully deployed under ' + central.hooksDir, fixable: true });
    }
    else {
        const inSync = sameFileContents(central.hookJs, repo.hookSourceJs) &&
            sameFileContents(central.hookContractsJs, repo.contractsSourceJs);
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
    // Installed manager artifacts used by self-contained control surfaces.
    const managerPresent = fs.existsSync(central.managerJs) && fs.existsSync(central.managerHookSourceJs) && fs.existsSync(central.managerContractsJs);
    if (!managerPresent) {
        checks.push({ name: 'installed manager', level: 'warn', detail: 'not fully deployed under ' + central.managerDir + ' (install will deploy it)', fixable: true });
    }
    else {
        let managerSync = false;
        try {
            managerSync = sameFileContents(central.managerJs, repo.managerSourceJs) &&
                sameFileContents(central.managerHookSourceJs, repo.hookSourceJs) &&
                sameFileContents(central.managerContractsJs, repo.contractsSourceJs);
        }
        catch (e) { }
        checks.push(managerSync
            ? { name: 'installed manager', level: 'ok', detail: 'installed manager artifacts present' }
            : { name: 'installed manager', level: 'warn', detail: 'installed manager artifacts differ from source (update will refresh)', fixable: true });
    }
    // Central Claude skill plugin payload.
    if (!fs.existsSync(central.skillManifest) || !fs.existsSync(central.skillMd)) {
        checks.push({ name: 'claude skill plugin', level: 'warn', detail: 'central payload not deployed at ' + central.skillDir + ' (install will deploy it)', fixable: true });
    }
    else if (fs.existsSync(repo.claudePluginManifest)) {
        let manifestSync = false;
        try {
            manifestSync = fs.readFileSync(central.skillManifest, 'utf8') === fs.readFileSync(repo.claudePluginManifest, 'utf8');
        }
        catch (e) { }
        let pathFresh = false;
        try {
            pathFresh = fs.readFileSync(central.skillMd, 'utf8').includes(central.managerJs);
        }
        catch (e) { }
        if (manifestSync && pathFresh) {
            checks.push({ name: 'claude skill plugin', level: 'ok', detail: 'central payload deployed; points at installed manager' });
        }
        else {
            checks.push({ name: 'claude skill plugin', level: 'warn', detail: (!manifestSync ? 'manifest differs from source' : 'installed manager path missing/stale') + ' (update will refresh)', fixable: true });
        }
    }
    else {
        checks.push({ name: 'claude skill plugin', level: 'ok', detail: 'central payload deployed' });
    }
    // Central Codex plugin payload.
    if (!fs.existsSync(central.codexPluginManifest) || !fs.existsSync(central.codexPluginSkillMd)) {
        checks.push({ name: 'codex plugin payload', level: 'warn', detail: 'central payload not deployed at ' + central.codexPluginDir + ' (install will deploy it)', fixable: true });
    }
    else if (fs.existsSync(repo.codexPluginManifest)) {
        let manifestSync = false;
        try {
            manifestSync = fs.readFileSync(central.codexPluginManifest, 'utf8') === fs.readFileSync(repo.codexPluginManifest, 'utf8');
        }
        catch (e) { }
        let pathFresh = false;
        try {
            const skill = fs.readFileSync(central.codexPluginSkillMd, 'utf8');
            pathFresh = skill.includes(central.managerJs) && skill.includes(CODEX_PLUGIN_TABLE);
        }
        catch (e) { }
        if (manifestSync && pathFresh) {
            checks.push({ name: 'codex plugin payload', level: 'ok', detail: 'central payload deployed; points at installed manager' });
        }
        else {
            checks.push({ name: 'codex plugin payload', level: 'warn', detail: (!manifestSync ? 'manifest differs from source' : 'installed manager/plugin activation path missing/stale') + ' (update will refresh)', fixable: true });
        }
    }
    else {
        checks.push({ name: 'codex plugin payload', level: 'ok', detail: 'central payload deployed' });
    }
    // Scope the per-agent checks to the recorded set (D6); fall back to inferred, then all.
    const scoped = new Set(scopedAgentNames());
    for (const ap of allAgentPaths().filter(ap => scoped.has(ap.name))) {
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
        const contracts = linkState(ap.hookContractsJs, central.hookContractsJs);
        if (contracts.ok && contracts.mechanism !== 'copy')
            checks.push({ name: 'contracts link', level: 'ok', detail: 'linked to center (' + contracts.mechanism + ')' });
        else if (contracts.ok)
            checks.push({ name: 'contracts link', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
        else
            checks.push({ name: 'contracts link', level: 'fail', detail: contracts.mechanism + ' — not linked to ' + central.hookContractsJs, fixable: true });
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
        if (ap.codexPluginDir && ap.codexConfigToml) {
            const pl = dirLinkState(ap.codexPluginDir, central.codexPluginDir, CODEX_PLUGIN_MARKER);
            if (pl.ok && pl.mechanism !== 'copy')
                checks.push({ name: 'codex plugin cache', level: 'ok', detail: ap.name + ' cache linked to center (' + pl.mechanism + ')' });
            else if (pl.ok)
                checks.push({ name: 'codex plugin cache', level: 'warn', detail: ap.name + ' degraded cache copy (install will relink)', fixable: true });
            else if (!fs.existsSync(central.codexPluginManifest))
                checks.push({ name: 'codex plugin cache', level: 'warn', detail: ap.name + ' central Codex plugin missing — install will deploy + cache it', fixable: true });
            else
                checks.push({ name: 'codex plugin cache', level: 'fail', detail: ap.name + ' ' + pl.mechanism + ' — not materialized at ' + ap.codexPluginDir, fixable: true });
            const act = codexPluginActivationState(ap.codexConfigToml);
            if (act.ok)
                checks.push({ name: 'codex plugin activation', level: 'ok', detail: ap.name + ' config.toml contains ' + CODEX_PLUGIN_TABLE });
            else
                checks.push({ name: 'codex plugin activation', level: 'fail', detail: ap.name + ' ' + act.mechanism + ' — config.toml must contain ' + CODEX_PLUGIN_TABLE, fixable: act.mechanism !== 'unreadable' });
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
async function cmdDoctor(fix) {
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
        await cmdUpdate();
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
    console.log('  node scripts/manage.js install [--preset <n>] [--agents <a,b>]  Deploy the dispatcher, seed the config preset, link agents, wire hook config.');
    console.log('  node scripts/manage.js verify                  Functionally test a wired route (does it fire?).');
    console.log('  node scripts/manage.js update                  Redeploy dispatcher + re-sync hook wiring from current config.');
    console.log('  node scripts/manage.js doctor [--fix]          Validate config + wiring and report health; --fix repairs it.');
    console.log('  node scripts/manage.js uninstall               Remove per-agent wiring + links (keeps the central config folder).');
    console.log('  node scripts/manage.js help                    Show this help.');
    console.log('');
    console.log('install options:');
    console.log('  --preset <minimal|default>   Which repo preset to seed when no config folder exists. Default: default.');
    console.log('  --force                      Replace an existing central config folder with the preset (DESTRUCTIVE — user edits lost).');
    console.log('  --agents <a,b>               Comma list of agents to wire (claude-code,codex). Each must be detected. Default: prompt on a TTY, else all detected.');
    console.log('');
    console.log('Agents are detected by config-dir existence; an install/update/uninstall scopes to the agents recorded in <install root>/state.json.');
    console.log('Native Zig runtime is paused for the routes feature; the dispatcher is Node-only in v1.');
    console.log('Installed manager artifacts are deployed under <install root>/scripts so generated control surfaces do not depend on the source checkout.');
    console.log('A Claude skills-dir plugin (baseline@skills-dir) is deployed + linked so Claude recognizes baseline; it carries no hooks.');
    console.log('A Codex plugin (' + CODEX_PLUGIN_KEY + ') is deployed under <install root>/codex-plugin/baseline, materialized at $CODEX_HOME/plugins/cache/' + CODEX_MARKETPLACE + '/' + CODEX_PLUGIN + '/' + CODEX_PLUGIN_VERSION + ', and activated by ' + CODEX_PLUGIN_TABLE + ' in config.toml.');
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
        else if (a === '--agents' || a === '-agents') {
            const val = argv[i + 1] || '';
            i++;
            if (!val)
                fail(cmd + ': --agents needs a comma-separated value (e.g. claude-code,codex).', 2);
            opts.agents = parseAgentList(val, cmd);
        }
        else if (a.startsWith('--agents=')) {
            opts.agents = parseAgentList(a.slice(a.indexOf('=') + 1), cmd);
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
        cmdInstall(parseInstallOpts(process.argv.slice(3))).catch((e) => fail('install: ' + e.message, 1));
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
        parseInstallOpts(process.argv.slice(3), 'update'); // reject native flags
        cmdUpdate().catch((e) => fail('update: ' + e.message, 1));
        break;
    case 'doctor':
        parseInstallOpts(process.argv.slice(3), 'doctor'); // reject native flags
        cmdDoctor(process.argv.slice(3).some(a => a === '--fix' || a === '-fix')).catch((e) => fail('doctor: ' + e.message, 1));
        break;
    default:
        console.log('[baseline] unknown command "' + cmd + '".');
        printHelp();
        process.exit(2);
}
