# baseline — internals

Read this when changing *mechanism* (how the hook counts or injects), not when
editing rules (that's just `~/.omne/baseline.md`).

## Why a UserPromptSubmit hook

`UserPromptSubmit` fires on every user prompt, before the model runs. A hook is
a process the harness spawns; it gets a JSON payload on stdin and may print
output. If it prints `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
"additionalContext":"..."}}` on exit 0, the harness injects that text wrapped in
a `<system-reminder>` — higher-priority, drift-resistant context, not shown as a
chat message. That wrapper is exactly why a recital works: it lands in the
model's attention every Nth turn without the user lifting a finger.

Trust boundary: anything written to `~/.omne/baseline.md` becomes future
higher-priority reminder context. Treat that file as trusted configuration, not
scratch text. Keep rules short and review edits before relying on them.

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
- **Read caps** so prompt stdin and counters are capped at 1 MiB, `baseline.md`
  at 64 KiB, and injected rules at 50 lines of 500 characters each.
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
copies it to the **central store** `~/.omne/hooks/baseline-recital.js` (always
overwrites — skill wins) and wires the JS runtime by default. The Zig file is an
optional native port and must mirror the JS behavior. Prebuilt native installs
are explicit and verified against `bin/SHA256SUMS`; source builds require Zig
0.16.x and refresh the checksum manifest. `status` reports JS byte sync and
native checksum status separately, so a stale native binary is not presented as
source-synced. `baseline.md` is seeded from `assets/baseline.template.md` only if
no rules exist anywhere — edited rules are never clobbered.

## Central store + per-agent links

There is one central install root, `OMNE_HOME` or `~/.omne`. It holds the
canonical deployed hook (`hooks/baseline-recital.js` + optional native exe) and
the single editable `baseline.md`. Each agent's config dir (Claude:
`CLAUDE_CONFIG_DIR` or `~/.claude`) gets **links** back into the center when the
platform allows it:

```
~/.omne/                              ~/.claude/
  hooks/baseline-recital.js   <-------- hooks/baseline-recital.js   (link)
  baseline.md                 <-------- baseline.md                 (link)
                                        settings.json               (REAL, per-agent)
                                        .baseline-counters.json      (REAL, per-agent)
```

With a symlink or hardlink, editing `~/.omne/baseline.md` once changes the live
rules for every wired agent. A plain-copy fallback is intentionally degraded and
requires reinstall/update after central edits.

**Link fallback ladder.** `linkInto()` tries `symlink` → `hardlink` → `copy` and
reports which won. POSIX uses symlinks; Windows without Developer Mode /
privilege falls back to a same-volume hardlink (still one inode, so edits
propagate), and only a cross-volume install degrades to a `copy` (no
propagation, flagged by `status`/`doctor`). Because a central `tmp+rename`
deploy replaces the inode and breaks an existing hardlink, install ALWAYS
re-creates the per-agent links *after* writing the center — which also makes both
mechanisms idempotent and update-safe.

**Why `settings.json` and `.baseline-counters.json` stay per-agent and unlinked.**
Settings carry each agent's co-resident `UserPromptSubmit` hooks and are edited
surgically. Counters are per-agent session state, and the hook deliberately
*refuses* a symlinked counter file (planted-link hardening) — so the counter must
never be a link. The hook command in `settings.json` points at the agent's own
(linked) hook path, keeping `CLAUDE_CONFIG_DIR`-relative resolution intact and
matching uninstall-by-path.

**Migration.** An existing single-agent install has a real agent-local
`baseline.md`. On the first central install that real file is *moved* into
`~/.omne/baseline.md` (never overwritten), then replaced in place by a link, so
operator edits survive.
A divergent real file in any other agent dir is backed up to `baseline.md.bak`
before being relinked.

## settings.json wiring

`install` appends our command into the first existing `UserPromptSubmit` hook
group (sharing it with any co-resident hook such as caveman), or creates a group
if none exists. It's idempotent: if our deployed hook path is already present it
refreshes the command string (e.g. if the node path changed). `uninstall`
filters only entries pointing at this package's deployed JS or native hook paths
and drops emptied groups. Malformed `settings.json` is a hard error; the manager
refuses to rewrite it rather than replacing co-resident hooks. All edits
reserialize with 2-space indent + trailing newline to stay diff-clean.
