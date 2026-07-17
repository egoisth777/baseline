#!/usr/bin/env node
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { builtinModules } from 'module';
import { spawnSync } from 'child_process';
import {
  ROUTE_KEYS, SESSION_PHASES, SUPPORTED_EVENTS,
  cwdMatches, eventMatches, isSupportedRouteEvent, parseEvent, safeDocPath
} from './contracts';

const root = path.resolve(__dirname, '..');
const manage = path.join(root, 'scripts', 'manage.js');
const dispatcher = path.join(root, 'scripts', 'baseline-recital.js');
const contracts = path.join(root, 'scripts', 'contracts.js');

function tempConfig(prefix = 'baseline-test-'): string {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Detection is by config-dir existence (CLAUDE_CONFIG_DIR / CODEX_HOME). mkdtemp
  // already created the claude config dir; create the codex one too so BOTH agents are
  // detected by default and the both-agent tests keep wiring both. Detection tests that
  // need an agent ABSENT remove its config dir explicitly before installing.
  fs.mkdirSync(codexFor(cfg), { recursive: true });
  return cfg;
}

// Each test gets an isolated install root alongside its config dir, so install
// never touches the real ~/.baseline. Deterministic: derived from the unique cfg.
function homeFor(cfg: string): string {
  return cfg + '-home';
}

function codexFor(cfg: string): string {
  return cfg + '-codex';
}

// Extension-host agent config dirs (pi / oh-my-pi / opencode). NOT created by
// default, so detection-driven tests keep seeing exactly claude-code + codex;
// shim tests create the dirs they need explicitly.
function piFor(cfg: string): string {
  return cfg + '-pi';
}

function ompFor(cfg: string): string {
  return cfg + '-omp';
}

function opencodeFor(cfg: string): string {
  return cfg + '-opencode';
}

// Manager-owned detection overrides for the extension-host agents; always set so a
// developer's real ~/.pi, ~/.omp, or ~/.config/opencode is never detected or touched.
function shimAgentEnv(cfg: string): { [k: string]: string } {
  return {
    BASELINE_PI_HOME: piFor(cfg),
    BASELINE_OMP_HOME: ompFor(cfg),
    BASELINE_OPENCODE_HOME: opencodeFor(cfg),
  };
}

// Run the manager with isolated install root + agent config dirs. extraEnv can set
// BASELINE_CFG to exercise an external (symlinked) config folder.
function run(args: string[], cfg: string, home?: string, extraEnv?: { [k: string]: string }, workingDirectory = root) {
  const baseHome = home || homeFor(cfg);
  return spawnSync(process.execPath, [manage].concat(args), {
    cwd: workingDirectory,
    env: Object.assign({}, process.env, {
      CLAUDE_CONFIG_DIR: cfg,
      CODEX_HOME: codexFor(cfg),
      BASELINE_HOME: baseHome,
      // Isolate BASELINE_CFG too: pin it to this install root's own cfg dir so a real
      // BASELINE_CFG in the developer's environment can never be read or clobbered. An
      // override equal to <installRoot>/cfg is treated as "no override" (a real seeded
      // folder), preserving the internal-config semantics the tests assume. Tests that
      // exercise external config pass their own BASELINE_CFG via extraEnv, which wins.
      BASELINE_CFG: path.join(baseHome, 'cfg'),
      BASELINE_CODEX_CLI: fakeCodexCli,
    }, shimAgentEnv(cfg), extraEnv || {}),
    encoding: 'utf8'
  });
}

function runInstalled(args: string[], cfg: string, home?: string, extraEnv?: { [k: string]: string }) {
  const baseHome = home || homeFor(cfg);
  return spawnSync(process.execPath, [installedManager(baseHome)].concat(args), {
    cwd: root,
    env: Object.assign({}, process.env, {
      CLAUDE_CONFIG_DIR: cfg,
      CODEX_HOME: codexFor(cfg),
      BASELINE_HOME: baseHome,
      BASELINE_CFG: path.join(baseHome, 'cfg'),
      BASELINE_CODEX_CLI: fakeCodexCli
    }, shimAgentEnv(cfg), extraEnv || {}),
    encoding: 'utf8'
  });
}

function runInstalledWithoutBaselineEnv(args: string[], cfg: string, home: string, extraEnv?: { [k: string]: string }) {
  const env = Object.assign({}, process.env, {
    CLAUDE_CONFIG_DIR: cfg,
    CODEX_HOME: codexFor(cfg),
    BASELINE_CODEX_CLI: fakeCodexCli,
  }, shimAgentEnv(cfg), extraEnv || {});
  delete env.BASELINE_HOME;
  delete env.BASELINE_CFG;
  return spawnSync(process.execPath, [installedManager(home)].concat(args), {
    cwd: root,
    env,
    encoding: 'utf8'
  });
}

// Drive the deployed dispatcher directly with one synthetic hook payload. It reads
// CLAUDE_CONFIG_DIR for the linked cfg/baseline and the counter file.
function hook(input: any, cfg: string) {
  const env = Object.assign({}, process.env,
    { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codexFor(cfg), BASELINE_HOME: homeFor(cfg) },
    shimAgentEnv(cfg));
  delete env.BASELINE_AGENT_CONFIG_DIR;
  return spawnSync(process.execPath, [dispatcher], {
    input: JSON.stringify(input),
    env,
    encoding: 'utf8'
  });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// Overwrite the config folder contents (edits propagate to agents through the link).
// Config is flat under <installRoot>/cfg: config.json + docs/ (no cfg/baseline nesting).
function setCentralConfig(home: string, routes: any[], docs: { [name: string]: string }): void {
  write(path.join(home, 'cfg', 'config.json'), JSON.stringify({ version: 1, routes }, null, 2));
  for (const name of Object.keys(docs)) {
    write(path.join(home, 'cfg', name), docs[name]);
  }
}

function readThrough(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

const FAKE_CODEX_STATE_FILE = '.baseline-test-codex-cli-state.json';

interface FakeCodexMarketplace {
  name: string;
  root: string;
}

interface FakeCodexPlugin {
  pluginId: string;
  enabled: boolean;
  version: string;
  source: { path: string };
}

interface FakeCodexState {
  marketplaces: FakeCodexMarketplace[];
  installed: FakeCodexPlugin[];
  commands: string[][];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFakeCodexMarketplace(value: unknown): value is FakeCodexMarketplace {
  return isRecord(value) && typeof value.name === 'string' && typeof value.root === 'string';
}

function isFakeCodexPlugin(value: unknown): value is FakeCodexPlugin {
  return isRecord(value) &&
    typeof value.pluginId === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.version === 'string' &&
    isRecord(value.source) &&
    typeof value.source.path === 'string';
}

function isFakeCodexState(value: unknown): value is FakeCodexState {
  return isRecord(value) &&
    Array.isArray(value.marketplaces) &&
    value.marketplaces.every(isFakeCodexMarketplace) &&
    Array.isArray(value.installed) &&
    value.installed.every(isFakeCodexPlugin) &&
    Array.isArray(value.commands) &&
    value.commands.every(command => Array.isArray(command) && command.every(arg => typeof arg === 'string'));
}

function fakeCodexStatePath(codex: string): string {
  return path.join(codex, FAKE_CODEX_STATE_FILE);
}

function readFakeCodexState(codex: string): FakeCodexState {
  const parsed: unknown = JSON.parse(readThrough(fakeCodexStatePath(codex)));
  assert.ok(isFakeCodexState(parsed), 'fake Codex state has an invalid shape');
  return parsed;
}

function writeFakeCodexState(codex: string, state: FakeCodexState): void {
  write(fakeCodexStatePath(codex), JSON.stringify(state, null, 2) + '\n');
}

function resetFakeCodexCommands(codex: string): void {
  const state = readFakeCodexState(codex);
  state.commands = [];
  writeFakeCodexState(codex, state);
}

function createFakeCodexCli(prefix = 'baseline-test-codex-cli-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const script = path.join(dir, 'codex.js');
  write(script, String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME;
const statePath = path.join(home, '${FAKE_CODEX_STATE_FILE}');
const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function emptyState() {
  return { marketplaces: [], installed: [], commands: [] };
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state && Array.isArray(state.marketplaces) && Array.isArray(state.installed) && Array.isArray(state.commands)) return state;
  } catch {}
  return emptyState();
}

function saveState(state) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

function output(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function reportedPath(value) {
  if (process.env.BASELINE_TEST_FAKE_CODEX_CANONICAL_PATHS !== '1') return value;
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

if (!home) fail('CODEX_HOME is required');
if (args[0] !== 'plugin' || args[args.length - 1] !== '--json') fail('expected codex plugin ... --json');
const command = args.slice(1, -1);
const state = loadState();
state.commands.push(args);

if (command.length === 2 && command[0] === 'marketplace' && command[1] === 'list') {
  saveState(state);
  if (process.env.BASELINE_TEST_FAKE_CODEX_MARKETPLACE_LIST_WRONG_SHAPE === '1') {
    output({ marketplaces: {} });
    process.exit(0);
  }
  if (process.env.BASELINE_TEST_FAKE_CODEX_MARKETPLACE_LIST_MALFORMED_ENTRY === '1') {
    output({ marketplaces: [null] });
    process.exit(0);
  }
  output({ marketplaces: state.marketplaces.map(entry => ({ name: entry.name, root: reportedPath(entry.root) })) });
  process.exit(0);
}

if (command.length === 3 && command[0] === 'marketplace' && command[1] === 'add') {
  const root = path.resolve(command[2]);
  const manifestPath = path.join(root, '.agents', 'plugins', 'marketplace.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('cannot read marketplace manifest at ' + manifestPath);
  }
  if (!manifest || typeof manifest.name !== 'string') fail('marketplace manifest needs a name');
  const existing = state.marketplaces.find(entry => entry.name === manifest.name);
  if (existing) {
    saveState(state);
    output({ alreadyAdded: true });
    process.exit(0);
  }
  state.marketplaces.push({ name: manifest.name, root });
  saveState(state);
  output({ alreadyAdded: false });
  process.exit(0);
}

if (command.length === 3 && command[0] === 'marketplace' && command[1] === 'remove') {
  state.marketplaces = state.marketplaces.filter(entry => entry.name !== command[2]);
  saveState(state);
  output({ removed: true });
  process.exit(0);
}

if (command.length === 1 && command[0] === 'list') {
  saveState(state);
  if (process.env.BASELINE_TEST_FAKE_CODEX_PLUGIN_LIST_UNREADABLE === '1') {
    fail('fake Codex plugin list is unreadable');
  }
  if (process.env.BASELINE_TEST_FAKE_CODEX_PLUGIN_LIST_WRONG_SHAPE === '1') {
    output({ installed: {} });
    process.exit(0);
  }
  if (process.env.BASELINE_TEST_FAKE_CODEX_PLUGIN_LIST_MALFORMED_ENTRY === '1') {
    output({ installed: [null] });
    process.exit(0);
  }
  output({ installed: state.installed.map(entry => Object.assign({}, entry, { source: { path: reportedPath(entry.source.path) } })) });
  process.exit(0);
}

if (command.length === 2 && command[0] === 'add') {
  const selector = command[1];
  const at = selector.lastIndexOf('@');
  if (at <= 0) fail('invalid plugin selector ' + selector);
  const pluginName = selector.slice(0, at);
  const marketplaceName = selector.slice(at + 1);
  const marketplace = state.marketplaces.find(entry => entry.name === marketplaceName);
  if (!marketplace) fail('marketplace not registered: ' + marketplaceName);
  const pluginPath = path.join(marketplace.root, 'plugins', pluginName);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pluginPath, '.codex-plugin', 'plugin.json'), 'utf8'));
  } catch {
    fail('cannot read plugin manifest at ' + pluginPath);
  }
  if (!manifest || typeof manifest.version !== 'string') fail('plugin manifest needs a version');
  state.installed = state.installed.filter(entry => entry.pluginId !== selector);
  state.installed.push({ pluginId: selector, enabled: true, version: manifest.version, source: { path: pluginPath } });
  saveState(state);
  output({ version: manifest.version });
  process.exit(0);
}

if (command.length === 2 && command[0] === 'remove') {
  state.installed = state.installed.filter(entry => entry.pluginId !== command[1]);
  saveState(state);
  output({ removed: true });
  process.exit(0);
}

fail('unsupported fake Codex command: ' + command.join(' '));
`);
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'codex.cmd');
    write(shim, '@echo off\r\n"' + process.execPath + '" "%~dp0codex.js" %*\r\n');
    return shim;
  }
  fs.chmodSync(script, 0o755);
  return script;
}

const fakeCodexCli = createFakeCodexCli();

// A copied Node executable is a real native launcher on Windows (.exe) and a
// direct executable everywhere else. Its temporary `plugin` entrypoint hands
// the received argv to the same stateful fake CLI used by lifecycle tests.
function createFakeCodexNativeCli(): { cli: string; cwd: string; env: { [key: string]: string } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline test native & codex-'));
  const cli = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.copyFileSync(process.execPath, cli);
  if (process.platform !== 'win32') fs.chmodSync(cli, 0o755);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-native-codex-cwd-'));
  const fakeScript = path.join(path.dirname(fakeCodexCli), 'codex.js');
  write(path.join(cwd, 'plugin'), String.raw`const fakeScript = process.env.BASELINE_TEST_FAKE_CODEX_NATIVE_SCRIPT;
if (!fakeScript) throw new Error('missing native fake Codex script');
process.argv.splice(1, 1, fakeScript, 'plugin');
require(fakeScript);
`);
  return {
    cli,
    cwd,
    env: {
      BASELINE_CODEX_CLI: 'codex',
      BASELINE_TEST_FAKE_CODEX_NATIVE_SCRIPT: fakeScript,
      PATH: dir + path.delimiter + (process.env.PATH || ''),
    },
  };
}

function installedManager(home: string): string {
  return path.join(home, 'scripts', 'manage.js');
}

function installedDispatcherSource(home: string): string {
  return path.join(home, 'scripts', 'baseline-recital.js');
}
function installedContractsSource(home: string): string {
  return path.join(home, 'scripts', 'contracts.js');
}

function centralHookContracts(home: string): string {
  return path.join(home, 'hooks', 'contracts.js');
}

function agentHookDispatcher(agentConfig: string): string {
  return path.join(agentConfig, 'hooks', 'baseline-recital.js');
}

function agentHookContracts(agentConfig: string): string {
  return path.join(agentConfig, 'hooks', 'contracts.js');
}

function runAgentHook(agentConfig: string, home: string, input: any) {
  return spawnSync(process.execPath, [agentHookDispatcher(agentConfig), '--agent-config', agentConfig], {
    input: JSON.stringify(input),
    env: Object.assign({}, process.env, { BASELINE_HOME: home }),
    encoding: 'utf8'
  });
}

function runConfiguredHook(hook: any, input: any) {
  const options = { input: JSON.stringify(input), encoding: 'utf8' as const };
  if (Array.isArray(hook.args)) return spawnSync(hook.command, hook.args, options);
  return process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', hook.command], options)
    : spawnSync('sh', ['-c', hook.command], options);
}

function assertPlatformHookCommand(command: string, label: string): void {
  if (process.platform === 'win32') {
    assert.ok(command.startsWith("& '"), label + ' must invoke its quoted executable with PowerShell &: ' + command);
  } else {
    assert.ok(command.startsWith("'"), label + ' must start with a POSIX-quoted executable: ' + command);
    assert.ok(!command.startsWith('& '), label + ' must not use the PowerShell call operator: ' + command);
  }
}

function hookCommandText(hook: any): string {
  return [hook.command].concat(Array.isArray(hook.args) ? hook.args : []).join(' ');
}

function statusAgentSection(output: string, agentName: string): string {
  const text = output.replace(/\r\n/g, '\n');
  const marker = '  agent ' + agentName + ' @ ';
  const start = text.indexOf(marker);
  assert.notStrictEqual(start, -1, 'status missing ' + agentName + ' section');
  const next = text.indexOf('\n  agent ', start + marker.length);
  return text.slice(start, next === -1 ? undefined : next);
}
const CODEX_MARKETPLACE = 'baseline-local';
const CODEX_PLUGIN_KEY = 'baseline@baseline-local';

function centralCodexMarketplace(home: string): string {
  return path.join(home, 'codex-marketplace');
}

function codexCommand(...args: string[]): string[] {
  return ['plugin'].concat(args, ['--json']);
}

function assertCodexPluginInstalled(codex: string, home: string, label: string): void {
  const state = readFakeCodexState(codex);
  assert.deepStrictEqual(state.marketplaces, [{
    name: CODEX_MARKETPLACE,
    root: centralCodexMarketplace(home),
  }], label + ' marketplace registration');
  const plugin = state.installed.find(entry => entry.pluginId === CODEX_PLUGIN_KEY);
  if (!plugin) assert.fail(label + ' plugin was not installed');
  assert.strictEqual(plugin.enabled, true, label + ' plugin should be enabled');
  assert.strictEqual(plugin.source.path, centralCodexPlugin(home), label + ' plugin should resolve to the central payload');
  assert.strictEqual(plugin.version, expectedCodexPluginVersion(home, label),
    label + ' plugin should use the current deterministic Codex payload version');

}


function centralCodexPlugin(home: string): string {
  return path.join(home, 'codex-marketplace', 'plugins', 'baseline');
}

function expectedCodexPluginVersion(home: string, label: string): string {
  const sourceText = readThrough(path.join(root, '.codex-plugin', 'plugin.json'));
  const sourceManifest: unknown = JSON.parse(sourceText);
  if (!isRecord(sourceManifest) || typeof sourceManifest.version !== 'string' || !sourceManifest.version) {
    throw new Error(label + ' source Codex manifest needs a version');
  }
  const generatedSkill = readThrough(path.join(centralCodexPlugin(home), 'skills', 'baseline', 'SKILL.md'));
  const provenance = '\n    ' + root + '\n\nIf you need to refresh from a different checkout, run that checkout\'s';
  const canonicalProvenance = '\n    <source-checkout>\n\nIf you need to refresh from a different checkout, run that checkout\'s';
  if (!generatedSkill.includes(provenance)) throw new Error(label + ' generated Codex skill needs source-checkout provenance');
  const cachebusterSkill = generatedSkill.replace(provenance, canonicalProvenance);
  const digest = crypto.createHash('sha256').update(sourceText).update('\0').update(cachebusterSkill).digest('hex').slice(0, 12);
  return sourceManifest.version.split('+')[0] + '+codex.local-' + digest;
}



function assertCodexPayload(pluginDir: string, label: string): void {
  const manifest = path.join(pluginDir, '.codex-plugin', 'plugin.json');
  const skill = path.join(pluginDir, 'skills', 'baseline', 'SKILL.md');
  assert.strictEqual(JSON.parse(readThrough(manifest)).name, 'baseline', label + ' manifest should name baseline');
  assert.ok(fs.existsSync(skill), label + ' skill wrapper missing');
}

function assertControlSurfaceCommandsUseInstalledManager(skillBody: string, home: string, label: string): void {
  const manager = installedManager(home);
  for (const cmd of ['status', 'install', 'update', 'verify', 'doctor', 'doctor --fix', 'uninstall']) {
    assert.ok(skillBody.includes('node "' + manager + '" ' + cmd),
      label + ' should invoke installed manager for `' + cmd + '`');
  }
  assert.ok(!skillBody.includes('node "' + path.join(root, 'scripts', 'manage.js') + '" status'),
    label + ' must not use source-checkout manager commands for normal status');
}

// --- install / link / settings ---------------------------------------------

function testDefaultInstallAndVerify(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  // R-009: a plain install now prefers the shipped native Zig prebuilt as the hook hot path
  // when one is available for this platform; it only falls back to Node where none ships.
  const target = nativePrebuiltForPlatform();
  const havePrebuilt = target !== null && fs.existsSync(path.join(root, 'bin', target));
  if (havePrebuilt) {
    assert.match(install.stdout, /runtime\s+: native \(prebuilt /);
  } else {
    assert.match(install.stdout, /runtime\s+: node js/);
  }
  // No --preset → DEFAULT_PRESET is now 'default'.
  assert.match(install.stdout, /config folder : .*\(seeded, preset: default\)/);
  assert.ok(install.stdout.includes('manager       : ' + installedManager(home)),
    'plain install should report the self-contained installed manager path');
  assert.strictEqual(readThrough(installedManager(home)), readThrough(manage),
    'plain install did not deploy the manager artifact under the install root');
  assert.strictEqual(readThrough(installedDispatcherSource(home)), readThrough(dispatcher),
    'plain install did not deploy the dispatcher source artifact under install-root scripts');
  assert.strictEqual(readThrough(installedContractsSource(home)), readThrough(contracts),
    'plain install did not deploy the contracts artifact under install-root scripts');

  const installedStatus = runInstalled(['status'], cfg, home);
  assert.strictEqual(installedStatus.status, 0, installedStatus.stderr || installedStatus.stdout);
  assert.match(installedStatus.stdout, /manager\s+: present at /,
    'installed manager should run independently from the install root');

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const command = hookCommandText(settings.hooks.UserPromptSubmit[0].hooks[0]);
  // On POSIX nativeBinName ("baseline-recital") is a substring of the Node .js path, so the
  // native branch pairs the positive include with a negative /baseline-recital\.js/ check.
  if (havePrebuilt) {
    assert.ok(command.includes(nativeBinName), 'plain install with a prebuilt should wire the native binary: ' + command);
    assert.ok(!/baseline-recital\.js/.test(command), 'native hot path must not wire the Node .js: ' + command);
  } else {
    assert.ok(/baseline-recital\.js/.test(command), 'plain install without a prebuilt should wire Node: ' + command);
  }
  // default preset wires UserPromptSubmit + SessionStart (the 3 phase routes collapse to
  // one native SessionStart hook); PreToolUse stays unwired.
  assert.ok(settings.hooks.SessionStart, 'default preset should wire SessionStart');
  assert.ok(!settings.hooks.PreToolUse, 'unused PreToolUse event should not be wired');

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verify: PASS/);
}

// A source checkout deploys a payload containing its truthful provenance. The
// installed manager recovers that provenance while its cachebuster normalizes
// only the provenance field, so fresh payloads remain healthy after handoff.

function testInstalledManagerKeepsFreshCodexPayloadHealthy(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const status = runInstalled(['status'], cfg, home);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.ok(!status.stdout.includes('STALE'), 'installed manager status must not report a fresh Codex payload stale:\n' + status.stdout);
  const jsonStatusResult = runInstalled(['status', '--json'], cfg, home);
  assert.strictEqual(jsonStatusResult.status, 0, jsonStatusResult.stderr || jsonStatusResult.stdout);
  const jsonStatus: unknown = JSON.parse(jsonStatusResult.stdout);
  if (!isRecord(jsonStatus) || !isRecord(jsonStatus.data) || !isRecord(jsonStatus.data.codexPlugin)) {
    throw new Error('installed manager status --json needs Codex payload state');
  }
  assert.strictEqual(jsonStatus.data.codexPlugin.stale, false,
    'installed manager JSON status must mark a fresh Codex payload healthy');
  assert.strictEqual(jsonStatus.data.codexPlugin.version, expectedCodexPluginVersion(home, 'installed manager status'),
    'installed manager JSON status must report the exact deployed Codex version');


  const doctor = runInstalled(['doctor'], cfg, home);
  assert.strictEqual(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /codex plugin payload: central payload deployed; points at installed manager/);
  assert.match(doctor.stdout, /codex plugin install: codex baseline@baseline-local installed @/);
  assert.match(doctor.stdout, /doctor: healthy/);
  const codexSkillPath = path.join(centralCodexPlugin(home), 'skills', 'baseline', 'SKILL.md');
  const sourceProvenance = '\n    ' + root + '\n\nIf you need to refresh from a different checkout, run that checkout\'s';
  assert.ok(readThrough(codexSkillPath).includes(sourceProvenance),
    'source install should record truthful Codex source-checkout provenance');
  const update = runInstalled(['update'], cfg, home);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.ok(readThrough(codexSkillPath).includes(sourceProvenance),
    'installed update should preserve truthful Codex source-checkout provenance');
  const postUpdateDoctor = runInstalled(['doctor'], cfg, home);
  assert.strictEqual(postUpdateDoctor.status, 0, postUpdateDoctor.stderr || postUpdateDoctor.stdout);
  assert.match(postUpdateDoctor.stdout, /doctor: healthy/);

}

// Source-checkout provenance is intentionally displayed for refresh guidance, but
// changing only that field must not invalidate the deterministic Codex version.
function testCodexCachebusterIgnoresSourceCheckoutProvenance(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  const manifestPath = path.join(centralCodexPlugin(home), '.codex-plugin', 'plugin.json');
  const manifest: unknown = JSON.parse(readThrough(manifestPath));
  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new Error('installed central Codex manifest needs a version');
  }
  const installedVersion = manifest.version;
  const skillPath = path.join(centralCodexPlugin(home), 'skills', 'baseline', 'SKILL.md');
  const sourceProvenance = '\n    ' + root + '\n\nIf you need to refresh from a different checkout, run that checkout\'s';
  const movedProvenance = '\n    ' + path.join(cfg, 'moved-source-checkout') + '\n\nIf you need to refresh from a different checkout, run that checkout\'s';
  const skill = readThrough(skillPath);
  if (!skill.includes(sourceProvenance)) throw new Error('source-installed Codex skill needs source-checkout provenance');
  write(skillPath, skill.replace(sourceProvenance, movedProvenance));

  const status = runInstalled(['status', '--json'], cfg, home);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const jsonStatus: unknown = JSON.parse(status.stdout);
  if (!isRecord(jsonStatus) || !isRecord(jsonStatus.data) || !isRecord(jsonStatus.data.codexPlugin)) {
    throw new Error('installed manager status --json needs Codex payload state');
  }
  assert.strictEqual(jsonStatus.data.codexPlugin.version, installedVersion,
    'provenance-only change must leave the deployed Codex version untouched');
  assert.strictEqual(jsonStatus.data.codexPlugin.stale, false,
    'installed manager status must not treat provenance-only change as digest drift');

  const doctor = runInstalled(['doctor'], cfg, home);
  assert.strictEqual(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /doctor: healthy/);
}



function testInstalledManagerInfersInstallRootWithoutBaselineHome(): void {
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
  assert.ok(status.stdout.includes('install root   : ' + home),
    'installed manager should infer its own non-default install root when BASELINE_HOME is absent, even when the central hook is missing:\n' + status.stdout);
  assert.ok(status.stdout.includes('manager        : present at ' + installedManager(home)),
    'installed manager status should look under the inferred install root:\n' + status.stdout);

  const update = runInstalledWithoutBaselineEnv(['update'], cfg, home, noBaselineEnv);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.ok(fs.existsSync(path.join(home, 'hooks', 'baseline-recital.js')),
    'installed manager update should repair the missing central hook under the inferred install root');

  fs.rmSync(path.join(home, 'hooks'), { recursive: true, force: true });
  const fixed = runInstalledWithoutBaselineEnv(['doctor', '--fix'], cfg, home, noBaselineEnv);
  assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /doctor: installation repaired/);
  assert.ok(fs.existsSync(path.join(home, 'hooks', 'baseline-recital.js')),
    'installed manager doctor --fix should repair the missing central hook under the inferred install root');
}

function testBaselineHomeOverridesInstalledManagerLocation(): void {
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
  assert.ok(status.stdout.includes('install root   : ' + overrideHome),
    'BASELINE_HOME should override the installed manager location:\n' + status.stdout);
}

function testSourceLikeInstalledManagerDoesNotInferInstallRoot(): void {
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
  assert.ok(status.stdout.includes('install root   : ' + fallbackRoot),
    'source-like manager should fall back to the user install root when src/manage.ts is present:\n' + status.stdout);
  assert.ok(!status.stdout.includes('install root   : ' + home),
    'source-like manager must not infer the source-like root as installed:\n' + status.stdout);
}

// R-014 (goal decision #17): the install-root default is a pinned, tested contract.
// This consolidates the resolution ORDER in one place — BASELINE_HOME > the installed
// manager's own root > the ~/.baseline literal — driving all three rungs of the same
// installed manager (the scenario tests above each cover one rung; this pins the order).
function testInstallRootDefaultContract(): void {
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
  assert.ok(r1.stdout.includes('install root   : ' + overrideHome),
    'BASELINE_HOME must win over the inferred install root:\n' + r1.stdout);

  // Rung 2: no BASELINE_HOME — the installed manager infers its OWN root, ahead of ~/.baseline.
  const fakeUserHome = cfg + '-order-userhome';
  fs.mkdirSync(fakeUserHome, { recursive: true });
  const r2 = runInstalledWithoutBaselineEnv(['status'], cfg, home, { HOME: fakeUserHome, USERPROFILE: fakeUserHome });
  assert.strictEqual(r2.status, 0, r2.stderr || r2.stdout);
  assert.ok(r2.stdout.includes('install root   : ' + home),
    'installed manager must infer its own root ahead of ~/.baseline:\n' + r2.stdout);
  assert.ok(!r2.stdout.includes('install root   : ' + path.join(fakeUserHome, '.baseline')),
    'the inferred root must take precedence over the ~/.baseline literal:\n' + r2.stdout);

  // Rung 3: no BASELINE_HOME and a source-like manager (src/manage.ts present) → the
  // ~/.baseline literal under the user home is the final fallback.
  write(path.join(home, 'src', 'manage.ts'), '// source checkout marker\n');
  const r3 = runInstalledWithoutBaselineEnv(['status'], cfg, home, { HOME: fakeUserHome, USERPROFILE: fakeUserHome });
  assert.strictEqual(r3.status, 0, r3.stderr || r3.stdout);
  assert.ok(r3.stdout.includes('install root   : ' + path.join(fakeUserHome, '.baseline')),
    'source-like manager with no BASELINE_HOME must fall back to the ~/.baseline literal:\n' + r3.stdout);
}

// The minimal preset is bare baseline only: one UserPromptSubmit route, nothing else.
function testMinimalPresetWiresOnlyUserPromptSubmit(): void {
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
function testDefaultPresetWiresBaseEventsBothAgents(): void {
  const cfg = tempConfig();
  const codex = codexFor(cfg);
  const install = run(['install', '--preset', 'default'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  // The default preset config parses/validates: version 1, baseline + 3 SessionStart routes.
  const presetCfg = JSON.parse(fs.readFileSync(path.join(root, 'presets', 'default', 'config.json'), 'utf8'));
  assert.strictEqual(presetCfg.version, 1, 'default config version must be 1');
  assert.deepStrictEqual(presetCfg.routes.map((r: any) => r.id),
    ['baseline', 'sessionstart-startup', 'sessionstart-compact', 'sessionstart-clear'],
    'default preset route ids changed');
  assert.deepStrictEqual(presetCfg.routes.map((r: any) => r.event),
    ['UserPromptSubmit', 'SessionStart.startup', 'SessionStart.compact', 'SessionStart.clear'],
    'default preset route events changed');

  // Both agents wire EXACTLY [UserPromptSubmit, SessionStart]; the phase routes collapse
  // to ONE native SessionStart hook with no per-phase entry and no matcher.
  const agents: [string, string][] = [
    ['claude-code', path.join(cfg, 'settings.json')],
    ['codex', path.join(codex, 'hooks.json')]
  ];
  for (const [label, file] of agents) {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['SessionStart', 'UserPromptSubmit'],
      label + ' should wire exactly [UserPromptSubmit, SessionStart]');
    assert.ok(!Object.keys(s.hooks).some((k: string) => k.indexOf('.') !== -1),
      label + ' must not key a hook event by phase (e.g. SessionStart.compact)');
    for (const ev of ['UserPromptSubmit', 'SessionStart']) {
      assert.strictEqual(s.hooks[ev].length, 1, label + ' ' + ev + ' should have exactly one group');
      assert.strictEqual(s.hooks[ev][0].hooks.length, 1, label + ' ' + ev + ' should have exactly one hook entry');
      assert.strictEqual(s.hooks[ev][0].matcher, undefined, label + ' ' + ev + ' group must carry no matcher');
      assert.ok(hookCommandText(s.hooks[ev][0].hooks[0]).includes('baseline-recital'),
        label + ' ' + ev + ' hook should be the baseline dispatcher (native binary or Node .js)');
    }
  }

  // The seeded default config validates and passes doctor.
  const doctor = run(['doctor'], cfg);
  assert.strictEqual(doctor.status, 0, doctor.stdout);
  assert.match(doctor.stdout, /config\.json: valid; 4 route\(s\) over \[UserPromptSubmit, SessionStart\]/);
}

function testCentralInstallAndAgentLinks(): void {
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
  assert.strictEqual(readThrough(agentJs), readThrough(path.join(home, 'hooks', 'baseline-recital.js')),
    'agent dispatcher does not resolve to central content');
  assert.strictEqual(readThrough(agentContracts), readThrough(centralHookContracts(home)),
    'agent contracts do not resolve to central content');
  assert.strictEqual(readThrough(agentConfig), readThrough(path.join(home, 'cfg', 'config.json')),
    'agent config.json does not resolve to central content');

  const status = run(['status'], cfg);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /install root\s+: /);
  assert.match(status.stdout, /baseline: event=UserPromptSubmit, freq=5/);
}

function testCodexInstallAndAgentLinks(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const hooksJson = JSON.parse(fs.readFileSync(path.join(codex, 'hooks.json'), 'utf8'));
  const command = hooksJson.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(command.includes('baseline-recital'), 'codex hook should be the baseline dispatcher (native binary or Node .js): ' + command);
  assert.ok(command.includes('--agent-config'), command);
  assert.ok(command.includes(codex), command);
  const agentContracts = agentHookContracts(codex);
  assert.ok(fs.existsSync(agentContracts), 'codex contracts not linked');
  assert.strictEqual(readThrough(agentContracts), readThrough(centralHookContracts(home)),
    'codex contracts do not resolve to central content');

  const agentConfig = path.join(codex, 'cfg', 'baseline', 'config.json');
  assert.strictEqual(readThrough(agentConfig), readThrough(path.join(homeFor(cfg), 'cfg', 'config.json')),
    'codex config.json does not resolve to central content');
  assertCodexPluginInstalled(codex, home, 'install');
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('marketplace', 'add', centralCodexMarketplace(home)),
    codexCommand('add', CODEX_PLUGIN_KEY),
  ], 'install should register the central marketplace and install its selector through Codex CLI');
}

// Codex must receive each CLI token intact when every lifecycle path contains
// spaces and CMD metacharacters, including the npm-style .cmd shim used by Windows.
function testCodexLifecyclePreservesSpacedPaths(): void {
  const cfg = tempConfig('baseline test spaced & lifecycle-');
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const cli = createFakeCodexCli('baseline test fake & codex cli-');
  const env = { BASELINE_CODEX_CLI: cli };
  const marketplaceRoot = centralCodexMarketplace(home);
  assert.ok(/\s/.test(home), 'precondition: BASELINE_HOME must contain spaces');
  assert.ok(/\s/.test(codex), 'precondition: CODEX_HOME must contain spaces');
  assert.ok(/\s/.test(cli), 'precondition: BASELINE_CODEX_CLI must contain spaces');
  assert.ok(/\s/.test(marketplaceRoot), 'precondition: marketplace root must contain spaces');
  assert.ok(home.includes('&') && cli.includes('&') && marketplaceRoot.includes('&'),
    'precondition: command values must contain a CMD metacharacter');

  const install = run(['install'], cfg, undefined, env);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('marketplace', 'add', marketplaceRoot),
    codexCommand('add', CODEX_PLUGIN_KEY),
  ], 'install must pass the spaced marketplace root as one Codex CLI argument');
  assertCodexPayload(centralCodexPlugin(home), 'spaced-path central Codex plugin');
  assertCodexPluginInstalled(codex, home, 'spaced-path install');
  const hooks = JSON.parse(readThrough(path.join(codex, 'hooks.json')));
  assert.ok(hooks.hooks.UserPromptSubmit && hooks.hooks.UserPromptSubmit.length,
    'spaced-path install must establish the Codex hook control surface');

  resetFakeCodexCommands(codex);
  const update = run(['update'], cfg, undefined, env);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
    codexCommand('add', CODEX_PLUGIN_KEY),
  ], 'update must preserve spaced Codex CLI arguments and refresh the plugin');
  assertCodexPluginInstalled(codex, home, 'spaced-path update');
}

// Resolution must use the actual target: a bare PATH alias that resolves to a
// native executable takes the direct argv branch, including paths with CMD
// metacharacters. The stateful child verifies the argv it actually received.
function testCodexResolvesBareNativeExecutableAlias(): void {
  const cfg = tempConfig('baseline test native & lifecycle-');
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const native = createFakeCodexNativeCli();
  const install = run(['install'], cfg, undefined, native.env, native.cwd);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('marketplace', 'add', centralCodexMarketplace(home)),
    codexCommand('add', CODEX_PLUGIN_KEY),
  ], 'resolved native Codex executable must receive every lifecycle argv token intact');
  assertCodexPluginInstalled(codex, home, 'resolved native executable install');
}

// Windows resolves bare commands from the parent working directory before
// PATH. The native target lives only in that CWD; PATHEXT proves the resolver
// finds its .exe target without a shell fallback.
function testWindowsCodexResolvesBareCwdExecutableBeforePath(): void {
  if (process.platform !== 'win32') {
    console.log('  (skip) testWindowsCodexResolvesBareCwdExecutableBeforePath: Windows-only.');
    return;
  }
  const cfg = tempConfig('baseline test cwd & native-');
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const native = createFakeCodexNativeCli();
  fs.copyFileSync(native.cli, path.join(native.cwd, 'codex.exe'));
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-empty-codex-path-'));
  const install = run(['install'], cfg, undefined, Object.assign({}, native.env, {
    PATH: emptyPath,
    PATHEXT: '.EXE;.CMD;.BAT;.COM',
  }), native.cwd);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('marketplace', 'add', centralCodexMarketplace(home)),
    codexCommand('add', CODEX_PLUGIN_KEY),
  ], 'bare CWD Codex executable must receive every lifecycle argv token intact');
}

// npm publishes Codex through a .cmd shim on Windows. This must work from the
// normal bare `codex` name, rather than only through an explicit shim path.
function testCodexResolvesBareBatchShimAlias(): void {
  if (process.platform !== 'win32') {
    console.log('  (skip) testCodexResolvesBareBatchShimAlias: Windows-only.');
    return;
  }
  const cfg = tempConfig('baseline test bare & batch-');
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const shim = createFakeCodexCli('baseline test bare & batch cli-');
  write(path.join(path.dirname(shim), 'codex'), 'non-native npm shim decoy\n');
  const install = run(['install'], cfg, undefined, {
    BASELINE_CODEX_CLI: 'codex',
    PATH: path.dirname(shim) + path.delimiter + (process.env.PATH || ''),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  });
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('marketplace', 'add', centralCodexMarketplace(home)),
    codexCommand('add', CODEX_PLUGIN_KEY),
  ], 'resolved .cmd Codex alias must receive every CMD-metacharacter argv token intact');
}

// Missing bare `codex` is detected by resolution before spawn, so no localized
// cmd.exe diagnostic can determine whether lifecycle work is nonfatal.
function testMissingBareCodexCliLeavesControlSurfaceUninstalled(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-empty-codex-path-'));
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-empty-codex-cwd-'));
  const install = run(['install'], cfg, undefined, {
    BASELINE_CODEX_CLI: '',
    PATH: emptyPath,
  }, emptyCwd);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /codex NOTICE: `codex` CLI unavailable/);
  assert.ok(fs.existsSync(centralCodexPlugin(home)), 'missing bare Codex must still deploy the central payload');
  assert.ok(!fs.existsSync(fakeCodexStatePath(codex)), 'missing bare Codex must not spawn a fake lifecycle command');
}

// Codex reports canonical source paths after resolving a manager root through a
// symlink/junction. The manager must still own that registration, not reject it
// as a foreign marketplace/plugin.
function testCodexOwnershipAcceptsCanonicalSymlinkedHome(): void {
  const cfg = tempConfig();
  const linkedHome = homeFor(cfg);
  const realHome = linkedHome + '-real';
  fs.mkdirSync(realHome, { recursive: true });
  try {
    fs.symlinkSync(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    console.log('  (skip) testCodexOwnershipAcceptsCanonicalSymlinkedHome: symlink/junction creation unavailable.');
    return; // Windows policy can prohibit both symlink and junction creation.
  }
  const env = { BASELINE_TEST_FAKE_CODEX_CANONICAL_PATHS: '1' };
  const install = run(['install'], cfg, linkedHome, env);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  const update = run(['update'], cfg, linkedHome, env);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  const doctor = run(['doctor'], cfg, linkedHome, env);
  assert.strictEqual(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /doctor: healthy/);
  assertCodexPluginInstalled(codexFor(cfg), linkedHome, 'canonical symlinked-home lifecycle');
}

function testShellSafeHookCommandsBothAgents(): void {
  const cfg = tempConfig("'baseline-test-O'Brien-");
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  setCentralConfig(home, [
    { id: 'shell-safe', event: 'UserPromptSubmit', freq: 1, doc: 'docs/shell-safe.md' }
  ], { 'docs/shell-safe.md': 'SHELL SAFE OK\n' });

  const install = run(['install', '--runtime', 'node'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const agents: Array<[string, string, string]> = [
    ['claude-code', path.join(cfg, 'settings.json'), cfg],
    ['codex', path.join(codex, 'hooks.json'), codex]
  ];
  for (const [label, file, agentConfig] of agents) {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hook = settings.hooks.UserPromptSubmit[0].hooks[0];
    if (label === 'claude-code') {
      assert.strictEqual(hook.command, process.execPath, 'Claude must use its shell-free executable field');
      assert.deepStrictEqual(hook.args, [agentHookDispatcher(agentConfig), '--agent-config', agentConfig],
        'Claude must keep arguments as literal argv entries');
    } else {
      assertPlatformHookCommand(hook.command, label);
      assert.ok(hook.command.includes(process.platform === 'win32' ? "O''Brien" : "O'\"'\"'Brien"),
        label + ' command must shell-escape an apostrophe literally: ' + hook.command);
    }

    const fired = runConfiguredHook(hook, {
      session_id: 'shell-safe-' + label,
      hook_event_name: 'UserPromptSubmit',
      cwd: root
    });
    assert.strictEqual(fired.status, 0, label + ' configured command failed in its platform shell: ' + (fired.stderr || fired.stdout));
    assert.match(fired.stdout, /SHELL SAFE OK/, label + ' configured command did not run the dispatcher');
  }

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verify: PASS/);
  assert.match(verify.stdout, /agent tested\s+: codex/);
}

function testVerifyRunsConfiguredCommandThroughShell(): void {
  const cfg = tempConfig();
  const install = run(['install', '--runtime', 'node'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const settingsFile = path.join(codexFor(cfg), 'hooks.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.hooks.UserPromptSubmit[0].hooks[0].command += '; exit 7';
  write(settingsFile, JSON.stringify(settings, null, 2) + '\n');

  const verify = run(['verify'], cfg);
  assert.notStrictEqual(verify.status, 0, 'verify must honor shell syntax in the configured command');
  assert.match(verify.stdout, /configured shell exited 7/);
}

function testUpdateReplacesLegacyWindowsHookCommand(): void {
  if (process.platform !== 'win32') {
    console.log('  (skip) testUpdateReplacesLegacyWindowsHookCommand: PowerShell-only migration.');
    return;
  }
  const cfg = tempConfig();
  const codex = codexFor(cfg);
  const install = run(['install', '--runtime', 'node'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const files: Array<[string, string]> = [
    ['claude-code', path.join(cfg, 'settings.json')],
    ['codex', path.join(codex, 'hooks.json')]
  ];
  for (const [label, file] of files) {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hook = settings.hooks.UserPromptSubmit[0].hooks[0];
    if (label === 'claude-code') {
      const argv = [hook.command].concat(hook.args);
      hook.command = argv.map((arg: string) => '"' + arg.replace(/"/g, '\\"') + '"').join(' ');
      delete hook.args;
    } else {
      assert.ok(hook.command.startsWith('& '), 'precondition: Codex command must use PowerShell &');
      hook.command = hook.command.slice(2);
    }
    write(file, JSON.stringify(settings, null, 2) + '\n');
  }

  const doctor = run(['doctor'], cfg);
  assert.notStrictEqual(doctor.status, 0, 'doctor must flag recognized legacy hook invocations');
  assert.match(doctor.stdout, /\[FAIL\] hook invocation: claude-code uses a legacy\/noncanonical invocation/);
  assert.match(doctor.stdout, /\[FAIL\] hook invocation: codex uses a legacy\/noncanonical invocation/);
  const status = run(['status'], cfg);
  assert.match(statusAgentSection(status.stdout, 'claude-code'), /invocation\s+: UNHEALTHY/);
  assert.match(statusAgentSection(status.stdout, 'codex'), /invocation\s+: UNHEALTHY/);
  const jsonStatus = run(['status', '--json'], cfg);
  assert.strictEqual(jsonStatus.status, 0, jsonStatus.stderr || jsonStatus.stdout);
  const jsonAgents = JSON.parse(jsonStatus.stdout).data.agents
    .filter((agent: any) => agent.name === 'claude-code' || agent.name === 'codex');
  assert.ok(jsonAgents.length === 2 && jsonAgents.every((agent: any) => agent.invocation.canonical === false),
    'JSON status must expose noncanonical invocation drift for both agents');

  const update = run(['update', '--runtime', 'node'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  for (const [label, file] of files) {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const groups = settings.hooks.UserPromptSubmit;
    assert.strictEqual(groups.length, 1, file + ' must not retain a duplicate legacy hook group');
    assert.strictEqual(groups[0].hooks.length, 1, file + ' must contain exactly one baseline hook');
    const hook = groups[0].hooks[0];
    if (label === 'claude-code') {
      assert.strictEqual(hook.command, process.execPath);
      assert.ok(Array.isArray(hook.args), 'Claude update must restore shell-free args');
    } else {
      assertPlatformHookCommand(hook.command, file);
    }
  }
}

function testInstalledHooksResolveBundledContracts(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  setCentralConfig(home, [
    { id: 'hook-contracts', event: 'UserPromptSubmit', freq: 1, doc: 'docs/hook-contracts.md' }
  ], { 'docs/hook-contracts.md': 'CONTRACT HOOK OK\n' });

  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  for (const [label, agentConfig] of [['claude-code', cfg], ['codex', codex]] as Array<[string, string]>) {
    assert.ok(fs.existsSync(agentHookDispatcher(agentConfig)), label + ' dispatcher missing');
    assert.ok(fs.existsSync(agentHookContracts(agentConfig)), label + ' contracts missing');
    assert.strictEqual(readThrough(agentHookContracts(agentConfig)), readThrough(centralHookContracts(home)),
      label + ' contracts should resolve to central content');
  }

  const claude = runAgentHook(cfg, home, { session_id: 'contracts-claude', hook_event_name: 'UserPromptSubmit', cwd: cfg });
  assert.strictEqual(claude.status, 0, claude.stderr || claude.stdout);
  assert.ok((fireBodies(claude) || '').includes('CONTRACT HOOK OK'),
    'Claude installed hook should resolve ./contracts and fire');

  // Simulate the cross-device/perms fallback path: both hook files are regular copies
  // in the Codex hooks dir, so require("./contracts") must resolve beside that copy.
  fs.rmSync(agentHookDispatcher(codex), { force: true });
  fs.rmSync(agentHookContracts(codex), { force: true });
  fs.copyFileSync(path.join(home, 'hooks', 'baseline-recital.js'), agentHookDispatcher(codex));
  fs.copyFileSync(centralHookContracts(home), agentHookContracts(codex));

  const codexRun = runAgentHook(codex, home, { session_id: 'contracts-codex', hook_event_name: 'UserPromptSubmit', cwd: cfg });
  assert.strictEqual(codexRun.status, 0, codexRun.stderr || codexRun.stdout);
  assert.ok((fireBodies(codexRun) || '').includes('CONTRACT HOOK OK'),
    'Codex copied hook should resolve ./contracts from the copy target and fire');
}

function testCentralEditPropagatesToAgent(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  // Edit the central doc; the agent path must reflect it (single source).
  const edited = 'EDITED RULE BODY\n';
  fs.writeFileSync(path.join(home, 'cfg', 'docs', 'baseline.md'), edited, 'utf8');
  assert.strictEqual(readThrough(path.join(cfg, 'cfg', 'baseline', 'docs', 'baseline.md')), edited,
    'central edit not visible through the agent link');
}

function testIdempotentReinstall(): void {
  const cfg = tempConfig();
  assert.strictEqual(run(['install'], cfg).status, 0);
  const second = run(['install'], cfg);
  assert.strictEqual(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /\(kept, preset: default\)/);
  assert.strictEqual(run(['verify'], cfg).status, 0);
}

function testForceReplacesConfigKeepWithout(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  // Operator edit to the central config.
  const marker = 'OPERATOR EDIT MARKER\n';
  fs.writeFileSync(path.join(home, 'cfg', 'docs', 'baseline.md'), marker, 'utf8');

  // Plain reinstall keeps the edit.
  assert.strictEqual(run(['install'], cfg).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(home, 'cfg', 'docs', 'baseline.md'), 'utf8'), marker,
    'plain reinstall clobbered the operator config');

  // --force replaces it wholesale from the preset.
  const forced = run(['install', '--force'], cfg);
  assert.strictEqual(forced.status, 0, forced.stderr || forced.stdout);
  assert.match(forced.stdout, /\(replaced, preset: default\)/);
  assert.notStrictEqual(fs.readFileSync(path.join(home, 'cfg', 'docs', 'baseline.md'), 'utf8'), marker,
    '--force did not replace the operator config');
}

function testUnknownPresetFails(): void {
  const cfg = tempConfig();
  const install = run(['install', '--preset', 'nope'], cfg);
  assert.notStrictEqual(install.status, 0, 'install with unknown preset unexpectedly succeeded');
  assert.match(install.stderr, /preset "nope" not found/);
}

// --- native Zig runtime (R-009, goal decision #18) --------------------------

// The prebuilt shipped for this platform, or null where none exists (mirrors
// manage.ts nativePrebuiltName). Native tests skip cleanly on such platforms.
function nativePrebuiltForPlatform(): string | null {
  if (process.platform === 'win32' && process.arch === 'x64') return 'baseline-recital-windows-x64.exe';
  if (process.platform === 'linux' && process.arch === 'x64') return 'baseline-recital-linux-x64';
  return null;
}
const nativeBinName = process.platform === 'win32' ? 'baseline-recital.exe' : 'baseline-recital';
function agentHookBin(agentConfig: string): string {
  return path.join(agentConfig, 'hooks', nativeBinName);
}
function wiredCommandFor(cfg: string, event: string): string {
  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  return hookCommandText(settings.hooks[event][0].hooks[0]);
}

// install --runtime prebuilt lifts the former pause: it deploys the native binary to the
// center, links it into the agent, and wires the binary DIRECTLY (no node) as the hot path.
// verify drives the actually-wired command end-to-end. Skips where no prebuilt is shipped.
function testNativeRuntimeInstallsAndWires(): void {
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
  const codexSettings = JSON.parse(fs.readFileSync(path.join(codexFor(cfg), 'hooks.json'), 'utf8'));
  assertPlatformHookCommand(codexSettings.hooks.UserPromptSubmit[0].hooks[0].command, 'Codex native hook');

  // verify parses the wired command and runs it through the platform shell for real.
  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, 'verify should pass against the wired native binary: ' + (verify.stderr || verify.stdout));
}

// Fallback to Node when the native prebuilt is unavailable even on a platform that normally
// ships one. Seed the install from the checkout (this deploys the installed manager AND
// copies bin/<prebuilt> into the isolated install root), remove ONLY that prebuilt copy, then
// re-run via the INSTALLED manager whose repo.binDir is the install root. The vanished
// prebuilt forces the Node dispatcher: no native binary stays deployed/linked, Node is wired,
// and the wired Node command fires. The checkout's real bin/ asset is never touched. Skips
// where no prebuilt ships for the platform (plain install is already Node there).
function testNativeFallbackToNodeWhenBinaryAbsent(): void {
  const target = nativePrebuiltForPlatform();
  if (!target || !fs.existsSync(path.join(root, 'bin', target))) {
    console.log('  (skip) testNativeFallbackToNodeWhenBinaryAbsent: no native prebuilt for ' + process.platform + '-' + process.arch + '.');
    return;
  }
  const cfg = tempConfig();
  const home = homeFor(cfg);
  // 1. Seed from the checkout: deploys the installed manager and copies bin/<prebuilt> in.
  assert.strictEqual(run(['install'], cfg).status, 0, 'seed install failed');

  // 2. Remove ONLY the prebuilt copy inside the isolated install root (never the checkout).
  const isolatedPrebuilt = path.join(home, 'bin', target);
  assert.ok(fs.existsSync(isolatedPrebuilt), 'seed install should copy the prebuilt into the install root bin/');
  fs.rmSync(isolatedPrebuilt, { force: true });

  // 3. Re-run the INSTALLED manager: its repo.binDir is <home>/bin, so the vanished prebuilt
  //    forces a Node fallback (removeNative clears the previously-deployed native binary).
  const install = runInstalled(['update'], cfg, home);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /runtime\s+: node js/);
  assert.ok(install.stdout.includes('using the Node dispatcher'),
    'fallback should announce it is using the Node dispatcher: ' + install.stdout);
  assert.ok(!fs.existsSync(path.join(home, 'hooks', nativeBinName)),
    'native binary must be removed from the center after falling back to Node');
  assert.ok(!fs.existsSync(agentHookBin(cfg)),
    'native binary must be unlinked from the agent after falling back to Node');

  const cmd = wiredCommandFor(cfg, 'UserPromptSubmit');
  assert.ok(/baseline-recital\.js/.test(cmd), 'fallback -> the Node .js must be wired: ' + cmd);

  // verify runs the WIRED command through the platform shell, so this exercises the
  // actually-wired Node command end-to-end (not just the source dispatcher driven directly).
  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, 'the wired Node command should fire after fallback: ' + (verify.stderr || verify.stdout));
  assert.match(verify.stdout, /verify: PASS/);
}

// A plain update prefers native even when no native binary was deployed beforehand: starting
// from a Node install, update re-selects the shipped prebuilt, deploys + links it, and rewires
// the native hot path. Defends that update's default is "prefer native", not "keep whatever was
// there". Skips where no prebuilt ships for the platform.
function testUpdatePrefersNativeWithoutPreexistingBinary(): void {
  const target = nativePrebuiltForPlatform();
  if (!target || !fs.existsSync(path.join(root, 'bin', target))) {
    console.log('  (skip) testUpdatePrefersNativeWithoutPreexistingBinary: no native prebuilt for ' + process.platform + '-' + process.arch + '.');
    return;
  }
  const cfg = tempConfig();
  const home = homeFor(cfg);
  // Start from Node: no native binary deployed or linked.
  assert.strictEqual(run(['install', '--runtime', 'node'], cfg).status, 0, 'node install failed');
  assert.ok(!fs.existsSync(path.join(home, 'hooks', nativeBinName)), 'node install must not deploy a native binary');
  assert.ok(!fs.existsSync(agentHookBin(cfg)), 'node install must not link a native binary');
  assert.ok(/baseline-recital\.js/.test(wiredCommandFor(cfg, 'UserPromptSubmit')), 'node install must wire the Node .js');

  // Plain update (no --runtime) re-selects the shipped prebuilt as the hot path.
  const update = run(['update'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.match(update.stdout, /runtime\s+: native \(prebuilt /);
  assert.ok(fs.existsSync(path.join(home, 'hooks', nativeBinName)), 'update should deploy the native binary');
  assert.ok(fs.existsSync(agentHookBin(cfg)), 'update should link the native binary into the agent');
  const cmd = wiredCommandFor(cfg, 'UserPromptSubmit');
  assert.ok(cmd.includes(nativeBinName), 'update should wire the native binary: ' + cmd);
  assert.ok(!/baseline-recital\.js/.test(cmd), 'native hot path must not wire the Node .js: ' + cmd);

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, 'the wired native command should fire after update: ' + (verify.stderr || verify.stdout));
}

// update --runtime node forces the Node dispatcher even when native is the current hot path:
// starting from a native install, the explicit downgrade removes the native binary, unwires
// it, and rewires Node. Skips where no prebuilt ships (native is never the hot path there).
function testUpdateRuntimeNodeForcesNode(): void {
  const target = nativePrebuiltForPlatform();
  if (!target || !fs.existsSync(path.join(root, 'bin', target))) {
    console.log('  (skip) testUpdateRuntimeNodeForcesNode: no native prebuilt for ' + process.platform + '-' + process.arch + '.');
    return;
  }
  const cfg = tempConfig();
  const home = homeFor(cfg);
  // Start from native (the new default): confirm the downgrade actually has something to undo.
  assert.strictEqual(run(['install'], cfg).status, 0, 'native install failed');
  assert.ok(fs.existsSync(path.join(home, 'hooks', nativeBinName)), 'precondition: native binary should be deployed');
  assert.ok(fs.existsSync(agentHookBin(cfg)), 'precondition: native binary should be linked');

  const update = run(['update', '--runtime', 'node'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.match(update.stdout, /runtime\s+: node js/);
  assert.ok(!fs.existsSync(path.join(home, 'hooks', nativeBinName)), 'update --runtime node must remove the native binary');
  assert.ok(!fs.existsSync(agentHookBin(cfg)), 'update --runtime node must unlink the native binary from the agent');
  const cmd = wiredCommandFor(cfg, 'UserPromptSubmit');
  assert.ok(/baseline-recital\.js/.test(cmd), 'update --runtime node must wire the Node .js: ' + cmd);

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, 'the wired Node command should fire after --runtime node: ' + (verify.stderr || verify.stdout));
}

// End-to-end byte parity against a native binary freshly built by tools/test-with-native.js.
// On the mapped release hosts this lane is mandatory: a missing or failed build is a test
// failure, never a fallback to a stale shipped prebuilt.
function testNativeDispatchParity(): void {
  const nativeBin = process.env.BASELINE_TEST_NATIVE_BIN;
  const mapped = process.arch === 'x64' && (process.platform === 'win32' || process.platform === 'linux');
  if (!nativeBin || !fs.existsSync(nativeBin)) {
    if (mapped) assert.fail('fresh native binary missing; run tests through tools/test-with-native.js');
    console.log('  (skip) testNativeDispatchParity: fresh host native binary unavailable on ' + process.platform + '-' + process.arch + '.');
    return;
  }
  const freshNativeBin = nativeBin;

  interface Pair {
    nativeDir: string;
    nodeDir: string;
    config: (dir: string, value: any) => void;
    doc: (dir: string, name: string, value: string | Buffer) => void;
    invoke: (input: any, raw?: string | Buffer, extraEnv?: { [key: string]: string }) => { native: any; node: any };
    close: () => void;
  }

  function pair(setup: (dir: string) => void): Pair {
    const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-parity-native-'));
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-parity-node-'));
    const cfgPath = (dir: string) => path.join(dir, 'cfg', 'baseline');
    const config = (dir: string, value: any) => {
      fs.mkdirSync(path.join(cfgPath(dir), 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cfgPath(dir), 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
    };
    const doc = (dir: string, name: string, value: string | Buffer) => {
      fs.mkdirSync(path.join(cfgPath(dir), 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cfgPath(dir), 'docs', name), value);
    };
    setup(nativeDir);
    setup(nodeDir);
    const invoke = (input: any, raw?: string | Buffer, extraEnv?: { [key: string]: string }) => {
      const env = Object.assign({}, process.env, extraEnv || {});
      delete env.BASELINE_AGENT_CONFIG_DIR;
      const bytes = raw === undefined ? JSON.stringify(input) : raw;
      const nodeInput = raw === undefined && input && typeof input === 'object'
        ? Object.assign({}, input, typeof input.cwd === 'string'
          ? { cwd: input.cwd.replace(nativeDir, nodeDir) } : {})
        : input;
      const native = spawnSync(freshNativeBin, ['--agent-config', nativeDir], { input: bytes, encoding: 'utf8', env });
      const nodeBytes = raw === undefined ? JSON.stringify(nodeInput) : raw;
      const node = spawnSync(process.execPath, [dispatcher, '--agent-config', nodeDir], { input: nodeBytes, encoding: 'utf8', env });
      assert.strictEqual(native.status, 0, 'fresh native exit: ' + native.stderr);
      assert.strictEqual(node.status, 0, 'node exit: ' + node.stderr);
      assert.strictEqual(native.stdout, node.stdout,
        'stdout parity\n native=' + JSON.stringify(native.stdout) + '\n node=' + JSON.stringify(node.stdout));
      return { native, node };
    };
    return {
      nativeDir, nodeDir, config, doc, invoke,
      close: () => {
        fs.rmSync(nativeDir, { recursive: true, force: true });
        fs.rmSync(nodeDir, { recursive: true, force: true });
      }
    };
  }

  const exactEnvelope = (event: string, body: string) => JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: body }
  });

  // Every event and SessionStart phase, including exact envelope and separator bytes.
  {
    const p = pair(dir => {
      const routes: any[] = [];
      for (const event of SUPPORTED_EVENTS) routes.push({ id: event.toLowerCase(), event, freq: 1, doc: 'docs/' + event + '.md' });
      for (const phase of SESSION_PHASES) routes.push({ id: 'phase-' + phase, event: 'SessionStart.' + phase, freq: 1, doc: 'docs/' + phase + '.md' });
      pConfig(dir, { version: 1, routes });
      for (const event of SUPPORTED_EVENTS) pDoc(dir, event + '.md', event + '\n');
      for (const phase of SESSION_PHASES) pDoc(dir, phase + '.md', phase + '\n');
    });
    function pConfig(dir: string, value: any): void {
      const cb = path.join(dir, 'cfg', 'baseline'); fs.mkdirSync(path.join(cb, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cb, 'config.json'), JSON.stringify(value));
    }
    function pDoc(dir: string, name: string, value: string): void {
      fs.writeFileSync(path.join(dir, 'cfg', 'baseline', 'docs', name), value);
    }
    try {
      for (const event of SUPPORTED_EVENTS) {
        if (event === 'SessionStart') continue;
        const r = p.invoke({ session_id: 'event-' + event, hook_event_name: event, cwd: p.nativeDir });
        assert.strictEqual(r.native.stdout, exactEnvelope(event, event + '\n'));
      }
      for (const phase of SESSION_PHASES) {
        const r = p.invoke({ session_id: 'phase-' + phase, hook_event_name: 'SessionStart', source: phase });
        assert.strictEqual(r.native.stdout, exactEnvelope('SessionStart', 'SessionStart\n\n\n' + phase + '\n'));
      }
    } finally { p.close(); }
  }

  // Cwd boundary accept/reject.
  {
    const p = pair(dir => {
      const scoped = path.join(dir, 'project');
      fs.mkdirSync(path.join(scoped, 'child'), { recursive: true });
      const cb = path.join(dir, 'cfg', 'baseline'); fs.mkdirSync(path.join(cb, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cb, 'config.json'), JSON.stringify({ version: 1, routes: [
        { id: 'cwd', event: 'UserPromptSubmit', freq: 1, cwd: scoped, doc: 'docs/cwd.md' }
      ] }));
      fs.writeFileSync(path.join(cb, 'docs', 'cwd.md'), 'CWD\n');
    });
    try {
      assert.ok(p.invoke({ session_id: 'cwd-ok', hook_event_name: 'UserPromptSubmit', cwd: path.join(p.nativeDir, 'project', 'child') }).native.stdout);
      assert.strictEqual(p.invoke({ session_id: 'cwd-no', hook_event_name: 'UserPromptSubmit', cwd: p.nativeDir + '-other' }).native.stdout, '');
    } finally { p.close(); }
  }

  // Malformed hook and config inputs fail open identically.
  {
    const p = pair(dir => {
      const cb = path.join(dir, 'cfg', 'baseline'); fs.mkdirSync(path.join(cb, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cb, 'config.json'), '{bad json');
    });
    try {
      assert.strictEqual(p.invoke({}, '{bad hook').native.stdout, '');
      assert.strictEqual(p.invoke({ hook_event_name: 'UserPromptSubmit' }).native.stdout, '');
      assert.strictEqual(p.invoke({ session_id: 'bad-event', hook_event_name: 'Unknown' }).native.stdout, '');
      assert.strictEqual(p.invoke({ session_id: 'bad-config', hook_event_name: 'UserPromptSubmit' }).native.stdout, '');
      p.config(p.nativeDir, { version: 2, routes: [] });
      p.config(p.nodeDir, { version: 2, routes: [] });
      assert.strictEqual(p.invoke({ session_id: 'bad-version', hook_event_name: 'UserPromptSubmit' }).native.stdout, '');
    } finally { p.close(); }
  }

  // Route/doc/combined caps and config order.
  {
    const p = pair(dir => {
      const routes = [
        { id: 'first', event: 'UserPromptSubmit', freq: 1, doc: 'docs/first.md' },
        { id: 'oversize', event: 'UserPromptSubmit', freq: 1, doc: 'docs/oversize.md' },
        { id: 'second', event: 'UserPromptSubmit', freq: 1, doc: 'docs/second.md' },
        { id: 'combined-skip', event: 'UserPromptSubmit', freq: 1, doc: 'docs/combined-skip.md' },
        { id: 'third', event: 'UserPromptSubmit', freq: 1, doc: 'docs/third.md' },
      ];
      const cb = path.join(dir, 'cfg', 'baseline'); fs.mkdirSync(path.join(cb, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cb, 'config.json'), JSON.stringify({ version: 1, routes }));
      fs.writeFileSync(path.join(cb, 'docs', 'first.md'), 'A'.repeat(4000));
      fs.writeFileSync(path.join(cb, 'docs', 'oversize.md'), 'X'.repeat(65537));
      fs.writeFileSync(path.join(cb, 'docs', 'second.md'), 'B'.repeat(2000));
      fs.writeFileSync(path.join(cb, 'docs', 'combined-skip.md'), 'Y'.repeat(5000));
      fs.writeFileSync(path.join(cb, 'docs', 'third.md'), 'C'.repeat(1000));
    });
    try {
      const expected = 'A'.repeat(4000) + '\n\n' + 'B'.repeat(2000) + '\n\n' + 'C'.repeat(1000);
      assert.strictEqual(fireBodies(p.invoke({ session_id: 'caps', hook_event_name: 'UserPromptSubmit' }).native), expected);
      const tooMany = Array.from({ length: 65 }, (_, i) => ({ id: 'r' + i, event: 'UserPromptSubmit', doc: 'docs/first.md' }));
      p.config(p.nativeDir, { version: 1, routes: tooMany });
      p.config(p.nodeDir, { version: 1, routes: tooMany });
      assert.strictEqual(p.invoke({ session_id: 'route-cap', hook_event_name: 'UserPromptSubmit' }).native.stdout, '');
    } finally { p.close(); }
  }

  // A live config frequency change uses existing counter state and preserves the exact key shape.
  {
    const p = pair(dir => {
      const cb = path.join(dir, 'cfg', 'baseline'); fs.mkdirSync(path.join(cb, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cb, 'config.json'), JSON.stringify({ version: 1, routes: [
        { id: 'freq', event: 'UserPromptSubmit', freq: 2, doc: 'docs/freq.md' }
      ] }));
      fs.writeFileSync(path.join(cb, 'docs', 'freq.md'), 'FREQ\n');
    });
    try {
      assert.strictEqual(p.invoke({ session_id: 'state', hook_event_name: 'UserPromptSubmit' }).native.stdout, '');
      for (const dir of [p.nativeDir, p.nodeDir]) p.config(dir, { version: 1, routes: [
        { id: 'freq', event: 'UserPromptSubmit', freq: 1, doc: 'docs/freq.md' }
      ] });
      assert.strictEqual(p.invoke({ session_id: 'state', hook_event_name: 'UserPromptSubmit' }).native.stdout,
        exactEnvelope('UserPromptSubmit', 'FREQ\n'));
      for (const dir of [p.nativeDir, p.nodeDir]) {
        const counters = JSON.parse(fs.readFileSync(path.join(dir, '.baseline-counters.json'), 'utf8'));
        assert.deepStrictEqual(Object.keys(counters), ['state:freq']);
        assert.strictEqual(counters['state:freq'].count, 2);
        assert.strictEqual(typeof counters['state:freq'].ts, 'number');
      }
    } finally { p.close(); }
  }

  // One malformed due doc suppresses all output; diagnostics stay exact and redacted.
  {
    const p = pair(dir => {
      const cb = path.join(dir, 'cfg', 'baseline'); fs.mkdirSync(path.join(cb, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cb, 'config.json'), JSON.stringify({ version: 1, routes: [
        { id: 'good', event: 'UserPromptSubmit', freq: 1, doc: 'docs/good.md' },
        { id: 'bad', event: 'UserPromptSubmit', freq: 1, doc: 'docs/bad.md' }
      ] }));
      fs.writeFileSync(path.join(cb, 'docs', 'good.md'), 'GOOD\n');
      fs.writeFileSync(path.join(cb, 'docs', 'bad.md'), Buffer.from([0x66, 0x80, 0x67]));
    });
    try {
      const silent = p.invoke({ session_id: 'redacted-session', hook_event_name: 'UserPromptSubmit' });
      assert.strictEqual(silent.native.stdout, '');
      assert.strictEqual(silent.native.stderr, silent.node.stderr);
      const diagnostic = p.invoke(
        { session_id: 'redacted-session-2', hook_event_name: 'UserPromptSubmit' }, undefined,
        { BASELINE_DIAGNOSTICS: '1' });
      assert.strictEqual(diagnostic.native.stdout, '');
      assert.strictEqual(diagnostic.native.stderr, 'baseline: DOC_INVALID_UTF8\n');
      assert.strictEqual(diagnostic.native.stderr, diagnostic.node.stderr);
      assert.ok(!diagnostic.native.stderr.includes('redacted-session'));
      assert.ok(!diagnostic.native.stderr.includes(p.nativeDir));
    } finally { p.close(); }
  }
}

// The native counter update runs under the SAME mkdir-lock as the Node oracle. Verify freq
// integrity under CONCURRENT dispatch (no lost increments), that the lock dir is cleaned up,
// and that a stale lock is broken. Skips cleanly where no prebuilt exists for the platform.
function testNativeCounterLock(): void {
  const target = nativePrebuiltForPlatform();
  if (!target || !fs.existsSync(path.join(root, 'bin', target))) {
    console.log('  (skip) testNativeCounterLock: no native prebuilt for ' + process.platform + '-' + process.arch + '.');
    return;
  }
  const nativeBin = path.join(root, 'bin', target);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-lock-'));
  try {
    const cb = path.join(dir, 'cfg', 'baseline');
    fs.mkdirSync(path.join(cb, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(cb, 'config.json'), JSON.stringify({
      version: 1, routes: [{ id: 'r', event: 'UserPromptSubmit', freq: 3, doc: 'docs/r.md' }]
    }));
    fs.writeFileSync(path.join(cb, 'docs', 'r.md'), 'LOCK DOC\n');
    const lockPath = path.join(dir, '.baseline-counters.json.lock');

    // Concurrency: K same-session invocations race the shared counter (spawned concurrently by
    // a child so the synchronous test runner still blocks on the result). With the lock the
    // counts form a clean 1..K, so the final count is K and exactly floor(K/3) fire; a lockless
    // read-modify-write would lose increments (final count < K).
    const K = 12;
    const helper =
      'const {spawn}=require("child_process");' +
      'const bin=process.env.NB,dir=process.env.ND,K=+process.env.NK;' +
      'const e=Object.assign({},process.env);delete e.BASELINE_AGENT_CONFIG_DIR;delete e.CLAUDE_CONFIG_DIR;delete e.CODEX_HOME;' +
      'const input=JSON.stringify({session_id:"lock",hook_event_name:"UserPromptSubmit",cwd:dir});' +
      'Promise.all(Array.from({length:K},()=>new Promise(res=>{' +
      'const p=spawn(bin,["--agent-config",dir],{stdio:["pipe","pipe","ignore"],env:e});' +
      'let o="";p.stdout.on("data",d=>o+=d);p.on("close",()=>res(o.trim()));p.stdin.end(input);' +
      '}))).then(outs=>process.stdout.write(JSON.stringify({fired:outs.filter(Boolean).length})));';
    const r = spawnSync(process.execPath, ['-e', helper], {
      encoding: 'utf8', env: Object.assign({}, process.env, { NB: nativeBin, ND: dir, NK: String(K) })
    });
    assert.strictEqual(r.status, 0, 'concurrency helper failed: ' + (r.stderr || r.stdout));
    const fired = JSON.parse((r.stdout || '').trim()).fired;

    const counters = JSON.parse(fs.readFileSync(path.join(dir, '.baseline-counters.json'), 'utf8'));
    assert.strictEqual(counters['lock:r'] && counters['lock:r'].count, K,
      'lock must serialize concurrent bumps to a clean 1..' + K + ' (no lost increments); got ' + JSON.stringify(counters['lock:r']));
    assert.strictEqual(fired, Math.floor(K / 3), 'exactly floor(K/3) invocations should fire under the freq-3 route (got ' + fired + ')');
    assert.ok(!fs.existsSync(lockPath), 'lock dir must be cleaned up after a normal dispatch');

    // Stale lock: one older than the 5s window must be broken so a crashed holder never wedges
    // the counter. Plant a 30s-old lock, run one freq-1 dispatch, assert it fired and cleaned up.
    fs.writeFileSync(path.join(cb, 'config.json'), JSON.stringify({
      version: 1, routes: [{ id: 'r1', event: 'UserPromptSubmit', freq: 1, doc: 'docs/r.md' }]
    }));
    fs.mkdirSync(lockPath);
    const old = Date.now() / 1000 - 30;
    fs.utimesSync(lockPath, old, old);
    const r2 = spawnSync(nativeBin, ['--agent-config', dir], {
      input: JSON.stringify({ session_id: 'stale', hook_event_name: 'UserPromptSubmit', cwd: dir }),
      encoding: 'utf8', env: Object.assign({}, process.env)
    });
    assert.ok((r2.stdout || '').includes('LOCK DOC'), 'a stale lock must be broken so the dispatch fires: ' + JSON.stringify(r2.stdout));
    assert.ok(!fs.existsSync(lockPath), 'the broken stale lock dir must be cleaned up after dispatch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Native HEALTH checks (R-009): once the default/native hot path is wired, status and
// doctor must surface a fault when the central or per-agent native binary/link goes
// missing — a native-wired install must never read back as healthy against a dangling
// or absent native binary. The previous behavior only inspected the JS dispatcher and
// contracts links, so a vanished native binary was invisible. Skips cleanly where no
// prebuilt ships for the platform (native is never the hot path there).
//
// Link-layer note: install links the central native binary into each agent via symlink,
// falling back to hardlink/copy where symlinks are unavailable. With a hardlink/copy the
// per-agent file SURVIVES a central deletion (it is still present and executable), so the
// per-agent native link/executable checks are mechanism-dependent for a CENTRAL fault.
// We therefore assert only the deterministic, mechanism-independent surfaces: the central
// binary state (checked directly), and — for the per-agent fault — the agent file deleted.
function testNativeHealthCentralBinaryMissing(): void {
  const target = nativePrebuiltForPlatform();
  if (!target || !fs.existsSync(path.join(root, 'bin', target))) {
    console.log('  (skip) testNativeHealthCentralBinaryMissing: no native prebuilt for ' + process.platform + '-' + process.arch + '.');
    return;
  }
  const cfg = tempConfig();
  const home = homeFor(cfg);
  // A PLAIN (default) install prefers the shipped native prebuilt as the hot path.
  assert.strictEqual(run(['install'], cfg).status, 0, 'native install failed');
  const centralBin = path.join(home, 'hooks', nativeBinName);
  assert.ok(fs.existsSync(centralBin), 'precondition: native binary should be deployed to the center');

  // Precondition: status --json reports the native dispatcher active + healthy.
  const before = run(['status', '--json'], cfg);
  assert.strictEqual(before.status, 0, before.stderr || before.stdout);
  const beforeObj = JSON.parse(before.stdout.trim());
  assert.strictEqual(beforeObj.data.nativeDispatcher.active, true, 'native hot path should be active');
  assert.strictEqual(beforeObj.data.nativeDispatcher.state.ok, true, 'central native binary should be healthy pre-fault');

  // BREAK IT: delete ONLY the central native binary (never the repo checkout's bin/).
  fs.rmSync(centralBin, { force: true });

  // status --json must surface the central native fault. The central binary state is
  // checked directly (nativeBinaryState(central.hookBin)), so this is deterministic
  // across the symlink/hardlink/copy link layer. status keeps exit 0: it reports.
  const res = run(['status', '--json'], cfg);
  assert.strictEqual(res.status, 0, res.stderr || res.stdout);
  const obj = JSON.parse(res.stdout.trim());
  assert.strictEqual(obj.data.nativeDispatcher.active, true, 'native wiring is unchanged; still active');
  assert.strictEqual(obj.data.nativeDispatcher.state.ok, false, 'central native binary must be unhealthy after deletion');
  assert.match(obj.data.nativeDispatcher.state.detail, /missing at/,
    'state.detail should name the missing central binary: ' + obj.data.nativeDispatcher.state.detail);

  // Human status prints the central native binary line as UNHEALTHY.
  const human = run(['status'], cfg);
  assert.strictEqual(human.status, 0, human.stderr || human.stdout);
  assert.match(human.stdout, /native binary\s+: UNHEALTHY/,
    'human status must print the central native binary unhealthy: ' + human.stdout);

  // doctor must FAIL (exit 1) and name a native binary fault — the old JS-only doctor
  // would report healthy here. At least one native check fails regardless of link layer.
  const broken = run(['doctor'], cfg);
  assert.strictEqual(broken.status, 1, 'doctor should exit 1 when the central native binary is missing');
  assert.match(broken.stdout, /\[FAIL\] native binary/, 'doctor must surface a [FAIL] native binary check: ' + broken.stdout);
  assert.ok(!/doctor: healthy/.test(broken.stdout), 'doctor must not report healthy with a missing native binary');

  // doctor --fix redeploys via update (which re-selects the repo prebuilt) and repairs.
  const fixed = run(['doctor', '--fix'], cfg);
  assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /doctor: installation repaired/);
  assert.ok(fs.existsSync(centralBin), 'doctor --fix should redeploy the central native binary');
  const healthy = run(['doctor'], cfg);
  assert.strictEqual(healthy.status, 0, healthy.stderr || healthy.stdout);
  assert.match(healthy.stdout, /doctor: healthy/);
}

// Deleting ONLY the per-agent native binary/link (central intact) is deterministic across
// the link layer — the agent file is gone — so the per-agent native state and link can be
// asserted directly, in both status JSON and doctor.
function testNativeHealthAgentBinaryMissing(): void {
  const target = nativePrebuiltForPlatform();
  if (!target || !fs.existsSync(path.join(root, 'bin', target))) {
    console.log('  (skip) testNativeHealthAgentBinaryMissing: no native prebuilt for ' + process.platform + '-' + process.arch + '.');
    return;
  }
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0, 'native install failed');
  assert.ok(fs.existsSync(path.join(home, 'hooks', nativeBinName)), 'precondition: central native binary present');
  assert.ok(fs.existsSync(agentHookBin(cfg)), 'precondition: agent native binary linked');

  // BREAK IT: delete ONLY the per-agent native binary/link; the central binary is intact.
  fs.rmSync(agentHookBin(cfg), { force: true });

  // status --json: central stays healthy, but the agent's native binary state AND its
  // native link must read unhealthy. claude-code is the first registered agent.
  const res = run(['status', '--json'], cfg);
  assert.strictEqual(res.status, 0, res.stderr || res.stdout);
  const obj = JSON.parse(res.stdout.trim());
  assert.strictEqual(obj.data.nativeDispatcher.state.ok, true, 'central native binary is intact');
  const claude = obj.data.agents[0];
  assert.strictEqual(claude.name, 'claude-code', 'first agent should be claude-code');
  assert.ok(claude.nativeBinary, 'agent nativeBinary state should be reported when native is wired');
  assert.strictEqual(claude.nativeBinary.ok, false, 'agent native binary must be unhealthy after deletion');
  assert.match(claude.nativeBinary.detail, /missing at/, 'agent nativeBinary.detail should name the missing file');
  assert.ok(claude.links && claude.links.native, 'agent native link state should be reported when native is wired');
  assert.strictEqual(claude.links.native.ok, false, 'agent native link must be unhealthy after deletion');

  // Human status: the per-agent native runtime line must read UNHEALTHY.
  const human = run(['status'], cfg);
  assert.strictEqual(human.status, 0, human.stderr || human.stdout);
  assert.match(statusAgentSection(human.stdout, 'claude-code'), /native\s+: UNHEALTHY/,
    'human status must print the agent native runtime unhealthy');

  // doctor: the native link + native executable checks must FAIL (the agent file is gone).
  const broken = run(['doctor'], cfg);
  assert.strictEqual(broken.status, 1, 'doctor should exit 1 when the agent native binary is missing');
  assert.match(broken.stdout, /\[FAIL\] native link/, 'doctor must flag the missing native link: ' + broken.stdout);
  assert.match(broken.stdout, /\[FAIL\] native executable/, 'doctor must flag the missing agent native executable: ' + broken.stdout);

  // doctor --fix relinks the agent native binary; rescan comes back healthy.
  const fixed = run(['doctor', '--fix'], cfg);
  assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /doctor: installation repaired/);
  assert.ok(fs.existsSync(agentHookBin(cfg)), 'doctor --fix should relink the agent native binary');
  const healthy = run(['doctor'], cfg);
  assert.strictEqual(healthy.status, 0, healthy.stderr || healthy.stdout);
  assert.match(healthy.stdout, /doctor: healthy/);
}

function testInvalidSettingsFailsClosed(): void {
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

function testInvalidSettingsShapeFailsClosed(): void {
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

function testInvalidNullHookGroupFailsClosed(): void {
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

function testConfigDrivenWiringAndUnwire(): void {
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

function testCoResidentHookPreserved(): void {
  const cfg = tempConfig();
  // A co-resident UserPromptSubmit hook the operator owns.
  write(path.join(cfg, 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo theirs', timeout: 3 }] }] }
  }, null, 2) + '\n');

  assert.strictEqual(run(['install'], cfg).status, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const entries = settings.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks);
  assert.ok(entries.some((h: any) => h.command === 'echo theirs'), 'co-resident hook was dropped');
  assert.ok(entries.some((h: any) => hookCommandText(h).includes('baseline-recital')), 'baseline hook not added');

  // Uninstall removes only ours.
  assert.strictEqual(run(['uninstall'], cfg).status, 0);
  const after = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const left = after.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.deepStrictEqual(left, ['echo theirs'], 'uninstall did not preserve exactly the co-resident hook');
}

function testBaselineHookDoesNotInheritMatcher(): void {
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
  assert.ok(groups.some((g: any) => g.matcher === 'Read' && g.hooks.some((h: any) => h.command === 'echo theirs')),
    'co-resident matched group was not preserved');
  assert.ok(groups.some((g: any) => g.matcher === undefined && g.hooks.some((h: any) => hookCommandText(h).includes('baseline-recital'))),
    'baseline hook should be installed in its own matcher-free group');

  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
}

// --- dispatcher behavior (drive the deployed hook directly) -----------------

function fireBodies(res: { stdout: string }): string | null {
  const out = (res.stdout || '').trim();
  if (!out) return null;
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

function testContractsPureHelpers(): void {
  assert.deepStrictEqual(parseEvent('SessionStart.compact'), { base: 'SessionStart', phase: 'compact' });
  const bare = parseEvent('UserPromptSubmit');
  assert.deepStrictEqual(bare, { base: 'UserPromptSubmit' });
  assert.strictEqual(bare.phase, undefined, 'bare events must have an undefined phase');
  assert.deepStrictEqual(parseEvent('a.b.c'), { base: 'a', phase: 'b.c' });

  for (const event of SUPPORTED_EVENTS) {
    assert.strictEqual(isSupportedRouteEvent(event), true, event + ' should be a supported bare route event');
  }
  assert.strictEqual(isSupportedRouteEvent('SessionStart.compact'), true, 'recognized SessionStart phase should be supported');
  assert.strictEqual(isSupportedRouteEvent('PreToolUse.startup'), false, 'non-SessionStart phases should be unsupported');
  assert.strictEqual(isSupportedRouteEvent('Notification'), false, 'unsupported base event should be rejected');

  for (const source of [undefined, 'startup', 'compact']) {
    assert.strictEqual(eventMatches('UserPromptSubmit', 'UserPromptSubmit', source), true,
      'bare route must match UserPromptSubmit regardless of source');
  }
  assert.strictEqual(eventMatches('SessionStart.compact', 'SessionStart', 'compact'), true,
    'phased route must match its base event and phase');
  assert.strictEqual(eventMatches('SessionStart.compact', 'SessionStart', 'startup'), false,
    'phased route must reject a different source');
  assert.strictEqual(eventMatches('SessionStart.compact', 'UserPromptSubmit', 'compact'), false,
    'phased route must reject a different hook event');

  // cwdMatches delegates path normalization to the host path module. Keep the
  // literal Windows paths in the Windows runtime, and use equivalent native
  // paths elsewhere while exercising the isWin case-folding branch.
  const routeCwd = process.platform === 'win32' ? 'C:\\foo' : path.join(os.tmpdir(), 'foo');
  const siblingCwd = routeCwd + 'bar';
  const subdirectoryCwd = process.platform === 'win32' ? 'C:\\foo\\sub' : path.join(routeCwd, 'sub');
  assert.strictEqual(cwdMatches(routeCwd, siblingCwd, true), false,
    'Windows cwd matching must not accept a sibling-prefix collision');
  assert.strictEqual(cwdMatches(routeCwd, subdirectoryCwd, true), true,
    'Windows cwd matching must accept a true subdirectory');
  assert.strictEqual(cwdMatches(routeCwd, routeCwd, true), true,
    'Windows cwd matching must accept the exact directory');
  assert.strictEqual(cwdMatches(routeCwd.toUpperCase(), subdirectoryCwd.toLowerCase(), true), true,
    'Windows cwd matching must be case-insensitive');

  const cfgDir = path.join(os.tmpdir(), 'baseline-contracts-unit');
  assert.strictEqual(safeDocPath(path.resolve(cfgDir, 'absolute.md'), cfgDir), null,
    'absolute doc paths must be rejected');
  assert.strictEqual(safeDocPath('../escape.md', cfgDir), null,
    'doc paths escaping the config folder must be rejected');
  assert.strictEqual(safeDocPath('docs/../docs/x.md', cfgDir), path.resolve(cfgDir, 'docs', 'x.md'),
    'normalized in-config doc paths must be accepted');
  assert.strictEqual(safeDocPath('', cfgDir), null, 'empty doc paths must be rejected');
}

function testPerRouteCountersIndependent(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  setCentralConfig(home, [
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

function testMalformedCounterArrayDoesNotBreakFrequency(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  setCentralConfig(home, [
    { id: 'two', event: 'UserPromptSubmit', freq: 2, doc: 'docs/two.md' }
  ], { 'docs/two.md': 'TWO\n' });
  write(path.join(cfg, '.baseline-counters.json'), '[]');

  assert.strictEqual(fireBodies(hook({ session_id: 'array', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg)), null,
    'first turn should not fire');
  assert.ok(fireBodies(hook({ session_id: 'array', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg))?.includes('TWO'),
    'second turn should fire even after malformed array counters');
}

// Slice-1 acceptance: the event NAME is the sole moment-resolver. A SessionStart
// phase suffix (SessionStart.compact) fires only when stdin source matches; a bare
// SessionStart route matches every phase; a bare non-session event matches; cwd
// scope is still respected.
function testEventNameSemantics(): void {
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
  assert.ok(fireBodies(hook({ session_id: 's3', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg))?.includes('PROMPT'),
    'bare UserPromptSubmit route should fire');

  // cwd scope: only under the path.
  assert.ok(fireBodies(hook({ session_id: 's4', hook_event_name: 'UserPromptSubmit', cwd: path.join(scoped, 'sub') }, cfg))?.includes('SCOPED'),
    'scoped route should fire under its cwd');
  assert.ok(!fireBodies(hook({ session_id: 's5', hook_event_name: 'UserPromptSubmit', cwd: path.join(cfg, 'elsewhere') }, cfg))?.includes('SCOPED'),
    'scoped route should not fire outside its cwd');
}


// R-011 (goal decision #18): due docs are read concurrently but assembled strictly in
// config routes[] order. Four routes with very different doc sizes (so read-completion
// order differs from config order) must still emit in declared order.
function testConcurrentDispatchDeterministicOrder(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  const big = 'B'.repeat(5000);
  const mid = 'M'.repeat(2000);
  setCentralConfig(home, [
    { id: 'first',  event: 'UserPromptSubmit', freq: 1, doc: 'docs/first.md' },
    { id: 'second', event: 'UserPromptSubmit', freq: 1, doc: 'docs/second.md' },
    { id: 'third',  event: 'UserPromptSubmit', freq: 1, doc: 'docs/third.md' },
    { id: 'fourth', event: 'UserPromptSubmit', freq: 1, doc: 'docs/fourth.md' }
  ], {
    'docs/first.md': 'FIRST-' + big + '\n',   // largest: typically reads slowest
    'docs/second.md': 'SECOND\n',             // tiny
    'docs/third.md': 'THIRD-' + mid + '\n',
    'docs/fourth.md': 'FOURTH\n'
  });

  const body = fireBodies(hook({ session_id: 'order', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
  assert.ok(body, 'multi-route dispatch should fire');
  const iF = body!.indexOf('FIRST-'), iS = body!.indexOf('SECOND'), iT = body!.indexOf('THIRD-'), i4 = body!.indexOf('FOURTH');
  assert.ok(iF !== -1 && iS !== -1 && iT !== -1 && i4 !== -1, 'all four bodies must be present: ' + body);
  assert.ok(iF < iS && iS < iT && iT < i4,
    'bodies must appear in config routes[] order regardless of read timing (got offsets ' + [iF, iS, iT, i4].join(',') + ')');
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
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  fs.writeFileSync(path.join(home, 'cfg', 'config.json'), '{ not json', 'utf8');
  const r = hook({ session_id: 'y', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
  assert.strictEqual(r.status, 0, 'dispatcher should not crash on malformed config');
  assert.strictEqual((r.stdout || '').trim(), '', 'malformed config should inject nothing');
}

function testBadRouteSkippedOthersFire(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  setCentralConfig(home, [
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

function testDocSymlinkEscapeRejected(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  write(path.join(home, 'secret.md'), 'SECRET\n');
  const link = path.join(home, 'cfg', 'docs', 'link.md');
  try {
    fs.symlinkSync(path.join(home, 'secret.md'), link);
  } catch (e) {
    console.log('  (skip) testDocSymlinkEscapeRejected: symlink creation unavailable.');
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

function testOversizeDocSkipped(): void {
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

function testDocInjectionCharCapBoundaries(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  const asciiAtCap = 'A'.repeat(10_000);
  assert.strictEqual(asciiAtCap.length, 10_000, 'ASCII at-cap fixture must be exactly 10,000 characters');
  setCentralConfig(home, [
    { id: 'ascii-at-cap', event: 'UserPromptSubmit', freq: 1, doc: 'docs/ascii-at-cap.md' }
  ], { 'docs/ascii-at-cap.md': asciiAtCap });
  assert.strictEqual(fireBodies(hook({ session_id: 'ascii-at-cap', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg)),
    asciiAtCap, 'a 10,000-character ASCII doc must be injected verbatim');

  const asciiOverCap = 'B'.repeat(10_001);
  assert.strictEqual(asciiOverCap.length, 10_001, 'ASCII over-cap fixture must be exactly 10,001 characters');
  setCentralConfig(home, [
    { id: 'ascii-over-cap', event: 'UserPromptSubmit', freq: 1, doc: 'docs/ascii-over-cap.md' }
  ], { 'docs/ascii-over-cap.md': asciiOverCap });
  const asciiOver = hook({ session_id: 'ascii-over-cap', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
  assert.strictEqual((asciiOver.stdout || '').trim(), '', 'a 10,001-character ASCII doc must emit no JSON');

  const rocket = '🚀';
  const emojiAtCap = rocket.repeat(4_999);
  assert.strictEqual(emojiAtCap.length, 9_998, '4,999 rockets must occupy 9,998 UTF-16 code units');
  setCentralConfig(home, [
    { id: 'emoji-at-cap', event: 'UserPromptSubmit', freq: 1, doc: 'docs/emoji-at-cap.md' }
  ], { 'docs/emoji-at-cap.md': emojiAtCap });
  assert.strictEqual(fireBodies(hook({ session_id: 'emoji-at-cap', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg)),
    emojiAtCap, 'a 9,998-code-unit emoji doc must be injected verbatim');

  const emojiOverCap = rocket.repeat(5_001);
  assert.strictEqual(emojiOverCap.length, 10_002, '5,001 rockets must occupy 10,002 UTF-16 code units');
  setCentralConfig(home, [
    { id: 'emoji-over-cap', event: 'UserPromptSubmit', freq: 1, doc: 'docs/emoji-over-cap.md' }
  ], { 'docs/emoji-over-cap.md': emojiOverCap });
  const emojiOver = hook({ session_id: 'emoji-over-cap', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg);
  assert.strictEqual((emojiOver.stdout || '').trim(), '', 'a 10,002-code-unit emoji doc must emit no JSON');
}

function testCombinedDocInjectionCapSkipsMiddleBody(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  const doc1 = 'A'.repeat(6_000);
  const doc2 = 'B'.repeat(6_000);
  const doc3 = 'C'.repeat(1_000);
  setCentralConfig(home, [
    { id: 'first', event: 'UserPromptSubmit', freq: 1, doc: 'docs/first.md' },
    { id: 'second', event: 'UserPromptSubmit', freq: 1, doc: 'docs/second.md' },
    { id: 'third', event: 'UserPromptSubmit', freq: 1, doc: 'docs/third.md' }
  ], {
    'docs/first.md': doc1,
    'docs/second.md': doc2,
    'docs/third.md': doc3
  });

  const body = fireBodies(hook({ session_id: 'combined-cap', hook_event_name: 'UserPromptSubmit', cwd: cfg }, cfg));
  assert.strictEqual(body, doc1 + '\n\n' + doc3,
    'the dispatcher must skip the over-cap middle body and append the later fitting body');
  assert.ok(!body!.includes(doc2), 'the skipped middle body must not appear in additionalContext');
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

// Deleting the whole install root leaves the per-agent symlinks DANGLING (they resolve
// to the right path, but the target is gone). doctor must report that as a failure —
// not [ OK ] — and --fix must re-deploy.
function testDoctorDetectsDanglingHookLinks(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  // The bug is symlink-specific; if install fell back to hardlink/copy here, skip.
  if (!fs.lstatSync(agentHookDispatcher(cfg)).isSymbolicLink()) {
    console.log('SKIP testDoctorDetectsDanglingHookLinks: install did not use symlinks on this machine');
    return;
  }

  fs.rmSync(home, { recursive: true, force: true }); // kill the entire install root

  const broken = run(['doctor'], cfg);
  assert.strictEqual(broken.status, 1, broken.stdout);
  assert.match(broken.stdout, /\[FAIL\] install root: missing/);
  assert.match(broken.stdout, /\[FAIL\] dispatcher link: dangling/);
  assert.ok(broken.stdout.indexOf('[ OK ] dispatcher link') === -1,
    'doctor reported a dangling dispatcher link as OK');

  const fixed = run(['doctor', '--fix'], cfg);
  assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /doctor: installation repaired/);

  const healthy = run(['doctor'], cfg);
  assert.strictEqual(healthy.status, 0, healthy.stderr || healthy.stdout);
  assert.match(healthy.stdout, /doctor: healthy/);
}

function testStatusAndDoctorRepairPerAgentContracts(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  const healthy = run(['status'], cfg);
  assert.strictEqual(healthy.status, 0, healthy.stderr || healthy.stdout);
  assert.match(statusAgentSection(healthy.stdout, 'claude-code'), /contracts\s+: OK/,
    'status should report healthy Claude contracts');
  assert.match(statusAgentSection(healthy.stdout, 'codex'), /contracts\s+: OK/,
    'status should report healthy Codex contracts');

  fs.unlinkSync(agentHookContracts(cfg));
  fs.unlinkSync(agentHookContracts(codex));

  const degraded = run(['status'], cfg);
  assert.strictEqual(degraded.status, 0, degraded.stderr || degraded.stdout);
  assert.match(statusAgentSection(degraded.stdout, 'claude-code'), /contracts\s+: MISSING/,
    'status should report missing Claude contracts');
  assert.match(statusAgentSection(degraded.stdout, 'codex'), /contracts\s+: MISSING/,
    'status should report missing Codex contracts');

  const broken = run(['doctor'], cfg);
  assert.strictEqual(broken.status, 1, broken.stdout);
  assert.match(broken.stdout, /\[FAIL\] contracts link: missing/,
    'doctor should check per-agent contracts links');

  const fixed = run(['doctor', '--fix'], cfg);
  assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /doctor: installation repaired/);
  assert.strictEqual(readThrough(agentHookContracts(cfg)), readThrough(centralHookContracts(home)),
    'doctor --fix did not repair Claude contracts');
  assert.strictEqual(readThrough(agentHookContracts(codex)), readThrough(centralHookContracts(home)),
    'doctor --fix did not repair Codex contracts');
}

function testDoctorDetectsMissingDoc(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  fs.unlinkSync(path.join(home, 'cfg', 'docs', 'baseline.md'));
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

function testVerifyRequiresSelectedRouteEvent(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  setCentralConfig(home, [
    { id: 'read', event: 'PreToolUse', freq: 1, doc: 'docs/read.md' }
  ], { 'docs/read.md': 'READ\n' });
  assert.strictEqual(run(['install'], cfg).status, 0);

  for (const file of [path.join(cfg, 'settings.json'), path.join(codexFor(cfg), 'hooks.json')]) {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    const moved = { hooks: { UserPromptSubmit: [{ hooks: [hook] }] } };
    write(file, JSON.stringify(moved, null, 2) + '\n');
  }

  const verify = run(['verify'], cfg);
  assert.notStrictEqual(verify.status, 0, 'verify should fail when selected route event is not wired');
  assert.match(verify.stdout, /no baseline hook wired for PreToolUse/);
}

function testVerifyToolEventFires(): void {
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
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks || !settings.hooks.UserPromptSubmit || settings.hooks.UserPromptSubmit.length === 0,
    'uninstall left a wired hook');
  assert.ok(!fs.existsSync(path.join(cfg, 'hooks', 'baseline-recital.js')), 'agent dispatcher link not removed');
  assert.ok(!fs.existsSync(agentHookContracts(cfg)), 'agent contracts link not removed');
  assert.ok(!fs.existsSync(agentHookContracts(codex)), 'codex contracts link not removed');
  assert.ok(fs.existsSync(path.join(home, 'cfg', 'config.json')), 'central config was wrongly removed');
}

// A half-dead install (install root deleted, per-agent wiring + dangling links left
// behind) must still uninstall cleanly: unwire the hook and remove the dangling links.
function testUninstallCleansHalfDeadInstall(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  fs.rmSync(home, { recursive: true, force: true }); // kill the entire install root

  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks || !settings.hooks.UserPromptSubmit || settings.hooks.UserPromptSubmit.length === 0,
    'uninstall left a wired hook');
  // fs.existsSync follows symlinks (false for a dangling link), so assert via lstat.
  assert.throws(() => fs.lstatSync(agentHookDispatcher(cfg)), /ENOENT/, 'dangling dispatcher link not removed');
  assert.throws(() => fs.lstatSync(agentHookContracts(cfg)), /ENOENT/, 'dangling contracts link not removed');
}

function testUninstallPreservesDivergentPerAgentContracts(): void {
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
  assert.strictEqual(readThrough(agentHookContracts(codex)), unmanaged,
    'uninstall should preserve divergent/unmanaged Codex contracts');
  assert.ok(fs.existsSync(centralHookContracts(home)), 'uninstall should keep central contracts');
}

function testUninstallRemovesOnlyManagedCodexMarketplacePlugin(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const configToml = path.join(codex, 'config.toml');
  const unrelatedConfig = '# operator config stays untouched\n[profiles.default]\nmodel = "gpt-5.1"\n';
  const otherMarketplace: FakeCodexMarketplace = {
    name: 'other-market',
    root: path.join(codex, 'operator-marketplace'),
  };
  const otherPlugin: FakeCodexPlugin = {
    pluginId: 'other@other-market',
    enabled: true,
    version: '2.0.0',
    source: { path: path.join(otherMarketplace.root, 'plugins', 'other') },
  };
  write(configToml, unrelatedConfig);
  writeFakeCodexState(codex, {
    marketplaces: [otherMarketplace],
    installed: [otherPlugin],
    commands: [],
  });

  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.strictEqual(readThrough(configToml), unrelatedConfig, 'install must not modify unrelated Codex config.toml');
  const codexState = readFakeCodexState(codex);
  const managedPlugin = codexState.installed.find(entry => entry.pluginId === CODEX_PLUGIN_KEY);
  if (!managedPlugin) throw new Error('install did not create the managed Codex plugin fixture');
  const currentVersion = expectedCodexPluginVersion(home, 'uninstall stale fixture');
  managedPlugin.version = currentVersion.slice(0, -12) + '000000000000';
  assert.notStrictEqual(managedPlugin.version, currentVersion, 'stale fixture must differ from the expected version');
  writeFakeCodexState(codex, codexState);


  resetFakeCodexCommands(codex);
  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.deepStrictEqual(readFakeCodexState(codex), {
    marketplaces: [otherMarketplace],
    installed: [otherPlugin],
    commands: [
      codexCommand('marketplace', 'list'),
      codexCommand('list'),
      codexCommand('remove', CODEX_PLUGIN_KEY),
      codexCommand('marketplace', 'remove', CODEX_MARKETPLACE),
    ],
  }, 'uninstall should remove only baseline@baseline-local and baseline-local through Codex CLI');
  assert.strictEqual(readThrough(configToml), unrelatedConfig, 'uninstall must leave unrelated Codex config.toml byte-for-byte unchanged');
  assert.ok(!fs.existsSync(path.join(cfg, 'skills', 'baseline')), 'uninstall should remove the Claude agent skill link');
  assert.ok(fs.existsSync(path.join(home, 'cfg', 'config.json')), 'uninstall should keep central config');
  assert.ok(fs.existsSync(path.join(home, 'skills', 'baseline')), 'uninstall should keep the central Claude skill payload');
  assertCodexPayload(centralCodexPlugin(home), 'central Codex plugin');
}

// An unreadable plugin list is unknown state, not proof that baseline is absent.
// Preserve the manager-owned marketplace until the plugin is known missing or removed.
function testUninstallKeepsCodexMarketplaceWhenPluginStateUnreadable(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const configToml = path.join(codex, 'config.toml');
  const unrelatedConfig = '# operator config stays untouched\n[profiles.default]\nmodel = "gpt-5.1"\n';
  write(configToml, unrelatedConfig);
  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  const before = readFakeCodexState(codex);

  resetFakeCodexCommands(codex);
  const uninstall = run(['uninstall'], cfg, undefined, {
    BASELINE_TEST_FAKE_CODEX_PLUGIN_LIST_UNREADABLE: '1',
  });
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  const after = readFakeCodexState(codex);
  assert.deepStrictEqual(after.marketplaces, before.marketplaces,
    'unreadable plugin state must preserve the manager-owned marketplace');
  assert.deepStrictEqual(after.installed, before.installed,
    'unreadable plugin state must preserve the installed manager-owned plugin');
  assert.deepStrictEqual(after.commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
  ], 'uninstall must not invoke Codex marketplace remove after an unreadable plugin list');
  assert.match(uninstall.stdout, /codex plugin: unreadable — left as-is/,
    'uninstall must report unreadable plugin state rather than falsely reporting absence');
  assert.match(uninstall.stdout, /marketplace : owned — kept because plugin is unreadable/,
    'uninstall must report why it preserved the manager-owned marketplace');
  assert.strictEqual(readThrough(configToml), unrelatedConfig,
    'uninstall must leave unrelated Codex config.toml byte-for-byte unchanged');
  assert.ok(fs.existsSync(centralCodexPlugin(home)), 'uninstall must keep the central Codex payload');
}

// Canonical ownership must remain strict: a same-named marketplace rooted
// elsewhere is operator-owned and uninstall must not touch it.
function testUninstallPreservesForeignCodexMarketplace(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const install = run(['install'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  const foreignRoot = path.join(cfg, 'operator-baseline-marketplace');
  const foreign = readFakeCodexState(codex);
  foreign.marketplaces = [{ name: CODEX_MARKETPLACE, root: foreignRoot }];
  const plugin = foreign.installed.find(entry => entry.pluginId === CODEX_PLUGIN_KEY);
  if (!plugin) throw new Error('install did not create the managed Codex plugin fixture');
  plugin.source.path = path.join(foreignRoot, 'plugins', 'baseline');
  foreign.commands = [];
  writeFakeCodexState(codex, foreign);

  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  const after = readFakeCodexState(codex);
  assert.deepStrictEqual(after.marketplaces, foreign.marketplaces,
    'foreign same-named marketplace must remain registered');
  assert.deepStrictEqual(after.installed, foreign.installed,
    'foreign plugin state must remain untouched');
  assert.deepStrictEqual(after.commands, [codexCommand('marketplace', 'list')],
    'foreign marketplace detection must stop before plugin or marketplace removal');
  assert.match(uninstall.stdout, /marketplace : foreign — left as-is/);
}

// A syntactically valid but schema-invalid list response is unknown state, not
// proof that baseline is absent. Both marketplace and plugin faults must keep
// all managed CLI state intact and issue no destructive remove command.
function testUninstallKeepsCodexStateWhenListJsonHasWrongShape(): void {
  const faults: Array<{
    name: string;
    env: { [key: string]: string };
    commands: string[][];
    marketplaceReport: RegExp;
  }> = [
    {
      name: 'marketplace',
      env: { BASELINE_TEST_FAKE_CODEX_MARKETPLACE_LIST_WRONG_SHAPE: '1' },
      commands: [codexCommand('marketplace', 'list')],
      marketplaceReport: /marketplace : unreadable — left as-is/,
    },
    {
      name: 'marketplace malformed entry',
      env: { BASELINE_TEST_FAKE_CODEX_MARKETPLACE_LIST_MALFORMED_ENTRY: '1' },
      commands: [codexCommand('marketplace', 'list')],
      marketplaceReport: /marketplace : unreadable — left as-is/,
    },
    {
      name: 'plugin',
      env: { BASELINE_TEST_FAKE_CODEX_PLUGIN_LIST_WRONG_SHAPE: '1' },
      commands: [codexCommand('marketplace', 'list'), codexCommand('list')],
      marketplaceReport: /marketplace : owned — kept because plugin is unreadable/,
    },
    {
      name: 'plugin malformed entry',
      env: { BASELINE_TEST_FAKE_CODEX_PLUGIN_LIST_MALFORMED_ENTRY: '1' },
      commands: [codexCommand('marketplace', 'list'), codexCommand('list')],
      marketplaceReport: /marketplace : owned — kept because plugin is unreadable/,
    },
  ];
  for (const fault of faults) {
    const cfg = tempConfig();
    const home = homeFor(cfg);
    const codex = codexFor(cfg);
    const install = run(['install'], cfg);
    assert.strictEqual(install.status, 0, fault.name + ': ' + (install.stderr || install.stdout));
    const before = readFakeCodexState(codex);

    resetFakeCodexCommands(codex);
    const uninstall = run(['uninstall'], cfg, undefined, fault.env);
    assert.strictEqual(uninstall.status, 0, fault.name + ': ' + (uninstall.stderr || uninstall.stdout));
    const after = readFakeCodexState(codex);
    assert.deepStrictEqual(after.marketplaces, before.marketplaces,
      fault.name + ': wrong-shaped list must preserve the manager-owned marketplace');
    assert.deepStrictEqual(after.installed, before.installed,
      fault.name + ': wrong-shaped list must preserve the manager-owned plugin');
    assert.deepStrictEqual(after.commands, fault.commands,
      fault.name + ': uninstall must stop before any Codex remove command');
    assert.match(uninstall.stdout, /codex plugin: unreadable — left as-is/,
      fault.name + ': wrong-shaped JSON must report plugin state as unreadable');
    assert.match(uninstall.stdout, fault.marketplaceReport,
      fault.name + ': wrong-shaped JSON must report why marketplace state was preserved');
  }
}

// --- repo invariants --------------------------------------------------------

function assertGitVisible(file: string): void {
  const r = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, file + ' should be visible to git; git check-ignore status=' + r.status);
}

// Inverse of assertGitVisible: the path must be gitignored (git check-ignore exits 0
// when a path is ignored). The .arca/<proj>-sp/ knowledge database is local-only and
// must never be visible to git.
function assertGitIgnored(file: string): void {
  const r = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, file + ' should be gitignored; git check-ignore status=' + r.status);
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

// R-014 (goal decision #20): zero runtime dependencies is a guarded contract, not a
// hope. Assert package.json declares none, and that src/ + scripts/ import/require only
// Node built-ins or in-repo relative paths — never a bare third-party specifier.
function testNoRuntimeDependencies(): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deps = pkg.dependencies;
  assert.ok(
    deps === undefined || (deps && typeof deps === 'object' && !Array.isArray(deps) && Object.keys(deps).length === 0),
    'package.json must declare no runtime dependencies (found ' + JSON.stringify(deps) + ')');

  const builtins = new Set(builtinModules);
  const allowed = (spec: string): boolean => {
    if (spec.startsWith('./') || spec.startsWith('../')) return true; // in-repo relative
    const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
    return builtins.has(bare) || builtins.has(bare.split('/')[0]);
  };
  const specifiers = (text: string, res: RegExp[]): string[] => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '); // drop comments
    const out: string[] = [];
    for (const re of res) {
      const r = new RegExp(re.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = r.exec(code)) !== null) out.push(m[m.length - 1]);
    }
    return out;
  };
  const scan = (dir: string, ext: string, res: RegExp[]): void => {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(ext)) continue;
      for (const spec of specifiers(fs.readFileSync(path.join(dir, f), 'utf8'), res)) {
        assert.ok(allowed(spec), path.join(dir, f) + ' imports a non-builtin, non-relative module "' + spec + '"');
      }
    }
  };
  scan(path.join(root, 'src'), '.ts', [/\bfrom\s+['"]([^'"]+)['"]/, /\bimport\s+['"]([^'"]+)['"]/]);
  scan(path.join(root, 'scripts'), '.js', [/\brequire\(\s*['"]([^'"]+)['"]\s*\)/]);
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

// R-006 (goal decision #13): the minimal preset is the neutral, project-agnostic
// guardrail floor — no personal branding, no recital opener, and not a near-copy of
// the curated default preset doc. testPresetsAreValid covers only JSON/route shape.
function testMinimalPresetIsNeutral(): void {
  const minimal = fs.readFileSync(path.join(root, 'presets', 'minimal', 'docs', 'baseline.md'), 'utf8');
  const dflt = fs.readFileSync(path.join(root, 'presets', 'default', 'docs', 'baseline.md'), 'utf8');
  assert.ok(!minimal.includes('LI BASELINE'), 'minimal preset doc must not carry the personal "LI BASELINE" marker');
  assert.ok(!minimal.includes('LI BASELINE ALIGNED:'), 'minimal preset doc must not use the personal recital opener');
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  assert.notStrictEqual(normalize(minimal), normalize(dflt),
    'minimal preset doc must not be near-identical to the default preset doc');
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
  // R-007 (I-006): the text/ANSI logos are ASCII, not "ASM".
  assert.ok(!readme.includes('ASM logo'), 'README must not call the logos "ASM" (typo for ASCII)');
  assert.match(readme, /ASCII logo/, 'README should describe the ASCII logos');
}

function testDocsDescribeRoutesModel(): void {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  // Canonical goal docs live in the persistent knowledge database under
  // .arca/<proj>-sp/goal/, which is intentionally gitignored — git must never
  // see those knowledge files.
  for (const doc of ['vision.md', 'architecture.md', 'vocabulary.md', 'plain.md'] as const) {
    assertGitIgnored(path.join('.arca', 'baseline-sp', 'goal', doc));
  }
  for (const [name, text] of [['README', readme], ['SKILL', skill]] as const) {
    assert.match(text, /cfg\/baseline/, name + ' should describe the cfg/baseline config folder');
    assert.match(text, /config\.json/, name + ' should mention config.json');
    assert.match(text, /route/i, name + ' should describe routes');
  }
}

// R-005 (goal decision #12): install wrappers expose only a curated flag set. The native
// runtime is now available via `manage.js install --runtime prebuilt|build` (R-009), but the
// install WRAPPERS deliberately do NOT advertise --build/--runtime — that surface stays with
// the manager. This guards the wrappers against re-growing those flags.
function testInstallWrappersHaveNoBuildFlag(): void {
  const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const ps1 = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
  for (const [name, text] of [['install.sh', sh], ['install.ps1', ps1]] as const) {
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
function testCfgLocationPhrasingIsCanonical(): void {
  const sources: Array<[string, string]> = [
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

// R-014 (goal decision #17): one canonical sentence states the install-root resolution
// order everywhere in docs and generated control-surface text, and the divergent
// two-rung phrasing (which omits the installed-manager rung) no longer survives.
function testInstallRootPhrasingIsCanonical(): void {
  const clause = '`BASELINE_HOME`, else the installed manager\'s own root, else `~/.baseline`';
  const divergent = '`BASELINE_HOME`, else `~/.baseline`'; // two-rung form, must not survive
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const sources: Array<[string, string]> = [
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

function testCodexPluginManifest(): void {
  const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
  assert.ok(fs.existsSync(manifestPath), 'Codex plugin manifest missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.name, 'baseline');
  assert.strictEqual(manifest.skills, './skills/');
  assert.ok(fs.existsSync(path.join(root, 'skills', 'baseline', 'SKILL.md')), 'Codex plugin skill wrapper missing');
}

function testClaudePluginManifest(): void {
  const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
  assert.ok(fs.existsSync(manifestPath), 'Claude plugin manifest missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.name, 'baseline');
  // Skill-only plugin: it must NOT declare hooks. baseline's hook wiring lives in
  // settings.json and is managed by the installer, additive to any plugin hooks.
  assert.ok(!('hooks' in manifest), 'Claude plugin manifest must not declare hooks (skill-only)');
  // Top-level SKILL.md is exposed via "skills": ["./"].
  assert.ok(Array.isArray(manifest.skills) && manifest.skills.indexOf('./') !== -1,
    'Claude plugin manifest should expose the top-level skill via "skills": ["./"]');
}

// install deploys self-contained control surfaces: Claude gets the skills-dir
// .claude-plugin payload, while Codex gets a manager-owned marketplace payload.
// Both generated skill payloads point normal commands at the installed manager.
function testControlSurfacePluginsDeployed(): void {
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
  const claudeSkill = readThrough(agentSkill);
  assert.match(claudeSkill, /name:\s*baseline/, 'deployed Claude skill missing name frontmatter');
  assertControlSurfaceCommandsUseInstalledManager(claudeSkill, home, 'deployed Claude skill');

  // Codex receives the central marketplace payload through its supported CLI.
  assertCodexPayload(centralCodexPlugin(home), 'central Codex plugin');
  assertControlSurfaceCommandsUseInstalledManager(
    readThrough(path.join(centralCodexPlugin(home), 'skills', 'baseline', 'SKILL.md')),
    home,
    'deployed Codex skill');
  assertCodexPluginInstalled(codex, home, 'control surface');

  resetFakeCodexCommands(codex);
  const status = run(['status'], cfg);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /skill plugin : OK/, 'status should report the Claude agent skill link');
  assert.match(status.stdout, /codex plugin\s+: present at /, 'status should report the central Codex plugin payload');
  assert.match(statusAgentSection(status.stdout, 'codex'), /marketplace\s+: OK \(registered\)/,
    'status should inspect the registered marketplace through Codex CLI');
  assert.match(statusAgentSection(status.stdout, 'codex'), /codex plugin\s+: OK \(installed\) @/,
    'status should inspect the installed plugin through Codex CLI');
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
  ], 'status should query marketplace and plugin state through Codex CLI');

  resetFakeCodexCommands(codex);
  const doctor = run(['doctor'], cfg);
  assert.strictEqual(doctor.status, 0, doctor.stdout);
  assert.match(doctor.stdout, /claude skill plugin: central payload deployed; points at installed manager/);
  assert.match(doctor.stdout, /skill link: claude-code linked to center/);
  assert.match(doctor.stdout, /codex plugin payload: central payload deployed; points at installed manager/);
  assert.match(doctor.stdout, /codex marketplace: codex registered from manager-owned root/);
  assert.match(doctor.stdout, /codex plugin install: codex baseline@baseline-local installed @/);
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
  ], 'doctor should query marketplace and plugin state through Codex CLI');
}

function testUpdateRestoresCodexMarketplacePlugin(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  writeFakeCodexState(codex, { marketplaces: [], installed: [], commands: [] });
  const update = run(['update'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assertCodexPluginInstalled(codex, home, 'update');
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('marketplace', 'add', centralCodexMarketplace(home)),
    codexCommand('add', CODEX_PLUGIN_KEY),
  ], 'update should recreate the registered marketplace and installed plugin through Codex CLI');
}

function testDoctorFixRestoresCodexMarketplacePlugin(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  writeFakeCodexState(codex, { marketplaces: [], installed: [], commands: [] });
  const broken = run(['doctor'], cfg);
  assert.strictEqual(broken.status, 1, broken.stdout);
  assert.match(broken.stdout, /\[FAIL\] codex marketplace: codex missing/);
  assert.match(broken.stdout, /\[FAIL\] codex plugin install: codex missing/);

  resetFakeCodexCommands(codex);
  const fixed = run(['doctor', '--fix'], cfg);
  assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /doctor: installation repaired/);
  assertCodexPluginInstalled(codex, home, 'doctor --fix');
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('marketplace', 'list'),
    codexCommand('marketplace', 'add', centralCodexMarketplace(home)),
    codexCommand('add', CODEX_PLUGIN_KEY),
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
  ], 'doctor --fix should repair and recheck Codex marketplace/plugin state through the CLI');
}

// A valid-looking old cachebuster is drift, even when the marketplace and source
// path remain manager-owned. The fix must redeploy the central payload and re-add
// the CLI-installed plugin through the supported lifecycle.
function testCodexDigestDriftIsDetectedAndRepaired(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);

  const expectedVersion = expectedCodexPluginVersion(home, 'digest drift');
  const manifestPath = path.join(centralCodexPlugin(home), '.codex-plugin', 'plugin.json');
  const deployedManifest: unknown = JSON.parse(readThrough(manifestPath));
  if (!isRecord(deployedManifest) || typeof deployedManifest.version !== 'string') {
    throw new Error('installed central Codex manifest needs a version');
  }
  assert.strictEqual(deployedManifest.version, expectedVersion, 'install should deploy the exact expected Codex version');
  const staleVersion = expectedVersion.slice(0, -12) + '000000000000';
  assert.notStrictEqual(staleVersion, expectedVersion, 'stale fixture must differ from the expected version');
  deployedManifest.version = staleVersion;
  write(manifestPath, JSON.stringify(deployedManifest, null, 2) + '\n');

  const staleState = readFakeCodexState(codex);
  const stalePlugin = staleState.installed.find(entry => entry.pluginId === CODEX_PLUGIN_KEY);
  if (!stalePlugin) throw new Error('install did not create the managed Codex plugin fixture');
  assert.strictEqual(stalePlugin.source.path, centralCodexPlugin(home), 'stale fixture must keep the manager-owned source path');
  stalePlugin.version = staleVersion;
  writeFakeCodexState(codex, staleState);

  const status = run(['status'], cfg);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.ok(status.stdout.includes('codex plugin   : STALE — deployed @ ' + staleVersion + '; expected @ ' + expectedVersion),
    'human status should surface a stale central Codex payload');
  assert.ok(statusAgentSection(status.stdout, 'codex').includes('codex plugin : STALE — installed @ ' + staleVersion + '; expected @ ' + expectedVersion),
    'human status should surface a stale CLI-installed Codex plugin');

  const jsonStatusResult = run(['status', '--json'], cfg);
  assert.strictEqual(jsonStatusResult.status, 0, jsonStatusResult.stderr || jsonStatusResult.stdout);
  const jsonStatus: unknown = JSON.parse(jsonStatusResult.stdout);

  if (!isRecord(jsonStatus) || !isRecord(jsonStatus.data)) throw new Error('status --json needs a data object');
  const centralStatus = jsonStatus.data.codexPlugin;
  if (!isRecord(centralStatus)) throw new Error('status --json needs Codex payload state');
  assert.strictEqual(centralStatus.stale, true, 'JSON status should mark the central payload stale');
  assert.strictEqual(centralStatus.version, staleVersion, 'JSON status should expose the stale central version');
  assert.strictEqual(centralStatus.expectedVersion, expectedVersion, 'JSON status should expose the expected central version');
  const agents = jsonStatus.data.agents;
  if (!Array.isArray(agents)) throw new Error('status --json needs agents');
  const codexAgent = agents.find((agent: unknown) => isRecord(agent) && agent.name === 'codex');
  if (!isRecord(codexAgent) || !isRecord(codexAgent.codex)) throw new Error('status --json needs Codex agent state');
  assert.strictEqual(codexAgent.codex.stale, true, 'JSON status should mark the installed plugin stale');
  assert.strictEqual(codexAgent.codex.version, staleVersion, 'JSON status should expose the stale installed version');
  assert.strictEqual(codexAgent.codex.expectedVersion, expectedVersion, 'JSON status should expose the expected installed version');

  resetFakeCodexCommands(codex);
  const broken = run(['doctor'], cfg);
  assert.strictEqual(broken.status, 1, broken.stdout);
  assert.match(broken.stdout, /\[WARN\] codex plugin payload: deployed manifest\/cachebuster differs from source \(update will refresh\)/,
    'doctor should retain the fixable central payload drift message');
  assert.ok(broken.stdout.includes('[FAIL] codex plugin install: codex ' + CODEX_PLUGIN_KEY + ' stale @ ' + staleVersion + '; expected @ ' + expectedVersion),
    'doctor should fail a stale CLI-installed version');
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
  ], 'doctor should inspect stale plugin ownership and version through the CLI');

  resetFakeCodexCommands(codex);
  const fixed = run(['doctor', '--fix'], cfg);
  assert.strictEqual(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /doctor: installation repaired/);
  const repairedManifest: unknown = JSON.parse(readThrough(manifestPath));
  if (!isRecord(repairedManifest) || typeof repairedManifest.version !== 'string') {
    throw new Error('repaired central Codex manifest needs a version');
  }
  assert.strictEqual(repairedManifest.version, expectedVersion,
    'doctor --fix should restore the central manifest to the exact expected version');

  assertCodexPluginInstalled(codex, home, 'doctor --fix stale digest');
  assert.deepStrictEqual(readFakeCodexState(codex).commands, [
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
    codexCommand('add', CODEX_PLUGIN_KEY),
    codexCommand('marketplace', 'list'),
    codexCommand('list'),
  ], 'doctor --fix should re-add the stale CLI-installed plugin then verify it through the CLI');
}

function testUnavailableCodexCliLeavesControlSurfaceUninstalled(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  const unavailable = path.join(cfg, 'missing-codex-cli');
  const env = { BASELINE_CODEX_CLI: unavailable };

  const install = run(['install'], cfg, undefined, env);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /codex NOTICE: `codex` CLI unavailable/,
    'install should stay nonfatal when the configured Codex CLI is unavailable');
  assert.ok(fs.existsSync(centralCodexPlugin(home)), 'install should still deploy the central Codex marketplace payload');
  assert.ok(!fs.existsSync(fakeCodexStatePath(codex)), 'unavailable Codex CLI must not create plugin lifecycle state');

  const status = run(['status'], cfg, undefined, env);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  assert.match(statusAgentSection(status.stdout, 'codex'), /marketplace\s+: UNAVAILABLE/);
  assert.match(statusAgentSection(status.stdout, 'codex'), /codex plugin\s+: UNAVAILABLE/);
  const jsonStatusResult = run(['status', '--json'], cfg, undefined, env);
  assert.strictEqual(jsonStatusResult.status, 0, jsonStatusResult.stderr || jsonStatusResult.stdout);
  const jsonStatus: unknown = JSON.parse(jsonStatusResult.stdout);
  if (!isRecord(jsonStatus) || !isRecord(jsonStatus.data) || !Array.isArray(jsonStatus.data.agents)) {
    throw new Error('unavailable Codex status --json needs agent state');
  }
  const codexAgent = jsonStatus.data.agents.find((agent: unknown) => isRecord(agent) && agent.name === 'codex');
  if (!isRecord(codexAgent) || !isRecord(codexAgent.links) || !isRecord(codexAgent.codex)) {
    throw new Error('unavailable Codex status --json needs Codex fields');
  }
  const pluginLink = codexAgent.links.codexPlugin;
  if (!isRecord(pluginLink)) throw new Error('unavailable Codex status --json needs a plugin link state');
  assert.strictEqual(pluginLink.mechanism, 'unavailable',
    'JSON status should retain the unavailable CLI lifecycle state');
  assert.strictEqual(codexAgent.codex.stale, false,
    'JSON status must not misclassify an unavailable Codex CLI as stale');


  const doctor = run(['doctor'], cfg, undefined, env);
  assert.strictEqual(doctor.status, 1, doctor.stdout);
  assert.match(doctor.stdout, /\[WARN\] codex marketplace: codex unavailable/);
}

// install with BASELINE_CFG set: config lives FLAT in the external folder, the install
// root holds only artifacts, <installRoot>/cfg symlinks to the external folder, agents
// read through the chain, and --force refuses to clobber the (tracked) external config.
function testExternalConfigLocation(): void {
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

function testShellWrappersExecutable(): void {
  for (const file of ['install.sh', 'update.sh', 'doctor.sh', 'uninstall.sh', 'build.sh']) {
    const r = spawnSync('git', ['ls-files', '--stage', '--', file], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^100755 /, file + ' should be executable in git');
  }
}

// --- guided agent selection on install (R-004) -----------------------------

// --agents selects a subset: only claude-code is wired, codex is left alone, and
// the selected set is recorded verbatim in <installRoot>/state.json.
function testAgentsFlagSelectsSubset(): void {
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
  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /agent tested\s+: claude-code/,
    'verify must stay within the recorded agent scope and execute Claude directly');
}

// --agents with the full comma list wires both agents and records both.
function testAgentsFlagBothExplicit(): void {
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
function testUnknownAgentErrors(): void {
  const cfg = tempConfig();
  const install = run(['install', '--agents', 'bogus'], cfg);
  assert.notStrictEqual(install.status, 0, 'unknown agent should be a hard error');
  assert.match((install.stderr || '') + (install.stdout || ''), /bogus/, 'error should name the bad agent');
}

// Selecting an agent whose config dir does not exist is a hard error (D2: strictly
// limited to detected agents).
function testNotDetectedAgentErrors(): void {
  const cfg = tempConfig();
  const codex = codexFor(cfg);
  fs.rmSync(codex, { recursive: true, force: true });
  const install = run(['install', '--agents', 'codex'], cfg);
  assert.notStrictEqual(install.status, 0, 'selecting a not-detected agent should fail');
  assert.match((install.stderr || '') + (install.stdout || ''), /codex/, 'error should name the not-detected agent');
}

// Non-interactive (spawnSync is not a TTY) with no --agents selects ALL detected.
function testNonTtyWiresAllDetected(): void {
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
function testStrictlyDetectedOnly(): void {
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
function testZeroDetectedErrors(): void {
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
function testUpdateScopesToRecordedSet(): void {
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
function testUpdateMigrationInfersFromWired(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const codex = codexFor(cfg);
  assert.strictEqual(run(['install'], cfg).status, 0);
  fs.rmSync(path.join(home, 'state.json'), { force: true }); // simulate a legacy install

  const update = run(['update'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);

  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  assert.deepStrictEqual(state.agents.slice().sort(), ['claude-code', 'codex'],
    'update should recreate state.json from the wired set');
  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(settings.hooks && settings.hooks.UserPromptSubmit, 'claude-code must remain wired');
  const hooks = JSON.parse(fs.readFileSync(path.join(codex, 'hooks.json'), 'utf8'));
  assert.ok(hooks.hooks && hooks.hooks.UserPromptSubmit, 'codex must remain wired');
}

// uninstall scopes to the recorded set: a claude-only install's uninstall removes
// claude wiring and never touches codex (D6).
function testUninstallScopesToRecordedSet(): void {
  const cfg = tempConfig();
  const codex = codexFor(cfg);
  assert.strictEqual(run(['install', '--agents', 'claude-code'], cfg).status, 0);
  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks || !settings.hooks.UserPromptSubmit || !settings.hooks.UserPromptSubmit.length,
    'uninstall should remove claude-code wiring');
  assert.ok(!fs.existsSync(path.join(codex, 'hooks.json')),
    'uninstall scoped to [claude-code] must not create/touch codex hooks.json');
}

// A recorded agent whose config dir later vanishes is dropped GRACEFULLY on update
// (exit 0) with a notice — never a hard error — and the recorded set narrows to what
// remains (D6: drop-with-notice, not silent and not a hard error). The hard error is
// reserved for an explicit user-supplied --agents (D1).
function testUpdateDropsVanishedRecordedAgent(): void {
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

// --- extension-shim agents (pi / oh-my-pi / opencode) ------------------------

// install --agents pi deploys the marker-tagged extension shim with the agent dir
// baked in, links the dispatcher artifacts, and uninstall removes exactly our shim.
function testPiShimInstallUninstall(): void {
  const cfg = tempConfig();
  const pi = piFor(cfg);
  fs.mkdirSync(pi, { recursive: true });
  const install = run(['install', '--agents', 'pi'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const shim = path.join(pi, 'extensions', 'baseline-recital.ts');
  const text = fs.readFileSync(shim, 'utf8');
  assert.ok(text.startsWith('// baseline-shim v1'), 'shim must start with the ownership marker');
  assert.ok(text.includes(JSON.stringify(pi)), 'shim must bake in the agent config dir');
  assert.ok(text.includes('before_agent_start') && text.includes('session_start'),
    'pi shim must handle before_agent_start and session_start');
  assert.ok(fs.existsSync(path.join(pi, 'hooks', 'baseline-recital.js')), 'dispatcher link deployed');
  assert.ok(fs.existsSync(path.join(pi, 'cfg', 'baseline', 'config.json')), 'cfg link deployed');
  assert.ok(!fs.existsSync(path.join(pi, 'settings.json')), 'pi settings.json must never be created or rewritten');

  const state = JSON.parse(fs.readFileSync(path.join(homeFor(cfg), 'state.json'), 'utf8'));
  assert.deepStrictEqual(state, { agents: ['pi'] }, 'state.json should record exactly the selected set');

  const status = run(['status'], cfg);
  assert.match(statusAgentSection(status.stdout, 'pi'), /shim\s+: OK \(generated, current\)/);

  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.ok(!fs.existsSync(shim), 'uninstall must remove our shim');
}

// oh-my-pi shares the pi extension surface but its own config dir.
function testOmpShimInstall(): void {
  const cfg = tempConfig();
  const omp = ompFor(cfg);
  fs.mkdirSync(omp, { recursive: true });
  const install = run(['install', '--agents', 'oh-my-pi'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  const shim = path.join(omp, 'extensions', 'baseline-recital.ts');
  const text = fs.readFileSync(shim, 'utf8');
  assert.ok(text.startsWith('// baseline-shim v1'), 'marker-tagged shim deployed');
  assert.ok(text.includes(JSON.stringify(omp)), 'shim must bake in the oh-my-pi config dir');
}

// opencode gets a generated plugin dir plus a surgical opencode.json plugin-array
// entry; co-resident config keys and entries survive install and uninstall.
function testOpencodeShimInstallUninstall(): void {
  const cfg = tempConfig();
  const oc = opencodeFor(cfg);
  fs.mkdirSync(oc, { recursive: true });
  write(path.join(oc, 'opencode.json'),
    JSON.stringify({ theme: 'dark', plugin: ['./plugins/other/plugin.js'] }, null, 2) + '\n');
  const install = run(['install', '--agents', 'opencode'], cfg);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);

  const shim = path.join(oc, 'plugins', 'baseline', 'plugin.js');
  const text = fs.readFileSync(shim, 'utf8');
  assert.ok(text.startsWith('// baseline-shim v1'), 'shim must start with the ownership marker');
  assert.ok(text.includes('experimental.chat.system.transform'), 'delivery hook present');
  assert.ok(fs.existsSync(path.join(oc, 'plugins', 'baseline', 'package.json')), 'plugin package.json deployed');

  const oj = JSON.parse(fs.readFileSync(path.join(oc, 'opencode.json'), 'utf8'));
  assert.strictEqual(oj.theme, 'dark', 'co-resident keys preserved');
  assert.ok(oj.plugin.indexOf('./plugins/baseline/plugin.js') !== -1, 'our plugin entry added');
  assert.ok(oj.plugin.indexOf('./plugins/other/plugin.js') !== -1, 'co-resident plugin entries preserved');

  const uninstall = run(['uninstall'], cfg);
  assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.ok(!fs.existsSync(shim), 'plugin.js removed');
  assert.ok(!fs.existsSync(path.join(oc, 'plugins', 'baseline')), 'empty plugin dir removed');
  const after = JSON.parse(fs.readFileSync(path.join(oc, 'opencode.json'), 'utf8'));
  assert.deepStrictEqual(after.plugin, ['./plugins/other/plugin.js'], 'only our entry removed');
}

// A file at the shim path without our marker is foreign: hard error, left untouched.
function testShimForeignFileRefused(): void {
  const cfg = tempConfig();
  const pi = piFor(cfg);
  const shim = path.join(pi, 'extensions', 'baseline-recital.ts');
  write(shim, 'export default function () {}\n');
  const install = run(['install', '--agents', 'pi'], cfg);
  assert.notStrictEqual(install.status, 0, 'foreign file at the shim path must be a hard error');
  assert.match(install.stdout + install.stderr, /foreign file/);
  assert.strictEqual(fs.readFileSync(shim, 'utf8'), 'export default function () {}\n', 'foreign file untouched');
}

// No deliverable events → no shim (pi cannot deliver tool events; opencode can).
function testShimSkippedWhenNoDeliverableEvents(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const pi = piFor(cfg);
  const oc = opencodeFor(cfg);
  fs.mkdirSync(pi, { recursive: true });
  fs.mkdirSync(oc, { recursive: true });
  assert.strictEqual(run(['install', '--agents', 'pi,opencode'], cfg).status, 0);

  setCentralConfig(home, [{ id: 'tools', event: 'PreToolUse', freq: 1, doc: 'docs/tools.md' }],
    { 'docs/tools.md': 'tool doc\n' });
  const update = run(['update'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.ok(!fs.existsSync(path.join(pi, 'extensions', 'baseline-recital.ts')),
    'pi shim must be removed when the config has no pi-deliverable events');
  assert.match(update.stdout, /shim NOTICE : events \[PreToolUse\]/, 'undeliverable notice for pi');
  assert.ok(fs.existsSync(path.join(oc, 'plugins', 'baseline', 'plugin.js')),
    'opencode shim must stay (PreToolUse is deliverable there)');
}

// A hand-edited (stale) shim is reported by status/doctor and restored by update.
function testShimStaleRefreshedOnUpdate(): void {
  const cfg = tempConfig();
  const pi = piFor(cfg);
  fs.mkdirSync(pi, { recursive: true });
  assert.strictEqual(run(['install', '--agents', 'pi'], cfg).status, 0);
  const shim = path.join(pi, 'extensions', 'baseline-recital.ts');
  const original = fs.readFileSync(shim, 'utf8');
  fs.writeFileSync(shim, original + '// drifted\n', 'utf8');

  const status = run(['status'], cfg);
  assert.match(statusAgentSection(status.stdout, 'pi'), /STALE/);
  const doctor = run(['doctor'], cfg);
  assert.notStrictEqual(doctor.status, 0, 'doctor must flag the stale shim');
  assert.match(doctor.stdout, /\[WARN\] shim wiring: pi shim differs from expected/);

  const update = run(['update'], cfg);
  assert.strictEqual(update.status, 0, update.stderr || update.stdout);
  assert.strictEqual(fs.readFileSync(shim, 'utf8'), original, 'update must restore the canonical shim');
}

// verify drives the same dispatcher a shim agent spawns, within the recorded scope.
function testVerifyThroughShimAgent(): void {
  const cfg = tempConfig();
  const pi = piFor(cfg);
  fs.mkdirSync(pi, { recursive: true });
  assert.strictEqual(run(['install', '--agents', 'pi'], cfg).status, 0);
  const verify = run(['verify'], cfg);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /agent tested\s+: pi/);
}

// --- CLI --json machine surface (R-012) ------------------------------------

function testJsonStatusShape(): void {
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

function testJsonRouteListShape(): void {
  const cfg = tempConfig();
  assert.strictEqual(run(['install'], cfg).status, 0);
  const res = run(['route', 'list', '--json'], cfg);
  assert.strictEqual(res.status, 0, res.stderr || res.stdout);
  const obj = JSON.parse(res.stdout.trim());
  assert.strictEqual(obj.apiVersion, 1);
  assert.strictEqual(obj.command, 'route.list');
  assert.ok(Array.isArray(obj.data.routes), 'routes array');
  const baseline = obj.data.routes.find((r: any) => r.id === 'baseline');
  assert.ok(baseline, 'default preset baseline route present in JSON');
  for (const k of ['id', 'event', 'freq', 'doc']) assert.ok(k in baseline, 'route entry has ' + k);
}

function testJsonRouteAddRemove(): void {
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
  assert.ok(addObj.data.routes.some((r: any) => r.id === 'extra'), 'returned routes include the added one');
  // config.json actually mutated on disk, preserving the preset routes.
  let cfgJson = JSON.parse(readThrough(path.join(home, 'cfg', 'config.json')));
  assert.ok(cfgJson.routes.some((r: any) => r.id === 'extra' && r.freq === 3), 'config.json gained the route');
  assert.ok(cfgJson.routes.some((r: any) => r.id === 'baseline'), 'existing routes preserved');

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
  assert.ok(!rmObj.data.routes.some((r: any) => r.id === 'extra'), 'removed route gone from returned list');
  cfgJson = JSON.parse(readThrough(path.join(home, 'cfg', 'config.json')));
  assert.ok(!cfgJson.routes.some((r: any) => r.id === 'extra'), 'config.json no longer has the route');
}

function testJsonDispatchSimulate(): void {
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
  assert.ok(obj.data.selected.some((r: any) => r.id === 'sim'), 'sim route selected');
  assert.strictEqual(obj.data.additionalContext, 'SIM {{event}}\n',
    'static body must be previewed verbatim: ' + obj.data.additionalContext);
  // Side-effect-free: simulate must never write the counter file.
  assert.ok(!fs.existsSync(path.join(cfg, '.baseline-counters.json')), 'simulate must not write counters');
}

function testJsonErrorPathExitCode(): void {
  const cfg = tempConfig();
  assert.strictEqual(run(['install'], cfg).status, 0);
  const res = run(['route', 'remove', '--id', 'ghost', '--json'], cfg);
  assert.notStrictEqual(res.status, 0, 'error path must exit nonzero');
  const obj = JSON.parse(res.stdout.trim());
  assert.strictEqual(obj.apiVersion, 1);
  assert.ok(obj.error && typeof obj.error.code === 'string' && typeof obj.error.message === 'string',
    'structured { code, message } error');
  assert.ok(!('data' in obj), 'error payload carries no data');
  assert.strictEqual((res.stderr || '').trim(), '', 'json error must not also write stderr');
}

// --- benchmark harness smoke (R-013) ---------------------------------------

// The bench harness must not rot: shape-check it (one run per impl, correctness only, NO
// timing assertions). Required impls (baseline-node, ref-node) must produce correct
// output; optional impls (python/ts) may skip cleanly but must still be reported.
function testBenchHarnessSmoke(): void {
  const res = spawnSync(process.execPath, [path.join(root, 'bench', 'run.js'), '--smoke'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, 'bench --smoke should exit 0: ' + (res.stderr || res.stdout));
  const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  const obj = JSON.parse(lastLine);
  assert.strictEqual(obj.smoke, true, 'smoke summary shape');
  const byName: { [k: string]: any } = {};
  for (const i of obj.impls) byName[i.name] = i;
  assert.ok(byName['baseline-node'] && byName['baseline-node'].ok === true, 'baseline dispatcher produces correct injection output');
  assert.ok(byName['ref-node'] && byName['ref-node'].ok === true, 'ref-node produces correct injection output');
  // The native lane (R-009) must be reported and, when a prebuilt exists for this platform,
  // produce correct output; on platforms with no prebuilt it skips-with-notice (never dropped).
  assert.ok('baseline-native' in byName, 'baseline-native lane is reported');
  assert.ok(byName['baseline-native'].skipped || byName['baseline-native'].ok === true,
    'baseline-native produces correct injection output when a prebuilt exists');
  // Optional impls must appear as entries (ok or skipped) — never silently dropped.
  assert.ok('ref-python' in byName && 'ref-ts' in byName, 'optional impls are reported (ok or skipped, not absent)');
}

// R-014 (goal decision #20): a PROVISIONAL peak-RSS ceiling for the Node dispatch path,
// pinned generously from the benchmark (bench/budgets.json). Measured cross-platform via
// the reference injection's own ##RSS self-report (the shipped dispatcher is a peer Node
// process). Enforced now with ample headroom so it never flakes; skips-with-notice only
// when the ceiling is unpinned or the RSS number can't be obtained (never a false green).
// The FINAL post-native budget stays a separate open TODO (R-014 + bench/budgets.json).
function testDispatchRssWithinCeiling(): void {
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
    const r = spawnSync(process.execPath, [path.join(root, 'bench', 'refs', 'node-min.js')], {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function standaloneDispatcherFixture(label: string, routes?: any[]): string {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-dispatch-' + label + '-'));
  const cfgDir = path.join(agent, 'cfg', 'baseline');
  fs.mkdirSync(path.join(cfgDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    version: 1,
    routes: routes || [{ id: 'route', event: 'UserPromptSubmit', freq: 1, doc: 'docs/route.md' }]
  }));
  fs.writeFileSync(path.join(cfgDir, 'docs', 'route.md'), label + '\n');
  return agent;
}

function dispatcherEnv(extra?: { [key: string]: string }): NodeJS.ProcessEnv {
  const env = Object.assign({}, process.env);
  delete env.BASELINE_DIAGNOSTICS;
  return Object.assign(env, extra || {});
}

// An explicit agent directory is capability-like authority: no inherited manager,
// agent, or home fallback may redirect config reads or counter writes.
function testExplicitAgentConfigOutranksHostileEnvironment(): void {
  const requested = standaloneDispatcherFixture('requested');
  const hostile = standaloneDispatcherFixture('hostile');
  try {
    const env = dispatcherEnv({
      BASELINE_AGENT_CONFIG_DIR: hostile,
      CLAUDE_CONFIG_DIR: hostile,
      CODEX_HOME: hostile,
      HOME: hostile,
      USERPROFILE: hostile,
      HOMEDRIVE: hostile.slice(0, 2),
      HOMEPATH: hostile.slice(2),
    });
    const input = JSON.stringify({ session_id: 'authority', hook_event_name: 'UserPromptSubmit' });
    const explicit = spawnSync(process.execPath, [dispatcher, '--agent-config', requested], { input, env, encoding: 'utf8' });
    assert.strictEqual(explicit.status, 0, explicit.stderr);
    assert.strictEqual(fireBodies(explicit), 'requested\n');
    assert.ok(fs.existsSync(path.join(requested, '.baseline-counters.json')), 'explicit dir receives counter state');
    assert.ok(!fs.existsSync(path.join(hostile, '.baseline-counters.json')), 'hostile env dir remains untouched');

    const fallback = spawnSync(process.execPath, [dispatcher], { input, env, encoding: 'utf8' });
    assert.strictEqual(fireBodies(fallback), 'hostile\n', 'environment fallback remains active without the argument');
  } finally {
    fs.rmSync(requested, { recursive: true, force: true });
    fs.rmSync(hostile, { recursive: true, force: true });
  }
}

// Invalid UTF-8 is an all-output fail-open no-op. Diagnostics are opt-in, stable,
// stderr-only, and contain no input or path material.
function testInvalidUtf8AndRedactedDiagnostics(): void {
  const agent = standaloneDispatcherFixture('utf8', [
    { id: 'good', event: 'UserPromptSubmit', freq: 1, doc: 'docs/route.md' },
    { id: 'bad', event: 'UserPromptSubmit', freq: 1, doc: 'docs/bad.md' },
  ]);
  const badPath = path.join(agent, 'cfg', 'baseline', 'docs', 'bad.md');
  fs.writeFileSync(badPath, Buffer.from([0x66, 0x80, 0x67]));
  const input = JSON.stringify({ session_id: 'sensitive-session', hook_event_name: 'UserPromptSubmit' });
  try {
    const silent = spawnSync(process.execPath, [dispatcher, '--agent-config', agent], {
      input, env: dispatcherEnv(), encoding: 'utf8'
    });
    assert.strictEqual(silent.status, 0);
    assert.strictEqual(silent.stdout, '');
    assert.strictEqual(silent.stderr, '');

    const diagnostic = spawnSync(process.execPath, [dispatcher, '--agent-config', agent], {
      input, env: dispatcherEnv({ BASELINE_DIAGNOSTICS: '1' }), encoding: 'utf8'
    });
    assert.strictEqual(diagnostic.status, 0);
    assert.strictEqual(diagnostic.stdout, '');
    assert.strictEqual(diagnostic.stderr, 'baseline: DOC_INVALID_UTF8\n');
    assert.ok(!diagnostic.stderr.includes(agent));
    assert.ok(!diagnostic.stderr.includes('sensitive-session'));
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
}

// Counter persistence never opens the old predictable temp path and never follows a
// planted destination link. Only a temp created by this invocation may be cleaned up.
function testCounterTempAndDestinationSymlinksAreSafe(): void {
  const agent = standaloneDispatcherFixture('counter-safe');
  const target = path.join(agent, 'external-target.txt');
  const counter = path.join(agent, '.baseline-counters.json');
  const legacyTemp = counter + '.tmp';
  fs.writeFileSync(target, 'DO NOT TOUCH');
  try {
    try { fs.symlinkSync(target, legacyTemp, 'file'); }
    catch (e) {
      console.log('SKIP testCounterTempAndDestinationSymlinksAreSafe: file symlinks unavailable');
      return;
    }
    const input = JSON.stringify({ session_id: 'counter-safe', hook_event_name: 'UserPromptSubmit' });
    const first = spawnSync(process.execPath, [dispatcher, '--agent-config', agent], {
      input, env: dispatcherEnv(), encoding: 'utf8'
    });
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'DO NOT TOUCH');
    assert.ok(fs.lstatSync(legacyTemp).isSymbolicLink(), 'foreign legacy temp remains untouched');
    assert.ok(fs.existsSync(counter), 'counter state persisted through an unpredictable sibling temp');
    const leftovers = fs.readdirSync(agent).filter(name => /^\.baseline-counters\.json\..+\.tmp$/.test(name));
    assert.deepStrictEqual(leftovers, [], 'self-created temps are cleaned up');

    fs.rmSync(counter);
    fs.symlinkSync(target, counter, 'file');
    const second = spawnSync(process.execPath, [dispatcher, '--agent-config', agent], {
      input, env: dispatcherEnv(), encoding: 'utf8'
    });
    assert.strictEqual(second.status, 0, second.stderr);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'DO NOT TOUCH');
    assert.ok(fs.lstatSync(counter).isSymbolicLink(), 'destination symlink remains untouched');
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
}

function testGeneratedShimsPinAndSanitizeAgentConfig(): void {
  const cfg = tempConfig();
  const home = homeFor(cfg);
  const pi = piFor(cfg);
  const oc = opencodeFor(cfg);
  const hostile = standaloneDispatcherFixture('shim-hostile');
  fs.mkdirSync(pi, { recursive: true });
  fs.mkdirSync(oc, { recursive: true });
  try {
    const install = run(['install', '--runtime', 'node', '--agents', 'pi,opencode'], cfg);
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    for (const shim of [
      path.join(pi, 'extensions', 'baseline-recital.ts'),
      path.join(oc, 'plugins', 'baseline', 'plugin.js'),
    ]) {
      const text = fs.readFileSync(shim, 'utf8');
      assert.match(text, /"--agent-config", AGENT_DIR/);
      assert.match(text, /delete env\.BASELINE_AGENT_CONFIG_DIR/);
      assert.match(text, /delete env\.CLAUDE_CONFIG_DIR/);
      assert.match(text, /delete env\.CODEX_HOME/);
      assert.match(text, /env: dispatcherEnv\(\)/);
    }

    setCentralConfig(home,
      [{ id: 'shim', event: 'UserPromptSubmit', freq: 1, doc: 'docs/shim.md' }],
      { 'docs/shim.md': 'shim-requested\n' });
    const update = run(['update', '--runtime', 'node'], cfg);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);

    const plugin = path.join(oc, 'plugins', 'baseline', 'plugin.js');
    const probe = [
      'const { pathToFileURL } = require("node:url");',
      '(async () => {',
      '  const plugin = await import(pathToFileURL(process.argv[1]).href);',
      '  const hooks = await plugin.default({ directory: process.cwd() });',
      '  await hooks["chat.message"]({ sessionID: "shim-authority" });',
      '  const output = { system: [] };',
      '  await hooks["experimental.chat.system.transform"]({ sessionID: "shim-authority" }, output);',
      '  process.stdout.write(JSON.stringify(output));',
      '})().catch(e => { process.stderr.write(String(e)); process.exitCode = 1; });',
    ].join('\n');
    const env = dispatcherEnv({
      BASELINE_AGENT_CONFIG_DIR: hostile,
      CLAUDE_CONFIG_DIR: hostile,
      CODEX_HOME: hostile,
      HOME: hostile,
      USERPROFILE: hostile,
    });
    const direct = spawnSync(process.execPath,
      [path.join(oc, 'hooks', 'baseline-recital.js'), '--agent-config', oc], {
        input: JSON.stringify({ session_id: 'shim-direct', hook_event_name: 'UserPromptSubmit' }),
        env, encoding: 'utf8', cwd: root
      });
    assert.strictEqual(fireBodies(direct), 'shim-requested\n',
      'generated shim dispatcher fixture must be executable: ' + direct.stderr);
    const executed = spawnSync(process.execPath, ['-e', probe, plugin], { env, encoding: 'utf8', cwd: root });
    assert.strictEqual(executed.status, 0, executed.stderr);
    assert.deepStrictEqual(JSON.parse(executed.stdout).system, ['shim-requested\n']);
    assert.ok(fs.existsSync(path.join(oc, '.baseline-counters.json')), 'generated shim writes only requested agent state');
    assert.ok(!fs.existsSync(path.join(hostile, '.baseline-counters.json')), 'hostile inherited directory remains untouched');
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(codexFor(cfg), { recursive: true, force: true });
    fs.rmSync(pi, { recursive: true, force: true });
    fs.rmSync(oc, { recursive: true, force: true });
    fs.rmSync(hostile, { recursive: true, force: true });
  }
}

// --- runner -----------------------------------------------------------------

const TESTS: Array<[string, () => void]> = [
  ['testCentralInstallAndAgentLinks', testCentralInstallAndAgentLinks],
  ['testCodexInstallAndAgentLinks', testCodexInstallAndAgentLinks],
  ['testCodexLifecyclePreservesSpacedPaths', testCodexLifecyclePreservesSpacedPaths],
  ['testCodexResolvesBareNativeExecutableAlias', testCodexResolvesBareNativeExecutableAlias],
  ['testWindowsCodexResolvesBareCwdExecutableBeforePath', testWindowsCodexResolvesBareCwdExecutableBeforePath],
  ['testCodexResolvesBareBatchShimAlias', testCodexResolvesBareBatchShimAlias],
  ['testMissingBareCodexCliLeavesControlSurfaceUninstalled', testMissingBareCodexCliLeavesControlSurfaceUninstalled],
  ['testCodexOwnershipAcceptsCanonicalSymlinkedHome', testCodexOwnershipAcceptsCanonicalSymlinkedHome],
  ['testShellSafeHookCommandsBothAgents', testShellSafeHookCommandsBothAgents],
  ['testVerifyRunsConfiguredCommandThroughShell', testVerifyRunsConfiguredCommandThroughShell],
  ['testUpdateReplacesLegacyWindowsHookCommand', testUpdateReplacesLegacyWindowsHookCommand],
  ['testInstalledHooksResolveBundledContracts', testInstalledHooksResolveBundledContracts],
  ['testCentralEditPropagatesToAgent', testCentralEditPropagatesToAgent],
  ['testIdempotentReinstall', testIdempotentReinstall],
  ['testForceReplacesConfigKeepWithout', testForceReplacesConfigKeepWithout],
  ['testUnknownPresetFails', testUnknownPresetFails],
  ['testNativeRuntimeInstallsAndWires', testNativeRuntimeInstallsAndWires],
  ['testNativeFallbackToNodeWhenBinaryAbsent', testNativeFallbackToNodeWhenBinaryAbsent],
  ['testUpdatePrefersNativeWithoutPreexistingBinary', testUpdatePrefersNativeWithoutPreexistingBinary],
  ['testUpdateRuntimeNodeForcesNode', testUpdateRuntimeNodeForcesNode],
  ['testNativeDispatchParity', testNativeDispatchParity],
  ['testNativeCounterLock', testNativeCounterLock],
  ['testNativeHealthCentralBinaryMissing', testNativeHealthCentralBinaryMissing],
  ['testNativeHealthAgentBinaryMissing', testNativeHealthAgentBinaryMissing],
  ['testDefaultInstallAndVerify', testDefaultInstallAndVerify],
  ['testInstalledManagerKeepsFreshCodexPayloadHealthy', testInstalledManagerKeepsFreshCodexPayloadHealthy],
  ['testCodexCachebusterIgnoresSourceCheckoutProvenance', testCodexCachebusterIgnoresSourceCheckoutProvenance],
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
  ['testContractsPureHelpers', testContractsPureHelpers],
  ['testPerRouteCountersIndependent', testPerRouteCountersIndependent],
  ['testMalformedCounterArrayDoesNotBreakFrequency', testMalformedCounterArrayDoesNotBreakFrequency],
  ['testEventNameSemantics', testEventNameSemantics],
  ['testConcurrentDispatchDeterministicOrder', testConcurrentDispatchDeterministicOrder],
  ['testFailOpenMissingConfig', testFailOpenMissingConfig],
  ['testMalformedConfigInjectsNothing', testMalformedConfigInjectsNothing],
  ['testBadRouteSkippedOthersFire', testBadRouteSkippedOthersFire],
  ['testDocPathTraversalRejected', testDocPathTraversalRejected],
  ['testDocSymlinkEscapeRejected', testDocSymlinkEscapeRejected],
  ['testOversizeDocSkipped', testOversizeDocSkipped],
  ['testDocInjectionCharCapBoundaries', testDocInjectionCharCapBoundaries],
  ['testCombinedDocInjectionCapSkipsMiddleBody', testCombinedDocInjectionCapSkipsMiddleBody],
  ['testExplicitAgentConfigOutranksHostileEnvironment', testExplicitAgentConfigOutranksHostileEnvironment],
  ['testInvalidUtf8AndRedactedDiagnostics', testInvalidUtf8AndRedactedDiagnostics],
  ['testCounterTempAndDestinationSymlinksAreSafe', testCounterTempAndDestinationSymlinksAreSafe],
  ['testGeneratedShimsPinAndSanitizeAgentConfig', testGeneratedShimsPinAndSanitizeAgentConfig],
  ['testDoctorReportsAndFixes', testDoctorReportsAndFixes],
  ['testDoctorDetectsDanglingHookLinks', testDoctorDetectsDanglingHookLinks],
  ['testDoctorDetectsMissingDoc', testDoctorDetectsMissingDoc],
  ['testStatusAndDoctorRepairPerAgentContracts', testStatusAndDoctorRepairPerAgentContracts],
  ['testDoctorFixRefusesInvalidSettings', testDoctorFixRefusesInvalidSettings],
  ['testVerifyRequiresSelectedRouteEvent', testVerifyRequiresSelectedRouteEvent],
  ['testVerifyToolEventFires', testVerifyToolEventFires],
  ['testUpdateRedeploysDispatcher', testUpdateRedeploysDispatcher],
  ['testUninstallKeepsCentralConfig', testUninstallKeepsCentralConfig],
  ['testUninstallCleansHalfDeadInstall', testUninstallCleansHalfDeadInstall],
  ['testUninstallPreservesDivergentPerAgentContracts', testUninstallPreservesDivergentPerAgentContracts],
  ['testControlSurfacePluginsDeployed', testControlSurfacePluginsDeployed],
  ['testUpdateRestoresCodexMarketplacePlugin', testUpdateRestoresCodexMarketplacePlugin],
  ['testDoctorFixRestoresCodexMarketplacePlugin', testDoctorFixRestoresCodexMarketplacePlugin],
  ['testCodexDigestDriftIsDetectedAndRepaired', testCodexDigestDriftIsDetectedAndRepaired],
  ['testUninstallRemovesOnlyManagedCodexMarketplacePlugin', testUninstallRemovesOnlyManagedCodexMarketplacePlugin],
  ['testUninstallKeepsCodexMarketplaceWhenPluginStateUnreadable', testUninstallKeepsCodexMarketplaceWhenPluginStateUnreadable],
  ['testUninstallPreservesForeignCodexMarketplace', testUninstallPreservesForeignCodexMarketplace],
  ['testUninstallKeepsCodexStateWhenListJsonHasWrongShape', testUninstallKeepsCodexStateWhenListJsonHasWrongShape],
  ['testUnavailableCodexCliLeavesControlSurfaceUninstalled', testUnavailableCodexCliLeavesControlSurfaceUninstalled],
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
  // extension-shim agents (pi / oh-my-pi / opencode)
  ['testPiShimInstallUninstall', testPiShimInstallUninstall],
  ['testOmpShimInstall', testOmpShimInstall],
  ['testOpencodeShimInstallUninstall', testOpencodeShimInstallUninstall],
  ['testShimForeignFileRefused', testShimForeignFileRefused],
  ['testShimSkippedWhenNoDeliverableEvents', testShimSkippedWhenNoDeliverableEvents],
  ['testShimStaleRefreshedOnUpdate', testShimStaleRefreshedOnUpdate],
  ['testVerifyThroughShimAgent', testVerifyThroughShimAgent],
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
  } catch (e) {
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
