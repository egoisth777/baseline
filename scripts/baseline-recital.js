#!/usr/bin/env node
// baseline — baseline-recital UserPromptSubmit hook (canonical source).
//
// Problem it solves: across a long session the agent drifts from standing rules
// in CLAUDE.md (notably: route file read/write/search through subagents instead
// of doing them inline). Every Nth user prompt this hook injects a "baseline" —
// a Blade-Runner-style forced recital. The agent must open its reply with the
// recital prefix and restate each rule verbatim before proceeding, so drift
// becomes visible (in the recited text) and self-corrects (generating the rule
// primes the next action).
//
// Nothing operator-tunable is hardcoded here. The interval, the recital prefix,
// and the rules themselves all live in ~/.claude/baseline.md — frontmatter for
// interval/prefix, body lines for rules — and are read at runtime. Editing the
// baseline never requires touching this file. The DEFAULT_* / FALLBACK_* values
// below apply only when baseline.md is missing, unreadable, or omits a key.
//
// Counting is keyed by session_id from the hook stdin payload — NOT transcript
// line count, which mixes user prompts, assistant messages, tool calls and tool
// results and would fire at random intervals.
//
// This file is deployed to ~/.claude/hooks/baseline-recital.js by manage.js.
// Edit the copy in the skill, then re-run `node scripts/manage.js install`.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Defaults — used only when baseline.md doesn't specify.
const DEFAULT_N = 5;                              // fire every Nth prompt
const DEFAULT_PREFIX = 'LI BASELINE ALIGNED:';    // forced opening line
const FALLBACK_RULES = [
  'File read/write/search -> subagent (cavecrew-investigator/builder, Explore), not inline. Save main ctx.'
];
// Drop counter entries untouched for longer than this (stale sessions).
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_BASELINE_BYTES = 64 * 1024;
const MAX_COUNTER_BYTES = 1024 * 1024;
const MAX_RULES = 50;
const MAX_RULE_CHARS = 500;

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const counterPath = path.join(claudeDir, '.baseline-counters.json');
const baselinePath = path.join(claudeDir, 'baseline.md');

// Parse baseline.md into { interval, prefix, rules }. Tolerant of a missing
// file, missing frontmatter, or missing keys — every field has a default, so
// the hook never goes dark over a formatting slip.
function loadBaseline() {
  let raw;
  try {
    const st = fs.statSync(baselinePath);
    if (st.size > MAX_BASELINE_BYTES) throw new Error('baseline.md too large');
    raw = fs.readFileSync(baselinePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_BASELINE_BYTES) throw new Error('baseline.md too large');
  } catch (e) {
    return { interval: DEFAULT_N, prefix: DEFAULT_PREFIX, rules: FALLBACK_RULES };
  }

  let interval = DEFAULT_N;
  let prefix = DEFAULT_PREFIX;
  let body = raw;

  // Optional YAML-ish frontmatter: a leading --- ... --- block. We only need
  // two scalar keys, so we parse line-by-line rather than pull in a YAML lib.
  const fm = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();   // slice on FIRST colon — prefix may contain ':'
      if (key === 'interval') {
        const n = parseInt(val, 10);
        if (Number.isFinite(n) && n > 0) interval = n;
      } else if (key === 'prefix') {
        // Strip optional surrounding quotes.
        prefix = val.replace(/^["']|["']$/g, '') || DEFAULT_PREFIX;
      }
    }
  }

  const rules = body
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .slice(0, MAX_RULES)
    .map(l => l.length > MAX_RULE_CHARS ? l.slice(0, MAX_RULE_CHARS) : l);

  return {
    interval,
    prefix,
    rules: rules.length ? rules : FALLBACK_RULES
  };
}

// Refuse to follow a symlink at the counter path (basic hardening — never write
// through a link an attacker may have planted in place of our state file).
function readCounters() {
  try {
    const st = fs.lstatSync(counterPath);
    if (st.isSymbolicLink()) return {};
    if (st.size > MAX_COUNTER_BYTES) return {};
    const obj = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeCounters(counters) {
  try {
    const st = fs.lstatSync(counterPath);
    if (st.isSymbolicLink()) return;
  } catch (e) {
    // ENOENT — fine, file will be created.
  }
  try {
    const tmp = counterPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(counters), 'utf8');
    fs.renameSync(tmp, counterPath); // atomic replace
  } catch (e) {
    // Best-effort; never break prompt submission over counter I/O.
  }
}

let input = '';
let inputBytes = 0;
let inputTooLarge = false;
process.stdin.on('data', chunk => {
  inputBytes += chunk.length;
  if (inputBytes > MAX_STDIN_BYTES) {
    inputTooLarge = true;
    input = '';
    return;
  }
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    if (inputTooLarge) return;
    const data = JSON.parse(input);
    const sessionId = data.session_id;
    if (!sessionId) return; // No stable key → nothing to count.

    const { interval, prefix, rules } = loadBaseline();

    const now = Date.now();
    const counters = readCounters();

    // Prune stale sessions so the map can't grow without bound.
    for (const key of Object.keys(counters)) {
      const entry = counters[key];
      if (!entry || typeof entry.ts !== 'number' || (now - entry.ts) > PRUNE_MS) {
        delete counters[key];
      }
    }

    const prev = counters[sessionId] && typeof counters[sessionId].count === 'number'
      ? counters[sessionId].count
      : 0;
    const count = prev + 1;
    counters[sessionId] = { count: count, ts: now };
    writeCounters(counters);

    // Fire on every Nth prompt (interval, 2*interval, ...). When interval > 1,
    // turn 1 never fires; when interval is 1, every turn fires.
    if (count % interval !== 0) return;

    const recited = rules.map(r => '- ' + r).join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          'BASELINE (turn ' + count + '). Open reply with line:\n' +
          '"' + prefix + '"\n' +
          'then recite each rule verbatim, then comply this turn:\n' +
          recited + '\n' +
          'Drifted (did inline)? Say so + correct now.'
      }
    }));
  } catch (e) {
    // Silent fail — a hook error must never block prompt submission.
  }
});
