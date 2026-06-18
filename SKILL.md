---
name: baseline
description: >-
  Control surface for the baseline-recital drift-correction hook: a Claude Code
  UserPromptSubmit hook that periodically injects trusted baseline rules from
  ~/.omne/baseline.md so the agent recites them before continuing. Use when
  the user asks to view, edit, add, or remove baseline-recital rules; tune the
  recital interval; change the recital prefix; install, verify, check status,
  repair, or uninstall the baseline-recital hook; or manage
  ~/.omne/baseline.md. Trigger on qualified phrases like "baseline-recital",
  "baseline rules", "baseline hook", "baseline drift", "change baseline
  interval", or "make the agent recite X every N turns".
---

# baseline

A drift-correction system. Over a long session the agent forgets standing rules (e.g. "route file read/write/search through subagents, don't do them inline"). This installs a `UserPromptSubmit` hook that, every Nth prompt, injects a **baseline recital** — the agent must open its reply with a fixed prefix line and restate each rule verbatim before continuing. Reciting both *re-aligns* the agent (generating the rule primes the next action) and *exposes* drift (you see in the recital whether it got the rules right).

The baseline is the minimal invariant subset of rules the agent re-aligns to — like the Blade Runner 2049 baseline test.

## Architecture (what lives where)

| Piece | Path | Role |
|---|---|---|
| Hook program (canonical) | `scripts/baseline-recital.js` | Source of truth: count per session, fire on Nth. Default runtime. |
| Native port | `scripts/baseline-recital.zig` | Optional speed path. Must mirror the JS hook. Build with Zig 0.16.x. |
| Central hook | `~/.omne/hooks/baseline-recital.js` or `~/.omne/hooks/baseline-recital[.exe]` | Canonical deployed hook artifact. |
| Agent hook link | `~/.claude/hooks/baseline-recital.js` or `~/.claude/hooks/baseline-recital[.exe]` | Installed command path wired in settings; links to central. |
| Baseline data | `~/.omne/baseline.md` | **Everything tunable**: interval + prefix (frontmatter) + rules (body). Read live via symlink/hardlink; copy fallback needs install/update after edits. |
| Counter state | `~/.claude/.baseline-counters.json` | Per-session turn counts. Auto-pruned. Never edit by hand. |
| Wiring | `~/.claude/settings.json` | `UserPromptSubmit` → agent hook link command. `install`/`uninstall` manage it. |
| Manager | `scripts/manage.js` | install / update / doctor / verify / status / uninstall. Run from repo root. |
| Platform wrappers | `install` / `update` / `doctor` / `uninstall` `.sh` (Linux+macOS) and `.ps1` (Windows) | Per-command entry points. |
| Builder | `build.sh` / `build.ps1` | Compile Zig binary from source (optional). |

**Key split:** rules/interval/prefix are *data* in `baseline.md` (edit anytime, takes effect next prompt). The hook program is *mechanism* (only changes when you alter how counting or injection works → must redeploy via `install`).

For internals (frontmatter parser, counting, hardening) read `references/architecture.md`.

## Requirements and Runtimes

Requires Claude Code and Node.js. Node runs the manager and is also the default hook runtime. Zig is optional and only needed for native builds.

The baseline hook can run as:
1. **Node JS** (default) — canonical, portable, no native trust step.
2. **Prebuilt binary** (explicit `--runtime prebuilt`) — Windows x64 and Linux x64 only; SHA256 checked against `bin/SHA256SUMS` before install.
3. **Compile from source** (explicit `--build` / `--runtime build`) — requires Zig 0.16.x.

macOS has no shipped prebuilt; use the default JS runtime unless you are deliberately testing a local native build.

## Trust Boundary

`~/.omne/baseline.md` is injected as higher-priority reminder context every N prompts through the agent's linked `baseline.md`. Treat it as trusted configuration: inspect edits, keep rules short, and do not copy untrusted text into it. The hook caps file size, rule count, and rule length, but content still steers future agent behavior. If `status` reports a plain-copy fallback, rerun install/update after editing the central file.

## The two most common tasks

### Edit the baseline (rules / interval / prefix) — no reinstall

This is the everyday case and it is just editing one file: `~/.omne/baseline.md`.

```
---
interval: 5                       # fire every 5th prompt
prefix: LI BASELINE ALIGNED:      # the line the agent must open with
---
# comments and blank lines ignored; one rule per line below
File read/write/search -> subagent (cavecrew-investigator/builder, Explore), not inline. Save main ctx.
```

- **Add a rule:** append a line. Keep it short — it's injected into context every fire, so caveman-compress it (drop articles/filler).
- **Change interval:** edit `interval:`. Lower = tighter leash, more tokens.
- **Change prefix:** edit `prefix:`. This is the literal line the agent recites under.
- Changes apply on the **next prompt** when `status` reports a symlink or hardlink. If it reports a copy fallback, rerun install/update.

After editing, you can confirm what's live with `status` (below).

### Manage the hook itself

Run the manager from the repo root:

```bash
node scripts/manage.js status      # what's installed, in-sync?, current rules
node scripts/manage.js install     # deploy central hook/baseline + link agent + wire settings
node scripts/manage.js verify      # functional: confirm it fires on turn N
node scripts/manage.js update      # redeploy hook + settings from repo (keeps wired runtime)
node scripts/manage.js doctor      # scan installation health; --fix to repair
node scripts/manage.js uninstall   # unwire settings + remove agent links (keeps central baseline.md)
```

Or use the platform installer scripts:
```bash
./install.sh       # Unix (sh/bash/zsh)
.\install.ps1      # Windows (PowerShell)
```

The commands are idempotent and preserve any co-resident `UserPromptSubmit` hook (e.g. caveman) — settings edits are surgical.

## Workflow guidance for the agent using this skill

1. **Identify the intent.** Editing rules/interval/prefix → it's a `baseline.md` edit, nothing more. Installing/repairing/removing → it's a `manage.js` run.
2. **For data edits:** read `~/.omne/baseline.md`, make the change, keep rules caveman-short, preserve the frontmatter fences. Then run `node scripts/manage.js status` (from repo root) to show the user the live result.
3. **For mechanism changes** (how counting/injection works): edit `scripts/baseline-recital.js` first. If native support must stay current, mirror the change in `scripts/baseline-recital.zig`, run `build.sh` / `build.ps1` to regenerate binaries and `bin/SHA256SUMS`, then install the intended runtime (`node scripts/manage.js install` for JS, `--runtime build` or `--runtime prebuilt` for native).
4. **Always end with `node scripts/test.js` plus `status` or `verify`** so the user sees ground truth, not a claim. After any settings change, remind them: open `/hooks` once or restart so Claude Code reloads settings (the running session won't pick it up otherwise).

## Evolving the system

This skill is meant to grow. Likely future directions, and where they'd live:

- **More rules / rule sets:** just `baseline.md` body. If you ever want *named* rule sets (e.g. a "perforce" set vs a "subagent" set), that's a mechanism change: extend the JS parser first, mirror Zig if native support matters, then redeploy.
- **Different cadence logic** (e.g. fire on token-count instead of turn-count): mechanism. Note the harness gives the hook `session_id`, `transcript_path`, `cwd`, `prompt` on stdin; there is no context-percentage field, so turn-count is the reliable trigger.
- **Per-project baselines:** mechanism: have the hook read a project-local `baseline.md` (via `cwd` from stdin) and merge with the global one.

When you change mechanism, keep `scripts/baseline-recital.js` as the source of truth and redeploy with `install`; never hand-edit the deployed copy in `~/.omne/hooks/`.
