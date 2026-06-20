# baseline — internals

Read this when changing *mechanism* (how the dispatcher selects routes, counts, or
injects), not when editing docs/routes (that's just `~/.omne/cfg/baseline/`).

## Why hook events

baseline injects via Claude Code hooks. A hook is a process the harness spawns with
a JSON payload on stdin; if it prints
`{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"..."}}` on
exit 0, the harness injects that text wrapped in a `<system-reminder>` — higher-
priority, drift-resistant context, not shown as a chat message. That wrapper is why
a recital works: it lands in the model's attention without the user lifting a finger.

The dispatcher injects on four **supported events**:

| Event | `matcher` meaning | Counter domain |
|---|---|---|
| `UserPromptSubmit` | (ignored) | user prompts |
| `SessionStart` | lifecycle phase: `startup`/`resume`/`clear`/`compact` (exact match against stdin `source`) | session starts of that phase |
| `PreToolUse` | tool-name regex (unanchored, case-sensitive) | matching tool calls |
| `PostToolUse` | tool-name regex | matching tool calls |

`Stop`/`SubagentStop` are excluded (they force a continuation, they cannot inject
standing context); side-effect-only events (`PreCompact`, `Notification`,
`SessionEnd`) are excluded. Tool routes only ever add context; they never deny a tool.

Exit codes: 0 = inject; 2 = block. We always exit 0 and swallow errors — a hook fault
must never block the agent.

## Content vs routing

The system splits *what is injected* from *when/where*:

- **Docs** (`docs/*.md`) hold the exact text, injected **verbatim** — the dispatcher
  adds no wrapper, so any "open with this line, restate verbatim" scaffolding is
  authored inside the doc.
- **`config.json`** holds routing only and carries no injected text.

A **route** is `{ id, event, matcher?, freq?, cwd?, doc }`. It fires only when all
hold: the `event` matches, the `matcher` matches (if set), the `cwd` scope matches
(if set), and the per-route counter hits `freq`.

## stdin payload (fields we rely on)

```json
{
  "session_id": "stable for the whole session",
  "hook_event_name": "UserPromptSubmit | SessionStart | PreToolUse | PostToolUse",
  "cwd": "current working dir",
  "source": "startup|resume|clear|compact  (SessionStart only)",
  "tool_name": "the tool being called      (PreToolUse/PostToolUse only)"
}
```

There is **no context-window / token-percentage field**, which is why `UserPromptSubmit`
cadence is prompt-count, not "fire at 40% context".

## Route selection and counting

On each invocation the dispatcher:

1. reads stdin (≤1 MiB) and parses it; needs `session_id` and a supported `hook_event_name`;
2. loads and validates `cfg/baseline/config.json` (≤64 KiB, ≤64 routes, `version`
   must be 1, ids unique slugs, events supported, docs in-range);
3. selects routes whose `event` matches and whose `matcher`/`cwd` (if present) match;
4. for each selected route, increments its counter `"<session>:<routeId>"` — the
   counter domain is *matching invocations*, so a tool route only counts on a matching tool call;
5. for each route now satisfying `count % freq == 0`, reads its doc (≤64 KiB, resolved
   strictly inside the config folder) and collects the verbatim body;
6. emits one `additionalContext` payload with the due doc bodies concatenated in
   `config.json` `routes[]` order, joined by a blank line, with no headers or
   route-id labels (labels would break verbatim injection) — or exits silently.

Resolved details:
- **Duplicate `id`** → the first occurrence wins; later duplicates are skipped (never double-count).
- **Changing `freq`** keeps the running `count` (takes effect immediately, no reset);
  renaming an `id` starts a fresh counter; a removed `id`'s entries age out.
- **`version`**: missing → assume 1; any value other than 1 → inject nothing (`doctor` fails).
- **`cwd`** is a normalized prefix match on path boundaries (`/foo` must not match
  `/foobar`), case-insensitive on Windows.

Hardening in the counter path:
- **Atomic write** (`tmp` + `rename`); **symlink refusal** (`lstat`) so we never write
  through a planted link; **stale prune** (7 days); read caps (stdin/counters 1 MiB,
  config/each doc 64 KiB). Every failure path is swallowed — worst case nothing is injected.

## Fail-open / fail-closed split

The dispatcher hot path is **fail-open**: a missing/malformed config or doc injects
nothing and never blocks; an individual broken route is skipped in isolation; the
dispatcher carries no hardcoded fallback rule. The manager is **fail-closed** for state
that could destroy data: malformed `settings.json` is never rewritten, real directories
are never removed to plant a link, divergent real files are preserved. `doctor` is the
visibility layer the fail-open dispatcher relies on — it validates the config, every
route, and the per-event wiring, and exits nonzero on any fault.

## Deploy model

`src/baseline-recital.ts` is the canonical source; `npm run build` compiles it to
`scripts/baseline-recital.js` (committed). `manage.js install` copies that compiled
`.js` to the central store `~/.omne/hooks/baseline-recital.js` (always overwrites —
repo wins). The config folder `~/.omne/cfg/baseline/` is seeded from a repo **preset**
(`presets/<name>/`, default `minimal`) and is never clobbered without `--force`. There
is **no legacy `baseline.md` migration** — the system is pre-release; install seeds the
new model fresh and ignores any orphaned `baseline.md`.

The native Zig port is **paused** (ADR-0001): the dispatcher is Node-only for v1, so a
native install would silently ignore routed config. `--runtime prebuilt|build` is
refused until a fast-follow ports the stabilized dispatcher.

## Central store + per-agent links

There is one central install root, `OMNE_HOME` or `~/.omne`. It holds the canonical
deployed dispatcher and the editable config folder. Each agent's config dir (Claude:
`CLAUDE_CONFIG_DIR` or `~/.claude`) gets **links** back into the center:

```
~/.omne/                              ~/.claude/
  hooks/baseline-recital.js   <-------- hooks/baseline-recital.js   (link)
  cfg/baseline/               <-------- cfg/baseline/               (link, as a unit)
                                        settings.json               (REAL, per-agent)
                                        .baseline-counters.json      (REAL, per-agent)
```

The config folder is linked as a **directory** so editing the central `docs/*.md` and
`config.json` is live for every agent. `linkInto()` (for the dispatcher file) tries
`symlink` → `hardlink` → `copy`; the config folder tries directory `symlink` → recursive
`copy`. A copy is intentionally degraded (no propagation) and flagged by `status`/`doctor`.
Because a central `tmp+rename` deploy replaces the dispatcher inode and breaks a hardlink,
install ALWAYS re-creates the per-agent links *after* writing the center, which also makes
it idempotent and update-safe.

**Why `settings.json` and `.baseline-counters.json` stay per-agent and unlinked.**
Settings carry each agent's co-resident hooks and are edited surgically. Counters are
per-agent session state, and the dispatcher *refuses* a symlinked counter file
(planted-link hardening) — so the counter must never be a link. The dispatcher command
in `settings.json` points at the agent's own (linked) hook path, keeping
`CLAUDE_CONFIG_DIR`-relative resolution intact and matching uninstall-by-path.

## settings.json wiring (config-driven)

Wiring spans every supported event group, not just `UserPromptSubmit`. The manager
computes `desiredEvents` = the unique events the config's valid routes use, then for
each supported event: if desired, wires (or refreshes) our one dispatcher command into
that event group; if not, removes our entry and drops the emptied group. So a removed
route's event is **unwired**, and the high-frequency `PreToolUse`/`PostToolUse` hooks
never spawn for nothing. The settings group `matcher` is omitted (`"*"`) — the dispatcher
self-selects routes at runtime. A hook is recognized as "ours" only when its command's
argv refers to that agent's deployed dispatcher path. Co-resident hooks are always
preserved; malformed `settings.json` is a hard stop the manager refuses to rewrite; all
edits reserialize with 2-space indent + trailing newline.
