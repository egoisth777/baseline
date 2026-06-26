#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const child_process_1 = require("child_process");
const root = path.resolve(__dirname, '..');
const manage = path.join(root, 'scripts', 'manage.js');
const dispatcher = path.join(root, 'scripts', 'baseline-recital.js');
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
// --- install / link / settings ---------------------------------------------
function testDefaultInstallAndVerify() {
    const cfg = tempConfig();
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stdout, /runtime\s+: node js/);
    // No --preset → DEFAULT_PRESET is now 'default'.
    assert.match(install.stdout, /config folder : .*\(seeded, preset: default\)/);
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
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'config.json')), 'central config.json missing');
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'docs', 'baseline.md')), 'central doc missing');
    const agentJs = path.join(cfg, 'hooks', 'baseline-recital.js');
    const agentConfig = path.join(cfg, 'cfg', 'baseline', 'config.json');
    assert.ok(fs.existsSync(agentJs), 'agent dispatcher not linked');
    assert.strictEqual(readThrough(agentJs), readThrough(path.join(home, 'hooks', 'baseline-recital.js')), 'agent dispatcher does not resolve to central content');
    assert.strictEqual(readThrough(agentConfig), readThrough(path.join(home, 'cfg', 'config.json')), 'agent config.json does not resolve to central content');
    const status = run(['status'], cfg);
    assert.strictEqual(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /install root\s+: /);
    assert.match(status.stdout, /baseline: event=UserPromptSubmit, freq=5/);
}
function testCodexInstallAndAgentLinks() {
    const cfg = tempConfig();
    const codex = codexFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    const hooksJson = JSON.parse(fs.readFileSync(path.join(codex, 'hooks.json'), 'utf8'));
    const command = hooksJson.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(command.includes('baseline-recital.js'), command);
    assert.ok(command.includes('--agent-config'), command);
    assert.ok(command.includes(codex), command);
    const agentConfig = path.join(codex, 'cfg', 'baseline', 'config.json');
    assert.strictEqual(readThrough(agentConfig), readThrough(path.join(homeFor(cfg), 'cfg', 'config.json')), 'codex config.json does not resolve to central content');
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
function testNativeRuntimePaused() {
    const cfg = tempConfig();
    const install = run(['install', '--runtime', 'prebuilt'], cfg);
    assert.strictEqual(install.status, 2, install.stderr || install.stdout);
    assert.match(install.stderr, /native runtime is paused/);
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
    assert.strictEqual(run(['install'], cfg).status, 0);
    const uninstall = run(['uninstall'], cfg);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    assert.ok(!settings.hooks || !settings.hooks.UserPromptSubmit || settings.hooks.UserPromptSubmit.length === 0, 'uninstall left a wired hook');
    assert.ok(!fs.existsSync(path.join(cfg, 'hooks', 'baseline-recital.js')), 'agent dispatcher link not removed');
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'config.json')), 'central config was wrongly removed');
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
}
function testDocsDescribeRoutesModel() {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
    // Knowledge/reference docs (architecture.md, ubi_lang.md) live in the persistent
    // knowledge database under .arca/<proj>-sp/, which is intentionally gitignored —
    // git must never see the knowledge files. Assert that invariant instead of the old
    // tracked references/ location.
    assertGitIgnored(path.join('.arca', 'baseline-sp', 'architecture.md'));
    assertGitIgnored(path.join('.arca', 'baseline-sp', 'ubi_lang.md'));
    for (const [name, text] of [['README', readme], ['SKILL', skill]]) {
        assert.match(text, /cfg\/baseline/, name + ' should describe the cfg/baseline config folder');
        assert.match(text, /config\.json/, name + ' should mention config.json');
        assert.match(text, /route/i, name + ' should describe routes');
    }
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
// install deploys a Claude skills-dir plugin (baseline@skills-dir): a central payload
// linked into the Claude agent's skills dir, skill-only, Claude-only, and removed on
// uninstall while the central payload is kept.
function testClaudeSkillPluginDeployed() {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    assert.strictEqual(run(['install'], cfg).status, 0);
    // Central payload (manifest + generated SKILL.md wrapper) exists.
    assert.ok(fs.existsSync(path.join(home, 'skills', 'baseline', '.claude-plugin', 'plugin.json')), 'central skill manifest missing');
    assert.ok(fs.existsSync(path.join(home, 'skills', 'baseline', 'SKILL.md')), 'central skill SKILL.md missing');
    // Linked into the Claude agent skills dir so Claude loads it as baseline@skills-dir.
    const agentManifest = path.join(cfg, 'skills', 'baseline', '.claude-plugin', 'plugin.json');
    const agentSkill = path.join(cfg, 'skills', 'baseline', 'SKILL.md');
    assert.ok(fs.existsSync(agentManifest), 'Claude skill plugin not linked into the agent skills dir');
    assert.strictEqual(JSON.parse(readThrough(agentManifest)).name, 'baseline');
    const skillBody = readThrough(agentSkill);
    assert.match(skillBody, /name:\s*baseline/, 'deployed skill missing name frontmatter');
    assert.ok(skillBody.includes(root), 'deployed skill should record the repo root so the manager can be found');
    // Codex uses .codex-plugin, not a skills dir — it must NOT get one.
    assert.ok(!fs.existsSync(path.join(codex, 'skills', 'baseline')), 'Codex should not get a skills-dir plugin');
    // status + doctor report the skill link healthy.
    const status = run(['status'], cfg);
    assert.match(status.stdout, /skill plugin : OK/, 'status should report the agent skill link');
    const doctor = run(['doctor'], cfg);
    assert.strictEqual(doctor.status, 0, doctor.stdout);
    assert.match(doctor.stdout, /skill plugin: central payload deployed/);
    assert.match(doctor.stdout, /skill link: claude-code linked to center/);
    // uninstall removes the per-agent link but keeps the central payload.
    assert.strictEqual(run(['uninstall'], cfg).status, 0);
    assert.ok(!fs.existsSync(path.join(cfg, 'skills', 'baseline')), 'uninstall should remove the agent skill link');
    assert.ok(fs.existsSync(path.join(home, 'skills', 'baseline')), 'uninstall should keep the central skill payload');
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
// --- runner -----------------------------------------------------------------
const TESTS = [
    ['testCentralInstallAndAgentLinks', testCentralInstallAndAgentLinks],
    ['testCodexInstallAndAgentLinks', testCodexInstallAndAgentLinks],
    ['testCentralEditPropagatesToAgent', testCentralEditPropagatesToAgent],
    ['testIdempotentReinstall', testIdempotentReinstall],
    ['testForceReplacesConfigKeepWithout', testForceReplacesConfigKeepWithout],
    ['testUnknownPresetFails', testUnknownPresetFails],
    ['testNativeRuntimePaused', testNativeRuntimePaused],
    ['testDefaultInstallAndVerify', testDefaultInstallAndVerify],
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
    ['testFailOpenMissingConfig', testFailOpenMissingConfig],
    ['testMalformedConfigInjectsNothing', testMalformedConfigInjectsNothing],
    ['testBadRouteSkippedOthersFire', testBadRouteSkippedOthersFire],
    ['testDocPathTraversalRejected', testDocPathTraversalRejected],
    ['testDocSymlinkEscapeRejected', testDocSymlinkEscapeRejected],
    ['testOversizeDocSkipped', testOversizeDocSkipped],
    ['testDoctorReportsAndFixes', testDoctorReportsAndFixes],
    ['testDoctorDetectsMissingDoc', testDoctorDetectsMissingDoc],
    ['testDoctorFixRefusesInvalidSettings', testDoctorFixRefusesInvalidSettings],
    ['testVerifyRequiresSelectedRouteEvent', testVerifyRequiresSelectedRouteEvent],
    ['testVerifyToolEventFires', testVerifyToolEventFires],
    ['testUpdateRedeploysDispatcher', testUpdateRedeploysDispatcher],
    ['testUninstallKeepsCentralConfig', testUninstallKeepsCentralConfig],
    ['testClaudeSkillPluginDeployed', testClaudeSkillPluginDeployed],
    ['testClaudePluginManifest', testClaudePluginManifest],
    ['testExternalConfigLocation', testExternalConfigLocation],
    ['testChecksumsMatchBinaries', testChecksumsMatchBinaries],
    ['testPresetsAreValid', testPresetsAreValid],
    ['testBrandAssetsAndReadme', testBrandAssetsAndReadme],
    ['testDocsDescribeRoutesModel', testDocsDescribeRoutesModel],
    ['testCodexPluginManifest', testCodexPluginManifest],
    ['testShellWrappersExecutable', testShellWrappersExecutable],
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
let passed = 0;
let failed = 0;
for (const [name, fn] of TESTS) {
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
