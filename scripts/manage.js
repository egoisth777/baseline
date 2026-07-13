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
//   and Codex local-marketplace payload (codex-marketplace/plugins/baseline/). The repo is the source of
//   truth; install always overwrites these from it.
// - The editable CONFIG folder (config.json + docs/) lives separately, wherever the
//   operator wants: BASELINE_CFG, else <install root>/cfg. <install root>/cfg is the
//   canonical path agents link to — a symlink to BASELINE_CFG when set, else a real
//   seeded folder. Config and artifacts never share a directory.
// - Each agent's config dir (Claude: CLAUDE_CONFIG_DIR or ~/.claude; Codex:
//   CODEX_HOME or ~/.codex) gets LINKS back into the center:
//   hooks/baseline-recital.js + hooks/contracts.js → install root; cfg/baseline → <install root>/cfg.
//   Claude also gets skills/baseline → <install root>/skills/baseline. Codex's
//   supported plugin CLI registers the manager-owned local marketplace and installs
//   baseline@baseline-local; Codex owns its resulting cache + config state.
//   Editing the config folder changes live behavior for every wired agent
//   (when the link layer can use a symlink; copy fallback is degraded).
// - Hook config and .baseline-counters.json stay REAL, per-agent files. Hook
//   wiring is config-driven: install wires our one dispatcher command into EXACTLY
//   the events the config's routes use, and unwires events no route references, so
//   the high-frequency PreToolUse/PostToolUse hooks never spawn for nothing.
// - The config folder is seeded from a repo PRESET (presets/<name>/) and is never
//   clobbered without --force. There is no legacy baseline.md migration — the
//   system is pre-release and install seeds the new model fresh.
// - Native Zig runtime (R-009): the repo-shipped prebuilt is the default hook hot
//   path when available; `--runtime build` compiles it from source first;
//   `--runtime prebuilt` explicitly selects the shipped prebuilt; `--runtime node`
//   forces the Node dispatcher. A platform with no shipped prebuilt falls back to
//   the Node dispatcher automatically.
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const child_process_1 = require("child_process");
const contracts_1 = require("./contracts");
// --- constants -------------------------------------------------------------
const CONFIG_KEYS = ['version', 'routes'];
const DEFAULT_PRESET = 'default';
const CODEX_MARKETPLACE = 'baseline-local';
const CODEX_PLUGIN = 'baseline';
const CODEX_PLUGIN_KEY = CODEX_PLUGIN + '@' + CODEX_MARKETPLACE;
const CODEX_MARKETPLACE_MANIFEST = path.join('.agents', 'plugins', 'marketplace.json');
// --- JSON machine surface (R-012) ------------------------------------------
// Global --json: every covered command (status, route list/add/remove, dispatch
// simulate) emits exactly ONE versioned JSON object on stdout and suppresses human
// console.log; errors become { apiVersion, error } on stdout with a nonzero exit. This
// is the whole programmatic surface — no Node library export, no daemon (decision #6).
const JSON_API_VERSION = 1;
const jsonMode = process.argv.slice(2).indexOf('--json') !== -1;
function emitJson(command, data) {
    process.stdout.write(JSON.stringify({ apiVersion: JSON_API_VERSION, command, data }) + '\n');
}
// Read a single --flag value from an arg list (supports "--flag value" and "--flag=value").
function flagValue(argv, name) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === name)
            return argv[i + 1];
        if (argv[i].indexOf(name + '=') === 0)
            return argv[i].slice(name.length + 1);
    }
    return undefined;
}
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
// Native Zig runtime (R-009). One shipped prebuilt per (platform, arch); a platform with
// none falls back to the Node dispatcher. The deployed binary keeps a fixed per-OS name so
// the wired command and status/uninstall can find it regardless of which target it came from.
function nativePrebuiltName() {
    if (process.platform === 'win32' && process.arch === 'x64')
        return 'baseline-recital-windows-x64.exe';
    if (process.platform === 'linux' && process.arch === 'x64')
        return 'baseline-recital-linux-x64';
    return null;
}
const nativeBinName = isWin ? 'baseline-recital.exe' : 'baseline-recital';
const central = {
    root: installRoot,
    hooksDir: path.join(installRoot, 'hooks'),
    hookJs: path.join(installRoot, 'hooks', 'baseline-recital.js'),
    hookBin: path.join(installRoot, 'hooks', nativeBinName), // native prebuilt when deployed
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
    installedBinDir: path.join(installRoot, 'bin'),
    // Claude skills-dir plugin payload (skill-only; no hooks). Linked into each
    // skill-capable agent's skills dir so Claude recognizes baseline + loads its skill.
    skillDir: path.join(installRoot, 'skills', 'baseline'),
    skillManifest: path.join(installRoot, 'skills', 'baseline', '.claude-plugin', 'plugin.json'),
    skillMd: path.join(installRoot, 'skills', 'baseline', 'SKILL.md'),
    // Manager-owned local marketplace. Codex's supported CLI registers this root,
    // then owns the installed cache/config derived from the payload below.
    codexMarketplaceRoot: path.join(installRoot, 'codex-marketplace'),
    codexMarketplaceManifest: path.join(installRoot, 'codex-marketplace', CODEX_MARKETPLACE_MANIFEST),
    codexPluginDir: path.join(installRoot, 'codex-marketplace', 'plugins', 'baseline'),
    codexPluginManifest: path.join(installRoot, 'codex-marketplace', 'plugins', 'baseline', '.codex-plugin', 'plugin.json'),
    codexPluginSkillMd: path.join(installRoot, 'codex-marketplace', 'plugins', 'baseline', 'skills', 'baseline', 'SKILL.md'),
};
const repo = {
    managerSourceJs: path.join(repoRoot, 'scripts', 'manage.js'),
    hookSourceJs: path.join(repoRoot, 'scripts', 'baseline-recital.js'),
    contractsSourceJs: path.join(repoRoot, 'scripts', 'contracts.js'),
    presetsDir: path.join(repoRoot, 'presets'),
    binDir: path.join(repoRoot, 'bin'),
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
// lifecycle state is owned by the Codex CLI under that agent's CODEX_HOME.
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
        hookBin: path.join(d, 'hooks', nativeBinName),
        hookContractsJs: path.join(d, 'hooks', 'contracts.js'),
        cfgDir: path.join(d, 'cfg', 'baseline'),
        skillDir: agent.skillPlugin ? path.join(d, 'skills', 'baseline') : null,
        codexPlugin: agent.codexPlugin,
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
function fail(message, code, jsonCode) {
    if (jsonMode) {
        process.stdout.write(JSON.stringify({ apiVersion: JSON_API_VERSION, error: { code: jsonCode || 'error', message } }) + '\n');
    }
    else {
        console.error('[baseline] ' + message);
    }
    process.exit(code || 1);
}
// Render hook commands for the shell each agent uses on this platform. PowerShell
// needs the call operator before a quoted executable; single-quoted literals keep
// paths literal in both shells (with their respective apostrophe escapes).
function quoteArg(s) {
    const value = String(s);
    return isWin
        ? "'" + value.replace(/'/g, "''") + "'"
        : "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
function renderHookCommand(args) {
    return (isWin ? '& ' : '') + args.map(quoteArg).join(' ');
}
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
// Deploy the native prebuilt into the center, making it executable on POSIX (the shipped
// bit is not preserved through a copy). Windows keys execution off the .exe extension.
function deployNativeBinary(src, dest) {
    copyFileAtomic(src, dest);
    if (!isWin) {
        try {
            fs.chmodSync(dest, 0o755);
        }
        catch (e) { /* best effort */ }
    }
}
function removeCentralNative() {
    try {
        fs.rmSync(central.hookBin, { force: true });
    }
    catch (e) { /* absent */ }
}
// --runtime build: compile the native binary from source via the platform build script,
// which refreshes bin/. Requires a source checkout + zig 0.16 on PATH; a hard error otherwise.
function buildNativeFromSource() {
    const script = isWin ? path.join(repoRoot, 'build.ps1') : path.join(repoRoot, 'build.sh');
    if (!fs.existsSync(script)) {
        fail('install: --runtime build needs ' + script + ' (run it from a source checkout).', 1);
    }
    const r = isWin
        ? (0, child_process_1.spawnSync)('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: repoRoot, encoding: 'utf8' })
        : (0, child_process_1.spawnSync)('bash', [script], { cwd: repoRoot, encoding: 'utf8' });
    if (r.error || r.status !== 0) {
        fail('install: --runtime build failed to compile the native binary (' +
            (r.error ? r.error.message : 'exit ' + r.status) + '). Is zig 0.16 on PATH?', 1);
    }
}
function deployRepoNativePrebuilt(prebuiltName, repoPrebuilt) {
    const fallback = (reason) => {
        console.log('[baseline] ' + reason + '; using the Node dispatcher.');
        return { useNative: false, runtimeLabel: 'node js', removeNative: true };
    };
    if (!prebuiltName || !repoPrebuilt) {
        return fallback('no native prebuilt for ' + process.platform + '-' + process.arch);
    }
    if (!fs.existsSync(repoPrebuilt)) {
        return fallback('native prebuilt ' + prebuiltName + ' not found under ' + path.dirname(repoPrebuilt));
    }
    try {
        fs.mkdirSync(central.hooksDir, { recursive: true });
        deployNativeBinary(repoPrebuilt, central.hookBin);
        return { useNative: true, runtimeLabel: 'native (prebuilt ' + prebuiltName + ')', removeNative: false };
    }
    catch (e) {
        return fallback('failed to deploy native prebuilt ' + prebuiltName + ' (' + (e && e.message ? e.message : String(e)) + ')');
    }
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
    const clean = (value) => isWin && value.indexOf('\\\\?\\') === 0 ? value.slice(4) : value;
    const aa = path.resolve(clean(a));
    const bb = path.resolve(clean(b));
    return isWin ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// Ownership is reported by Codex after its own path resolution, which may
// canonicalize a manager root reached through a symlink or Windows junction.
// If either path cannot be resolved (for example, a removed payload), retain
// the lexical comparison so absence never becomes ownership.
function sameCanonicalPath(a, b) {
    try {
        return samePath(fs.realpathSync(a), fs.realpathSync(b));
    }
    catch (e) {
        return samePath(a, b);
    }
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
        if (!samePath(abs, target))
            return { ok: false, mechanism: 'wrong' };
        // existsSync follows symlinks: false for a right-target link means the central
        // target file was deleted (e.g. the whole install root) — the link is dangling.
        if (!fs.existsSync(linkPath))
            return { ok: false, mechanism: 'dangling' };
        return { ok: true, mechanism: 'symlink' };
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
    return s.mechanism.toUpperCase() + (s.mechanism === 'dangling' ? ' (target missing)' : '');
}
function nativeBinaryState(file) {
    let st;
    try {
        st = fs.statSync(file);
    }
    catch (e) {
        if (e && e.code === 'ENOENT')
            return { ok: false, detail: 'missing at ' + file };
        return { ok: false, detail: 'unreadable at ' + file + ' (' + e.message + ')' };
    }
    if (!st.isFile())
        return { ok: false, detail: 'not a file at ' + file };
    if (st.size === 0)
        return { ok: false, detail: 'empty file at ' + file };
    if (!isWin && (st.mode & 0o111) === 0)
        return { ok: false, detail: 'not executable at ' + file };
    return { ok: true, detail: 'present at ' + file };
}
function nativeRuntimeFaults(ap) {
    const faults = [];
    const centralBin = nativeBinaryState(central.hookBin);
    const nativeLink = linkState(ap.hookBin, central.hookBin);
    const agentBin = nativeBinaryState(ap.hookBin);
    if (!centralBin.ok)
        faults.push('central native binary ' + centralBin.detail);
    if (!nativeLink.ok)
        faults.push('native link ' + describeLink(nativeLink) + ' at ' + ap.hookBin);
    if (!agentBin.ok)
        faults.push('agent native binary ' + agentBin.detail);
    return faults;
}
function describeNativeRuntime(ap) {
    const faults = nativeRuntimeFaults(ap);
    if (!faults.length)
        return describeLink(linkState(ap.hookBin, central.hookBin)) + '; central ' + central.hookBin;
    return 'UNHEALTHY — ' + faults.join('; ');
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
        if (!samePath(abs, target))
            return { ok: false, mechanism: 'wrong' };
        // existsSync follows symlinks: false means the central target dir was deleted.
        if (!fs.existsSync(linkPath))
            return { ok: false, mechanism: 'dangling' };
        return { ok: true, mechanism: 'symlink' };
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
// --- Codex plugin lifecycle (supported CLI) --------------------------------
// `cmd.exe` needs a command string to launch npm's .cmd/.bat shims. Keep its
// parser from splitting paths or interpreting manager-controlled values as
// syntax. Native Windows executables are never sent through CMD.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
function escapeCmdArgument(value) {
    let escaped = String(value)
        .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
        .replace(/(?=(\\+?)?)\1$/, '$1$1');
    escaped = ('"' + escaped + '"').replace(CMD_META_CHARS, '^$1');
    return escaped.replace(CMD_META_CHARS, '^$1');
}
function renderCmdPluginCommand(cli, argv) {
    // A .cmd/.bat shim expands %*, so its arguments need a second layer of CMD
    // escaping. This renderer is called only after resolution identifies a shim.
    return '"' + [cli.replace(CMD_META_CHARS, '^$1')]
        .concat(argv.map(escapeCmdArgument))
        .join(' ') + '"';
}
function executablePath(candidate) {
    try {
        if (!fs.statSync(candidate).isFile())
            return null;
        if (!isWin)
            fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
    }
    catch (e) {
        return null;
    }
}
function windowsExecutableCandidates(candidate) {
    if (!isWin || path.extname(candidate))
        return [candidate];
    const configured = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    const extensions = configured.split(';').filter(Boolean);
    return extensions.map(extension => candidate + extension).concat(candidate);
}
function executablePathEnvironment() {
    const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH');
    return key ? process.env[key] || '' : '';
}
// Resolve before spawning so absence is independent of cmd.exe diagnostics
// (which are localized on Windows) and launch semantics use the actual target,
// not a textual alias such as `codex`.
function resolveCodexExecutable(configured) {
    const explicit = path.isAbsolute(configured) || /[\\/]/.test(configured);
    const pathBases = executablePathEnvironment().split(path.delimiter).map(segment => {
        const directory = segment.replace(/^"(.*)"$/, '$1');
        return path.resolve(directory || '.', configured);
    });
    // Windows bare-command lookup checks the parent working directory before
    // PATH. Preserve that behavior while still resolving PATHEXT ourselves.
    const bases = explicit
        ? [path.resolve(configured)]
        : (isWin ? [path.resolve(configured)].concat(pathBases) : pathBases);
    for (const base of bases) {
        for (const candidate of windowsExecutableCandidates(base)) {
            const resolved = executablePath(candidate);
            if (resolved)
                return resolved;
        }
    }
    return null;
}
function runCodexPluginCli(ap, args) {
    const argv = ['plugin'].concat(args, ['--json']);
    const override = process.env.BASELINE_CODEX_CLI;
    const configuredCli = override || 'codex';
    const resolvedCli = resolveCodexExecutable(configuredCli);
    if (!resolvedCli) {
        return {
            available: false,
            ok: false,
            data: null,
            detail: override
                ? 'configured Codex CLI not found at ' + override
                : '`codex` executable not found on PATH',
        };
    }
    const spawnOpts = {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CODEX_HOME: ap.configDir }),
        windowsHide: true,
    };
    const isCmdShim = isWin && /\.(cmd|bat)$/i.test(resolvedCli);
    const result = isCmdShim
        ? (0, child_process_1.spawnSync)(process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', ['/d', '/v:off', '/s', '/c', renderCmdPluginCommand(resolvedCli, argv)], Object.assign({}, spawnOpts, { windowsVerbatimArguments: true }))
        : (0, child_process_1.spawnSync)(resolvedCli, argv, spawnOpts);
    if (result.error) {
        const unavailable = 'code' in result.error && result.error.code === 'ENOENT';
        return {
            available: !unavailable,
            ok: false,
            data: null,
            detail: unavailable ? '`codex` executable not found on PATH' : result.error.message,
        };
    }
    if (result.status !== 0) {
        const output = result.stderr || result.stdout;
        return {
            available: true,
            ok: false,
            data: null,
            detail: (output || '').trim() || 'codex plugin command exited ' + result.status,
        };
    }
    try {
        return { available: true, ok: true, data: JSON.parse((result.stdout || '').trim()), detail: '' };
    }
    catch (e) {
        return { available: true, ok: false, data: null, detail: 'invalid JSON from codex plugin CLI: ' + e.message };
    }
}
function isCodexMarketplaceListEntry(value) {
    return isRecord(value) && typeof value.name === 'string' && typeof value.root === 'string';
}
function isCodexPluginListEntry(value) {
    return isRecord(value) &&
        typeof value.pluginId === 'string' &&
        (value.enabled === undefined || typeof value.enabled === 'boolean') &&
        (value.version === undefined || typeof value.version === 'string') &&
        isRecord(value.source) && typeof value.source.path === 'string';
}
function codexMarketplaceEntries(data) {
    if (!isRecord(data) || !Array.isArray(data.marketplaces))
        return null;
    return data.marketplaces.every(isCodexMarketplaceListEntry) ? data.marketplaces : null;
}
function codexPluginEntries(data) {
    if (!isRecord(data) || !Array.isArray(data.installed))
        return null;
    return data.installed.every(isCodexPluginListEntry) ? data.installed : null;
}
function codexPluginInspection(ap) {
    const unavailable = { ok: false, mechanism: 'unavailable' };
    const markets = runCodexPluginCli(ap, ['marketplace', 'list']);
    if (!markets.available) {
        return { marketplace: unavailable, plugin: unavailable, version: null, installedPath: null, detail: markets.detail };
    }
    if (!markets.ok) {
        const unreadable = { ok: false, mechanism: 'unreadable' };
        return { marketplace: unreadable, plugin: unreadable, version: null, installedPath: null, detail: markets.detail };
    }
    const entries = codexMarketplaceEntries(markets.data);
    if (!entries) {
        const unreadable = { ok: false, mechanism: 'unreadable' };
        return { marketplace: unreadable, plugin: unreadable, version: null, installedPath: null, detail: 'invalid marketplace list JSON shape' };
    }
    const marketplace = entries.find(entry => entry.name === CODEX_MARKETPLACE);
    if (!marketplace) {
        return {
            marketplace: { ok: false, mechanism: 'missing' },
            plugin: { ok: false, mechanism: 'missing' },
            version: null, installedPath: null, detail: null,
        };
    }
    const marketplaceRoot = marketplace.root;
    if (!sameCanonicalPath(marketplaceRoot, central.codexMarketplaceRoot)) {
        const foreign = { ok: false, mechanism: 'foreign' };
        return {
            marketplace: foreign, plugin: foreign, version: null, installedPath: null,
            detail: CODEX_MARKETPLACE + ' is registered at ' + String(marketplaceRoot) + ', not ' + central.codexMarketplaceRoot,
        };
    }
    const plugins = runCodexPluginCli(ap, ['list']);
    if (!plugins.ok) {
        const state = { ok: false, mechanism: plugins.available ? 'unreadable' : 'unavailable' };
        return { marketplace: { ok: true, mechanism: 'registered' }, plugin: state, version: null, installedPath: null, detail: plugins.detail };
    }
    const installed = codexPluginEntries(plugins.data);
    if (!installed) {
        return {
            marketplace: { ok: true, mechanism: 'registered' },
            plugin: { ok: false, mechanism: 'unreadable' },
            version: null,
            installedPath: null,
            detail: 'invalid plugin list JSON shape',
        };
    }
    const plugin = installed.find(entry => entry.pluginId === CODEX_PLUGIN_KEY);
    if (!plugin) {
        return {
            marketplace: { ok: true, mechanism: 'registered' },
            plugin: { ok: false, mechanism: 'missing' },
            version: null, installedPath: null, detail: null,
        };
    }
    const pluginSource = plugin.source.path;
    if (!pluginSource || !sameCanonicalPath(pluginSource, central.codexPluginDir)) {
        return {
            marketplace: { ok: true, mechanism: 'registered' },
            plugin: { ok: false, mechanism: 'foreign' },
            version: plugin.version === undefined ? null : plugin.version,
            installedPath: null,
            detail: CODEX_PLUGIN_KEY + ' resolves to ' + String(pluginSource) + ', not ' + central.codexPluginDir,
        };
    }
    return {
        marketplace: { ok: true, mechanism: 'registered' },
        plugin: { ok: plugin.enabled !== false, mechanism: plugin.enabled === false ? 'disabled' : 'installed' },
        version: plugin.version === undefined ? null : plugin.version,
        installedPath: null,
        detail: null,
    };
}
function ensureCodexPluginForAgent(ap) {
    if (!ap.codexPlugin)
        return null;
    const before = codexPluginInspection(ap);
    if (before.marketplace.mechanism === 'unavailable') {
        return { marketplace: 'unavailable', plugin: 'unavailable', version: null };
    }
    if (before.marketplace.mechanism === 'foreign') {
        throw new Error(before.detail || ('refusing to replace foreign Codex marketplace ' + CODEX_MARKETPLACE));
    }
    if (before.marketplace.mechanism === 'unreadable') {
        throw new Error('cannot inspect Codex marketplaces: ' + before.detail);
    }
    let marketplace = 'present';
    if (!before.marketplace.ok) {
        const added = runCodexPluginCli(ap, ['marketplace', 'add', central.codexMarketplaceRoot]);
        if (!added.ok)
            throw new Error('cannot register Codex marketplace: ' + added.detail);
        marketplace = isRecord(added.data) && added.data.alreadyAdded === true ? 'present' : 'added';
    }
    const installed = runCodexPluginCli(ap, ['add', CODEX_PLUGIN_KEY]);
    if (!installed.ok)
        throw new Error('cannot install Codex plugin ' + CODEX_PLUGIN_KEY + ': ' + installed.detail);
    return {
        marketplace,
        plugin: 'installed',
        version: isRecord(installed.data) && typeof installed.data.version === 'string' ? installed.data.version : null,
    };
}
function uninstallCodexPluginForAgent(ap) {
    if (!ap.codexPlugin)
        return null;
    const state = codexPluginInspection(ap);
    if (state.marketplace.mechanism === 'unavailable')
        return { marketplace: 'unavailable', plugin: 'left as-is' };
    if (state.marketplace.mechanism === 'foreign')
        return { marketplace: 'foreign — left as-is', plugin: 'left as-is' };
    if (state.marketplace.mechanism === 'missing')
        return { marketplace: 'absent', plugin: 'absent' };
    if (!state.marketplace.ok) {
        return {
            marketplace: state.marketplace.mechanism + ' — left as-is',
            plugin: state.plugin.mechanism + ' — left as-is',
        };
    }
    let plugin = 'absent';
    if (state.plugin.mechanism === 'installed' || state.plugin.mechanism === 'disabled') {
        const removed = runCodexPluginCli(ap, ['remove', CODEX_PLUGIN_KEY]);
        if (!removed.ok)
            throw new Error('cannot remove Codex plugin ' + CODEX_PLUGIN_KEY + ': ' + removed.detail);
        plugin = 'removed';
    }
    else if (state.plugin.mechanism !== 'missing') {
        return {
            marketplace: 'owned — kept because plugin is ' + state.plugin.mechanism,
            plugin: state.plugin.mechanism + ' — left as-is',
        };
    }
    const removedMarketplace = runCodexPluginCli(ap, ['marketplace', 'remove', CODEX_MARKETPLACE]);
    if (!removedMarketplace.ok)
        throw new Error('cannot remove Codex marketplace ' + CODEX_MARKETPLACE + ': ' + removedMarketplace.detail);
    return { marketplace: 'removed', plugin };
}
// --- hook command rendering + parsing -------------------------------------
function hookCommand(ap, argv) {
    return ap.name === 'claude-code'
        ? { command: argv[0], args: argv.slice(1) }
        : { command: renderHookCommand(argv) };
}
// Claude supports shell-free command+args entries. Codex command strings are
// rendered for its platform shell (PowerShell on Windows, sh on POSIX).
function jsCommand(ap) {
    return hookCommand(ap, [process.execPath, ap.hookJs, '--agent-config', ap.configDir]);
}
function nativeCommand(ap) {
    return hookCommand(ap, [ap.hookBin, '--agent-config', ap.configDir]);
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
            if (isWin && quote === "'" && ch === "'" && command[i + 1] === "'") {
                cur += "'";
                i++;
            }
            else if (quote === '"' && ch === '\\' && i + 1 < command.length && command[i + 1] === quote) {
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
    if (isWin && args[0] === '&')
        args.shift();
    return args.length ? args : null;
}
function commandArgv(hook) {
    return hook.args === undefined ? parseCommandLine(hook.command) : [hook.command].concat(hook.args);
}
function commandRuntime(hook, ap) {
    const argv = commandArgv(hook);
    if (!argv)
        return null;
    if (samePath(argv[0], ap.hookBin))
        return 'native';
    if (argv.length >= 2 && samePath(argv[1], ap.hookJs))
        return 'node';
    return null;
}
function isCanonicalCommand(hook, ap, runtime) {
    const expected = runtime === 'native' ? nativeCommand(ap) : jsCommand(ap);
    return hook.command === expected.command &&
        JSON.stringify(hook.args) === JSON.stringify(expected.args);
}
// A settings command is ours when it runs this agent's deployed dispatcher — either the
// native binary directly (argv[0]) or Node running the .js (argv[1]). Recognizing both
// keeps unwire/update/status runtime-agnostic across a native<->node switch.
function isOurCommand(hook, ap) {
    return isCommandHook(hook) && commandRuntime(hook, ap) !== null;
}
function isCommandHook(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
        'command' in value && typeof value.command === 'string' &&
        (!('args' in value) || (Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string')));
}
function eventHookGroups(settings, event) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !('hooks' in settings))
        return null;
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
        return null;
    return hooks[event];
}
function commandHooksInGroups(groups) {
    const out = [];
    if (!Array.isArray(groups))
        return out;
    for (const group of groups) {
        if (!group || typeof group !== 'object' || Array.isArray(group) || !('hooks' in group))
            continue;
        const hooks = group.hooks;
        if (!Array.isArray(hooks))
            continue;
        for (const hook of hooks) {
            if (isCommandHook(hook))
                out.push(hook);
        }
    }
    return out;
}
// --- hook config surgery (config-driven, across all events) -----------------
function findOurHookInGroups(groups, ap) {
    for (const hook of commandHooksInGroups(groups)) {
        if (isOurCommand(hook, ap))
            return hook;
    }
    return null;
}
function findOurCommand(settings, ap) {
    for (const event of contracts_1.SUPPORTED_EVENTS) {
        const h = findOurHookInGroups(eventHookGroups(settings, event), ap);
        if (h)
            return h;
    }
    return null;
}
function wiredHooks(settings, ap) {
    const out = [];
    for (const event of contracts_1.SUPPORTED_EVENTS) {
        for (const hook of commandHooksInGroups(eventHookGroups(settings, event))) {
            const runtime = commandRuntime(hook, ap);
            if (runtime)
                out.push({ event, hook, runtime });
        }
    }
    return out;
}
function eventsForRuntime(hooks, runtime) {
    const out = [];
    for (const h of hooks) {
        if (h.runtime === runtime && out.indexOf(h.event) === -1)
            out.push(h.event);
    }
    return out;
}
// Which supported events currently carry our hook.
function wiredEvents(settings, ap) {
    const out = [];
    for (const h of wiredHooks(settings, ap)) {
        if (out.indexOf(h.event) === -1)
            out.push(h.event);
    }
    return out;
}
function noncanonicalEvents(hooks, ap) {
    const out = [];
    for (const h of hooks) {
        if (!isCanonicalCommand(h.hook, ap, h.runtime) && out.indexOf(h.event) === -1)
            out.push(h.event);
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
                group.hooks = group.hooks.filter((h) => !isOurCommand(h, ap));
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
            const entry = {
                type: 'command', command: command.command, args: command.args,
                timeout: 5, statusMessage: 'Baseline check...'
            };
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
    for (const key of Object.keys(cfg)) {
        if (CONFIG_KEYS.indexOf(key) === -1)
            report.issues.push({ level: 'warn', msg: 'config.json has unrecognized key "' + key + '"' });
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
        if (!(0, contracts_1.isSupportedRouteEvent)(r.event)) {
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
            if (contracts_1.ROUTE_KEYS.indexOf(key) === -1)
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
// shared contracts, manifests, presets, and shipped native prebuilts. When the
// manager is run from the install root these paths are already identical, so this
// is a no-op.
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
    if (fs.existsSync(repo.binDir))
        copyDir(repo.binDir, central.installedBinDir);
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
        '  user-configurable injection routes in the baseline config folder — config.json +',
        '  docs/, at BASELINE_CFG, else <install root>/cfg (default install root ~/.baseline). Use when the user asks to view,',
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
        "Install root: `BASELINE_HOME`, else the installed manager's own root, else `~/.baseline`. This install resolved it to:",
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
        'Codex plugin lifecycle managed by `install`/`update` through the supported CLI:',
        '',
        '    marketplace: ' + central.codexMarketplaceRoot,
        '    selector: ' + CODEX_PLUGIN_KEY,
        '    Codex owns its cache and config entries; do not edit them by hand.',
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
function isJsonRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function parseCodexPluginManifest(text) {
    const manifest = JSON.parse(text);
    if (!isJsonRecord(manifest)) {
        throw new Error('Codex plugin manifest needs a non-empty version.');
    }
    return manifest;
}
// The cachebuster version changes whenever cache-relevant manifest or
// control-surface content changes. Provenance-only source-checkout text is
// rendered for refresh guidance but normalized out, so it never changes the version.
function expectedCodexPluginVersion(manifest, sourceText, generatedSkill, sourceCheckoutPath) {
    const sourceVersion = manifest.version;
    if (typeof sourceVersion !== 'string' || !sourceVersion) {
        throw new Error('Codex plugin manifest needs a non-empty version.');
    }
    const provenance = '\n    ' + sourceCheckoutPath + '\n\nIf you need to refresh from a different checkout, run that checkout\'s';
    const canonicalProvenance = '\n    <source-checkout>\n\nIf you need to refresh from a different checkout, run that checkout\'s';
    if (!generatedSkill.includes(provenance)) {
        throw new Error('generated Codex skill is missing source-checkout provenance.');
    }
    const cachebusterSkill = generatedSkill.replace(provenance, canonicalProvenance);
    const digest = crypto.createHash('sha256').update(sourceText).update('\0').update(cachebusterSkill).digest('hex').slice(0, 12);
    return sourceVersion.split('+')[0] + '+codex.local-' + digest;
}
// A self-contained installed manager has repoRoot === installRoot, but preserve
// the source-checkout provenance written by the original source deployment when
// it later refreshes the payload. Source checkouts always record their own root.
function codexSkillSourceCheckoutPath() {
    if (!samePath(repoRoot, installRoot) || fs.existsSync(path.join(repoRoot, 'src', 'manage.ts'))) {
        return repoRoot;
    }
    try {
        const skill = fs.readFileSync(central.codexPluginSkillMd, 'utf8');
        const marker = 'Source checkout recorded for provenance/source refresh only:\n\n    ';
        const start = skill.indexOf(marker);
        if (start === -1)
            return repoRoot;
        const pathStart = start + marker.length;
        const pathEnd = skill.indexOf('\n', pathStart);
        const recordedPath = skill.slice(pathStart, pathEnd === -1 ? undefined : pathEnd);
        if (recordedPath)
            return recordedPath;
    }
    catch (e) { }
    return repoRoot;
}
function readExpectedCodexPluginPayload() {
    if (!fs.existsSync(repo.codexPluginManifest)) {
        throw new Error('Codex plugin manifest missing at ' + repo.codexPluginManifest + ' — cannot deploy the Codex plugin.');
    }
    const sourceText = fs.readFileSync(repo.codexPluginManifest, 'utf8');
    const manifest = parseCodexPluginManifest(sourceText);
    const sourceCheckoutPath = codexSkillSourceCheckoutPath();
    const generatedSkill = installedControlSurfaceSkill('Codex', sourceCheckoutPath);
    return {
        manifest,
        generatedSkill,
        version: expectedCodexPluginVersion(manifest, sourceText, generatedSkill, sourceCheckoutPath),
    };
}
function centralCodexPluginPayloadStatus() {
    const present = fs.existsSync(central.codexMarketplaceManifest) &&
        fs.existsSync(central.codexPluginManifest) && fs.existsSync(central.codexPluginSkillMd);
    let expectedVersion = null;
    try {
        expectedVersion = readExpectedCodexPluginPayload().version;
    }
    catch (e) { }
    let version = null;
    try {
        const manifest = parseCodexPluginManifest(fs.readFileSync(central.codexPluginManifest, 'utf8'));
        version = typeof manifest.version === 'string' ? manifest.version : null;
    }
    catch (e) { }
    return {
        present,
        version,
        expectedVersion,
        stale: present && expectedVersion !== null && version !== expectedVersion,
    };
}
function codexPluginVersionIsStale(plugin, expectedVersion) {
    return plugin.plugin.ok && expectedVersion !== null && plugin.version !== expectedVersion;
}
// Deploy the central Codex local marketplace + plugin payload. The deployed
// manifest gets a deterministic content-derived cachebuster, while the source
// manifest remains byte-for-byte untouched. Identical payloads therefore keep the
// same version; cache-relevant manifest/control-surface content changes force a new
// cache version through the supported CLI, while provenance-only source-checkout text
// is normalized out and does not.
function ensureCentralCodexPlugin() {
    const payload = readExpectedCodexPluginPayload();
    const manifest = payload.manifest;
    manifest.version = payload.version;
    const interfaceMetadata = manifest.interface;
    const category = isJsonRecord(interfaceMetadata) && typeof interfaceMetadata.category === 'string'
        ? interfaceMetadata.category
        : 'Productivity';
    atomicWrite(central.codexPluginManifest, JSON.stringify(manifest, null, 2) + '\n');
    atomicWrite(central.codexPluginSkillMd, payload.generatedSkill);
    atomicWrite(central.codexMarketplaceManifest, JSON.stringify({
        name: CODEX_MARKETPLACE,
        interface: { displayName: 'baseline local' },
        plugins: [{
                name: CODEX_PLUGIN,
                source: { source: 'local', path: './plugins/' + CODEX_PLUGIN },
                policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
                category,
            }],
    }, null, 2) + '\n');
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
    // 2c. Native runtime selection (R-009, decision #18). Plain install/update prefers
    // the repo-shipped prebuilt as the hook hot path; --runtime prebuilt makes that
    // choice explicit, --runtime build refreshes bin/ first, and --runtime node forces
    // the Node dispatcher. Missing/deploy-failed prebuilts fail open to Node.
    const prebuiltName = nativePrebuiltName();
    const repoPrebuilt = prebuiltName ? path.join(repo.binDir, prebuiltName) : null;
    let useNative = false;
    let runtimeLabel = 'node js';
    let removeNative = false;
    if (opts.runtime === 'node') {
        removeNative = true; // explicit downgrade to Node after per-agent native links are unwired
    }
    else {
        if (opts.runtime === 'build') {
            buildNativeFromSource();
            if (fs.existsSync(repo.binDir))
                copyDir(repo.binDir, central.installedBinDir);
        }
        const native = deployRepoNativePrebuilt(prebuiltName, repoPrebuilt);
        useNative = native.useNative;
        runtimeLabel = native.runtimeLabel;
        removeNative = native.removeNative;
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
    // events. Codex is registered and installed through its supported plugin CLI.
    const perAgent = [];
    for (const ap of agentsP) {
        const jsMech = linkInto(central.hookJs, ap.hookJs);
        const contractsMech = linkInto(central.hookContractsJs, ap.hookContractsJs);
        // Native binary: link it in when active (the wired hot path), unlink our copy otherwise.
        const binMech = useNative ? linkInto(central.hookBin, ap.hookBin) : (removeOurLink(ap.hookBin, central.hookBin) ? 'removed' : null);
        const cfgMech = linkDirInto(central.cfgLink, ap.cfgDir, CONFIG_MARKER);
        const skillMech = ap.skillDir ? linkDirInto(central.skillDir, ap.skillDir, SKILL_MARKER) : null;
        const codexPlugin = ensureCodexPluginForAgent(ap);
        const command = useNative ? nativeCommand(ap) : jsCommand(ap);
        const sync = syncWiring(ap, command, cfg.desiredEvents);
        perAgent.push({ name: ap.name, configDir: ap.configDir, jsMech, contractsMech, binMech, cfgMech, skillMech, codexPlugin, sync });
    }
    if (removeNative)
        removeCentralNative();
    console.log('[baseline] install complete');
    console.log('  install root  : ' + central.root);
    console.log('  runtime       : ' + runtimeLabel);
    console.log('  manager       : ' + central.managerJs);
    console.log('  dispatcher    : ' + central.hookJs);
    console.log('  config folder : ' + central.cfgDir + ' (' + configState + ', preset: ' + opts.preset + ')' +
        (configIsExternal ? ' [external; ' + central.cfgLink + ' (' + cfgLocMech + ') links to it]' : ''));
    console.log('  claude skill  : ' + central.skillDir + ' (baseline@skills-dir; no hooks)');
    console.log('  codex plugin  : ' + central.codexPluginDir + ' (' + CODEX_PLUGIN_KEY + ' via ' + central.codexMarketplaceRoot + ')');
    console.log('  routes        : ' + cfg.routes.length + (cfg.desiredEvents.length ? ' over [' + cfg.desiredEvents.join(', ') + ']' : ' (no events wired)'));
    if (cfg.fatal)
        console.log('  config WARNING: ' + cfg.fatal + ' — run doctor');
    for (const a of perAgent) {
        console.log('  agent ' + a.name + ' @ ' + a.configDir);
        console.log('    links       : dispatcher=' + a.jsMech + ', contracts=' + a.contractsMech + (a.binMech && a.binMech !== 'removed' ? ', native=' + a.binMech : '') + ', cfg=' + a.cfgMech + (a.skillMech ? ', skill=' + a.skillMech : '') +
            (a.codexPlugin ? ', codex-marketplace=' + a.codexPlugin.marketplace + ', codex-plugin=' + a.codexPlugin.plugin + (a.codexPlugin.version ? '@' + a.codexPlugin.version : '') : ''));
        if (a.codexPlugin && a.codexPlugin.plugin === 'unavailable') {
            console.log('    codex NOTICE: `codex` CLI unavailable; hooks are wired but the Codex control surface was not installed');
        }
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
        const binGone = removeOurLink(ap.hookBin, central.hookBin);
        const contractsGone = removeOurLink(ap.hookContractsJs, central.hookContractsJs);
        const cfgGone = removeOurDirLink(ap.cfgDir, central.cfgLink, CONFIG_MARKER);
        const skillGone = ap.skillDir ? removeOurDirLink(ap.skillDir, central.skillDir, SKILL_MARKER) : false;
        let codexLifecycle = null;
        try {
            codexLifecycle = uninstallCodexPluginForAgent(ap);
        }
        catch (e) {
            fail('uninstall: ' + e.message, 1);
        }
        console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
        console.log('    ' + ap.settingsLabel.padEnd(12) + ': ' + (unwired.length ? 'unwired ' + unwired.join(', ') : 'nothing wired'));
        console.log('    dispatcher  : ' + (jsGone ? 'unlinked' : 'absent'));
        if (binGone)
            console.log('    native      : unlinked');
        console.log('    contracts   : ' + (contractsGone ? 'unlinked' : 'absent'));
        console.log('    cfg folder  : ' + (cfgGone ? 'unlinked (central kept)' : 'left as-is'));
        if (ap.skillDir)
            console.log('    skill plugin: ' + (skillGone ? 'unlinked (central kept)' : 'left as-is'));
        if (codexLifecycle) {
            console.log('    codex plugin: ' + codexLifecycle.plugin);
            console.log('    marketplace : ' + codexLifecycle.marketplace);
        }
    }
    console.log('  central config : KEPT at ' + central.cfgDir + ' (delete by hand if you want it gone)');
    console.log('  central payloads: KEPT under ' + central.root + ' (delete by hand if you want them gone)');
}
// Structured mirror of `status` for the --json surface: the same facts the human view
// prints, shaped for machines. Link fields carry the { ok, mechanism } LinkState.
function collectStatusData() {
    const dispatcherPresent = fs.existsSync(central.hookJs) && fs.existsSync(central.hookContractsJs);
    const inSync = dispatcherPresent &&
        sameFileContents(central.hookJs, repo.hookSourceJs) &&
        sameFileContents(central.hookContractsJs, repo.contractsSourceJs);
    const cfg = loadCentralConfig();
    const managerPresent = fs.existsSync(central.managerJs) && fs.existsSync(central.managerHookSourceJs) && fs.existsSync(central.managerContractsJs);
    const skillPresent = fs.existsSync(central.skillManifest) && fs.existsSync(central.skillMd);
    const codexPlugin = centralCodexPluginPayloadStatus();
    const expectedCodexVersion = codexPlugin.expectedVersion;
    const agents = allAgentPaths().map(ap => {
        const { settings, error } = settingsForRead(ap);
        const hooks = error ? [] : wiredHooks(settings, ap);
        const nativeEvents = eventsForRuntime(hooks, 'native');
        const nodeEvents = eventsForRuntime(hooks, 'node');
        const invocationDrift = noncanonicalEvents(hooks, ap);
        const links = {
            dispatcher: linkState(ap.hookJs, central.hookJs),
            contracts: linkState(ap.hookContractsJs, central.hookContractsJs),
            cfg: dirLinkState(ap.cfgDir, central.cfgLink, CONFIG_MARKER),
        };
        if (nativeEvents.length)
            links.native = linkState(ap.hookBin, central.hookBin);
        if (ap.skillDir)
            links.skill = dirLinkState(ap.skillDir, central.skillDir, SKILL_MARKER);
        const codex = ap.codexPlugin ? codexPluginInspection(ap) : null;
        if (codex) {
            links.codexMarketplace = codex.marketplace;
            links.codexPlugin = codex.plugin;
        }
        return {
            name: ap.name,
            configDir: ap.configDir,
            settingsValid: !error,
            settingsError: error ? error.message : null,
            wiredEvents: hooks.map(h => h.event),
            runtime: { nativeEvents, nodeEvents },
            invocation: { canonical: invocationDrift.length === 0, noncanonicalEvents: invocationDrift },
            nativeBinary: nativeEvents.length ? nativeBinaryState(ap.hookBin) : null,
            links,
            codex: codex ? {
                version: codex.version,
                expectedVersion: expectedCodexVersion,
                stale: codexPluginVersionIsStale(codex, expectedCodexVersion),
                installedPath: codex.installedPath,
                detail: codex.detail,
            } : null,
        };
    });
    const nativeConfigured = agents.some(a => a.runtime.nativeEvents.length > 0);
    return {
        installRoot: central.root,
        dispatcher: { present: dispatcherPresent, inSync },
        configFolder: { present: cfg.present, path: central.cfgDir, external: configIsExternal },
        manager: { present: managerPresent },
        claudeSkill: { present: skillPresent },
        codexPlugin,
        nativeDispatcher: { active: nativeConfigured, state: nativeConfigured ? nativeBinaryState(central.hookBin) : null },
        config: { fatal: cfg.fatal, routes: cfg.routes, issues: cfg.issues, desiredEvents: cfg.desiredEvents },
        agents
    };
}
function cmdStatus() {
    if (jsonMode) {
        emitJson('status', collectStatusData());
        return;
    }
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
    const codexPlugin = centralCodexPluginPayloadStatus();
    const codexPluginDetail = !codexPlugin.present
        ? 'not deployed (install will deploy it)'
        : codexPlugin.stale
            ? 'STALE — deployed @ ' + (codexPlugin.version || 'missing version') + '; expected @ ' + codexPlugin.expectedVersion + ' (update will refresh)'
            : 'present at ' + central.codexPluginDir + ' via ' + central.codexMarketplaceRoot + (codexPlugin.version ? ' @ ' + codexPlugin.version : '');
    console.log('  codex plugin   : ' + codexPluginDetail);
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
    const nativeConfigured = agentsP.some(ap => {
        const { settings, error } = settingsForRead(ap);
        return !error && eventsForRuntime(wiredHooks(settings, ap), 'native').length > 0;
    });
    if (nativeConfigured) {
        const native = nativeBinaryState(central.hookBin);
        console.log('  native binary  : ' + (native.ok ? native.detail : 'UNHEALTHY — ' + native.detail));
    }
    for (const ap of agentsP) {
        const { settings, error } = settingsForRead(ap);
        const hooks = error ? [] : wiredHooks(settings, ap);
        const nativeEvents = eventsForRuntime(hooks, 'native');
        const nodeEvents = eventsForRuntime(hooks, 'node');
        const invocationDrift = noncanonicalEvents(hooks, ap);
        console.log('  agent ' + ap.name + ' @ ' + ap.configDir);
        if (error) {
            console.log('    ' + ap.settingsLabel.padEnd(13) + ': INVALID (' + error.message + ')');
        }
        else {
            const wired = wiredEvents(settings, ap);
            const runtimeBits = [];
            if (nativeEvents.length)
                runtimeBits.push('native [' + nativeEvents.join(', ') + ']');
            if (nodeEvents.length)
                runtimeBits.push('node [' + nodeEvents.join(', ') + ']');
            console.log('    ' + ap.settingsLabel.padEnd(13) + ': ' + (wired.length ? 'wired [' + wired.join(', ') + '] via ' + runtimeBits.join('; ') : 'not wired'));
            if (invocationDrift.length) {
                console.log('    invocation   : UNHEALTHY — legacy/noncanonical for [' + invocationDrift.join(', ') + ']; run update');
            }
        }
        console.log('    dispatcher   : ' + describeLink(linkState(ap.hookJs, central.hookJs)));
        if (nativeEvents.length)
            console.log('    native       : ' + describeNativeRuntime(ap));
        console.log('    contracts    : ' + describeLink(linkState(ap.hookContractsJs, central.hookContractsJs)));
        console.log('    cfg folder   : ' + describeLink(dirLinkState(ap.cfgDir, central.cfgLink, CONFIG_MARKER)));
        if (ap.skillDir)
            console.log('    skill plugin : ' + describeLink(dirLinkState(ap.skillDir, central.skillDir, SKILL_MARKER)));
        if (ap.codexPlugin) {
            const codex = codexPluginInspection(ap);
            console.log('    marketplace  : ' + describeLink(codex.marketplace));
            const stale = codexPluginVersionIsStale(codex, codexPlugin.expectedVersion);
            console.log('    codex plugin : ' + (stale
                ? 'STALE — installed @ ' + (codex.version || 'missing version') + '; expected @ ' + codexPlugin.expectedVersion + ' (run update)'
                : describeLink(codex.plugin) + (codex.version ? ' @ ' + codex.version : '')));
            if (codex.detail)
                console.log('    codex detail : ' + codex.detail);
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
function spawnHookCommand(hook, input) {
    if (hook.args !== undefined) {
        return (0, child_process_1.spawnSync)(hook.command, hook.args, { input, encoding: 'utf8' });
    }
    return isWin
        ? (0, child_process_1.spawnSync)('powershell', ['-NoProfile', '-NonInteractive', '-Command', hook.command], { input, encoding: 'utf8' })
        : (0, child_process_1.spawnSync)('sh', ['-c', hook.command], { input, encoding: 'utf8' });
}
// Functional check — drive an ACTUALLY-WIRED dispatcher, preferring Codex so its
// shell-rendered command path is exercised when both agents are installed.
function cmdVerify() {
    const cfg = loadCentralConfig();
    if (!cfg.routes.length) {
        console.log('[baseline] verify: FAIL — config has no valid routes' + (cfg.fatal ? ' (' + cfg.fatal + ')' : '') + '.');
        process.exit(1);
    }
    // Prefer a UserPromptSubmit route (no phase, fires every turn — deterministic); else the first.
    const route = cfg.routes.filter(r => r.event === 'UserPromptSubmit')[0] || cfg.routes[0];
    const routeEvent = (0, contracts_1.parseEvent)(route.event).base;
    const scoped = new Set(scopedAgentNames());
    const candidates = allAgentPaths()
        .filter(ap => scoped.has(ap.name))
        .sort((a, b) => Number(b.name === 'codex') - Number(a.name === 'codex'));
    let selected = null;
    let invalid = null;
    for (const candidate of candidates) {
        const sr = settingsForRead(candidate);
        if (sr.error) {
            if (!invalid)
                invalid = { ap: candidate, error: sr.error };
            continue;
        }
        const hook = findOurHookInGroups(eventHookGroups(sr.settings, routeEvent), candidate);
        if (hook) {
            selected = { ap: candidate, hook };
            break;
        }
    }
    if (!selected) {
        if (invalid) {
            console.log('[baseline] verify: FAIL — invalid ' + invalid.ap.settingsLabel + ': ' + invalid.error.message);
            process.exit(1);
        }
        console.log('[baseline] verify: FAIL — no baseline hook wired for ' + routeEvent + '. Run install.');
        process.exit(1);
    }
    const { ap, hook: ourHook } = selected;
    const runtime = commandRuntime(ourHook, ap);
    if (!runtime) {
        console.log('[baseline] verify: FAIL — cannot parse wired command.');
        process.exit(1);
    }
    if (runtime === 'native') {
        const faults = nativeRuntimeFaults(ap);
        if (faults.length) {
            console.log('[baseline] verify: FAIL — native hook command is unhealthy.');
            for (const fault of faults)
                console.log('  native fault  : ' + fault);
            process.exit(1);
        }
    }
    const cwd = route.cwd || process.cwd();
    const sid = 'baseline-verify-' + process.pid;
    let firedAt = 0;
    let firedText = '';
    let spawnErr = null;
    for (let i = 1; i <= route.freq; i++) {
        const r = spawnHookCommand(ourHook, synthInput(route, sid, cwd));
        if (r.error) {
            spawnErr = r.error;
            break;
        }
        if (r.status !== 0) {
            const detail = (r.stderr || '').trim();
            const runner = ourHook.args === undefined ? 'shell' : 'command';
            spawnErr = new Error('configured ' + runner + ' exited ' + r.status + (detail ? ': ' + detail : ''));
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
    console.log('  agent tested  : ' + ap.name);
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
async function cmdUpdate(runtime) {
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
    await cmdInstall({ preset: DEFAULT_PRESET, force: false, runtime });
}
// Inspect the installation and return a list of checks.
function doctorChecks() {
    const checks = [];
    // A deleted install root (e.g. rm -rf ~/.baseline) leaves every per-agent link
    // dangling; report the real cause first, ahead of the symptoms below.
    if (!fs.existsSync(central.root)) {
        checks.push({ name: 'install root', level: 'fail', detail: 'missing — ' + central.root + ' does not exist; agent hook links are dangling. Run doctor --fix (or install) from the source checkout to re-deploy', fixable: true });
    }
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
    let expectedCodexPayload = null;
    try {
        expectedCodexPayload = readExpectedCodexPluginPayload();
    }
    catch (e) { }
    // Central Codex plugin payload.
    if (!fs.existsSync(central.codexMarketplaceManifest) || !fs.existsSync(central.codexPluginManifest) || !fs.existsSync(central.codexPluginSkillMd)) {
        checks.push({ name: 'codex plugin payload', level: 'warn', detail: 'central payload not deployed at ' + central.codexPluginDir + ' (install will deploy it)', fixable: true });
    }
    else if (fs.existsSync(repo.codexPluginManifest)) {
        let manifestSync = false;
        let pathFresh = false;
        try {
            const deployedManifest = parseCodexPluginManifest(fs.readFileSync(central.codexPluginManifest, 'utf8'));
            const sourceName = expectedCodexPayload ? expectedCodexPayload.manifest.name : null;
            manifestSync = expectedCodexPayload !== null &&
                typeof sourceName === 'string' &&
                deployedManifest.name === sourceName &&
                deployedManifest.version === expectedCodexPayload.version;
            const skill = fs.readFileSync(central.codexPluginSkillMd, 'utf8');
            const marketplace = JSON.parse(fs.readFileSync(central.codexMarketplaceManifest, 'utf8'));
            pathFresh = skill.includes(central.managerJs) && skill.includes(CODEX_PLUGIN_KEY) &&
                marketplace.name === CODEX_MARKETPLACE && Array.isArray(marketplace.plugins) &&
                marketplace.plugins.some((entry) => entry && entry.name === CODEX_PLUGIN && entry.source && entry.source.path === './plugins/' + CODEX_PLUGIN);
        }
        catch (e) { }
        if (manifestSync && pathFresh) {
            checks.push({ name: 'codex plugin payload', level: 'ok', detail: 'central payload deployed; points at installed manager' });
        }
        else {
            checks.push({ name: 'codex plugin payload', level: 'warn', detail: (!manifestSync ? 'deployed manifest/cachebuster differs from source' : 'installed manager/marketplace metadata missing or stale') + ' (update will refresh)', fixable: true });
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
        const hooks = wiredHooks(sr.settings, ap);
        const wired = wiredEvents(sr.settings, ap);
        const nativeEvents = eventsForRuntime(hooks, 'native');
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
        const invocationDrift = noncanonicalEvents(hooks, ap);
        if (invocationDrift.length) {
            checks.push({
                name: 'hook invocation', level: 'fail', fixable: true,
                detail: ap.name + ' uses a legacy/noncanonical invocation for [' + invocationDrift.join(', ') + ']; update will rewrite it'
            });
        }
        if (nativeEvents.length) {
            const scope = ap.name + ' wired native [' + nativeEvents.join(', ') + ']';
            const centralBin = nativeBinaryState(central.hookBin);
            if (centralBin.ok)
                checks.push({ name: 'native binary', level: 'ok', detail: scope + '; central ' + centralBin.detail });
            else
                checks.push({ name: 'native binary', level: 'fail', detail: scope + '; central ' + centralBin.detail, fixable: true });
            const nativeLink = linkState(ap.hookBin, central.hookBin);
            if (nativeLink.ok && nativeLink.mechanism !== 'copy')
                checks.push({ name: 'native link', level: 'ok', detail: scope + '; linked to center (' + nativeLink.mechanism + ')' });
            else if (nativeLink.ok)
                checks.push({ name: 'native link', level: 'warn', detail: scope + '; degraded copy (edits will not propagate; install will relink)', fixable: true });
            else if (nativeLink.mechanism === 'dangling')
                checks.push({ name: 'native link', level: 'fail', detail: scope + '; dangling — target ' + central.hookBin + ' missing', fixable: true });
            else
                checks.push({ name: 'native link', level: 'fail', detail: scope + '; ' + nativeLink.mechanism + ' — not linked to ' + central.hookBin, fixable: true });
            const agentBin = nativeBinaryState(ap.hookBin);
            if (agentBin.ok)
                checks.push({ name: 'native executable', level: 'ok', detail: scope + '; agent ' + agentBin.detail });
            else
                checks.push({ name: 'native executable', level: 'fail', detail: scope + '; agent ' + agentBin.detail, fixable: true });
        }
        const js = linkState(ap.hookJs, central.hookJs);
        if (js.ok && js.mechanism !== 'copy')
            checks.push({ name: 'dispatcher link', level: 'ok', detail: 'linked to center (' + js.mechanism + ')' });
        else if (js.ok)
            checks.push({ name: 'dispatcher link', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
        else if (js.mechanism === 'dangling')
            checks.push({ name: 'dispatcher link', level: 'fail', detail: 'dangling — target ' + central.hookJs + ' missing', fixable: true });
        else
            checks.push({ name: 'dispatcher link', level: 'fail', detail: js.mechanism + ' — not linked to ' + central.hookJs, fixable: true });
        const contracts = linkState(ap.hookContractsJs, central.hookContractsJs);
        if (contracts.ok && contracts.mechanism !== 'copy')
            checks.push({ name: 'contracts link', level: 'ok', detail: 'linked to center (' + contracts.mechanism + ')' });
        else if (contracts.ok)
            checks.push({ name: 'contracts link', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
        else if (contracts.mechanism === 'dangling')
            checks.push({ name: 'contracts link', level: 'fail', detail: 'dangling — target ' + central.hookContractsJs + ' missing', fixable: true });
        else
            checks.push({ name: 'contracts link', level: 'fail', detail: contracts.mechanism + ' — not linked to ' + central.hookContractsJs, fixable: true });
        const cl = dirLinkState(ap.cfgDir, central.cfgLink, CONFIG_MARKER);
        if (cl.ok && cl.mechanism !== 'copy')
            checks.push({ name: 'config link', level: 'ok', detail: 'linked to center (' + cl.mechanism + ')' });
        else if (cl.ok)
            checks.push({ name: 'config link', level: 'warn', detail: 'degraded copy (edits will not propagate; install will relink)', fixable: true });
        else if (cl.mechanism === 'dangling')
            checks.push({ name: 'config link', level: 'fail', detail: 'dangling — target ' + central.cfgLink + ' missing', fixable: true });
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
        if (ap.codexPlugin) {
            const codex = codexPluginInspection(ap);
            if (codex.marketplace.ok) {
                checks.push({ name: 'codex marketplace', level: 'ok', detail: ap.name + ' registered from manager-owned root' });
            }
            else {
                const unavailable = codex.marketplace.mechanism === 'unavailable';
                checks.push({
                    name: 'codex marketplace', level: unavailable ? 'warn' : 'fail',
                    detail: ap.name + ' ' + codex.marketplace.mechanism + (codex.detail ? ' — ' + codex.detail : ''),
                    fixable: !unavailable && codex.marketplace.mechanism !== 'foreign' && codex.marketplace.mechanism !== 'unreadable',
                });
            }
            if (codex.plugin.ok) {
                const expectedVersion = expectedCodexPayload ? expectedCodexPayload.version : null;
                const stale = codexPluginVersionIsStale(codex, expectedVersion);
                checks.push(stale
                    ? {
                        name: 'codex plugin install',
                        level: 'fail',
                        detail: ap.name + ' ' + CODEX_PLUGIN_KEY + ' stale @ ' + (codex.version || 'missing version') +
                            '; expected @ ' + expectedVersion + ' (update will refresh)',
                        fixable: true,
                    }
                    : { name: 'codex plugin install', level: 'ok', detail: ap.name + ' ' + CODEX_PLUGIN_KEY + ' installed' + (codex.version ? ' @ ' + codex.version : '') });
            }
            else if (codex.marketplace.mechanism !== 'unavailable') {
                checks.push({
                    name: 'codex plugin install',
                    level: 'fail',
                    detail: ap.name + ' ' + codex.plugin.mechanism + (codex.detail ? ' — ' + codex.detail : ''),
                    fixable: codex.plugin.mechanism !== 'foreign' && codex.plugin.mechanism !== 'unreadable',
                });
            }
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
// --- route + dispatch-simulate commands (R-012) -----------------------------
// Read config.json as a plain object for mutation, preserving unknown keys. A missing
// file yields a fresh { version: 1, routes: [] }. A fatal shape
// error fails (json-aware).
function readConfigObject() {
    const r = readJson(central.config);
    if (!r.ok)
        fail('config.json is not valid JSON: ' + (r.error ? r.error.message : 'parse error'), 1, 'invalid_config');
    if (r.missing || r.value === null || r.value === undefined)
        return { version: 1, routes: [] };
    const v = r.value;
    if (typeof v !== 'object' || Array.isArray(v))
        fail('config.json root must be an object', 1, 'invalid_config');
    if (!Array.isArray(v.routes))
        v.routes = [];
    return v;
}
function writeConfigObject(obj) {
    atomicWrite(central.config, JSON.stringify(obj, null, 2) + '\n');
}
// Bounded doc read for `dispatch simulate` (mirrors the dispatcher's caps). Synchronous
// — the CLI has no concurrency need.
function readDocBodyForSimulate(doc) {
    const p = (0, contracts_1.safeRealDocPath)(doc, central.cfgDir);
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
function cmdRouteList() {
    const cfg = loadCentralConfig();
    if (jsonMode) {
        emitJson('route.list', { routes: cfg.routes, fatal: cfg.fatal, issues: cfg.issues });
        return;
    }
    console.log('[baseline] routes (' + cfg.routes.length + ')');
    for (const r of cfg.routes) {
        const bits = ['event=' + r.event, 'freq=' + r.freq];
        if (r.cwd !== undefined)
            bits.push('cwd=' + r.cwd);
        bits.push('doc=' + r.doc);
        console.log('  ' + r.id + ': ' + bits.join(', '));
    }
    if (cfg.fatal)
        console.log('  config INVALID: ' + cfg.fatal);
}
function cmdRouteAdd(argv) {
    const id = flagValue(argv, '--id');
    const event = flagValue(argv, '--event');
    const doc = flagValue(argv, '--doc');
    const freqRaw = flagValue(argv, '--freq');
    const cwd = flagValue(argv, '--cwd');
    if (!id || !contracts_1.SLUG.test(id))
        fail('route add: --id must be a slug matching ' + contracts_1.SLUG.source, 2, 'invalid_args');
    if (!event)
        fail('route add: --event is required', 2, 'invalid_args');
    if (!(0, contracts_1.isSupportedRouteEvent)(event)) {
        fail('route add: unsupported event "' + event + '"', 2, 'invalid_args');
    }
    if (!doc || !(0, contracts_1.safeDocPath)(doc, central.cfgDir))
        fail('route add: --doc must be a config-relative path inside the config folder', 2, 'invalid_args');
    let freq = 1;
    if (freqRaw !== undefined) {
        const n = Number(freqRaw);
        if (!Number.isInteger(n) || n < 1)
            fail('route add: --freq must be a positive integer', 2, 'invalid_args');
        freq = n;
    }
    const cfg = readConfigObject();
    if (cfg.routes.some((r) => r && r.id === id))
        fail('route add: a route with id "' + id + '" already exists', 2, 'duplicate');
    const route = { id, event, freq, doc };
    if (cwd)
        route.cwd = cwd;
    cfg.routes.push(route);
    writeConfigObject(cfg);
    if (jsonMode) {
        emitJson('route.add', { added: route, routes: cfg.routes });
        return;
    }
    console.log('[baseline] route added: ' + id + ' (' + event + ', freq ' + freq + ', doc ' + doc + ')');
    console.log('  rerun install/update if this introduces a new event so hook wiring re-syncs.');
}
function cmdRouteRemove(argv) {
    const id = flagValue(argv, '--id');
    if (!id)
        fail('route remove: --id is required', 2, 'invalid_args');
    const cfg = readConfigObject();
    const before = cfg.routes.length;
    cfg.routes = cfg.routes.filter((r) => !(r && r.id === id));
    if (cfg.routes.length === before)
        fail('route remove: no route with id "' + id + '"', 2, 'not_found');
    writeConfigObject(cfg);
    if (jsonMode) {
        emitJson('route.remove', { removed: id, routes: cfg.routes });
        return;
    }
    console.log('[baseline] route removed: ' + id);
    console.log('  rerun install/update if this drops an event so hook wiring re-syncs.');
}
// Dry-run: which routes a (event, cwd, source) invocation selects, and the exact static
// additionalContext that would be injected if they were due. Side-effect-free — it never
// touches counters (freq gating is stateful, so simulate reports selection assuming due).
function cmdDispatchSimulate(argv) {
    const event = flagValue(argv, '--event');
    const cwd = flagValue(argv, '--cwd') || process.cwd();
    const source = flagValue(argv, '--source');
    if (!event)
        fail('dispatch simulate: --event is required', 2, 'invalid_args');
    if (!(0, contracts_1.isSupportedRouteEvent)(event))
        fail('dispatch simulate: unsupported event "' + event + '"', 2, 'invalid_args');
    const ev = (0, contracts_1.parseEvent)(event);
    const effectiveSource = source !== undefined ? source : ev.phase;
    const cfg = loadCentralConfig();
    const selected = cfg.routes.filter(r => (0, contracts_1.eventMatches)(r.event, ev.base, effectiveSource) && (0, contracts_1.cwdMatches)(r.cwd, cwd, isWin));
    const bodies = [];
    for (const r of selected) {
        const body = readDocBodyForSimulate(r.doc);
        if (body === null)
            continue;
        const joined = bodies.length ? bodies.join('\n\n') + '\n\n' + body : body;
        if (joined.length <= contracts_1.MAX_DOC_CHARS)
            bodies.push(body);
    }
    const additionalContext = bodies.length ? bodies.join('\n\n') : null;
    if (jsonMode) {
        emitJson('dispatch.simulate', {
            event: ev.base,
            phase: ev.phase !== undefined ? ev.phase : null,
            cwd,
            source: effectiveSource !== undefined ? effectiveSource : null,
            selected: selected.map(r => ({ id: r.id, event: r.event, freq: r.freq, cwd: r.cwd !== undefined ? r.cwd : null, doc: r.doc })),
            additionalContext
        });
        return;
    }
    console.log('[baseline] dispatch simulate: event=' + event + (source ? ', source=' + source : '') + ', cwd=' + cwd);
    console.log('  selected routes : ' + (selected.length ? selected.map(r => r.id).join(', ') : '(none)'));
    console.log('  would inject     : ' + (additionalContext ? additionalContext.length + ' chars' : '(nothing)'));
}
// --- help / arg parsing -----------------------------------------------------
function printHelp() {
    console.log('baseline — manage the injection-routes dispatcher (cross-platform: Windows + Linux)');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/manage.js status                  Report installed artifacts, config, and agent health.');
    console.log('  node scripts/manage.js route list|add|remove   Inspect or edit routes in config.json (see route options).');
    console.log('  node scripts/manage.js dispatch simulate --event <e> [--cwd <d>] [--source <phase>]  Dry-run: show what would be injected.');
    console.log('  node scripts/manage.js install [--preset <n>] [--agents <a,b>]  Deploy the dispatcher, seed the config preset, link agents, wire hook config.');
    console.log('  node scripts/manage.js verify                  Functionally test a wired route (does it fire?).');
    console.log('  node scripts/manage.js update [--runtime <r>]    Redeploy dispatcher + re-sync hook wiring from current config.');
    console.log('  node scripts/manage.js doctor [--fix]          Validate config + wiring and report health; --fix repairs it.');
    console.log('  node scripts/manage.js uninstall               Remove per-agent wiring + links (keeps the central config folder).');
    console.log('  node scripts/manage.js help                    Show this help.');
    console.log('');
    console.log('install options:');
    console.log('  --preset <minimal|default>   Which repo preset to seed when no config folder exists. Default: default.');
    console.log('  --force                      Replace an existing central config folder with the preset (DESTRUCTIVE — user edits lost).');
    console.log('  --agents <a,b>               Comma list of agents to wire (claude-code,codex). Each must be detected. Default: prompt on a TTY, else all detected.');
    console.log('  --runtime <node|prebuilt|build>  Hook runtime: default uses the shipped native Zig prebuilt when available; node forces Node, build compiles first. Also accepted by update.');
    console.log('');
    console.log('route options:');
    console.log('  add    --id <slug> --event <e> --doc <config-relative path> [--freq <n>] [--cwd <dir>]');
    console.log('  remove --id <slug>');
    console.log('');
    console.log('Machine output: add --json to status, route list/add/remove, and dispatch simulate to get one');
    console.log('versioned JSON object (apiVersion 1) on stdout; on error it prints {"apiVersion":1,"error":{...}} and');
    console.log('exits nonzero. This CLI plus --json is the whole programmatic surface — no Node library, no daemon.');
    console.log('');
    console.log('Agents are detected by config-dir existence; an install/update/uninstall scopes to the agents recorded in <install root>/state.json.');
    console.log('Native runtime: plain install/update wires the shipped Zig prebuilt as the hook hot path when available; --runtime node forces Node; a missing or undeployable prebuilt falls back to the Node dispatcher.');
    console.log('Installed manager artifacts are deployed under <install root>/scripts so generated control surfaces do not depend on the source checkout.');
    console.log('A Claude skills-dir plugin (baseline@skills-dir) is deployed + linked so Claude recognizes baseline; it carries no hooks.');
    console.log('A manager-owned Codex marketplace is deployed under <install root>/codex-marketplace; install/update register it with `codex plugin marketplace add` and install ' + CODEX_PLUGIN_KEY + ' through the supported plugin CLI. Codex owns its cache and config state.');
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
        else if (a === '--runtime' || a === '-runtime') {
            const val = argv[i + 1] || '';
            i++;
            opts.runtime = parseRuntime(val, cmd);
        }
        else if (a.startsWith('--runtime=')) {
            opts.runtime = parseRuntime(a.slice(a.indexOf('=') + 1), cmd);
        }
        else if (a === '--build' || a === '-build') {
            opts.runtime = 'build';
        }
    }
    return opts;
}
function parseRuntime(val, cmd) {
    if (val === 'node' || val === 'prebuilt' || val === 'build')
        return val;
    fail(cmd + ': --runtime must be one of node|prebuilt|build (got ' + JSON.stringify(val) + ').', 2);
    return 'node'; // unreachable — fail() exits
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
    case 'route': {
        const sub = (process.argv[3] || '').toLowerCase();
        const rest = process.argv.slice(4);
        try {
            if (sub === 'list' || sub === 'ls')
                cmdRouteList();
            else if (sub === 'add')
                cmdRouteAdd(rest);
            else if (sub === 'remove' || sub === 'rm')
                cmdRouteRemove(rest);
            else
                fail('route: unknown subcommand "' + sub + '" (use list|add|remove)', 2, 'invalid_args');
        }
        catch (e) {
            fail('route ' + sub + ': ' + (e && e.message ? e.message : e), 1);
        }
        break;
    }
    case 'dispatch': {
        const sub = (process.argv[3] || '').toLowerCase();
        const rest = process.argv.slice(4);
        try {
            if (sub === 'simulate' || sub === 'sim')
                cmdDispatchSimulate(rest);
            else
                fail('dispatch: unknown subcommand "' + sub + '" (use simulate)', 2, 'invalid_args');
        }
        catch (e) {
            fail('dispatch ' + sub + ': ' + (e && e.message ? e.message : e), 1);
        }
        break;
    }
    case 'verify':
        cmdVerify();
        break;
    case 'update': {
        const opts = parseInstallOpts(process.argv.slice(3), 'update');
        cmdUpdate(opts.runtime).catch((e) => fail('update: ' + e.message, 1));
        break;
    }
    case 'doctor':
        parseInstallOpts(process.argv.slice(3), 'doctor'); // keep shared option validation consistent
        cmdDoctor(process.argv.slice(3).some(a => a === '--fix' || a === '-fix')).catch((e) => fail('doctor: ' + e.message, 1));
        break;
    default:
        console.log('[baseline] unknown command "' + cmd + '".');
        printHelp();
        process.exit(2);
}
