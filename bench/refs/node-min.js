#!/usr/bin/env node
'use strict';
// Minimal plain-Node reference hook for the benchmark: the SAME injection task the
// baseline dispatcher does, stripped to essentials — read config, match the event, read
// the doc, print additionalContext. No counters, no lock, no caps. Reads the config path
// from BENCH_CONFIG and the event from stdin.
const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const configPath = process.env.BENCH_CONFIG;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const cfgDir = path.dirname(configPath);
    const route = (cfg.routes || []).find((r) => r && r.event === data.hook_event_name);
    if (!route) return;
    const body = fs.readFileSync(path.join(cfgDir, route.doc), 'utf8');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: data.hook_event_name, additionalContext: body }
    }));
  } catch (e) {
    // Fail-open like the real dispatcher: emit nothing.
  }
});
