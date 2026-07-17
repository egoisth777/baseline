#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'contract', 'dispatch-contract.json'), 'utf8'));
const q = JSON.stringify;

function ts() {
  const c = manifest.caps, l = manifest.lockProtocol, w = manifest.wire, p = manifest.layout;
  return `// GENERATED from contract/dispatch-contract.json. DO NOT EDIT.\n` +
`export const SCHEMA_VERSION = ${manifest.schemaVersion};\n` +
`export const SUPPORTED_EVENTS = ${q(manifest.events)} as readonly string[];\n` +
`export const SESSION_PHASES = ${q(manifest.sessionPhases)} as readonly string[];\n` +
`export const ROUTE_KEYS = ${q(manifest.routeKeys)} as readonly string[];\n` +
`export const MAX_CONFIG_BYTES = ${c.configBytes};\nexport const MAX_DOC_BYTES = ${c.docBytes};\n` +
`export const MAX_DOC_CHARS = ${c.docChars};\nexport const MAX_STDIN_BYTES = ${c.stdinBytes};\n` +
`export const MAX_COUNTER_BYTES = ${c.counterBytes};\nexport const MAX_ROUTES = ${c.routes};\n` +
`export const MAX_COMBINED_CONTEXT_CHARS = ${c.combinedContextChars};\nexport const PRUNE_MS = ${manifest.pruneMs};\n` +
`export const MAX_LOCK_WAIT_MS = ${l.maxWaitMs};\nexport const LOCK_RETRY_MS = ${l.retryMs};\nexport const STALE_LOCK_MS = ${l.staleMs};\n` +
`export const OUTPUT_OUTER_FIELD = ${q(w.outerField)};\nexport const OUTPUT_EVENT_FIELD = ${q(w.eventField)};\n` +
`export const OUTPUT_CONTEXT_FIELD = ${q(w.contextField)};\nexport const DOCUMENT_SEPARATOR = ${q(w.documentSeparator)};\n` +
`export const COUNTER_KEY_SEPARATOR = ${q(w.counterKeySeparator)};\nexport const CONFIG_DIR = ${q(p.configDir)};\n` +
`export const CONFIG_FILE = ${q(p.configFile)};\nexport const COUNTER_FILE = ${q(p.counterFile)};\n` +
`export const LOCK_SUFFIX = ${q(p.lockSuffix)};\nexport const DEFAULT_AGENT_DIR = ${q(p.defaultAgentDir)};\n` +
`export const DIAGNOSTICS_ENV = ${q(manifest.diagnosticsEnv)};\n`;
}

function zigArray(values) { return values.map(v => q(v)).join(', '); }
function zig() {
  const c = manifest.caps, l = manifest.lockProtocol, w = manifest.wire, p = manifest.layout;
  return `// GENERATED from contract/dispatch-contract.json. DO NOT EDIT.\n` +
`pub const schema_version: i64 = ${manifest.schemaVersion};\n` +
`pub const supported_events = [_][]const u8{ ${zigArray(manifest.events)} };\n` +
`pub const session_phases = [_][]const u8{ ${zigArray(manifest.sessionPhases)} };\n` +
`pub const route_keys = [_][]const u8{ ${zigArray(manifest.routeKeys)} };\n` +
`pub const max_config_bytes: usize = ${c.configBytes};\npub const max_doc_bytes: usize = ${c.docBytes};\n` +
`pub const max_doc_chars: usize = ${c.docChars};\npub const max_stdin_bytes: usize = ${c.stdinBytes};\n` +
`pub const max_counter_bytes: usize = ${c.counterBytes};\npub const max_routes: usize = ${c.routes};\n` +
`pub const max_combined_context_chars: usize = ${c.combinedContextChars};\npub const prune_ms: i64 = ${manifest.pruneMs};\n` +
`pub const max_lock_wait_ms: i64 = ${l.maxWaitMs};\npub const lock_retry_ms: i64 = ${l.retryMs};\npub const stale_lock_ms: i64 = ${l.staleMs};\n` +
`pub const output_outer_field = ${q(w.outerField)};\npub const output_event_field = ${q(w.eventField)};\n` +
`pub const output_context_field = ${q(w.contextField)};\npub const document_separator = ${q(w.documentSeparator)};\n` +
`pub const counter_key_separator = ${q(w.counterKeySeparator)};\npub const config_dir = ${q(p.configDir)};\n` +
`pub const config_file = ${q(p.configFile)};\npub const counter_file = ${q(p.counterFile)};\n` +
`pub const lock_suffix = ${q(p.lockSuffix)};\npub const default_agent_dir = ${q(p.defaultAgentDir)};\n` +
`pub const diagnostics_env = ${q(manifest.diagnosticsEnv)};\n`;
}

const outputs = new Map([
  [path.join(root, 'src', 'generated-contract.ts'), ts()],
  [path.join(root, 'src', 'native', 'contracts.zig'), zig()],
]);
const check = process.argv.includes('--check');
let drift = false;
for (const [file, body] of outputs) {
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) {
      console.error(`generated contract drift: ${path.relative(root, file)}`);
      drift = true;
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
}
if (drift) process.exitCode = 1;
