#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-native-test-'));
const binary = path.join(temp, process.platform === 'win32' ? 'baseline-recital.exe' : 'baseline-recital');

function run(command, args, env) {
  return spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: 'inherit' });
}

let status = 1;
try {
  const built = run('zig', [
    'build-exe', '-O', 'ReleaseSmall', '-femit-bin=' + binary, 'src/baseline-recital.zig'
  ], process.env);
  if (built.error || built.status !== 0 || !fs.existsSync(binary)) {
    process.stderr.write('fresh native test build failed\n');
    status = built.status == null ? 1 : built.status;
  } else {
    const env = Object.assign({}, process.env, { BASELINE_TEST_NATIVE_BIN: binary });
    const tested = run(process.execPath, ['scripts/test.js'], env);
    status = tested.status == null ? 1 : tested.status;
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.exit(status);
