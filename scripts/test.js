#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const manage = path.join(root, 'scripts', 'manage.js');

function tempConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'));
}

function run(args, cfg) {
  return spawnSync(process.execPath, [manage].concat(args), {
    cwd: root,
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg }),
    encoding: 'utf8'
  });
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function testDefaultInstallAndVerify() {
  const cfg = tempConfig();
  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /runtime\s+: node js/);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(command.includes('baseline-recital.js'), command);

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verify: PASS/);
}

function testInvalidSettingsFailsClosed() {
  const cfg = tempConfig();
  const settings = path.join(cfg, 'settings.json');
  write(settings, '{ invalid json');

  const install = run(['install'], cfg);
  assert.notStrictEqual(install.status, 0, 'install unexpectedly succeeded');
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{ invalid json');
}

function testStatusMirrorsHookDefaults() {
  const cfg = tempConfig();
  write(path.join(cfg, 'baseline.md'), '---\ninterval: 1\n---\n# no live rules\n');

  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const status = run(['status'], cfg);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /prefix\s+: LI BASELINE ALIGNED:/);
  assert.match(status.stdout, /rules\s+: 1/);

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
}

function testInvalidRuntimeFails() {
  const cfg = tempConfig();
  const install = run(['install', '--runtime', 'jss'], cfg);
  assert.strictEqual(install.status, 2, install.stderr || install.stdout);
  assert.match(install.stderr, /unknown --runtime/);
}

function testOversizedBaselineFallsBack() {
  const cfg = tempConfig();
  write(path.join(cfg, 'baseline.md'), '---\ninterval: 1\n---\n' + 'x'.repeat(70 * 1024));

  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const status = run(['status'], cfg);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /interval\s+: 5/);
  assert.match(status.stdout, /rules\s+: 1/);

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
}

function hasPrebuiltForHost() {
  return process.platform === 'win32' || process.platform === 'linux';
}

function zig16Available() {
  const r = spawnSync('zig', ['version'], { encoding: 'utf8' });
  return r.status === 0 && /^0\.16\./.test((r.stdout || '').trim());
}

function testPrebuiltInstallAndVerify() {
  if (!hasPrebuiltForHost()) return;

  const cfg = tempConfig();
  const install = run(['install', '--runtime', 'prebuilt'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /runtime\s+: prebuilt native binary/);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(!command.includes('baseline-recital.js'), command);
  assert.ok(command.includes('baseline-recital'), command);

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verify: PASS/);
}

function testBuildInstallAndVerifyWhenZigAvailable() {
  if (!zig16Available()) return;

  const cfg = tempConfig();
  const install = run(['install', '--runtime', 'build'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /runtime\s+: native binary \(built locally with zig\)/);

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verify: PASS/);
}

function testUnquotedWindowsNativePathIsRecognized() {
  if (process.platform !== 'win32') return;

  const cfg = tempConfig();
  const command = path.join(cfg, 'hooks', 'baseline-recital.exe');
  write(path.join(cfg, 'settings.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command }] }
      ]
    }
  }, null, 2) + '\n');

  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks.UserPromptSubmit || settings.hooks.UserPromptSubmit.length === 0);
}

function testChecksumsMatchBinaries() {
  const sumsPath = path.join(root, 'bin', 'SHA256SUMS');
  assert.ok(fs.existsSync(sumsPath), 'bin/SHA256SUMS is missing');

  const raw = fs.readFileSync(sumsPath, 'utf8');
  // CRLF breaks `sha256sum -c` on POSIX (trailing \r becomes part of the
  // filename), so the checked-in file must use LF line endings.
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
  // Every shipped prebuilt must have a checksum entry — a new binary added to
  // bin/ without one would otherwise deploy unverified.
  for (const f of fs.readdirSync(path.join(root, 'bin'))) {
    if (/^baseline-recital-/.test(f)) {
      assert.ok(listed.has(f), 'prebuilt ' + f + ' has no entry in SHA256SUMS');
    }
  }
}

function testUpdatePreservesRuntimeAndRepairs() {
  const cfg = tempConfig();
  assert.strictEqual(run(['install'], cfg).status, 0);

  // Corrupt the deployed hook, then update should redeploy from repo source.
  const deployed = path.join(cfg, 'hooks', 'baseline-recital.js');
  fs.writeFileSync(deployed, '// tampered\n');
  const update = run(['update'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.match(update.stdout, /target runtime: js/);
  assert.strictEqual(
    fs.readFileSync(deployed, 'utf8'),
    fs.readFileSync(path.join(root, 'scripts', 'baseline-recital.js'), 'utf8'),
    'update did not restore the hook from repo source');
  assert.strictEqual(run(['verify'], cfg).status, 0);
}

function testDoctorReportsAndFixes() {
  const cfg = tempConfig();
  assert.strictEqual(run(['install'], cfg).status, 0);

  // Healthy install → exit 0, healthy.
  const healthy = run(['doctor'], cfg);
  assert.strictEqual(healthy.status, 0, healthy.stderr || healthy.stdout);
  assert.match(healthy.stdout, /doctor: healthy/);

  // Break it: delete the deployed hook → doctor FAILs (exit 1).
  fs.unlinkSync(path.join(cfg, 'hooks', 'baseline-recital.js'));
  const broken = run(['doctor'], cfg);
  assert.strictEqual(broken.status, 1, broken.stdout);
  assert.match(broken.stdout, /\[FAIL\] hook \.js/);

  // doctor --fix repairs and re-scans clean.
  const fixed = run(['doctor', '--fix'], cfg);
  assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /doctor: installation repaired/);
}

function testDoctorFixRefusesInvalidSettings() {
  const cfg = tempConfig();
  const settings = path.join(cfg, 'settings.json');
  write(settings, '{ invalid json');

  const fixed = run(['doctor', '--fix'], cfg);
  assert.notStrictEqual(fixed.status, 0, 'doctor --fix unexpectedly succeeded on invalid settings');
  // Must NOT have rewritten the broken settings.
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{ invalid json');
}

testDefaultInstallAndVerify();
testInvalidSettingsFailsClosed();
testStatusMirrorsHookDefaults();
testInvalidRuntimeFails();
testOversizedBaselineFallsBack();
testPrebuiltInstallAndVerify();
testBuildInstallAndVerifyWhenZigAvailable();
testUnquotedWindowsNativePathIsRecognized();
testChecksumsMatchBinaries();
testUpdatePreservesRuntimeAndRepairs();
testDoctorReportsAndFixes();
testDoctorFixRefusesInvalidSettings();
console.log('baseline tests passed');
