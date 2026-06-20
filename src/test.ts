#!/usr/bin/env node
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '..');
const manage = path.join(root, 'scripts', 'manage.js');
const dispatcher = path.join(root, 'scripts', 'baseline-recital.js');

function tempConfig(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'));
}

// Each test gets an isolated central root alongside its config dir, so install
// never touches the real ~/.omne. Deterministic: derived from the unique cfg.
function omneFor(cfg: string): string {
  return cfg + '-omne';
}

function run(args: string[], cfg: string, omne?: string) {
  return spawnSync(process.execPath, [manage].concat(args), {
    cwd: root,
    env: Object.assign({}, process.env, {
      CLAUDE_CONFIG_DIR: cfg,
      OMNE_HOME: omne || omneFor(cfg)
    }),
    encoding: 'utf8'
  });
}

// Drive the deployed dispatcher directly with one synthetic hook payload. It reads
// CLAUDE_CONFIG_DIR for the linked cfg/baseline and the counter file.
function hook(input: any, cfg: string) {
  return spawnSync(process.execPath, [dispatcher], {
    input: JSON.stringify(input),
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg, OMNE_HOME: omneFor(cfg) }),
    encoding: 'utf8'
  });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// Overwrite the central config + docs (edits propagate to agents through the link).
function setCentralConfig(omne: string, routes: any[], docs: { [name: string]: string }): void {
  write(path.join(omne, 'cfg', 'baseline', 'config.json'), JSON.stringify({ version: 1, routes }, null, 2));
  for (const name of Object.keys(docs)) {
    write(path.join(omne, 'cfg', 'baseline', name), docs[name]);
  }
}

function readThrough(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

// --- install / link / settings ---------------------------------------------

function testDefaultInstallAndVerify(): void {
  const cfg = tempConfig();
  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /runtime\s+: node js/);
  assert.match(install.stdout, /config folder : .*\(seeded, preset: minimal\)/);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(command.includes('baseline-recital.js'), command);
  // minimal preset uses only UserPromptSubmit — no other event group is wired.
  assert.ok(!settings.hooks.SessionStart, 'unused SessionStart event should not be wired');
  assert.ok(!settings.hooks.PreToolUse, 'unused PreToolUse event should not be wired');

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verify: PASS/);
}

function testCentralInstallAndAgentLinks(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  assert.ok(fs.existsSync(path.join(omne, 'hooks', 'baseline-recital.js')), 'central dispatcher missing');
  assert.ok(fs.existsSync(path.join(omne, 'cfg', 'baseline', 'config.json')), 'central config.json missing');
  assert.ok(fs.existsSync(path.join(omne, 'cfg', 'baseline', 'docs', 'baseline.md')), 'central doc missing');

  const agentJs = path.join(cfg, 'hooks', 'baseline-recital.js');
  const agentConfig = path.join(cfg, 'cfg', 'baseline', 'config.json');
  assert.ok(fs.existsSync(agentJs), 'agent dispatcher not linked');
  assert.strictEqual(readThrough(agentJs), readThrough(path.join(omne, 'hooks', 'baseline-recital.js')),
    'agent dispatcher does not resolve to central content');
  assert.strictEqual(readThrough(agentConfig), readThrough(path.join(omne, 'cfg', 'baseline', 'config.json')),
    'agent config.json does not resolve to central content');

  const status = run(['status'], cfg);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /central root\s+: /);
  assert.match(status.stdout, /baseline: event=UserPromptSubmit, freq=5/);
}

function testCentralEditPropagatesToAgent(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  // Edit the central doc; the agent path must reflect it (single source).
  const edited = 'EDITED RULE BODY\n';
  fs.writeFileSync(path.join(omne, 'cfg', 'baseline', 'docs', 'baseline.md'), edited, 'utf8');
  assert.strictEqual(readThrough(path.join(cfg, 'cfg', 'baseline', 'docs', 'baseline.md')), edited,
    'central edit not visible through the agent link');
}

function testIdempotentReinstall(): void {
  const cfg = tempConfig();
  assert.strictEqual(run(['install'], cfg).status, 0);
  const second = run(['install'], cfg);
  assert.strictEqual(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /\(kept, preset: minimal\)/);
  assert.strictEqual(run(['verify'], cfg).status, 0);
}

function testForceReplacesConfigKeepWithout(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  // Operator edit to the central config.
  const marker = 'OPERATOR EDIT MARKER\n';
  fs.writeFileSync(path.join(omne, 'cfg', 'baseline', 'docs', 'baseline.md'), marker, 'utf8');

  // Plain reinstall keeps the edit.
  assert.strictEqual(run(['install'], cfg).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(omne, 'cfg', 'baseline', 'docs', 'baseline.md'), 'utf8'), marker,
    'plain reinstall clobbered the operator config');

  // --force replaces it wholesale from the preset.
  const forced = run(['install', '--force'], cfg);
  assert.strictEqual(forced.status, 0, forced.stderr || forced.stdout);
  assert.match(forced.stdout, /\(replaced, preset: minimal\)/);
  assert.notStrictEqual(fs.readFileSync(path.join(omne, 'cfg', 'baseline', 'docs', 'baseline.md'), 'utf8'), marker,
    '--force did not replace the operator config');
}

function testUnknownPresetFails(): void {
  const cfg = tempConfig();
  const install = run(['install', '--preset', 'nope'], cfg);
  assert.notStrictEqual(install.status, 0, 'install with unknown preset unexpectedly succeeded');
  assert.match(install.stderr, /preset "nope" not found/);
}

function testNativeRuntimePaused(): void {
  const cfg = tempConfig();
  const install = run(['install', '--runtime', 'prebuilt'], cfg);
  assert.strictEqual(install.status, 2, install.stderr || install.stdout);
  assert.match(install.stderr, /native runtime is paused/);
}

function testInvalidSettingsFailsClosed(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  const settings = path.join(cfg, 'settings.json');
  write(settings, '{ invalid json');

  const install = run(['install'], cfg);
  assert.notStrictEqual(install.status, 0, 'install unexpectedly succeeded');
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{ invalid json');
  assert.ok(!fs.existsSync(path.join(omne, 'hooks', 'baseline-recital.js')), 'invalid settings should not deploy dispatcher');
  assert.ok(!fs.existsSync(path.join(omne, 'cfg', 'baseline', 'config.json')), 'invalid settings should not seed config');
}

function testInvalidSettingsShapeFailsClosed(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  const settings = path.join(cfg, 'settings.json');
  const invalidShape = JSON.stringify({ hooks: { UserPromptSubmit: { hooks: [] } } }, null, 2) + '\n';
  write(settings, invalidShape);

  const install = run(['install'], cfg);
  assert.notStrictEqual(install.status, 0, 'install unexpectedly succeeded');
  assert.match(install.stderr, /hooks\.UserPromptSubmit must be an array/);
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), invalidShape);
  assert.ok(!fs.existsSync(path.join(omne, 'cfg', 'baseline', 'config.json')), 'invalid shape should not seed config');

  const doctor = run(['doctor'], cfg);
  assert.notStrictEqual(doctor.status, 0, 'doctor unexpectedly succeeded on invalid settings shape');
  assert.match(doctor.stdout, /invalid settings\.json/);
}

// --- config-driven wiring ---------------------------------------------------

function testConfigDrivenWiringAndUnwire(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);

  // default preset uses UserPromptSubmit + SessionStart → both wired, others not.
  const install = run(['install', '--preset', 'default'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  let settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.UserPromptSubmit, 'UserPromptSubmit not wired');
  assert.ok(settings.hooks.SessionStart, 'SessionStart not wired');
  assert.ok(!settings.hooks.PreToolUse, 'PreToolUse wired but no route uses it');

  // Remove the SessionStart route from central config; update must unwire it.
  setCentralConfig(omne, [
    { id: 'baseline', event: 'UserPromptSubmit', freq: 5, doc: 'docs/baseline.md' }
  ], {});
  const update = run(['update'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.UserPromptSubmit, 'UserPromptSubmit dropped wrongly');
  assert.ok(!settings.hooks.SessionStart, 'stale SessionStart event group not unwired after route removal');
}

function testCoResidentHookPreserved(): void {
  const cfg = tempConfig();
  // A co-resident UserPromptSubmit hook the operator owns.
  write(path.join(cfg, 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo theirs', timeout: 3 }] }] }
  }, null, 2) + '\n');

  assert.strictEqual(run(['install'], cfg).status, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const cmds = settings.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.ok(cmds.some((c: string) => c === 'echo theirs'), 'co-resident hook was dropped');
  assert.ok(cmds.some((c: string) => c.includes('baseline-recital.js')), 'baseline hook not added');

  // Uninstall removes only ours.
  assert.strictEqual(run(['uninstall'], cfg).status, 0);
  const after = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const left = after.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.deepStrictEqual(left, ['echo theirs'], 'uninstall did not preserve exactly the co-resident hook');
}

// --- dispatcher behavior (drive the deployed hook directly) -----------------

function fireBodies(res: { stdout: string }): string | null {
  const out = (res.stdout || '').trim();
  if (!out) return null;
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

function testPerRouteCountersIndependent(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  setCentralConfig(omne, [
    { id: 'two', event: 'UserPromptSubmit', freq: 2, doc: 'docs/two.md' },
    { id: 'three', event: 'UserPromptSubmit', freq: 3, doc: 'docs/three.md' }
  ], { 'docs/two.md': 'TWO\n', 'docs/three.md': 'THREE\n' });

  const sid = 'sess-counters';
  const fired: { [turn: number]: string } = {};
  for (let i = 1; i <= 6; i++) {
    const body = fireBodies(hook({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
    if (body) fired[i] = body;
  }
  // freq2 fires 2,4,6; freq3 fires 3,6. Independent counters, same session.
  assert.ok(fired[2] && fired[2].includes('TWO') && !fired[2].includes('THREE'), 'turn2: only freq2 route');
  assert.ok(fired[3] && fired[3].includes('THREE') && !fired[3].includes('TWO'), 'turn3: only freq3 route');
  assert.ok(!fired[5], 'turn5: nothing due');
  assert.ok(fired[6] && fired[6].includes('TWO') && fired[6].includes('THREE'), 'turn6: both due, joined');
}

function testMatcherSemantics(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  const scoped = path.join(cfg, 'scoped-tree');

  setCentralConfig(omne, [
    { id: 'compact', event: 'SessionStart', matcher: 'compact', freq: 1, doc: 'docs/c.md' },
    { id: 'bash', event: 'PreToolUse', matcher: '^Bash$', freq: 1, doc: 'docs/b.md' },
    { id: 'scoped', event: 'UserPromptSubmit', cwd: scoped, freq: 1, doc: 'docs/s.md' }
  ], { 'docs/c.md': 'COMPACT\n', 'docs/b.md': 'BASH\n', 'docs/s.md': 'SCOPED\n' });

  // SessionStart matcher: phase equality.
  assert.ok(fireBodies(hook({ session_id: 's1', hook_event_name: 'SessionStart', source: 'compact', cwd: cfg }, cfg))?.includes('COMPACT'),
    'compact route should fire on source=compact');
  assert.strictEqual(fireBodies(hook({ session_id: 's2', hook_event_name: 'SessionStart', source: 'startup', cwd: cfg }, cfg)), null,
    'compact route should not fire on source=startup');

  // PreToolUse matcher: tool-name regex (anchored here).
  assert.ok(fireBodies(hook({ session_id: 's3', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: cfg }, cfg))?.includes('BASH'),
    'bash route should fire on tool_name=Bash');
  assert.strictEqual(fireBodies(hook({ session_id: 's4', hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: cfg }, cfg)), null,
    'bash route should not fire on tool_name=Read');

  // cwd scope: only under the path.
  assert.ok(fireBodies(hook({ session_id: 's5', hook_event_name: 'UserPromptSubmit', cwd: path.join(scoped, 'sub') }, cfg))?.includes('SCOPED'),
    'scoped route should fire under its cwd');
  assert.strictEqual(fireBodies(hook({ session_id: 's6', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg)), null,
    'scoped route should not fire outside its cwd');
}

function testFailOpenMissingConfig(): void {
  // Point the dispatcher at a config dir with no cfg/baseline at all.
  const empty = tempConfig();
  const r = hook({ session_id: 'x', hook_event_name: 'UserPromptSubmit', cwd: empty }, empty);
  assert.strictEqual(r.status, 0, 'dispatcher should exit clean with no config');
  assert.strictEqual((r.stdout || '').trim(), '', 'dispatcher should inject nothing with no config');
}

function testMalformedConfigInjectsNothing(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  fs.writeFileSync(path.join(omne, 'cfg', 'baseline', 'config.json'), '{ not json', 'utf8');
  const r = hook({ session_id: 'y', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
  assert.strictEqual(r.status, 0, 'dispatcher should not crash on malformed config');
  assert.strictEqual((r.stdout || '').trim(), '', 'malformed config should inject nothing');
}

function testBadRouteSkippedOthersFire(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  setCentralConfig(omne, [
    { id: 'BadId!', event: 'UserPromptSubmit', freq: 1, doc: 'docs/x.md' },         // invalid id → skipped
    { id: 'missingdoc', event: 'UserPromptSubmit', freq: 1, doc: 'docs/gone.md' },  // doc absent → skipped at read
    { id: 'good', event: 'UserPromptSubmit', freq: 1, doc: 'docs/good.md' }
  ], { 'docs/good.md': 'GOOD\n' });
  const body = fireBodies(hook({ session_id: 'z', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
  assert.ok(body && body.includes('GOOD'), 'good route should still fire alongside bad routes');
  assert.ok(!body!.includes('docs'), 'bad routes must not leak');
}

function testDocPathTraversalRejected(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  // Plant a secret outside cfg/baseline and try to escape to it.
  write(path.join(omne, 'secret.md'), 'SECRET\n');
  setCentralConfig(omne, [
    { id: 'escape', event: 'UserPromptSubmit', freq: 1, doc: '../../secret.md' }
  ], {});
  const r = hook({ session_id: 'esc', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
  assert.strictEqual((r.stdout || '').trim(), '', 'doc path traversal must be rejected');

  const doctor = run(['doctor'], cfg);
  assert.notStrictEqual(doctor.status, 0, 'doctor should fail on out-of-range doc');
  assert.match(doctor.stdout, /out-of-range doc/);
}

// --- doctor / verify --------------------------------------------------------

function testDoctorReportsAndFixes(): void {
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

function testDoctorDetectsMissingDoc(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  fs.unlinkSync(path.join(omne, 'cfg', 'baseline', 'docs', 'baseline.md'));
  const doctor = run(['doctor'], cfg);
  assert.notStrictEqual(doctor.status, 0, 'doctor should fail on missing doc');
  assert.match(doctor.stdout, /doc not readable/);
}

function testDoctorFixRefusesInvalidSettings(): void {
  const cfg = tempConfig();
  const settings = path.join(cfg, 'settings.json');
  write(settings, '{ invalid json');
  const fixed = run(['doctor', '--fix'], cfg);
  assert.notStrictEqual(fixed.status, 0, 'doctor --fix unexpectedly succeeded on invalid settings');
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{ invalid json');
}

function testUpdateRedeploysDispatcher(): void {
  const cfg = tempConfig();
  assert.strictEqual(run(['install'], cfg).status, 0);
  const deployed = path.join(cfg, 'hooks', 'baseline-recital.js');
  fs.writeFileSync(deployed, '// tampered\n');
  const update = run(['update'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.strictEqual(
    fs.readFileSync(deployed, 'utf8'),
    fs.readFileSync(dispatcher, 'utf8'),
    'update did not restore the dispatcher from repo source');
  assert.strictEqual(run(['verify'], cfg).status, 0);
}

function testUninstallKeepsCentralConfig(): void {
  const cfg = tempConfig();
  const omne = omneFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks || !settings.hooks.UserPromptSubmit || settings.hooks.UserPromptSubmit.length === 0,
    'uninstall left a wired hook');
  assert.ok(!fs.existsSync(path.join(cfg, 'hooks', 'baseline-recital.js')), 'agent dispatcher link not removed');
  assert.ok(fs.existsSync(path.join(omne, 'cfg', 'baseline', 'config.json')), 'central config was wrongly removed');
}

// --- repo invariants --------------------------------------------------------

function assertGitVisible(file: string): void {
  const r = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, file + ' should be visible to git; git check-ignore status=' + r.status);
}

function testChecksumsMatchBinaries(): void {
  const sumsPath = path.join(root, 'bin', 'SHA256SUMS');
  assert.ok(fs.existsSync(sumsPath), 'bin/SHA256SUMS is missing');
  const raw = fs.readFileSync(sumsPath, 'utf8');
  assert.ok(!raw.includes('\r'), 'SHA256SUMS must use LF line endings, found CRLF');
  const lines = raw.split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'SHA256SUMS is empty');
  const listed = new Set<string>();
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    assert.ok(m, 'malformed SHA256SUMS line: ' + line);
    const [, expected, name] = m!;
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

function testPresetsAreValid(): void {
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
    assert.ok(!cfg.routes.some((r: any) => /README/.test(r.doc)), preset + ' must not route the README');
  }
}

function testBrandAssetsAndReadme(): void {
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

function testDocsDescribeRoutesModel(): void {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const architecture = fs.readFileSync(path.join(root, 'references', 'architecture.md'), 'utf8');
  for (const [name, text] of [['README', readme], ['SKILL', skill], ['architecture', architecture]] as const) {
    assert.match(text, /cfg\/baseline/, name + ' should describe the cfg/baseline config folder');
    assert.match(text, /config\.json/, name + ' should mention config.json');
    assert.match(text, /route/i, name + ' should describe routes');
  }
}

testCentralInstallAndAgentLinks();
testCentralEditPropagatesToAgent();
testIdempotentReinstall();
testForceReplacesConfigKeepWithout();
testUnknownPresetFails();
testNativeRuntimePaused();
testDefaultInstallAndVerify();
testInvalidSettingsFailsClosed();
testInvalidSettingsShapeFailsClosed();
testConfigDrivenWiringAndUnwire();
testCoResidentHookPreserved();
testPerRouteCountersIndependent();
testMatcherSemantics();
testFailOpenMissingConfig();
testMalformedConfigInjectsNothing();
testBadRouteSkippedOthersFire();
testDocPathTraversalRejected();
testDoctorReportsAndFixes();
testDoctorDetectsMissingDoc();
testDoctorFixRefusesInvalidSettings();
testUpdateRedeploysDispatcher();
testUninstallKeepsCentralConfig();
testChecksumsMatchBinaries();
testPresetsAreValid();
testBrandAssetsAndReadme();
testDocsDescribeRoutesModel();
console.log('baseline tests passed');
