#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const module_1 = require("module");
const child_process_1 = require("child_process");
const contracts_1 = require("./contracts");
const root = path.resolve(__dirname, '..');
const manage = path.join(root, 'scripts', 'manage.js');
const dispatcher = path.join(root, 'scripts', 'baseline-recital.js');
const contracts = path.join(root, 'scripts', 'contracts.js');
function tempConfig() {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'));
    // Detection is by config-dir existence (CLAUDE_CONFIG_DIR / CODEX_HOME). mkdtemp
    // already created the claude config dir; create the codex one too so BOTH agents are
    // detected by default and the both-agent tests keep wiring both. Detection tests that
    // need an agent ABSENT remove its config dir explicitly before installing.
    fs.mkdirSync(codexFor(cfg), { recursive: true });
    return cfg;
}
// Each test gets an isolated install root alongside its config dir, so install
// never touches the real ~/.baseline. Deterministic: derived from the unique cfg.
function homeFor(cfg) {
    return cfg + '-home';
}
function codexFor(cfg) {
    return cfg + '-codex';
}
// Run the manager with isolated install root + agent config dirs. extraEnv can set
// BASELINE_CFG to exercise an external (symlinked) config folder.
function run(args, cfg, home, extraEnv) {
    const baseHome = home || homeFor(cfg);
    return (0, child_process_1.spawnSync)(process.execPath, [manage].concat(args), {
        cwd: root,
        env: Object.assign({}, process.env, {
            CLAUDE_CONFIG_DIR: cfg,
            CODEX_HOME: codexFor(cfg),
            BASELINE_HOME: baseHome,
            // Isolate BASELINE_CFG too: pin it to this install root's own cfg dir so a real
            // BASELINE_CFG in the developer's environment can never be read or clobbered. An
            // override equal to <installRoot>/cfg is treated as "no override" (a real seeded
            // folder), preserving the internal-config semantics the tests assume. Tests that
            // exercise external config pass their own BASELINE_CFG via extraEnv, which wins.
            BASELINE_CFG: path.join(baseHome, 'cfg')
        }, extraEnv || {}),
        encoding: 'utf8'
    });
}
function runInstalled(args, cfg, home, extraEnv) {
    const baseHome = home || homeFor(cfg);
    return (0, child_process_1.spawnSync)(process.execPath, [installedManager(baseHome)].concat(args), {
        cwd: root,
        env: Object.assign({}, process.env, {
            CLAUDE_CONFIG_DIR: cfg,
            CODEX_HOME: codexFor(cfg),
            BASELINE_HOME: baseHome,
            BASELINE_CFG: path.join(baseHome, 'cfg')
        }, extraEnv || {}),
        encoding: 'utf8'
    });
}
function runInstalledWithoutBaselineEnv(args, cfg, home, extraEnv) {
    const env = Object.assign({}, process.env, {
        CLAUDE_CONFIG_DIR: cfg,
        CODEX_HOME: codexFor(cfg)
    }, extraEnv || {});
    delete env.BASELINE_HOME;
    delete env.BASELINE_CFG;
    return (0, child_process_1.spawnSync)(process.execPath, [installedManager(home)].concat(args), {
        cwd: root,
        env,
        encoding: 'utf8'
    });
}
// Drive the deployed dispatcher directly with one synthetic hook payload. It reads
// CLAUDE_CONFIG_DIR for the linked cfg/baseline and the counter file.
function hook(input, cfg) {
    return (0, child_process_1.spawnSync)(process.execPath, [dispatcher], {
        input: JSON.stringify(input),
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codexFor(cfg), BASELINE_HOME: homeFor(cfg) }),
        encoding: 'utf8'
    });
}
function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}
// Overwrite the config folder contents (edits propagate to agents through the link).
// Config is flat under <installRoot>/cfg: config.json + docs/ (no cfg/baseline nesting).
function setCentralConfig(home, routes, docs) {
    write(path.join(home, 'cfg', 'config.json'), JSON.stringify({ version: 1, routes }, null, 2));
    for (const name of Object.keys(docs)) {
        write(path.join(home, 'cfg', name), docs[name]);
    }
}
function readThrough(p) {
    return fs.readFileSync(p, 'utf8');
}
const CODEX_ACTIVATION_TABLE = '[plugins."baseline@baseline"]';
const CODEX_QUOTED_PROJECT_TABLE = '[projects."C:/work#prod"] # trusted project';
const CODEX_QUOTED_PROJECT_TRUST = CODEX_QUOTED_PROJECT_TABLE + '\ntrust_level = "trusted"';
function installedManager(home) {
    return path.join(home, 'scripts', 'manage.js');
}
function installedDispatcherSource(home) {
    return path.join(home, 'scripts', 'baseline-recital.js');
}
function installedContractsSource(home) {
    return path.join(home, 'scripts', 'contracts.js');
}
function centralHookContracts(home) {
    return path.join(home, 'hooks', 'contracts.js');
}
function agentHookDispatcher(agentConfig) {
    return path.join(agentConfig, 'hooks', 'baseline-recital.js');
}
function agentHookContracts(agentConfig) {
    return path.join(agentConfig, 'hooks', 'contracts.js');
}
function runAgentHook(agentConfig, home, input) {
    return (0, child_process_1.spawnSync)(process.execPath, [agentHookDispatcher(agentConfig), '--agent-config', agentConfig], {
        input: JSON.stringify(input),
        env: Object.assign({}, process.env, { BASELINE_HOME: home }),
        encoding: 'utf8'
    });
}
function statusAgentSection(output, agentName) {
    const text = output.replace(/\r\n/g, '\n');
    const marker = '  agent ' + agentName + ' @ ';
    const start = text.indexOf(marker);
    assert.notStrictEqual(start, -1, 'status missing ' + agentName + ' section');
    const next = text.indexOf('\n  agent ', start + marker.length);
    return text.slice(start, next === -1 ? undefined : next);
}
function centralCodexPlugin(home) {
    return path.join(home, 'codex-plugin', 'baseline');
}
function codexPluginCache(codex) {
    return path.join(codex, 'plugins', 'cache', 'baseline', 'baseline', 'local');
}
function assertCodexPayload(pluginDir, label) {
    const manifest = path.join(pluginDir, '.codex-plugin', 'plugin.json');
    const skill = path.join(pluginDir, 'skills', 'baseline', 'SKILL.md');
    assert.strictEqual(JSON.parse(readThrough(manifest)).name, 'baseline', label + ' manifest should name baseline');
    assert.ok(fs.existsSync(skill), label + ' skill wrapper missing');
}
function assertControlSurfaceCommandsUseInstalledManager(skillBody, home, label) {
    const manager = installedManager(home);
    for (const cmd of ['status', 'install', 'update', 'verify', 'doctor', 'doctor --fix', 'uninstall']) {
        assert.ok(skillBody.includes('node "' + manager + '" ' + cmd), label + ' should invoke installed manager for `' + cmd + '`');
    }
    assert.ok(!skillBody.includes('node "' + path.join(root, 'scripts', 'manage.js') + '" status'), label + ' must not use source-checkout manager commands for normal status');
}
function assertEmptyCodexActivationTable(tomlPath) {
    const lines = readThrough(tomlPath).replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex(line => line.trim() === CODEX_ACTIVATION_TABLE);
    assert.notStrictEqual(start, -1, 'Codex activation table missing from config.toml');
    for (let i = start + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed)
            continue;
        assert.ok(trimmed.startsWith('['), 'Codex activation table should be empty, found: ' + lines[i]);
        return;
    }
}
function assertNoClaudePayloadInCodex(codex) {
    assert.ok(!fs.existsSync(path.join(codexPluginCache(codex), '.claude-plugin', 'plugin.json')), 'Codex cache must not contain a Claude .claude-plugin manifest');
    assert.ok(!fs.existsSync(path.join(codex, 'skills', 'baseline', '.claude-plugin', 'plugin.json')), 'Codex must not receive the Claude skills-dir payload');
}
// --- install / link / settings ---------------------------------------------
function testDefaultInstallAndVerify() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stdout, /runtime\s+: node js/);
    // No --preset → DEFAULT_PRESET is now 'default'.
    assert.match(install.stdout, /config folder : .*\(seeded, preset: default\)/);
    assert.ok(install.stdout.includes('manager       : ' + installedManager(home)), 'plain install should report the self-contained installed manager path');
    assert.strictEqual(readThrough(installedManager(home)), readThrough(manage), 'plain install did not deploy the manager artifact under the install root');
    assert.strictEqual(readThrough(installedDispatcherSource(home)), readThrough(dispatcher), 'plain install did not deploy the dispatcher source artifact under install-root scripts');
    assert.strictEqual(readThrough(installedContractsSource(home)), readThrough(contracts), 'plain install did not deploy the contracts artifact under install-root scripts');
    const installedStatus = runInstalled(['status'], cfg, home);
    assert.strictEqual(installedStatus.status, 0, installedStatus.stderr || installedStatus.stdout);
    assert.match(installedStatus.stdout, /manager\s+: present at /, 'installed manager should run independently from the install root');
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(command.includes('baseline-recital.js'), command);
    // default preset wires UserPromptSubmit + SessionStart (the 3 phase routes collapse to
    // one native SessionStart hook); PreToolUse stays unwired.
    assert.ok(settings.hooks.SessionStart, 'default preset should wire SessionStart');
    assert.ok(!settings.hooks.PreToolUse, 'unused PreToolUse event should not be wired');
    const verify = run(['verify'], cfg);
    assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /verify: PASS/);
}
function testInstalledManagerInfersInstallRootWithoutBaselineHome() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    const fallbackHome = cfg + '-fallback-home';
    fs.mkdirSync(fallbackHome, { recursive: true });
    const noBaselineEnv = { HOME: fallbackHome, USERPROFILE: fallbackHome };
    fs.rmSync(path.join(home, 'hooks'), { recursive: true, force: true });
    const status = runInstalledWithoutBaselineEnv(['status'], cfg, home, noBaselineEnv);
    assert.strictEqual(status.status, 0, status.stderr || status.stdout);
    assert.ok(status.stdout.includes('install root   : ' + home), 'installed manager should infer its own non-default install root when BASELINE_HOME is absent, even when the central hook is missing:\n' + status.stdout);
    assert.ok(status.stdout.includes('manager        : present at ' + installedManager(home)), 'installed manager status should look under the inferred install root:\n' + status.stdout);
    const update = runInstalledWithoutBaselineEnv(['update'], cfg, home, noBaselineEnv);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    assert.ok(fs.existsSync(path.join(home, 'hooks', 'baseline-recital.js')), 'installed manager update should repair the missing central hook under the inferred install root');
    fs.rmSync(path.join(home, 'hooks'), { recursive: true, force: true });
    const fixed = runInstalledWithoutBaselineEnv(['doctor', '--fix'], cfg, home, noBaselineEnv);
    assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
    assert.match(fixed.stdout, /doctor: installation repaired/);
    assert.ok(fs.existsSync(path.join(home, 'hooks', 'baseline-recital.js')), 'installed manager doctor --fix should repair the missing central hook under the inferred install root');
}
function testBaselineHomeOverridesInstalledManagerLocation() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const overrideHome = cfg + '-override-home';
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    const status = runInstalled(['status'], cfg, home, {
        BASELINE_HOME: overrideHome,
        BASELINE_CFG: path.join(overrideHome, 'cfg')
    });
    assert.strictEqual(status.status, 0, status.stderr || status.stdout);
    assert.ok(status.stdout.includes('install root   : ' + overrideHome), 'BASELINE_HOME should override the installed manager location:\n' + status.stdout);
}
function testSourceLikeInstalledManagerDoesNotInferInstallRoot() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    write(path.join(home, 'src', 'manage.ts'), '// source checkout marker\n');
    const fakeUserHome = cfg + '-user-home';
    fs.mkdirSync(fakeUserHome, { recursive: true });
    const status = runInstalledWithoutBaselineEnv(['status'], cfg, home, {
        HOME: fakeUserHome,
        USERPROFILE: fakeUserHome
    });
    assert.strictEqual(status.status, 0, status.stderr || status.stdout);
    const fallbackRoot = path.join(fakeUserHome, '.baseline');
    assert.ok(status.stdout.includes('install root   : ' + fallbackRoot), 'source-like manager should fall back to the user install root when src/manage.ts is present:\n' + status.stdout);
    assert.ok(!status.stdout.includes('install root   : ' + home), 'source-like manager must not infer the source-like root as installed:\n' + status.stdout);
}
// R-009 (goal decision #17): the install-root default is a pinned, tested contract.
// This consolidates the resolution ORDER in one place — BASELINE_HOME > the installed
// manager's own root > the ~/.baseline literal — driving all three rungs of the same
// installed manager (the scenario tests above each cover one rung; this pins the order).
function testInstallRootDefaultContract() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    // Rung 1: BASELINE_HOME wins even though this installed manager could infer a root.
    const overrideHome = cfg + '-order-override';
    const r1 = runInstalled(['status'], cfg, home, {
        BASELINE_HOME: overrideHome,
        BASELINE_CFG: path.join(overrideHome, 'cfg')
    });
    assert.strictEqual(r1.status, 0, r1.stderr || r1.stdout);
    assert.ok(r1.stdout.includes('install root   : ' + overrideHome), 'BASELINE_HOME must win over the inferred install root:\n' + r1.stdout);
    // Rung 2: no BASELINE_HOME — the installed manager infers its OWN root, ahead of ~/.baseline.
    const fakeUserHome = cfg + '-order-userhome';
    fs.mkdirSync(fakeUserHome, { recursive: true });
    const r2 = runInstalledWithoutBaselineEnv(['status'], cfg, home, { HOME: fakeUserHome, USERPROFILE: fakeUserHome });
    assert.strictEqual(r2.status, 0, r2.stderr || r2.stdout);
    assert.ok(r2.stdout.includes('install root   : ' + home), 'installed manager must infer its own root ahead of ~/.baseline:\n' + r2.stdout);
    assert.ok(!r2.stdout.includes('install root   : ' + path.join(fakeUserHome, '.baseline')), 'the inferred root must take precedence over the ~/.baseline literal:\n' + r2.stdout);
    // Rung 3: no BASELINE_HOME and a source-like manager (src/manage.ts present) → the
    // ~/.baseline literal under the user home is the final fallback.
    write(path.join(home, 'src', 'manage.ts'), '// source checkout marker\n');
    const r3 = runInstalledWithoutBaselineEnv(['status'], cfg, home, { HOME: fakeUserHome, USERPROFILE: fakeUserHome });
    assert.strictEqual(r3.status, 0, r3.stderr || r3.stdout);
    assert.ok(r3.stdout.includes('install root   : ' + path.join(fakeUserHome, '.baseline')), 'source-like manager with no BASELINE_HOME must fall back to the ~/.baseline literal:\n' + r3.stdout);
}
// The minimal preset is bare baseline only: one UserPromptSubmit route, nothing else.
function testMinimalPresetWiresOnlyUserPromptSubmit() {
    const cfg = tempConfig();
    const install = run(['install', '--preset', 'minimal'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stdout, /config folder : .*\(seeded, preset: minimal\)/);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks.UserPromptSubmit, 'minimal must wire UserPromptSubmit');
    assert.ok(!settings.hooks.SessionStart, 'minimal must not wire SessionStart');
    assert.ok(!settings.hooks.PreToolUse, 'minimal must not wire PreToolUse');
    assert.strictEqual(run(['verify'], cfg).status, 0);
}
// Slice-2 acceptance: installing the DEFAULT preset wires BOTH agents (claude-code and
// codex) to EXACTLY the base events [UserPromptSubmit, SessionStart]. The three
// SessionStart.<phase> routes collapse to ONE native SessionStart hook — no per-phase
// hook entry and no matcher. The default config.json validates and passes doctor.
// BASELINE_CFG is isolated by run() (pinned to this install root's cfg), so a real
// external config in the developer's environment is never touched.
function testDefaultPresetWiresBaseEventsBothAgents() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    const install = run(['install', '--preset', 'default'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    // The default preset config parses/validates: version 1, baseline + 3 SessionStart routes.
    const presetCfg = JSON.parse(fs.readFileSync(path.join(root, 'presets', 'default', 'config.json'), 'utf8'));
    assert.strictEqual(presetCfg.version, 1, 'default config version must be 1');
    assert.deepStrictEqual(presetCfg.routes.map((r) => r.id), ['baseline', 'sessionstart-startup', 'sessionstart-compact', 'sessionstart-clear'], 'default preset route ids changed');
    assert.deepStrictEqual(presetCfg.routes.map((r) => r.event), ['UserPromptSubmit', 'SessionStart.startup', 'SessionStart.compact', 'SessionStart.clear'], 'default preset route events changed');
    // Both agents wire EXACTLY [UserPromptSubmit, SessionStart]; the phase routes collapse
    // to ONE native SessionStart hook with no per-phase entry and no matcher.
    const agents = [
        ['claude-code', path.join(cfg, 'settings.json')],
        ['codex', path.join(codex, 'hooks.json')]
    ];
    for (const [label, file] of agents) {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['SessionStart', 'UserPromptSubmit'], label + ' should wire exactly [UserPromptSubmit, SessionStart]');
        assert.ok(!Object.keys(s.hooks).some((k) => k.indexOf('.') !== -1), label + ' must not key a hook event by phase (e.g. SessionStart.compact)');
        for (const ev of ['UserPromptSubmit', 'SessionStart']) {
            assert.strictEqual(s.hooks[ev].length, 1, label + ' ' + ev + ' should have exactly one group');
            assert.strictEqual(s.hooks[ev][0].hooks.length, 1, label + ' ' + ev + ' should have exactly one hook entry');
            assert.strictEqual(s.hooks[ev][0].matcher, undefined, label + ' ' + ev + ' group must carry no matcher');
            assert.ok(s.hooks[ev][0].hooks[0].command.includes('baseline-recital.js'), label + ' ' + ev + ' hook should be the baseline dispatcher');
        }
    }
    // The seeded default config validates and passes doctor.
    const doctor = run(['doctor'], cfg);
    assert.strictEqual(doctor.status, 0, doctor.stdout);
    assert.match(doctor.stdout, /config\.json: valid; 4 route\(s\) over \[UserPromptSubmit, SessionStart\]/);
}
function testCentralInstallAndAgentLinks() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assert.ok(fs.existsSync(path.join(home, 'hooks', 'baseline-recital.js')), 'central dispatcher missing');
    assert.ok(fs.existsSync(centralHookContracts(home)), 'central contracts missing');
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'config.json')), 'central config.json missing');
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'docs', 'baseline.md')), 'central doc missing');
    const agentJs = agentHookDispatcher(cfg);
    const agentContracts = agentHookContracts(cfg);
    const agentConfig = path.join(cfg, 'cfg', 'baseline', 'config.json');
    assert.ok(fs.existsSync(agentJs), 'agent dispatcher not linked');
    assert.ok(fs.existsSync(agentContracts), 'agent contracts not linked');
    assert.strictEqual(readThrough(agentJs), readThrough(path.join(home, 'hooks', 'baseline-recital.js')), 'agent dispatcher does not resolve to central content');
    assert.strictEqual(readThrough(agentContracts), readThrough(centralHookContracts(home)), 'agent contracts do not resolve to central content');
    assert.strictEqual(readThrough(agentConfig), readThrough(path.join(home, 'cfg', 'config.json')), 'agent config.json does not resolve to central content');
    const status = run(['status'], cfg);
    assert.strictEqual(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /install root\s+: /);
    assert.match(status.stdout, /baseline: event=UserPromptSubmit, freq=5/);
}
function testCodexInstallAndAgentLinks() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    const hooksJson = JSON.parse(fs.readFileSync(path.join(codex, 'hooks.json'), 'utf8'));
    const command = hooksJson.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(command.includes('baseline-recital.js'), command);
    assert.ok(command.includes('--agent-config'), command);
    assert.ok(command.includes(codex), command);
    const agentContracts = agentHookContracts(codex);
    assert.ok(fs.existsSync(agentContracts), 'codex contracts not linked');
    assert.strictEqual(readThrough(agentContracts), readThrough(centralHookContracts(home)), 'codex contracts do not resolve to central content');
    const agentConfig = path.join(codex, 'cfg', 'baseline', 'config.json');
    assert.strictEqual(readThrough(agentConfig), readThrough(path.join(homeFor(cfg), 'cfg', 'config.json')), 'codex config.json does not resolve to central content');
}
function testInstalledHooksResolveBundledContracts() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    setCentralConfig(home, [
        { id: 'hook-contracts', event: 'UserPromptSubmit', freq: 1, doc: 'docs/hook-contracts.md' }
    ], { 'docs/hook-contracts.md': 'CONTRACT HOOK OK\n' });
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    for (const [label, agentConfig] of [['claude-code', cfg], ['codex', codex]]) {
        assert.ok(fs.existsSync(agentHookDispatcher(agentConfig)), label + ' dispatcher missing');
        assert.ok(fs.existsSync(agentHookContracts(agentConfig)), label + ' contracts missing');
        assert.strictEqual(readThrough(agentHookContracts(agentConfig)), readThrough(centralHookContracts(home)), label + ' contracts should resolve to central content');
    }
    const claude = runAgentHook(cfg, home, { session_id: 'contracts-claude', hook_event_name: 'UserPromptSubmit', cwd: cfg });
    assert.strictEqual(claude.status, 0, claude.stderr || claude.stdout);
    assert.ok((fireBodies(claude) || '').includes('CONTRACT HOOK OK'), 'Claude installed hook should resolve ./contracts and fire');
    // Simulate the cross-device/perms fallback path: both hook files are regular copies
    // in the Codex hooks dir, so require("./contracts") must resolve beside that copy.
    fs.rmSync(agentHookDispatcher(codex), { force: true });
    fs.rmSync(agentHookContracts(codex), { force: true });
    fs.copyFileSync(path.join(home, 'hooks', 'baseline-recital.js'), agentHookDispatcher(codex));
    fs.copyFileSync(centralHookContracts(home), agentHookContracts(codex));
    const codexRun = runAgentHook(codex, home, { session_id: 'contracts-codex', hook_event_name: 'UserPromptSubmit', cwd: cfg });
    assert.strictEqual(codexRun.status, 0, codexRun.stderr || codexRun.stdout);
    assert.ok((fireBodies(codexRun) || '').includes('CONTRACT HOOK OK'), 'Codex copied hook should resolve ./contracts from the copy target and fire');
}
function testCentralEditPropagatesToAgent() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    // Edit the central doc; the agent path must reflect it (single source).
    const edited = 'EDITED RULE BODY\n';
    fs.writeFileSync(path.join(home, 'cfg', 'docs', 'baseline.md'), edited, 'utf8');
    assert.strictEqual(readThrough(path.join(cfg, 'cfg', 'baseline', 'docs', 'baseline.md')), edited, 'central edit not visible through the agent link');
}
function testIdempotentReinstall() {
    const cfg = tempConfig();
    assert.strictEqual(run(['install'], cfg).status, 0);
    const second = run(['install'], cfg);
    assert.strictEqual(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /\(kept, preset: default\)/);
    assert.strictEqual(run(['verify'], cfg).status, 0);
}
function testForceReplacesConfigKeepWithout() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    // Operator edit to the central config.
    const marker = 'OPERATOR EDIT MARKER\n';
    fs.writeFileSync(path.join(home, 'cfg', 'docs', 'baseline.md'), marker, 'utf8');
    // Plain reinstall keeps the edit.
    assert.strictEqual(run(['install'], cfg).status, 0);
    assert.strictEqual(fs.readFileSync(path.join(home, 'cfg', 'docs', 'baseline.md'), 'utf8'), marker, 'plain reinstall clobbered the operator config');
    // --force replaces it wholesale from the preset.
    const forced = run(['install', '--force'], cfg);
    assert.strictEqual(forced.status, 0, forced.stderr || forced.stdout);
    assert.match(forced.stdout, /\(replaced, preset: default\)/);
    assert.notStrictEqual(fs.readFileSync(path.join(home, 'cfg', 'docs', 'baseline.md'), 'utf8'), marker, '--force did not replace the operator config');
}
function testUnknownPresetFails() {
    const cfg = tempConfig();
    const install = run(['install', '--preset', 'nope'], cfg);
    assert.notStrictEqual(install.status, 0, 'install with unknown preset unexpectedly succeeded');
    assert.match(install.stderr, /preset "nope" not found/);
}
// --- native Zig runtime (R-009, goal decision #18) --------------------------
// The prebuilt shipped for this platform, or null where none exists (mirrors
// manage.ts nativePrebuiltName). Native tests skip cleanly on such platforms.
function nativePrebuiltForPlatform() {
    if (process.platform === 'win32' && process.arch === 'x64')
        return 'baseline-recital-windows-x64.exe';
    if (process.platform === 'linux' && process.arch === 'x64')
        return 'baseline-recital-linux-x64';
    return null;
}
const nativeBinName = process.platform === 'win32' ? 'baseline-recital.exe' : 'baseline-recital';
function agentHookBin(agentConfig) {
    return path.join(agentConfig, 'hooks', nativeBinName);
}
function wiredCommandFor(cfg, event) {
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    return settings.hooks[event][0].hooks[0].command;
}
// install --runtime prebuilt lifts the former pause: it deploys the native binary to the
// center, links it into the agent, and wires the binary DIRECTLY (no node) as the hot path.
// verify drives the actually-wired command end-to-end. Skips where no prebuilt is shipped.
function testNativeRuntimeInstallsAndWires() {
    const target = nativePrebuiltForPlatform();
    if (!target || !fs.existsSync(path.join(root, 'bin', target))) {
        console.log('  (skip) testNativeRuntimeInstallsAndWires: no native prebuilt for ' + process.platform + '-' + process.arch + '.');
        return;
    }
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const install = run(['install', '--runtime', 'prebuilt'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stdout, /runtime\s+: native \(prebuilt /);
    assert.ok(fs.existsSync(path.join(home, 'hooks', nativeBinName)), 'native binary not deployed to the center');
    assert.ok(fs.existsSync(agentHookBin(cfg)), 'native binary not linked into the agent hooks dir');
    const cmd = wiredCommandFor(cfg, 'UserPromptSubmit');
    assert.ok(cmd.includes(nativeBinName), 'wired command should run the native binary: ' + cmd);
    assert.ok(!/baseline-recital\.js/.test(cmd), 'wired command must not run the Node .js when native: ' + cmd);
    // verify parses the wired command and spawns it (the native binary) for real.
    const verify = run(['verify'], cfg);
    assert.strictEqual(verify.status, 0, 'verify should pass against the wired native binary: ' + (verify.stderr || verify.stdout));
}
// With no native runtime requested the platform binary is absent, and the Node dispatcher
// is wired + dispatches. Deterministic on every platform (no prebuilt is deployed).
function testNativeFallbackToNodeWhenBinaryAbsent() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stdout, /runtime\s+: node js/);
    assert.ok(!fs.existsSync(path.join(home, 'hooks', nativeBinName)), 'no native binary should deploy without --runtime');
    assert.ok(!fs.existsSync(agentHookBin(cfg)), 'no native binary should link into the agent without --runtime');
    const cmd = wiredCommandFor(cfg, 'UserPromptSubmit');
    assert.ok(/baseline-recital\.js/.test(cmd), 'binary absent -> the Node .js must be wired: ' + cmd);
    setCentralConfig(home, [
        { id: 'fb', event: 'UserPromptSubmit', freq: 1, doc: 'docs/fb.md' }
    ], { 'docs/fb.md': 'FALLBACK OK\n' });
    const body = fireBodies(hook({ session_id: 'fallback', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
    assert.ok(body && body.includes('FALLBACK OK'), 'the Node dispatcher should fire when the native binary is absent');
}
// End-to-end byte-parity: identical stdin fixtures to the native binary and the Node
// dispatcher must produce byte-identical stdout across multi-route templating, freq
// rollover, and a no-match event. Skips cleanly where no prebuilt exists for the platform.
function testNativeDispatchParity() {
    const target = nativePrebuiltForPlatform();
    if (!target || !fs.existsSync(path.join(root, 'bin', target))) {
        console.log('  (skip) testNativeDispatchParity: no native prebuilt for ' + process.platform + '-' + process.arch + '.');
        return;
    }
    const nativeBin = path.join(root, 'bin', target);
    function fixture() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-parity-'));
        const cb = path.join(dir, 'cfg', 'baseline');
        fs.mkdirSync(path.join(cb, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(cb, 'config.json'), JSON.stringify({
            version: 1,
            vars: { greeting: 'hello', who: 'config' },
            routes: [
                { id: 'first', event: 'UserPromptSubmit', freq: 1, doc: 'docs/first.md', vars: { who: 'route' } },
                { id: 'second', event: 'UserPromptSubmit', freq: 1, doc: 'docs/second.md' },
                { id: 'every2', event: 'UserPromptSubmit', freq: 2, doc: 'docs/every2.md' }
            ]
        }, null, 2));
        fs.writeFileSync(path.join(cb, 'docs', 'first.md'), 'FIRST e={{event}} g={{greeting}} w={{who}} u={{unknown}}\n');
        fs.writeFileSync(path.join(cb, 'docs', 'second.md'), 'SECOND\n');
        fs.writeFileSync(path.join(cb, 'docs', 'every2.md'), 'EVERY-TWO\n');
        return dir;
    }
    // TZ=UTC aligns the Node {{date}}/{{time}} built-ins with the native UTC clock (the docs
    // here use neither, but this keeps the harness honest for future date/time cases).
    const env = Object.assign({}, process.env, { TZ: 'UTC' });
    const nDir = fixture();
    const jDir = fixture();
    const native = (dir, input) => (0, child_process_1.spawnSync)(nativeBin, ['--agent-config', dir], { input: JSON.stringify(input), encoding: 'utf8', env });
    const node = (dir, input) => (0, child_process_1.spawnSync)(process.execPath, [dispatcher, '--agent-config', dir], { input: JSON.stringify(input), encoding: 'utf8', env });
    try {
        const turns = [
            { hook_event_name: 'UserPromptSubmit' }, // t1: first + second (every2 not yet due)
            { hook_event_name: 'UserPromptSubmit' }, // t2: first + second + every2 (config order)
            { hook_event_name: 'PostToolUse', tool_name: 'Bash' } // no matching route -> empty
        ];
        const nativeOut = [];
        for (let i = 0; i < turns.length; i++) {
            const rn = native(nDir, Object.assign({ session_id: 'p', cwd: nDir }, turns[i]));
            const rj = node(jDir, Object.assign({ session_id: 'p', cwd: jDir }, turns[i]));
            assert.strictEqual(rn.status, 0, 'native exit 0 at turn ' + (i + 1) + ': ' + (rn.stderr || ''));
            assert.strictEqual(rj.status, 0, 'node exit 0 at turn ' + (i + 1) + ': ' + (rj.stderr || ''));
            assert.strictEqual(rn.stdout, rj.stdout, 'native vs node stdout must be byte-identical at turn ' + (i + 1) +
                '\n  native: ' + JSON.stringify(rn.stdout) + '\n  node:   ' + JSON.stringify(rj.stdout));
            nativeOut.push(rn.stdout || '');
        }
        // Guard against a vacuous pass (two empties): assert the expected non-empty semantics.
        assert.ok(nativeOut[0].includes('FIRST e=UserPromptSubmit g=hello w=route u={{unknown}}'), 't1 must template built-ins/vars and leave unknown verbatim: ' + nativeOut[0]);
        assert.ok(nativeOut[0].includes('SECOND') && !nativeOut[0].includes('EVERY-TWO'), 't1: freq-2 route not yet due');
        const iF = nativeOut[1].indexOf('FIRST'), iS = nativeOut[1].indexOf('SECOND'), iE = nativeOut[1].indexOf('EVERY-TWO');
        assert.ok(iF !== -1 && iS !== -1 && iE !== -1 && iF < iS && iS < iE, 't2: all three due, emitted in config order: ' + nativeOut[1]);
        assert.strictEqual(nativeOut[2].trim(), '', 't3: no-match event injects nothing');
    }
    finally {
        fs.rmSync(nDir, { recursive: true, force: true });
        fs.rmSync(jDir, { recursive: true, force: true });
    }
}
function testInvalidSettingsFailsClosed() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const settings = path.join(cfg, 'settings.json');
    write(settings, '{ invalid json');
    const install = run(['install'], cfg);
    assert.notStrictEqual(install.status, 0, 'install unexpectedly succeeded');
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{ invalid json');
    assert.ok(!fs.existsSync(path.join(home, 'hooks', 'baseline-recital.js')), 'invalid settings should not deploy dispatcher');
    assert.ok(!fs.existsSync(path.join(home, 'cfg', 'config.json')), 'invalid settings should not seed config');
}
function testInvalidSettingsShapeFailsClosed() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const settings = path.join(cfg, 'settings.json');
    const invalidShape = JSON.stringify({ hooks: { UserPromptSubmit: { hooks: [] } } }, null, 2) + '\n';
    write(settings, invalidShape);
    const install = run(['install'], cfg);
    assert.notStrictEqual(install.status, 0, 'install unexpectedly succeeded');
    assert.match(install.stderr, /hooks\.UserPromptSubmit must be an array/);
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), invalidShape);
    assert.ok(!fs.existsSync(path.join(home, 'cfg', 'config.json')), 'invalid shape should not seed config');
    const doctor = run(['doctor'], cfg);
    assert.notStrictEqual(doctor.status, 0, 'doctor unexpectedly succeeded on invalid settings shape');
    assert.match(doctor.stdout, /settings\.json invalid/);
}
function testInvalidNullHookGroupFailsClosed() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const settings = path.join(cfg, 'settings.json');
    const invalidShape = JSON.stringify({ hooks: { UserPromptSubmit: [null] } }, null, 2) + '\n';
    write(settings, invalidShape);
    const install = run(['install'], cfg);
    assert.notStrictEqual(install.status, 0, 'install unexpectedly succeeded');
    assert.match(install.stderr, /hooks\.UserPromptSubmit\[0\] must be an object/);
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), invalidShape);
    assert.ok(!fs.existsSync(path.join(home, 'cfg', 'config.json')), 'invalid group should not seed config');
}
// --- config-driven wiring ---------------------------------------------------
function testConfigDrivenWiringAndUnwire() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    // default preset uses UserPromptSubmit + SessionStart → both wired, others not.
    const install = run(['install', '--preset', 'default'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    let settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks.UserPromptSubmit, 'UserPromptSubmit not wired');
    assert.ok(settings.hooks.SessionStart, 'SessionStart not wired');
    assert.ok(!settings.hooks.PreToolUse, 'PreToolUse wired but no route uses it');
    // Remove the SessionStart route from central config; update must unwire it.
    setCentralConfig(home, [
        { id: 'baseline', event: 'UserPromptSubmit', freq: 5, doc: 'docs/baseline.md' }
    ], {});
    const update = run(['update'], cfg);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks.UserPromptSubmit, 'UserPromptSubmit dropped wrongly');
    assert.ok(!settings.hooks.SessionStart, 'stale SessionStart event group not unwired after route removal');
}
function testCoResidentHookPreserved() {
    const cfg = tempConfig();
    // A co-resident UserPromptSubmit hook the operator owns.
    write(path.join(cfg, 'settings.json'), JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo theirs', timeout: 3 }] }] }
    }, null, 2) + '\n');
    assert.strictEqual(run(['install'], cfg).status, 0);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    const cmds = settings.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.some((c) => c === 'echo theirs'), 'co-resident hook was dropped');
    assert.ok(cmds.some((c) => c.includes('baseline-recital.js')), 'baseline hook not added');
    // Uninstall removes only ours.
    assert.strictEqual(run(['uninstall'], cfg).status, 0);
    const after = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    const left = after.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
    assert.deepStrictEqual(left, ['echo theirs'], 'uninstall did not preserve exactly the co-resident hook');
}
function testBaselineHookDoesNotInheritMatcher() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    setCentralConfig(home, [
        { id: 'bash', event: 'PreToolUse', freq: 1, doc: 'docs/bash.md' }
    ], { 'docs/bash.md': 'BASH\n' });
    write(path.join(cfg, 'settings.json'), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo theirs', timeout: 3 }] }] }
    }, null, 2) + '\n');
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    const groups = settings.hooks.PreToolUse;
    assert.ok(groups.some((g) => g.matcher === 'Read' && g.hooks.some((h) => h.command === 'echo theirs')), 'co-resident matched group was not preserved');
    assert.ok(groups.some((g) => g.matcher === undefined && g.hooks.some((h) => h.command.includes('baseline-recital.js'))), 'baseline hook should be installed in its own matcher-free group');
    const verify = run(['verify'], cfg);
    assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
}
// --- dispatcher behavior (drive the deployed hook directly) -----------------
function fireBodies(res) {
    const out = (res.stdout || '').trim();
    if (!out)
        return null;
    return JSON.parse(out).hookSpecificOutput.additionalContext;
}
function testPerRouteCountersIndependent() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    setCentralConfig(home, [
        { id: 'two', event: 'UserPromptSubmit', freq: 2, doc: 'docs/two.md' },
        { id: 'three', event: 'UserPromptSubmit', freq: 3, doc: 'docs/three.md' }
    ], { 'docs/two.md': 'TWO\n', 'docs/three.md': 'THREE\n' });
    const sid = 'sess-counters';
    const fired = {};
    for (let i = 1; i <= 6; i++) {
        const body = fireBodies(hook({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
        if (body)
            fired[i] = body;
    }
    // freq2 fires 2,4,6; freq3 fires 3,6. Independent counters, same session.
    assert.ok(fired[2] && fired[2].includes('TWO') && !fired[2].includes('THREE'), 'turn2: only freq2 route');
    assert.ok(fired[3] && fired[3].includes('THREE') && !fired[3].includes('TWO'), 'turn3: only freq3 route');
    assert.ok(!fired[5], 'turn5: nothing due');
    assert.ok(fired[6] && fired[6].includes('TWO') && fired[6].includes('THREE'), 'turn6: both due, joined');
}
function testMalformedCounterArrayDoesNotBreakFrequency() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    setCentralConfig(home, [
        { id: 'two', event: 'UserPromptSubmit', freq: 2, doc: 'docs/two.md' }
    ], { 'docs/two.md': 'TWO\n' });
    write(path.join(cfg, '.baseline-counters.json'), '[]');
    assert.strictEqual(fireBodies(hook({ session_id: 'array', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg)), null, 'first turn should not fire');
    assert.ok(fireBodies(hook({ session_id: 'array', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg))?.includes('TWO'), 'second turn should fire even after malformed array counters');
}
// Slice-1 acceptance: the event NAME is the sole moment-resolver. A SessionStart
// phase suffix (SessionStart.compact) fires only when stdin source matches; a bare
// SessionStart route matches every phase; a bare non-session event matches; cwd
// scope is still respected.
function testEventNameSemantics() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    const scoped = path.join(cfg, 'scoped-tree');
    setCentralConfig(home, [
        { id: 'compact', event: 'SessionStart.compact', freq: 1, doc: 'docs/c.md' },
        { id: 'anysession', event: 'SessionStart', freq: 1, doc: 'docs/a.md' },
        { id: 'prompt', event: 'UserPromptSubmit', freq: 1, doc: 'docs/p.md' },
        { id: 'scoped', event: 'UserPromptSubmit', cwd: scoped, freq: 1, doc: 'docs/s.md' }
    ], { 'docs/c.md': 'COMPACT\n', 'docs/a.md': 'ANYSESSION\n', 'docs/p.md': 'PROMPT\n', 'docs/s.md': 'SCOPED\n' });
    // SessionStart.<phase>: the phase suffix must equal the stdin `source`.
    const onCompact = fireBodies(hook({ session_id: 's1', hook_event_name: 'SessionStart', source: 'compact', cwd: cfg }, cfg));
    assert.ok(onCompact?.includes('COMPACT'), 'SessionStart.compact route should fire on source=compact');
    assert.ok(onCompact?.includes('ANYSESSION'), 'bare SessionStart route should also fire on source=compact');
    // A different phase: the phased route stays silent; the bare route matches all phases.
    const onStartup = fireBodies(hook({ session_id: 's2', hook_event_name: 'SessionStart', source: 'startup', cwd: cfg }, cfg));
    assert.ok(!onStartup?.includes('COMPACT'), 'SessionStart.compact route should not fire on source=startup');
    assert.ok(onStartup?.includes('ANYSESSION'), 'bare SessionStart route should fire on any phase');
    // A bare non-session event matches its native event.
    assert.ok(fireBodies(hook({ session_id: 's3', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg))?.includes('PROMPT'), 'bare UserPromptSubmit route should fire');
    // cwd scope: only under the path.
    assert.ok(fireBodies(hook({ session_id: 's4', hook_event_name: 'UserPromptSubmit', cwd: path.join(scoped, 'sub') }, cfg))?.includes('SCOPED'), 'scoped route should fire under its cwd');
    assert.ok(!fireBodies(hook({ session_id: 's5', hook_event_name: 'UserPromptSubmit', cwd: path.join(cfg, 'elsewhere') }, cfg))?.includes('SCOPED'), 'scoped route should not fire outside its cwd');
}
// --- {{name}} templating (R-010) -------------------------------------------
// Fixed-clock context helper so date/time assertions are deterministic.
function tmplCtx(over) {
    return Object.assign({ event: 'UserPromptSubmit', cwd: '/work/proj', home: '/home/dev', now: new Date(2026, 0, 9, 4, 7), env: {}, vars: {} }, over);
}
function testTemplateResolvesBuiltinsAndVars() {
    const ctx = tmplCtx({ env: { FOO: 'bar' }, vars: { greeting: 'hello', name: 'Ada' } });
    const body = 'ev={{event}} cwd={{cwd}} home={{home}} date={{date}} time={{time}} env={{env.FOO}} g={{greeting}} n={{name}}';
    assert.strictEqual((0, contracts_1.applyTemplate)(body, ctx), 'ev=UserPromptSubmit cwd=/work/proj home=/home/dev date=2026-01-09 time=04:07 env=bar g=hello n=Ada');
    // Surrounding whitespace inside the braces is trimmed.
    assert.strictEqual((0, contracts_1.applyTemplate)('{{ event }}', ctx), 'UserPromptSubmit');
    // env.* miss resolves to empty string (it is a built-in family), not verbatim.
    assert.strictEqual((0, contracts_1.applyTemplate)('x={{env.NOPE}}y', ctx), 'x=y');
}
function testTemplatePerRouteOverrideOrder() {
    // route vars > config vars.
    assert.deepStrictEqual((0, contracts_1.mergeVars)({ scope: 'global', keep: 'cfg' }, { scope: 'route' }), { scope: 'route', keep: 'cfg' }, 'route vars must override config vars');
    // user vars > built-ins: a var named 'event' shadows the hook-event built-in, and a
    // route-level 'event' wins over a config-level 'event'.
    const merged = (0, contracts_1.mergeVars)({ event: 'CFG' }, { event: 'ROUTE' });
    assert.strictEqual((0, contracts_1.applyTemplate)('{{event}}', tmplCtx({ vars: merged })), 'ROUTE', 'route var must win over config var and the built-in');
    // with no override the built-in resolves.
    assert.strictEqual((0, contracts_1.applyTemplate)('{{event}}', tmplCtx({ vars: {} })), 'UserPromptSubmit');
}
function testTemplateUnknownPlaceholderVerbatim() {
    const ctx = tmplCtx({ vars: { known: 'K' } });
    assert.strictEqual((0, contracts_1.applyTemplate)('a {{unknown}} b', ctx), 'a {{unknown}} b');
    assert.strictEqual((0, contracts_1.applyTemplate)('{{known}}/{{missing}}', ctx), 'K/{{missing}}');
    // Non-env dotted unknown stays verbatim; only the env.* family blanks on miss.
    assert.strictEqual((0, contracts_1.applyTemplate)('{{foo.bar}}', ctx), '{{foo.bar}}');
    // Stray/empty braces are not valid tokens and are left untouched (no escaping syntax).
    assert.strictEqual((0, contracts_1.applyTemplate)('{{}} {{ }} {{no token here}}', ctx), '{{}} {{ }} {{no token here}}');
}
// e2e: drive the real deployed dispatcher with a placeholder doc, config-level vars, and
// a per-route var override; assert built-ins resolve, route vars beat config vars, and an
// unknown placeholder is injected verbatim.
function testTemplateDispatchEndToEnd() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    write(path.join(home, 'cfg', 'config.json'), JSON.stringify({
        version: 1,
        vars: { greeting: 'hello', who: 'config' },
        routes: [{ id: 'tmpl', event: 'UserPromptSubmit', freq: 1, doc: 'docs/tmpl.md', vars: { who: 'route' } }]
    }, null, 2));
    write(path.join(home, 'cfg', 'docs', 'tmpl.md'), 'E={{event}} G={{greeting}} W={{who}} U={{unknown}}\n');
    const body = fireBodies(hook({ session_id: 'tmpl-sess', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
    assert.ok(body, 'templated route should fire');
    assert.ok(body.includes('E=UserPromptSubmit'), 'built-in {{event}} should resolve: ' + body);
    assert.ok(body.includes('G=hello'), 'config var {{greeting}} should resolve: ' + body);
    assert.ok(body.includes('W=route'), 'route var must override config var: ' + body);
    assert.ok(body.includes('U={{unknown}}'), 'unknown placeholder must stay verbatim: ' + body);
}
// R-011 (goal decision #19): due docs are read concurrently but assembled strictly in
// config routes[] order. Four routes with very different doc sizes (so read-completion
// order differs from config order) must still emit in declared order.
function testConcurrentDispatchDeterministicOrder() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    const big = 'B'.repeat(5000);
    const mid = 'M'.repeat(2000);
    setCentralConfig(home, [
        { id: 'first', event: 'UserPromptSubmit', freq: 1, doc: 'docs/first.md' },
        { id: 'second', event: 'UserPromptSubmit', freq: 1, doc: 'docs/second.md' },
        { id: 'third', event: 'UserPromptSubmit', freq: 1, doc: 'docs/third.md' },
        { id: 'fourth', event: 'UserPromptSubmit', freq: 1, doc: 'docs/fourth.md' }
    ], {
        'docs/first.md': 'FIRST-' + big + '\n', // largest: typically reads slowest
        'docs/second.md': 'SECOND\n', // tiny
        'docs/third.md': 'THIRD-' + mid + '\n',
        'docs/fourth.md': 'FOURTH\n'
    });
    const body = fireBodies(hook({ session_id: 'order', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
    assert.ok(body, 'multi-route dispatch should fire');
    const iF = body.indexOf('FIRST-'), iS = body.indexOf('SECOND'), iT = body.indexOf('THIRD-'), i4 = body.indexOf('FOURTH');
    assert.ok(iF !== -1 && iS !== -1 && iT !== -1 && i4 !== -1, 'all four bodies must be present: ' + body);
    assert.ok(iF < iS && iS < iT && iT < i4, 'bodies must appear in config routes[] order regardless of read timing (got offsets ' + [iF, iS, iT, i4].join(',') + ')');
}
function testFailOpenMissingConfig() {
    // Point the dispatcher at a config dir with no cfg/baseline at all.
    const empty = tempConfig();
    const r = hook({ session_id: 'x', hook_event_name: 'UserPromptSubmit', cwd: empty }, empty);
    assert.strictEqual(r.status, 0, 'dispatcher should exit clean with no config');
    assert.strictEqual((r.stdout || '').trim(), '', 'dispatcher should inject nothing with no config');
}
function testMalformedConfigInjectsNothing() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    fs.writeFileSync(path.join(home, 'cfg', 'config.json'), '{ not json', 'utf8');
    const r = hook({ session_id: 'y', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
    assert.strictEqual(r.status, 0, 'dispatcher should not crash on malformed config');
    assert.strictEqual((r.stdout || '').trim(), '', 'malformed config should inject nothing');
}
function testBadRouteSkippedOthersFire() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    setCentralConfig(home, [
        { id: 'BadId!', event: 'UserPromptSubmit', freq: 1, doc: 'docs/x.md' }, // invalid id → skipped
        { id: 'missingdoc', event: 'UserPromptSubmit', freq: 1, doc: 'docs/gone.md' }, // doc absent → skipped at read
        { id: 'good', event: 'UserPromptSubmit', freq: 1, doc: 'docs/good.md' }
    ], { 'docs/good.md': 'GOOD\n' });
    const body = fireBodies(hook({ session_id: 'z', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
    assert.ok(body && body.includes('GOOD'), 'good route should still fire alongside bad routes');
    assert.ok(!body.includes('docs'), 'bad routes must not leak');
}
function testDocPathTraversalRejected() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    // Plant a secret outside cfg/baseline and try to escape to it.
    write(path.join(home, 'secret.md'), 'SECRET\n');
    setCentralConfig(home, [
        { id: 'escape', event: 'UserPromptSubmit', freq: 1, doc: '../../secret.md' }
    ], {});
    const r = hook({ session_id: 'esc', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
    assert.strictEqual((r.stdout || '').trim(), '', 'doc path traversal must be rejected');
    const doctor = run(['doctor'], cfg);
    assert.notStrictEqual(doctor.status, 0, 'doctor should fail on out-of-range doc');
    assert.match(doctor.stdout, /out-of-range doc/);
}
function testDocSymlinkEscapeRejected() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    write(path.join(home, 'secret.md'), 'SECRET\n');
    const link = path.join(home, 'cfg', 'docs', 'link.md');
    try {
        fs.symlinkSync(path.join(home, 'secret.md'), link);
    }
    catch (e) {
        return; // Windows without symlink privilege: covered where the platform allows it.
    }
    setCentralConfig(home, [
        { id: 'link', event: 'UserPromptSubmit', freq: 1, doc: 'docs/link.md' }
    ], {});
    const r = hook({ session_id: 'sym', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
    assert.strictEqual((r.stdout || '').trim(), '', 'doc symlink escape must be rejected');
    const doctor = run(['doctor'], cfg);
    assert.notStrictEqual(doctor.status, 0, 'doctor should fail on symlink escape');
    assert.match(doctor.stdout, /resolves outside the config folder/);
}
function testOversizeDocSkipped() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    setCentralConfig(home, [
        { id: 'big', event: 'UserPromptSubmit', freq: 1, doc: 'docs/big.md' }
    ], { 'docs/big.md': 'x'.repeat(10_001) });
    const r = hook({ session_id: 'big', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
    assert.strictEqual((r.stdout || '').trim(), '', 'oversize doc should not produce non-verbatim fallback output');
    const doctor = run(['doctor'], cfg);
    assert.notStrictEqual(doctor.status, 0, 'doctor should fail on doc over context cap');
    assert.match(doctor.stdout, /10,000 character context cap/);
}
// --- doctor / verify --------------------------------------------------------
function testDoctorReportsAndFixes() {
    const cfg = tempConfig();
    assert.strictEqual(run(['install'], cfg).status, 0);
    const healthy = run(['doctor'], cfg);
    assert.strictEqual(healthy.status, 0, healthy.stderr || healthy.stdout);
    assert.match(healthy.stdout, /doctor: healthy/);
    // Break it: delete the deployed dispatcher → doctor FAILs.
    fs.unlinkSync(path.join(cfg, 'hooks', 'baseline-recital.js'));
    const broken = run(['doctor'], cfg);
    assert.strictEqual(broken.status, 1, broken.stdout);
    assert.match(broken.stdout, /\[FAIL\] dispatcher link/);
    const fixed = run(['doctor', '--fix'], cfg);
    assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
    assert.match(fixed.stdout, /doctor: installation repaired/);
}
function testStatusAndDoctorRepairPerAgentContracts() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    const healthy = run(['status'], cfg);
    assert.strictEqual(healthy.status, 0, healthy.stderr || healthy.stdout);
    assert.match(statusAgentSection(healthy.stdout, 'claude-code'), /contracts\s+: OK/, 'status should report healthy Claude contracts');
    assert.match(statusAgentSection(healthy.stdout, 'codex'), /contracts\s+: OK/, 'status should report healthy Codex contracts');
    fs.unlinkSync(agentHookContracts(cfg));
    fs.unlinkSync(agentHookContracts(codex));
    const degraded = run(['status'], cfg);
    assert.strictEqual(degraded.status, 0, degraded.stderr || degraded.stdout);
    assert.match(statusAgentSection(degraded.stdout, 'claude-code'), /contracts\s+: MISSING/, 'status should report missing Claude contracts');
    assert.match(statusAgentSection(degraded.stdout, 'codex'), /contracts\s+: MISSING/, 'status should report missing Codex contracts');
    const broken = run(['doctor'], cfg);
    assert.strictEqual(broken.status, 1, broken.stdout);
    assert.match(broken.stdout, /\[FAIL\] contracts link: missing/, 'doctor should check per-agent contracts links');
    const fixed = run(['doctor', '--fix'], cfg);
    assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
    assert.match(fixed.stdout, /doctor: installation repaired/);
    assert.strictEqual(readThrough(agentHookContracts(cfg)), readThrough(centralHookContracts(home)), 'doctor --fix did not repair Claude contracts');
    assert.strictEqual(readThrough(agentHookContracts(codex)), readThrough(centralHookContracts(home)), 'doctor --fix did not repair Codex contracts');
}
function testDoctorDetectsMissingDoc() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    fs.unlinkSync(path.join(home, 'cfg', 'docs', 'baseline.md'));
    const doctor = run(['doctor'], cfg);
    assert.notStrictEqual(doctor.status, 0, 'doctor should fail on missing doc');
    assert.match(doctor.stdout, /doc not readable/);
}
function testDoctorFixRefusesInvalidSettings() {
    const cfg = tempConfig();
    const settings = path.join(cfg, 'settings.json');
    write(settings, '{ invalid json');
    const fixed = run(['doctor', '--fix'], cfg);
    assert.notStrictEqual(fixed.status, 0, 'doctor --fix unexpectedly succeeded on invalid settings');
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{ invalid json');
}
function testVerifyRequiresSelectedRouteEvent() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    setCentralConfig(home, [
        { id: 'read', event: 'PreToolUse', freq: 1, doc: 'docs/read.md' }
    ], { 'docs/read.md': 'READ\n' });
    assert.strictEqual(run(['install'], cfg).status, 0);
    let settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    settings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } };
    write(path.join(cfg, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    const verify = run(['verify'], cfg);
    assert.notStrictEqual(verify.status, 0, 'verify should fail when selected route event is not wired');
    assert.match(verify.stdout, /no baseline hook wired for PreToolUse/);
}
function testVerifyToolEventFires() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    setCentralConfig(home, [
        { id: 'tool', event: 'PreToolUse', freq: 1, doc: 'docs/tool.md' }
    ], { 'docs/tool.md': 'TOOL\n' });
    assert.strictEqual(run(['install'], cfg).status, 0);
    // Route matchers are gone: verify drives the PreToolUse route with the plain
    // default synthetic tool name and the route fires for any tool.
    const verify = run(['verify'], cfg);
    assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /verify: PASS/);
}
function testUpdateRedeploysDispatcher() {
    const cfg = tempConfig();
    assert.strictEqual(run(['install'], cfg).status, 0);
    const deployed = path.join(cfg, 'hooks', 'baseline-recital.js');
    fs.writeFileSync(deployed, '// tampered\n');
    const update = run(['update'], cfg);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    assert.strictEqual(fs.readFileSync(deployed, 'utf8'), fs.readFileSync(dispatcher, 'utf8'), 'update did not restore the dispatcher from repo source');
    assert.strictEqual(run(['verify'], cfg).status, 0);
}
function testUninstallKeepsCentralConfig() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    const uninstall = run(['uninstall'], cfg);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(!settings.hooks || !settings.hooks.UserPromptSubmit || settings.hooks.UserPromptSubmit.length === 0, 'uninstall left a wired hook');
    assert.ok(!fs.existsSync(path.join(cfg, 'hooks', 'baseline-recital.js')), 'agent dispatcher link not removed');
    assert.ok(!fs.existsSync(agentHookContracts(cfg)), 'agent contracts link not removed');
    assert.ok(!fs.existsSync(agentHookContracts(codex)), 'codex contracts link not removed');
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'config.json')), 'central config was wrongly removed');
}
function testUninstallPreservesDivergentPerAgentContracts() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    const unmanaged = 'OPERATOR-MANAGED CONTRACTS\n';
    fs.rmSync(agentHookContracts(codex), { force: true });
    write(agentHookContracts(codex), unmanaged);
    const uninstall = run(['uninstall'], cfg);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.ok(!fs.existsSync(agentHookContracts(cfg)), 'uninstall should remove managed Claude contracts');
    assert.strictEqual(readThrough(agentHookContracts(codex)), unmanaged, 'uninstall should preserve divergent/unmanaged Codex contracts');
    assert.ok(fs.existsSync(centralHookContracts(home)), 'uninstall should keep central contracts');
}
function testUninstallRemovesOnlyManagedCodexPluginActivation() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    const toml = path.join(codex, 'config.toml');
    const otherCache = path.join(codex, 'plugins', 'cache', 'other-market', 'other-plugin', 'local', 'keep.txt');
    const unrelatedToml = '[profiles.default]\n' +
        'model = "gpt-5.1"\n' +
        '\n' +
        '[plugins."other@market"]\n' +
        'enabled = true\n';
    write(toml, unrelatedToml);
    write(otherCache, 'KEEP\n');
    assert.strictEqual(run(['install'], cfg).status, 0);
    assertCodexPayload(codexPluginCache(codex), 'installed Codex cache plugin');
    assertEmptyCodexActivationTable(toml);
    const uninstall = run(['uninstall'], cfg);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.ok(!fs.existsSync(codexPluginCache(codex)), 'uninstall should remove only the managed Codex cache/local activation');
    assert.strictEqual(readThrough(otherCache), 'KEEP\n', 'uninstall should preserve unrelated Codex plugin caches');
    const after = readThrough(toml);
    assert.ok(!after.includes(CODEX_ACTIVATION_TABLE), 'uninstall should remove only the managed Codex activation table');
    assert.ok(after.includes('[profiles.default]\nmodel = "gpt-5.1"'), 'uninstall should preserve unrelated profile TOML');
    assert.ok(after.includes('[plugins."other@market"]\nenabled = true'), 'uninstall should preserve unrelated plugin TOML');
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'config.json')), 'uninstall should keep central config');
    assert.ok(fs.existsSync(path.join(home, 'skills', 'baseline')), 'uninstall should keep the central Claude skill payload');
    assert.ok(fs.existsSync(centralCodexPlugin(home)), 'uninstall should keep the central Codex plugin payload');
}
function testUninstallPreservesCodexArrayTablesAfterManagedActivation() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    const toml = path.join(codex, 'config.toml');
    assert.strictEqual(run(['install'], cfg).status, 0);
    const beforeUninstall = '[profiles.default]\n' +
        'model = "gpt-5.1"\n' +
        '\n' +
        CODEX_ACTIVATION_TABLE + '\n' +
        '[[plugins.something]]\n' +
        'name = "keep-plugin"\n' +
        'enabled = true\n' +
        '\n' +
        '[[tool.foo]]\n' +
        'name = "keep-tool"\n' +
        'path = "survives"\n';
    write(toml, beforeUninstall);
    const uninstall = run(['uninstall'], cfg);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    const after = readThrough(toml);
    assert.ok(!after.includes(CODEX_ACTIVATION_TABLE), 'uninstall should remove the managed Codex activation table');
    assert.ok(after.includes('[[plugins.something]]\nname = "keep-plugin"\nenabled = true'), 'uninstall should preserve unrelated plugin array-table entries after the managed activation table');
    assert.ok(after.includes('[[tool.foo]]\nname = "keep-tool"\npath = "survives"'), 'uninstall should preserve unrelated tool array-table entries after the managed activation table');
}
function testUninstallPreservesCodexQuotedProjectTableAfterManagedActivation() {
    const cases = [
        {
            name: 'ordinary double-quoted table key containing #',
            section: CODEX_QUOTED_PROJECT_TRUST + '\n'
        },
        {
            name: 'ordinary single-quoted table key containing #',
            section: "[projects.'C:/work#prod']\ntrust_level = \"trusted\"\n"
        },
        {
            name: 'array-table key containing #',
            section: '[[projects."C:/work#prod"]]\ntrust_level = "trusted"\n'
        }
    ];
    for (const c of cases) {
        const cfg = tempConfig();
        const codex = codexFor(cfg);
        const toml = path.join(codex, 'config.toml');
        assert.strictEqual(run(['install'], cfg).status, 0);
        const beforeUninstall = CODEX_ACTIVATION_TABLE + '\n' +
            c.section;
        write(toml, beforeUninstall);
        const uninstall = run(['uninstall'], cfg);
        assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
        const after = readThrough(toml);
        assert.ok(!after.includes(CODEX_ACTIVATION_TABLE), c.name + ': uninstall should remove the managed Codex activation table');
        assert.ok(after.includes(c.section.trim()), c.name + ': uninstall should preserve the quoted # table immediately after the managed activation table');
    }
}
function testUninstallPreservesCodexQuotedBracketTomlSectionsAfterManagedActivation() {
    const cases = [
        {
            name: 'ordinary double-quoted table key containing ]',
            section: '[projects."team]prod"]\ntrust_level = "trusted"\n'
        },
        {
            name: 'ordinary single-quoted table key containing ]',
            section: "[projects.'team]prod']\ntrust_level = \"trusted\"\n"
        },
        {
            name: 'array-table key containing ]',
            section: '[[projects."team]prod"]]\ntrust_level = "trusted"\n'
        }
    ];
    for (const c of cases) {
        const cfg = tempConfig();
        const codex = codexFor(cfg);
        const toml = path.join(codex, 'config.toml');
        assert.strictEqual(run(['install'], cfg).status, 0);
        const beforeUninstall = CODEX_ACTIVATION_TABLE + '\n' +
            c.section;
        write(toml, beforeUninstall);
        const uninstall = run(['uninstall'], cfg);
        assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
        const after = readThrough(toml);
        assert.ok(!after.includes(CODEX_ACTIVATION_TABLE), c.name + ': uninstall should remove the managed Codex activation table');
        assert.ok(after.includes(c.section.trim()), c.name + ': uninstall should preserve the quoted ] table immediately after the managed activation table');
    }
}
function testUninstallRemovesSingleQuotedManagedCodexPluginActivation() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    const toml = path.join(codex, 'config.toml');
    assert.strictEqual(run(['install'], cfg).status, 0);
    const beforeUninstall = "[plugins.'baseline@baseline']\n" +
        'enabled = true\n' +
        '[profiles.default]\n' +
        'model = "gpt-5.1"\n';
    write(toml, beforeUninstall);
    const uninstall = run(['uninstall'], cfg);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    const after = readThrough(toml);
    assert.strictEqual(after, '[profiles.default]\nmodel = "gpt-5.1"\n', 'uninstall should remove single-quoted managed activation and preserve the following ordinary table');
}
function testUninstallPreservesBaselineCodexPluginArrayTable() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    const toml = path.join(codex, 'config.toml');
    assert.strictEqual(run(['install'], cfg).status, 0);
    const arrayActivation = '[[plugins."baseline@baseline"]]\n' +
        'enabled = true\n';
    write(toml, arrayActivation);
    const uninstall = run(['uninstall'], cfg);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.strictEqual(readThrough(toml), arrayActivation, 'uninstall should not treat a Codex plugin array-table as the managed ordinary activation table');
}
// --- repo invariants --------------------------------------------------------
function assertGitVisible(file) {
    const r = (0, child_process_1.spawnSync)('git', ['check-ignore', '-q', '--', file], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(r.status, 1, file + ' should be visible to git; git check-ignore status=' + r.status);
}
// Inverse of assertGitVisible: the path must be gitignored (git check-ignore exits 0
// when a path is ignored). The .arca/<proj>-sp/ knowledge database is local-only and
// must never be visible to git.
function assertGitIgnored(file) {
    const r = (0, child_process_1.spawnSync)('git', ['check-ignore', '-q', '--', file], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, file + ' should be gitignored; git check-ignore status=' + r.status);
}
function testChecksumsMatchBinaries() {
    const sumsPath = path.join(root, 'bin', 'SHA256SUMS');
    assert.ok(fs.existsSync(sumsPath), 'bin/SHA256SUMS is missing');
    const raw = fs.readFileSync(sumsPath, 'utf8');
    assert.ok(!raw.includes('\r'), 'SHA256SUMS must use LF line endings, found CRLF');
    const lines = raw.split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'SHA256SUMS is empty');
    const listed = new Set();
    for (const line of lines) {
        const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
        assert.ok(m, 'malformed SHA256SUMS line: ' + line);
        const [, expected, name] = m;
        listed.add(name);
        const file = path.join(root, 'bin', name);
        assert.ok(fs.existsSync(file), 'missing binary listed in SHA256SUMS: ' + name);
        const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        assert.strictEqual(actual, expected, 'sha256 mismatch for ' + name);
    }
    for (const f of fs.readdirSync(path.join(root, 'bin'))) {
        if (/^baseline-recital-/.test(f)) {
            assert.ok(listed.has(f), 'prebuilt ' + f + ' has no entry in SHA256SUMS');
        }
    }
}
// R-014 (goal decision #21): zero runtime dependencies is a guarded contract, not a
// hope. Assert package.json declares none, and that src/ + scripts/ import/require only
// Node built-ins or in-repo relative paths — never a bare third-party specifier.
function testNoRuntimeDependencies() {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = pkg.dependencies;
    assert.ok(deps === undefined || (deps && typeof deps === 'object' && !Array.isArray(deps) && Object.keys(deps).length === 0), 'package.json must declare no runtime dependencies (found ' + JSON.stringify(deps) + ')');
    const builtins = new Set(module_1.builtinModules);
    const allowed = (spec) => {
        if (spec.startsWith('./') || spec.startsWith('../'))
            return true; // in-repo relative
        const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
        return builtins.has(bare) || builtins.has(bare.split('/')[0]);
    };
    const specifiers = (text, res) => {
        const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '); // drop comments
        const out = [];
        for (const re of res) {
            const r = new RegExp(re.source, 'g');
            let m;
            while ((m = r.exec(code)) !== null)
                out.push(m[m.length - 1]);
        }
        return out;
    };
    const scan = (dir, ext, res) => {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(ext))
                continue;
            for (const spec of specifiers(fs.readFileSync(path.join(dir, f), 'utf8'), res)) {
                assert.ok(allowed(spec), path.join(dir, f) + ' imports a non-builtin, non-relative module "' + spec + '"');
            }
        }
    };
    scan(path.join(root, 'src'), '.ts', [/\bfrom\s+['"]([^'"]+)['"]/, /\bimport\s+['"]([^'"]+)['"]/]);
    scan(path.join(root, 'scripts'), '.js', [/\brequire\(\s*['"]([^'"]+)['"]\s*\)/]);
}
function testPresetsAreValid() {
    for (const preset of ['minimal', 'default']) {
        const cfgPath = path.join(root, 'presets', preset, 'config.json');
        assert.ok(fs.existsSync(cfgPath), 'missing preset config: ' + preset);
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.strictEqual(cfg.version, 1, preset + ' config version must be 1');
        assert.ok(Array.isArray(cfg.routes) && cfg.routes.length >= 1, preset + ' must have at least one route');
        for (const r of cfg.routes) {
            assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(r.id), preset + ' route id not a slug: ' + r.id);
            assert.ok(fs.existsSync(path.join(root, 'presets', preset, r.doc)), preset + ' route doc missing: ' + r.doc);
        }
        // Non-routed editing-guidance README is seeded but never referenced by a route.
        assert.ok(fs.existsSync(path.join(root, 'presets', preset, 'README.md')), preset + ' missing editing-guidance README');
        assert.ok(!cfg.routes.some((r) => /README/.test(r.doc)), preset + ' must not route the README');
    }
}
// R-006 (goal decision #13): the minimal preset is the neutral, project-agnostic
// guardrail floor — no personal branding, no recital opener, and not a near-copy of
// the curated default preset doc. testPresetsAreValid covers only JSON/route shape.
function testMinimalPresetIsNeutral() {
    const minimal = fs.readFileSync(path.join(root, 'presets', 'minimal', 'docs', 'baseline.md'), 'utf8');
    const dflt = fs.readFileSync(path.join(root, 'presets', 'default', 'docs', 'baseline.md'), 'utf8');
    assert.ok(!minimal.includes('LI BASELINE'), 'minimal preset doc must not carry the personal "LI BASELINE" marker');
    assert.ok(!minimal.includes('LI BASELINE ALIGNED:'), 'minimal preset doc must not use the personal recital opener');
    const normalize = (s) => s.replace(/\s+/g, ' ').trim();
    assert.notStrictEqual(normalize(minimal), normalize(dflt), 'minimal preset doc must not be near-identical to the default preset doc');
}
function testBrandAssetsAndReadme() {
    for (const name of ['logo.png', 'logo.svg', 'logo.txt', 'logo.ans']) {
        assert.ok(fs.existsSync(path.join(root, 'resources', name)), 'missing resource asset: ' + name);
        assertGitVisible(path.join('resources', name));
    }
    const oldPrefix = 'baseline_' + 'design_02_' + 'stencil_ruler_';
    for (const name of [oldPrefix + 'logo.png', oldPrefix + 'logo.svg', oldPrefix + 'title_plain.txt', oldPrefix + 'title.ans']) {
        assert.ok(!fs.existsSync(path.join(root, 'resources', name)), 'old resource asset still present: ' + name);
    }
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(readme, /resources\/logo\.png/);
    assert.match(readme, /resources\/logo\.ans/);
    assert.match(readme, /resources\/logo\.txt/);
    assert.ok(!readme.includes(oldPrefix), 'README still references old resource asset names');
    // R-007 (I-006): the text/ANSI logos are ASCII, not "ASM".
    assert.ok(!readme.includes('ASM logo'), 'README must not call the logos "ASM" (typo for ASCII)');
    assert.match(readme, /ASCII logo/, 'README should describe the ASCII logos');
}
function testDocsDescribeRoutesModel() {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
    // Canonical goal docs live in the persistent knowledge database under
    // .arca/<proj>-sp/goal/, which is intentionally gitignored — git must never
    // see those knowledge files.
    for (const doc of ['vision.md', 'architecture.md', 'vocabulary.md', 'plain.md']) {
        assertGitIgnored(path.join('.arca', 'baseline-sp', 'goal', doc));
    }
    for (const [name, text] of [['README', readme], ['SKILL', skill]]) {
        assert.match(text, /cfg\/baseline/, name + ' should describe the cfg/baseline config folder');
        assert.match(text, /config\.json/, name + ' should mention config.json');
        assert.match(text, /route/i, name + ' should describe routes');
    }
}
// R-005 (goal decision #12): install wrappers expose only a curated flag set. The native
// runtime is now available via `manage.js install --runtime prebuilt|build` (R-009), but the
// install WRAPPERS deliberately do NOT advertise --build/--runtime — that surface stays with
// the manager. This guards the wrappers against re-growing those flags.
function testInstallWrappersHaveNoBuildFlag() {
    const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    const ps1 = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
    for (const [name, text] of [['install.sh', sh], ['install.ps1', ps1]]) {
        assert.ok(!text.includes('--build'), name + ' must not advertise --build');
        assert.ok(!text.includes('-build'), name + ' must not advertise -build');
        assert.ok(!text.includes('--runtime'), name + ' must not advertise --runtime');
    }
    assert.ok(!ps1.includes('[switch]$build'), 'install.ps1 must not declare a -build switch');
    // Wrappers still forward the install invocation to the Node manager.
    assert.ok(sh.includes('install "$@"'), 'install.sh must still forward install "$@" to the manager');
    assert.ok(ps1.includes('$RemainingArgs'), 'install.ps1 must still forward $RemainingArgs to the manager');
}
// R-007 (goal decision #14): one canonical phrasing states the config-folder default
// everywhere in docs and generated control-surface text — README, both SKILL docs, and
// the generated skill text use <install root>/cfg, and none reverts to the divergent
// bare ~/.baseline/cfg form.
function testCfgLocationPhrasingIsCanonical() {
    const sources = [
        ['root SKILL.md', fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')],
        ['skills/baseline/SKILL.md', fs.readFileSync(path.join(root, 'skills', 'baseline', 'SKILL.md'), 'utf8')],
        ['src/manage.ts', fs.readFileSync(path.join(root, 'src', 'manage.ts'), 'utf8')],
        ['README.md', fs.readFileSync(path.join(root, 'README.md'), 'utf8')],
    ];
    for (const [name, text] of sources) {
        assert.ok(text.includes('<install root>/cfg'), name + ' must state the config folder as <install root>/cfg');
        assert.ok(!text.includes('~/.baseline/cfg'), name + ' must not use the divergent bare ~/.baseline/cfg form');
    }
}
// R-009 (goal decision #17): one canonical sentence states the install-root resolution
// order everywhere in docs and generated control-surface text, and the divergent
// two-rung phrasing (which omits the installed-manager rung) no longer survives.
function testInstallRootPhrasingIsCanonical() {
    const clause = '`BASELINE_HOME`, else the installed manager\'s own root, else `~/.baseline`';
    const divergent = '`BASELINE_HOME`, else `~/.baseline`'; // two-rung form, must not survive
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const sources = [
        ['README.md', readme],
        ['root SKILL.md', fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')],
        ['skills/baseline/SKILL.md', fs.readFileSync(path.join(root, 'skills', 'baseline', 'SKILL.md'), 'utf8')],
        ['src/manage.ts', fs.readFileSync(path.join(root, 'src', 'manage.ts'), 'utf8')],
    ];
    for (const [name, text] of sources) {
        assert.ok(text.includes(clause), name + ' must state the canonical install-root resolution order');
        assert.ok(!text.includes(divergent), name + ' must not use the divergent two-rung install-root phrasing');
    }
    // Singular in the primary doc: the canonical order is stated once, not competing forms.
    assert.strictEqual(readme.split(clause).length - 1, 1, 'README must state the install-root order exactly once');
}
function testCodexPluginManifest() {
    const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
    assert.ok(fs.existsSync(manifestPath), 'Codex plugin manifest missing');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.name, 'baseline');
    assert.strictEqual(manifest.skills, './skills/');
    assert.ok(fs.existsSync(path.join(root, 'skills', 'baseline', 'SKILL.md')), 'Codex plugin skill wrapper missing');
}
function testClaudePluginManifest() {
    const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
    assert.ok(fs.existsSync(manifestPath), 'Claude plugin manifest missing');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.name, 'baseline');
    // Skill-only plugin: it must NOT declare hooks. baseline's hook wiring lives in
    // settings.json and is managed by the installer, additive to any plugin hooks.
    assert.ok(!('hooks' in manifest), 'Claude plugin manifest must not declare hooks (skill-only)');
    // Top-level SKILL.md is exposed via "skills": ["./"].
    assert.ok(Array.isArray(manifest.skills) && manifest.skills.indexOf('./') !== -1, 'Claude plugin manifest should expose the top-level skill via "skills": ["./"]');
}
// install deploys self-contained control surfaces: Claude gets the skills-dir
// .claude-plugin payload, Codex gets a .codex-plugin cache/activation, and both
// generated skill payloads point normal commands at the installed manager.
function testControlSurfacePluginsDeployed() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    // Central Claude payload (manifest + generated SKILL.md wrapper) exists.
    assert.ok(fs.existsSync(path.join(home, 'skills', 'baseline', '.claude-plugin', 'plugin.json')), 'central Claude skill manifest missing');
    assert.ok(fs.existsSync(path.join(home, 'skills', 'baseline', 'SKILL.md')), 'central Claude skill SKILL.md missing');
    // Linked into the Claude agent skills dir so Claude loads it as baseline@skills-dir.
    const agentManifest = path.join(cfg, 'skills', 'baseline', '.claude-plugin', 'plugin.json');
    const agentSkill = path.join(cfg, 'skills', 'baseline', 'SKILL.md');
    assert.ok(fs.existsSync(agentManifest), 'Claude skill plugin not linked into the agent skills dir');
    assert.strictEqual(JSON.parse(readThrough(agentManifest)).name, 'baseline');
    const skillBody = readThrough(agentSkill);
    assert.match(skillBody, /name:\s*baseline/, 'deployed Claude skill missing name frontmatter');
    assertControlSurfaceCommandsUseInstalledManager(skillBody, home, 'deployed Claude skill');
    // Codex parity is a marketplace/cache payload, not the Claude skills-dir payload.
    assertCodexPayload(centralCodexPlugin(home), 'central Codex plugin');
    assertCodexPayload(codexPluginCache(codex), 'Codex cache plugin');
    assertControlSurfaceCommandsUseInstalledManager(readThrough(path.join(codexPluginCache(codex), 'skills', 'baseline', 'SKILL.md')), home, 'deployed Codex skill');
    assertNoClaudePayloadInCodex(codex);
    // status + doctor report both central payloads and the per-agent links healthy.
    const status = run(['status'], cfg);
    assert.match(status.stdout, /skill plugin : OK/, 'status should report the Claude agent skill link');
    assert.match(status.stdout, /codex plugin\s+: present at /, 'status should report the central Codex plugin payload');
    assert.match(status.stdout, /codex cache\s+: OK/, 'status should report the Codex cache materialized');
    assert.match(status.stdout, /codex config\s+: OK/, 'status should report the Codex plugin activation table');
    const doctor = run(['doctor'], cfg);
    assert.strictEqual(doctor.status, 0, doctor.stdout);
    assert.match(doctor.stdout, /claude skill plugin: central payload deployed; points at installed manager/);
    assert.match(doctor.stdout, /skill link: claude-code linked to center/);
    assert.match(doctor.stdout, /codex plugin payload: central payload deployed; points at installed manager/);
    assert.match(doctor.stdout, /codex plugin cache: codex cache linked to center/);
    assert.match(doctor.stdout, /codex plugin activation: codex config\.toml contains \[plugins\."baseline@baseline"\]/);
    // uninstall removes per-agent links/cache but keeps central payloads.
    assert.strictEqual(run(['uninstall'], cfg).status, 0);
    assert.ok(!fs.existsSync(path.join(cfg, 'skills', 'baseline')), 'uninstall should remove the Claude agent skill link');
    assert.ok(!fs.existsSync(codexPluginCache(codex)), 'uninstall should remove the Codex agent cache');
    assert.ok(fs.existsSync(path.join(home, 'skills', 'baseline')), 'uninstall should keep the central Claude skill payload');
    assert.ok(fs.existsSync(centralCodexPlugin(home)), 'uninstall should keep the central Codex plugin payload');
}
function testCodexPluginPayloadDeployedAndActivated() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    const toml = path.join(codex, 'config.toml');
    const unrelatedToml = '# operator config stays\n' +
        '[profiles.default]\n' +
        'model = "gpt-5.1"\n' +
        '\n' +
        CODEX_QUOTED_PROJECT_TRUST + '\n';
    write(toml, unrelatedToml);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assertCodexPayload(centralCodexPlugin(home), 'central Codex plugin');
    assertCodexPayload(codexPluginCache(codex), 'Codex cache plugin');
    assert.strictEqual(readThrough(path.join(codexPluginCache(codex), '.codex-plugin', 'plugin.json')), readThrough(path.join(centralCodexPlugin(home), '.codex-plugin', 'plugin.json')), 'Codex cache plugin manifest should resolve to the central payload');
    assertControlSurfaceCommandsUseInstalledManager(readThrough(path.join(codexPluginCache(codex), 'skills', 'baseline', 'SKILL.md')), home, 'Codex cache skill');
    assertNoClaudePayloadInCodex(codex);
    const after = readThrough(toml);
    assert.ok(after.includes('# operator config stays'), 'install should preserve unrelated TOML comments');
    assert.ok(after.includes('[profiles.default]\nmodel = "gpt-5.1"'), 'install should preserve unrelated TOML tables');
    assert.ok(after.includes(CODEX_QUOTED_PROJECT_TRUST), 'install should preserve quoted project trust TOML with # in table key');
    assertEmptyCodexActivationTable(toml);
}
function testUpdateRepairsCodexPluginCacheAndActivation() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    const toml = path.join(codex, 'config.toml');
    const unrelatedToml = '[profiles.default]\n' +
        'model = "gpt-5.1"\n' +
        '\n' +
        CODEX_QUOTED_PROJECT_TRUST + '\n';
    write(toml, unrelatedToml);
    assert.strictEqual(run(['install'], cfg).status, 0);
    fs.rmSync(codexPluginCache(codex), { recursive: true, force: true });
    write(toml, unrelatedToml);
    const update = run(['update'], cfg);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    assertCodexPayload(codexPluginCache(codex), 'repaired Codex cache plugin');
    const after = readThrough(toml);
    assert.ok(after.includes('[profiles.default]\nmodel = "gpt-5.1"'), 'update should preserve unrelated profile TOML while repairing activation');
    assert.ok(after.includes(CODEX_QUOTED_PROJECT_TRUST), 'update should preserve quoted project trust TOML while repairing activation');
    assertEmptyCodexActivationTable(toml);
}
function testDoctorFixRepairsCodexPluginCacheAndActivation() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    const toml = path.join(codex, 'config.toml');
    const unrelatedToml = '[profiles.default]\nmodel = "gpt-5.1"\n';
    write(toml, unrelatedToml);
    assert.strictEqual(run(['install'], cfg).status, 0);
    fs.rmSync(codexPluginCache(codex), { recursive: true, force: true });
    write(toml, unrelatedToml);
    const broken = run(['doctor'], cfg);
    assert.strictEqual(broken.status, 1, broken.stdout);
    assert.match(broken.stdout, /\[FAIL\] codex plugin cache/);
    assert.match(broken.stdout, /\[FAIL\] codex plugin activation/);
    const fixed = run(['doctor', '--fix'], cfg);
    assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
    assert.match(fixed.stdout, /doctor: installation repaired/);
    assertCodexPayload(codexPluginCache(codex), 'doctor-repaired Codex cache plugin');
    assert.ok(readThrough(toml).includes(unrelatedToml.trim()), 'doctor --fix should preserve unrelated TOML while repairing activation');
    assertEmptyCodexActivationTable(toml);
}
// install with BASELINE_CFG set: config lives FLAT in the external folder, the install
// root holds only artifacts, <installRoot>/cfg symlinks to the external folder, agents
// read through the chain, and --force refuses to clobber the (tracked) external config.
function testExternalConfigLocation() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const external = cfg + '-extcfg';
    const env = { BASELINE_CFG: external };
    const install = run(['install'], cfg, undefined, env);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    // Config files live FLAT in the external folder; no artifacts leak into it.
    assert.ok(fs.existsSync(path.join(external, 'config.json')), 'external config.json missing');
    assert.ok(fs.existsSync(path.join(external, 'docs', 'baseline.md')), 'external doc missing');
    assert.ok(!fs.existsSync(path.join(external, 'hooks')), 'external config must not hold artifacts (hooks)');
    assert.ok(!fs.existsSync(path.join(external, 'skills')), 'external config must not hold artifacts (skills)');
    // <installRoot>/cfg is a symlink to the external folder; agents read through the chain.
    assert.ok(fs.lstatSync(path.join(home, 'cfg')).isSymbolicLink(), '<installRoot>/cfg should symlink to BASELINE_CFG');
    assert.ok(fs.existsSync(path.join(cfg, 'cfg', 'baseline', 'config.json')), 'agent cannot read external config via link chain');
    // doctor healthy + reports the external config location; verify fires.
    const doctor = run(['doctor'], cfg, undefined, env);
    assert.strictEqual(doctor.status, 0, doctor.stdout);
    assert.match(doctor.stdout, /config location: external/);
    assert.strictEqual(run(['verify'], cfg, undefined, env).status, 0, 'verify should pass with external config');
    // --force must refuse to delete tracked external config.
    const forced = run(['install', '--force'], cfg, undefined, env);
    assert.notStrictEqual(forced.status, 0, '--force should refuse on external config');
    assert.match(forced.stderr, /refusing --force/);
    assert.ok(fs.existsSync(path.join(external, 'config.json')), '--force must not delete external config');
}
function testShellWrappersExecutable() {
    for (const file of ['install.sh', 'update.sh', 'doctor.sh', 'uninstall.sh', 'build.sh']) {
        const r = (0, child_process_1.spawnSync)('git', ['ls-files', '--stage', '--', file], { cwd: root, encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /^100755 /, file + ' should be executable in git');
    }
}
// --- guided agent selection on install (R-004) -----------------------------
// --agents selects a subset: only claude-code is wired, codex is left alone, and
// the selected set is recorded verbatim in <installRoot>/state.json.
function testAgentsFlagSelectsSubset() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    const install = run(['install', '--agents', 'claude-code'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks && settings.hooks.UserPromptSubmit, 'claude-code should be wired');
    assert.ok(!fs.existsSync(path.join(codex, 'hooks.json')), 'codex must not be wired when not selected');
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.deepStrictEqual(state, { agents: ['claude-code'] }, 'state.json should record exactly the selected set');
}
// --agents with the full comma list wires both agents and records both.
function testAgentsFlagBothExplicit() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    const install = run(['install', '--agents', 'claude-code,codex'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks && settings.hooks.UserPromptSubmit, 'claude-code should be wired');
    const hooks = JSON.parse(fs.readFileSync(path.join(codex, 'hooks.json'), 'utf8'));
    assert.ok(hooks.hooks && hooks.hooks.UserPromptSubmit, 'codex should be wired');
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.deepStrictEqual(state.agents.slice().sort(), ['claude-code', 'codex'], 'state.json should record both');
}
// An unknown agent name is a hard error (non-zero exit) that names the offender.
function testUnknownAgentErrors() {
    const cfg = tempConfig();
    const install = run(['install', '--agents', 'bogus'], cfg);
    assert.notStrictEqual(install.status, 0, 'unknown agent should be a hard error');
    assert.match((install.stderr || '') + (install.stdout || ''), /bogus/, 'error should name the bad agent');
}
// Selecting an agent whose config dir does not exist is a hard error (D2: strictly
// limited to detected agents).
function testNotDetectedAgentErrors() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    fs.rmSync(codex, { recursive: true, force: true });
    const install = run(['install', '--agents', 'codex'], cfg);
    assert.notStrictEqual(install.status, 0, 'selecting a not-detected agent should fail');
    assert.match((install.stderr || '') + (install.stdout || ''), /codex/, 'error should name the not-detected agent');
}
// Non-interactive (spawnSync is not a TTY) with no --agents selects ALL detected.
function testNonTtyWiresAllDetected() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assert.ok(fs.existsSync(path.join(cfg, 'settings.json')), 'claude-code should be wired');
    assert.ok(fs.existsSync(path.join(codex, 'hooks.json')), 'codex should be wired');
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.deepStrictEqual(state.agents.slice().sort(), ['claude-code', 'codex'], 'state.json should record both detected');
}
// Selection is strictly limited to detected agents: with the codex config dir
// removed, a plain install wires only claude-code and records only it.
function testStrictlyDetectedOnly() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    fs.rmSync(codex, { recursive: true, force: true });
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assert.ok(fs.existsSync(path.join(cfg, 'settings.json')), 'claude-code should be wired');
    assert.ok(!fs.existsSync(path.join(codex, 'hooks.json')), 'codex must not be wired when its config dir is absent');
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.deepStrictEqual(state.agents, ['claude-code'], 'state.json should record only the detected agent');
}
// Zero detected agents => non-zero exit with guidance; nothing wired or recorded.
function testZeroDetectedErrors() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(codex, { recursive: true, force: true });
    const install = run(['install'], cfg);
    assert.notStrictEqual(install.status, 0, 'zero detected agents should fail');
    assert.match((install.stderr || '') + (install.stdout || ''), /no supported agents detected/i, 'should print guidance');
    assert.ok(!fs.existsSync(path.join(home, 'state.json')), 'nothing should be recorded on zero-detected');
}
// update honors the recorded set: a claude-only install stays claude-only on update
// even after the codex config dir appears (D6).
function testUpdateScopesToRecordedSet() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install', '--agents', 'claude-code'], cfg).status, 0);
    fs.mkdirSync(codex, { recursive: true }); // codex now detectable, but not recorded
    const update = run(['update'], cfg);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    assert.ok(!fs.existsSync(path.join(codex, 'hooks.json')), 'update must not wire an agent outside the recorded set');
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.deepStrictEqual(state.agents, ['claude-code'], 'recorded set must be preserved across update');
}
// A legacy install with no state.json infers the set from the currently-wired
// agents on first update, persists it, and never silently unwires (D6).
function testUpdateMigrationInfersFromWired() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    fs.rmSync(path.join(home, 'state.json'), { force: true }); // simulate a legacy install
    const update = run(['update'], cfg);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.deepStrictEqual(state.agents.slice().sort(), ['claude-code', 'codex'], 'update should recreate state.json from the wired set');
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks && settings.hooks.UserPromptSubmit, 'claude-code must remain wired');
    const hooks = JSON.parse(fs.readFileSync(path.join(codex, 'hooks.json'), 'utf8'));
    assert.ok(hooks.hooks && hooks.hooks.UserPromptSubmit, 'codex must remain wired');
}
// uninstall scopes to the recorded set: a claude-only install's uninstall removes
// claude wiring and never touches codex (D6).
function testUninstallScopesToRecordedSet() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install', '--agents', 'claude-code'], cfg).status, 0);
    const uninstall = run(['uninstall'], cfg);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(!settings.hooks || !settings.hooks.UserPromptSubmit || !settings.hooks.UserPromptSubmit.length, 'uninstall should remove claude-code wiring');
    assert.ok(!fs.existsSync(path.join(codex, 'hooks.json')), 'uninstall scoped to [claude-code] must not create/touch codex hooks.json');
}
// A recorded agent whose config dir later vanishes is dropped GRACEFULLY on update
// (exit 0) with a notice — never a hard error — and the recorded set narrows to what
// remains (D6: drop-with-notice, not silent and not a hard error). The hard error is
// reserved for an explicit user-supplied --agents (D1).
function testUpdateDropsVanishedRecordedAgent() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install', '--agents', 'claude-code,codex'], cfg).status, 0);
    // codex disappears (config dir removed) after being recorded + wired.
    fs.rmSync(codex, { recursive: true, force: true });
    const update = run(['update'], cfg);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    assert.match(update.stdout, /recorded agent "codex" no longer detected/, 'update should announce the dropped agent');
    assert.match(update.stdout, /dropped from selection/, 'notice should say the agent was dropped');
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.deepStrictEqual(state.agents, ['claude-code'], 'recorded set should narrow to the surviving agent');
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks && settings.hooks.UserPromptSubmit, 'claude-code must remain wired');
    assert.ok(!fs.existsSync(path.join(codex, 'hooks.json')), 'dropped codex must not be wired');
}
// --- CLI --json machine surface (R-012) ------------------------------------
function testJsonStatusShape() {
    const cfg = tempConfig();
    assert.strictEqual(run(['install'], cfg).status, 0);
    const res = run(['status', '--json'], cfg);
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    const out = res.stdout.trim();
    const obj = JSON.parse(out); // must parse cleanly → nothing but JSON on stdout
    assert.strictEqual(obj.apiVersion, 1, 'status --json apiVersion');
    assert.strictEqual(obj.command, 'status');
    assert.ok(obj.data && typeof obj.data === 'object', 'status data object');
    assert.strictEqual(obj.data.installRoot, homeFor(cfg), 'installRoot reflects BASELINE_HOME');
    assert.ok(Array.isArray(obj.data.config.routes), 'config.routes is an array');
    assert.ok(Array.isArray(obj.data.agents) && obj.data.agents.length >= 1, 'agents array present');
    assert.ok(obj.data.agents[0].links && obj.data.agents[0].links.dispatcher, 'agent link states present');
    assert.ok(!out.includes('[baseline] status'), 'json stdout must not carry human output');
}
function testJsonRouteListShape() {
    const cfg = tempConfig();
    assert.strictEqual(run(['install'], cfg).status, 0);
    const res = run(['route', 'list', '--json'], cfg);
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    const obj = JSON.parse(res.stdout.trim());
    assert.strictEqual(obj.apiVersion, 1);
    assert.strictEqual(obj.command, 'route.list');
    assert.ok(Array.isArray(obj.data.routes), 'routes array');
    const baseline = obj.data.routes.find((r) => r.id === 'baseline');
    assert.ok(baseline, 'default preset baseline route present in JSON');
    for (const k of ['id', 'event', 'freq', 'doc'])
        assert.ok(k in baseline, 'route entry has ' + k);
}
function testJsonRouteAddRemove() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    const add = run(['route', 'add', '--id', 'extra', '--event', 'UserPromptSubmit', '--doc', 'docs/extra.md', '--freq', '3', '--json'], cfg);
    assert.strictEqual(add.status, 0, add.stderr || add.stdout);
    const addObj = JSON.parse(add.stdout.trim());
    assert.strictEqual(addObj.apiVersion, 1);
    assert.strictEqual(addObj.command, 'route.add');
    assert.strictEqual(addObj.data.added.id, 'extra');
    assert.strictEqual(addObj.data.added.freq, 3);
    assert.ok(addObj.data.routes.some((r) => r.id === 'extra'), 'returned routes include the added one');
    // config.json actually mutated on disk, preserving the preset routes.
    let cfgJson = JSON.parse(readThrough(path.join(home, 'cfg', 'config.json')));
    assert.ok(cfgJson.routes.some((r) => r.id === 'extra' && r.freq === 3), 'config.json gained the route');
    assert.ok(cfgJson.routes.some((r) => r.id === 'baseline'), 'existing routes preserved');
    // Duplicate add → structured error, nonzero exit.
    const dup = run(['route', 'add', '--id', 'extra', '--event', 'UserPromptSubmit', '--doc', 'docs/extra.md', '--json'], cfg);
    assert.notStrictEqual(dup.status, 0, 'duplicate add should fail');
    const dupObj = JSON.parse(dup.stdout.trim());
    assert.ok(dupObj.error && dupObj.error.code, 'duplicate add returns a structured error');
    const rm = run(['route', 'remove', '--id', 'extra', '--json'], cfg);
    assert.strictEqual(rm.status, 0, rm.stderr || rm.stdout);
    const rmObj = JSON.parse(rm.stdout.trim());
    assert.strictEqual(rmObj.command, 'route.remove');
    assert.strictEqual(rmObj.data.removed, 'extra');
    assert.ok(!rmObj.data.routes.some((r) => r.id === 'extra'), 'removed route gone from returned list');
    cfgJson = JSON.parse(readThrough(path.join(home, 'cfg', 'config.json')));
    assert.ok(!cfgJson.routes.some((r) => r.id === 'extra'), 'config.json no longer has the route');
}
function testJsonDispatchSimulate() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    setCentralConfig(home, [
        { id: 'sim', event: 'UserPromptSubmit', freq: 1, doc: 'docs/sim.md' }
    ], { 'docs/sim.md': 'SIM {{event}}\n' });
    const res = run(['dispatch', 'simulate', '--event', 'UserPromptSubmit', '--cwd', cfg, '--json'], cfg);
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    const obj = JSON.parse(res.stdout.trim());
    assert.strictEqual(obj.apiVersion, 1);
    assert.strictEqual(obj.command, 'dispatch.simulate');
    assert.strictEqual(obj.data.event, 'UserPromptSubmit');
    assert.ok(obj.data.selected.some((r) => r.id === 'sim'), 'sim route selected');
    assert.ok(obj.data.additionalContext && obj.data.additionalContext.includes('SIM UserPromptSubmit'), 'templated body previewed: ' + obj.data.additionalContext);
    // Side-effect-free: simulate must never write the counter file.
    assert.ok(!fs.existsSync(path.join(cfg, '.baseline-counters.json')), 'simulate must not write counters');
}
function testJsonErrorPathExitCode() {
    const cfg = tempConfig();
    assert.strictEqual(run(['install'], cfg).status, 0);
    const res = run(['route', 'remove', '--id', 'ghost', '--json'], cfg);
    assert.notStrictEqual(res.status, 0, 'error path must exit nonzero');
    const obj = JSON.parse(res.stdout.trim());
    assert.strictEqual(obj.apiVersion, 1);
    assert.ok(obj.error && typeof obj.error.code === 'string' && typeof obj.error.message === 'string', 'structured { code, message } error');
    assert.ok(!('data' in obj), 'error payload carries no data');
    assert.strictEqual((res.stderr || '').trim(), '', 'json error must not also write stderr');
}
// --- benchmark harness smoke (R-013) ---------------------------------------
// The bench harness must not rot: shape-check it (one run per impl, correctness only, NO
// timing assertions). Required impls (baseline-node, ref-node) must produce correct
// output; optional impls (python/ts) may skip cleanly but must still be reported.
function testBenchHarnessSmoke() {
    const res = (0, child_process_1.spawnSync)(process.execPath, [path.join(root, 'bench', 'run.js'), '--smoke'], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, 'bench --smoke should exit 0: ' + (res.stderr || res.stdout));
    const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    const obj = JSON.parse(lastLine);
    assert.strictEqual(obj.smoke, true, 'smoke summary shape');
    const byName = {};
    for (const i of obj.impls)
        byName[i.name] = i;
    assert.ok(byName['baseline-node'] && byName['baseline-node'].ok === true, 'baseline dispatcher produces correct injection output');
    assert.ok(byName['ref-node'] && byName['ref-node'].ok === true, 'ref-node produces correct injection output');
    // The native lane (R-009) must be reported and, when a prebuilt exists for this platform,
    // produce correct output; on platforms with no prebuilt it skips-with-notice (never dropped).
    assert.ok('baseline-native' in byName, 'baseline-native lane is reported');
    assert.ok(byName['baseline-native'].skipped || byName['baseline-native'].ok === true, 'baseline-native produces correct injection output when a prebuilt exists');
    // Optional impls must appear as entries (ok or skipped) — never silently dropped.
    assert.ok('ref-python' in byName && 'ref-ts' in byName, 'optional impls are reported (ok or skipped, not absent)');
}
// R-014 (goal decision #21): a PROVISIONAL peak-RSS ceiling for the Node dispatch path,
// pinned generously from the benchmark (bench/budgets.json). Measured cross-platform via
// the reference injection's own ##RSS self-report (the shipped dispatcher is a peer Node
// process). Enforced now with ample headroom so it never flakes; skips-with-notice only
// when the ceiling is unpinned or the RSS number can't be obtained (never a false green).
// The FINAL post-native budget stays a separate open TODO (R-014 + bench/budgets.json).
function testDispatchRssWithinCeiling() {
    const budgets = JSON.parse(fs.readFileSync(path.join(root, 'bench', 'budgets.json'), 'utf8'));
    const ceiling = budgets.peakRssBytes;
    if (ceiling === null || ceiling === undefined) {
        console.log('  (skip) testDispatchRssWithinCeiling: RSS ceiling not pinned yet (TODO post-native) — not asserting.');
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-rss-'));
    try {
        fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, routes: [{ id: 'r', event: 'UserPromptSubmit', freq: 1, doc: 'docs/r.md' }] }));
        fs.writeFileSync(path.join(dir, 'docs', 'r.md'), 'RSS PROBE DOC\n');
        const r = (0, child_process_1.spawnSync)(process.execPath, [path.join(root, 'bench', 'refs', 'node-min.js')], {
            input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
            env: Object.assign({}, process.env, { BENCH_CONFIG: path.join(dir, 'config.json') })
        });
        const m = (r.stderr || '').match(/##RSS:(\d+)/);
        if (!m) {
            console.log('  (skip) testDispatchRssWithinCeiling: Node-path RSS not obtainable here — not asserting.');
            return;
        }
        const rssBytes = Number(m[1]);
        assert.ok(rssBytes <= ceiling, 'Node dispatch-path RSS ' + rssBytes + ' bytes exceeds ceiling ' + ceiling + ' bytes');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
// --- runner -----------------------------------------------------------------
const TESTS = [
    ['testCentralInstallAndAgentLinks', testCentralInstallAndAgentLinks],
    ['testCodexInstallAndAgentLinks', testCodexInstallAndAgentLinks],
    ['testInstalledHooksResolveBundledContracts', testInstalledHooksResolveBundledContracts],
    ['testCentralEditPropagatesToAgent', testCentralEditPropagatesToAgent],
    ['testIdempotentReinstall', testIdempotentReinstall],
    ['testForceReplacesConfigKeepWithout', testForceReplacesConfigKeepWithout],
    ['testUnknownPresetFails', testUnknownPresetFails],
    ['testNativeRuntimeInstallsAndWires', testNativeRuntimeInstallsAndWires],
    ['testNativeFallbackToNodeWhenBinaryAbsent', testNativeFallbackToNodeWhenBinaryAbsent],
    ['testNativeDispatchParity', testNativeDispatchParity],
    ['testDefaultInstallAndVerify', testDefaultInstallAndVerify],
    ['testInstalledManagerInfersInstallRootWithoutBaselineHome', testInstalledManagerInfersInstallRootWithoutBaselineHome],
    ['testBaselineHomeOverridesInstalledManagerLocation', testBaselineHomeOverridesInstalledManagerLocation],
    ['testSourceLikeInstalledManagerDoesNotInferInstallRoot', testSourceLikeInstalledManagerDoesNotInferInstallRoot],
    ['testInstallRootDefaultContract', testInstallRootDefaultContract],
    ['testMinimalPresetWiresOnlyUserPromptSubmit', testMinimalPresetWiresOnlyUserPromptSubmit],
    ['testDefaultPresetWiresBaseEventsBothAgents', testDefaultPresetWiresBaseEventsBothAgents],
    ['testInvalidSettingsFailsClosed', testInvalidSettingsFailsClosed],
    ['testInvalidSettingsShapeFailsClosed', testInvalidSettingsShapeFailsClosed],
    ['testInvalidNullHookGroupFailsClosed', testInvalidNullHookGroupFailsClosed],
    ['testConfigDrivenWiringAndUnwire', testConfigDrivenWiringAndUnwire],
    ['testCoResidentHookPreserved', testCoResidentHookPreserved],
    ['testBaselineHookDoesNotInheritMatcher', testBaselineHookDoesNotInheritMatcher],
    ['testPerRouteCountersIndependent', testPerRouteCountersIndependent],
    ['testMalformedCounterArrayDoesNotBreakFrequency', testMalformedCounterArrayDoesNotBreakFrequency],
    ['testEventNameSemantics', testEventNameSemantics],
    ['testTemplateResolvesBuiltinsAndVars', testTemplateResolvesBuiltinsAndVars],
    ['testTemplatePerRouteOverrideOrder', testTemplatePerRouteOverrideOrder],
    ['testTemplateUnknownPlaceholderVerbatim', testTemplateUnknownPlaceholderVerbatim],
    ['testTemplateDispatchEndToEnd', testTemplateDispatchEndToEnd],
    ['testConcurrentDispatchDeterministicOrder', testConcurrentDispatchDeterministicOrder],
    ['testFailOpenMissingConfig', testFailOpenMissingConfig],
    ['testMalformedConfigInjectsNothing', testMalformedConfigInjectsNothing],
    ['testBadRouteSkippedOthersFire', testBadRouteSkippedOthersFire],
    ['testDocPathTraversalRejected', testDocPathTraversalRejected],
    ['testDocSymlinkEscapeRejected', testDocSymlinkEscapeRejected],
    ['testOversizeDocSkipped', testOversizeDocSkipped],
    ['testDoctorReportsAndFixes', testDoctorReportsAndFixes],
    ['testDoctorDetectsMissingDoc', testDoctorDetectsMissingDoc],
    ['testStatusAndDoctorRepairPerAgentContracts', testStatusAndDoctorRepairPerAgentContracts],
    ['testDoctorFixRefusesInvalidSettings', testDoctorFixRefusesInvalidSettings],
    ['testVerifyRequiresSelectedRouteEvent', testVerifyRequiresSelectedRouteEvent],
    ['testVerifyToolEventFires', testVerifyToolEventFires],
    ['testUpdateRedeploysDispatcher', testUpdateRedeploysDispatcher],
    ['testUninstallKeepsCentralConfig', testUninstallKeepsCentralConfig],
    ['testUninstallPreservesDivergentPerAgentContracts', testUninstallPreservesDivergentPerAgentContracts],
    ['testControlSurfacePluginsDeployed', testControlSurfacePluginsDeployed],
    ['testCodexPluginPayloadDeployedAndActivated', testCodexPluginPayloadDeployedAndActivated],
    ['testUpdateRepairsCodexPluginCacheAndActivation', testUpdateRepairsCodexPluginCacheAndActivation],
    ['testDoctorFixRepairsCodexPluginCacheAndActivation', testDoctorFixRepairsCodexPluginCacheAndActivation],
    ['testUninstallRemovesOnlyManagedCodexPluginActivation', testUninstallRemovesOnlyManagedCodexPluginActivation],
    ['testUninstallPreservesCodexArrayTablesAfterManagedActivation', testUninstallPreservesCodexArrayTablesAfterManagedActivation],
    ['testUninstallPreservesCodexQuotedProjectTableAfterManagedActivation', testUninstallPreservesCodexQuotedProjectTableAfterManagedActivation],
    ['testUninstallPreservesCodexQuotedBracketTomlSectionsAfterManagedActivation', testUninstallPreservesCodexQuotedBracketTomlSectionsAfterManagedActivation],
    ['testUninstallRemovesSingleQuotedManagedCodexPluginActivation', testUninstallRemovesSingleQuotedManagedCodexPluginActivation],
    ['testUninstallPreservesBaselineCodexPluginArrayTable', testUninstallPreservesBaselineCodexPluginArrayTable],
    ['testClaudePluginManifest', testClaudePluginManifest],
    ['testExternalConfigLocation', testExternalConfigLocation],
    ['testChecksumsMatchBinaries', testChecksumsMatchBinaries],
    ['testNoRuntimeDependencies', testNoRuntimeDependencies],
    ['testJsonStatusShape', testJsonStatusShape],
    ['testJsonRouteListShape', testJsonRouteListShape],
    ['testJsonRouteAddRemove', testJsonRouteAddRemove],
    ['testJsonDispatchSimulate', testJsonDispatchSimulate],
    ['testJsonErrorPathExitCode', testJsonErrorPathExitCode],
    ['testBenchHarnessSmoke', testBenchHarnessSmoke],
    ['testDispatchRssWithinCeiling', testDispatchRssWithinCeiling],
    ['testPresetsAreValid', testPresetsAreValid],
    ['testMinimalPresetIsNeutral', testMinimalPresetIsNeutral],
    ['testBrandAssetsAndReadme', testBrandAssetsAndReadme],
    ['testDocsDescribeRoutesModel', testDocsDescribeRoutesModel],
    ['testCfgLocationPhrasingIsCanonical', testCfgLocationPhrasingIsCanonical],
    ['testInstallRootPhrasingIsCanonical', testInstallRootPhrasingIsCanonical],
    ['testCodexPluginManifest', testCodexPluginManifest],
    ['testShellWrappersExecutable', testShellWrappersExecutable],
    ['testInstallWrappersHaveNoBuildFlag', testInstallWrappersHaveNoBuildFlag],
    // guided agent selection (R-004)
    ['testAgentsFlagSelectsSubset', testAgentsFlagSelectsSubset],
    ['testAgentsFlagBothExplicit', testAgentsFlagBothExplicit],
    ['testUnknownAgentErrors', testUnknownAgentErrors],
    ['testNotDetectedAgentErrors', testNotDetectedAgentErrors],
    ['testNonTtyWiresAllDetected', testNonTtyWiresAllDetected],
    ['testStrictlyDetectedOnly', testStrictlyDetectedOnly],
    ['testZeroDetectedErrors', testZeroDetectedErrors],
    ['testUpdateScopesToRecordedSet', testUpdateScopesToRecordedSet],
    ['testUpdateMigrationInfersFromWired', testUpdateMigrationInfersFromWired],
    ['testUninstallScopesToRecordedSet', testUninstallScopesToRecordedSet],
    ['testUpdateDropsVanishedRecordedAgent', testUpdateDropsVanishedRecordedAgent],
];
const filterRaw = process.env.BASELINE_TEST_FILTER;
const testFilters = filterRaw ? filterRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
const selectedTests = testFilters.length
    ? TESTS.filter(([name]) => testFilters.some(filter => name.indexOf(filter) !== -1))
    : TESTS;
if (testFilters.length && selectedTests.length === 0) {
    console.error('No tests matched BASELINE_TEST_FILTER=' + filterRaw);
    process.exit(1);
}
let passed = 0;
let failed = 0;
for (const [name, fn] of selectedTests) {
    try {
        fn();
        passed++;
    }
    catch (e) {
        failed++;
        console.error('FAIL ' + name + ': ' + ((e && e.message) ? e.message : String(e)));
    }
}
if (failed) {
    console.error('');
    console.error(failed + ' failed, ' + passed + ' passed');
    process.exit(1);
}
console.log('baseline tests passed (' + passed + ')');
