# baseline — internals

Read this when changing *mechanism* (how the hook counts or injects), not when
editing rules (that's just `~/.claude/baseline.md`).

## Why a UserPromptSubmit hook

`UserPromptSubmit` fires on every user prompt, before the model runs. A hook is
a process the harness spawns; it gets a JSON payload on stdin and may print
output. If it prints `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
"additionalContext":"..."}}` on exit 0, the harness injects that text wrapped in
a `<system-reminder>` — higher-priority, drift-resistant context, not shown as a
chat message. That wrapper is exactly why a recital works: it lands in the
model's attention every Nth turn without the user lifting a finger.

Plain stdout (non-JSON) is also injected, but as visible transcript text rather
than a system reminder. We use the JSON form on purpose.

Exit codes: 0 = inject stdout/JSON; 2 = block the prompt (stderr fed back); other
nonzero = non-blocking error. We always exit 0 and swallow errors — a hook fault
must never block the user from submitting a prompt.

## stdin payload (fields we rely on)

```json
{
  "session_id": "stable for the whole session",
  "transcript_path": "~/.claude/projects/<proj>/<session>.jsonl",
  "cwd": "current working dir",
  "prompt": "the text the user submitted",
  "hook_event_name": "UserPromptSubmit"
}
```

`UserPromptSubmit` has **no matchers** — it fires on every prompt; filtering is
the hook's job. There is **no context-window / token-percentage field** on
stdin, which is why cadence is turn-count, not "fire at 40% context".

## Counting: why session_id, not transcript lines

The transcript JSONL interleaves user prompts, assistant messages, tool calls,
and tool results. Counting its lines would fire at effectively random intervals.
Instead we keep `~/.claude/.baseline-counters.json` = `{ session_id: {count, ts} }`,
increment on each fire, and trigger when `count % interval === 0`. `session_id`
is stable across the whole session, so the count is exactly "how many prompts in
this session."

Hardening / robustness in the counter path:
- **Atomic write** (`tmp` + `rename`) so a crash can't leave a half-written file.
- **Symlink refusal** (`lstat` check) so we never write through a planted link.
- **Stale prune** (`PRUNE_MS`, 7 days) so the map can't grow unbounded across
  many sessions.
- Every failure path is swallowed — worst case the hook injects nothing.

## baseline.md format

Optional frontmatter between `---` fences provides `interval` (positive int) and
`prefix` (string; quotes optional, may itself contain `:` — we split on the
first colon). The body is rules: one per line, `#`-comments and blanks ignored.
Missing file / missing keys / empty body all fall back to the `DEFAULT_*` /
`FALLBACK_RULES` constants in the `.js`, so a formatting slip degrades gracefully
rather than silencing the system.

The parser is deliberately hand-rolled (no YAML dependency) because we only need
two scalar keys and the hook must stay dependency-free and fast.

## Deploy model

`scripts/baseline-recital.js` in the skill is canonical. `manage.js install`
copies it to `~/.claude/hooks/baseline-recital.js` (always overwrites — skill
wins) and wires settings. `status` reports whether the deployed copy is byte-for-
byte in sync with the canonical source, so you can tell if a redeploy is due.
`baseline.md` is seeded from `assets/baseline.template.md` only if absent — edited
rules are never clobbered.

## settings.json wiring

`install` appends our command into the first existing `UserPromptSubmit` hook
group (sharing it with any co-resident hook such as caveman), or creates a group
if none exists. It's idempotent: if our command is already present it just
refreshes the command string (e.g. if the node path changed). `uninstall`
filters our entry out and drops emptied groups. All edits reserialize with
2-space indent + trailing newline to stay diff-clean.
