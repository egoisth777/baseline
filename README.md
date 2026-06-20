# baseline

<p align="center">
  <img src="resources/logo.png" alt="BASELINE stencil ruler logo" width="720">
</p>

<p align="center">
  <a href="resources/logo.ans">ANSI logo</a> |
  <a href="resources/logo.txt">plain text logo</a>
</p>

A drift-correction system for [Claude Code](https://claude.com/claude-code). Over a long session the agent forgets standing rules (e.g. "route file operations through subagents, don't do them inline"). baseline periodically injects small, trusted text into the model's context at chosen hook events — most often a **recital**: every Nth user prompt the agent must open its reply with a fixed prefix line and restate the rules verbatim before continuing. Reciting both re-aligns the agent (generating the rule primes the next action) and exposes drift (you see in the recital whether it got the rules right).

Inspired by the Blade Runner 2049 baseline test.

## What it is

baseline generalizes "recite the rules every N prompts" into **user-configurable injection routes**. A route binds a trusted **doc** (the verbatim text to inject) to a hook **event**, on its own **frequency**, optionally scoped to a session phase, a tool, or a working directory. You can run the classic recital every 5 prompts, drop compact-resume instructions on session resume, or remind the agent before certain tool calls — each independently.

Two things are kept strictly separate:

- **Docs** (`docs/*.md`) hold *what* is injected — the exact text, verbatim. No wrapper is added by code, so any "open with this line, restate verbatim" scaffolding lives inside the doc.
- **`config.json`** holds *when/where* — routing only: which doc fires at which event, how often, and under what scope. It carries no injected text.

This package targets Claude Code. The engine is shaped so adapters for other harnesses could be added later, but none ship today.

## How it works

One small **dispatcher** runs on each wired hook event. It reads the event JSON the harness passes on stdin, loads `cfg/baseline/config.json`, selects the routes matching the `(event, matcher, cwd)`, bumps each route's own per-session counter, and on a route's Nth match prints a JSON object whose `additionalContext` field Claude Code injects into the model's context as a system reminder. The dispatcher carries **zero baked content**: if the config or docs are gone it injects nothing and exits clean, and `doctor` reports the fault.

Supported injecting events: `UserPromptSubmit`, `SessionStart` (lifecycle phase matcher), `PreToolUse` / `PostToolUse` (tool-name regex matcher).

## Requirements

- **Claude Code** — the CLI agent harness
- **Node.js** — runs the installer/manager and the dispatcher

**Platforms:** the dispatcher is Node-only and works anywhere Claude Code and Node.js work. A native Zig port is paused for this feature and will be a fast-follow.

## Install

Run the installer for your platform:

**Windows (PowerShell):**
```powershell
.\install.ps1
```

**Linux / macOS (bash):**
```bash
bash install.sh
```

Both delegate to `node scripts/manage.js install`, which:
1. Deploys the canonical dispatcher to a **central store**, `~/.omne/hooks/baseline-recital.js`.
2. Seeds the editable **config folder** `~/.omne/cfg/baseline/` (`config.json` + `docs/`) from a repo **preset** — `minimal` by default (`--preset default` for the author's curated baseline).
3. **Links** each agent's config dir back into the center — `~/.claude/hooks/baseline-recital.js` → central dispatcher, and `~/.claude/cfg/baseline/` → central config folder.
4. Wires `~/.claude/settings.json` for **exactly** the events the config's routes use, and unwires events no route references.

When `status` reports a symlink, editing the central `~/.omne/cfg/baseline/*` changes live behavior for every wired agent at once. On Windows without symlink privilege the link layer degrades to a hardlink (dispatcher) or a plain copy (config folder); `status`/`doctor` report which mechanism is in effect, and a copy needs a reinstall/update after central edits.

The central root is `~/.omne` by default; override it with `OMNE_HOME`. After install, open `/hooks` in Claude Code once (or restart) so settings reload.

## The config folder (the everyday task)

Everything you tune lives under `~/.omne/cfg/baseline/`:

```text
~/.omne/cfg/baseline/
  config.json     # routes: when/where/how-often/which doc
  docs/           # the verbatim text each route injects
    baseline.md
  README.md       # editing guidance (never injected — no route points at it)
```

Edit a **doc** to change what is injected (takes effect on the next firing — no reinstall). Edit **`config.json`** to add a route, change a route's `event`/`matcher`/`freq`/`cwd`, or point it at a different doc. After changing the *set of events* your routes use, rerun `install`/`update` so settings wiring stays in sync.

A route is one entry in `config.json` `routes[]`:

```json
{
  "version": 1,
  "routes": [
    { "id": "baseline", "event": "UserPromptSubmit", "freq": 5, "doc": "docs/baseline.md" }
  ]
}
```

- `id` — required, unique, slug-shaped (`^[a-z0-9][a-z0-9-]*$`). Keys the route's counter.
- `event` — required, one of `UserPromptSubmit`, `SessionStart`, `PreToolUse`, `PostToolUse`.
- `doc` — required, path relative to the config folder; must stay inside it.
- `freq` — optional positive integer, default `1`. Fires when `count % freq == 0`.
- `matcher` — optional. `SessionStart`: lifecycle phase (`startup`/`resume`/`clear`/`compact`). `PreToolUse`/`PostToolUse`: a tool-name regex. Ignored for `UserPromptSubmit`.
- `cwd` — optional path prefix. Fires only when the session working directory is at or under it.

To add a new injection, copy a pair from `assets/route-templates/` (a doc + its matching route) or ask the plugin to author one. See `~/.omne/cfg/baseline/README.md` for the runtime caps.

### Presets

`install` deploys exactly one preset into the config folder if none exists:

- `presets/minimal/` — the neutral floor: one `baseline` / `UserPromptSubmit` / `freq 5` route with project-agnostic guardrails. Applied by a plain `install`.
- `presets/default/` — the author's personal curated baseline (multi-route). Opt-in: `install --preset default`.

`install` never overwrites an existing config folder without `--force` (which replaces it wholesale — your edits are lost).

## Managing baseline

| Command | Description |
|---------|-------------|
| `status` | Shows the central root, dispatcher sync, config folder, every route, and per-agent per-event wiring + link health. |
| `install [--preset <n>] [--force]` | Deploys the dispatcher, seeds the config preset, links each agent, wires settings for the config's events. Idempotent. |
| `verify` | Functional test: drives the wired dispatcher and confirms a route fires with `additionalContext`. |
| `update` | Redeploys the dispatcher and re-syncs settings wiring from the current config (keeps the config folder). |
| `doctor` | Validates `config.json` + every route + per-event wiring; reports OK/WARN/FAIL and exits nonzero on any fault. `--fix` repairs and re-scans. |
| `uninstall` | Unwires baseline across all events and removes per-agent links. Preserves the central config folder. |

```bash
node scripts/manage.js status
node scripts/manage.js install            # --preset default to seed the curated baseline
node scripts/manage.js verify
node scripts/manage.js update
node scripts/manage.js doctor             # add --fix to repair
node scripts/manage.js uninstall
```

Or via the platform wrappers:
```bash
bash update.sh        # pulls latest if a git checkout, then redeploys
bash doctor.sh --fix  # scan + repair
bash uninstall.sh
```
```powershell
.\update.ps1
.\doctor.ps1 -fix
.\uninstall.ps1
```

All commands are idempotent and preserve any co-resident hooks (e.g. other skills). Settings edits are surgical. `install`/`uninstall` refuse to rewrite malformed `settings.json`; fix the JSON first so existing hooks are not lost.

## Repository layout

```
baseline/
├── install.sh / install.ps1     # Installer (bash / PowerShell)
├── update.sh / update.ps1       # Pull latest + redeploy (bash / PowerShell)
├── doctor.sh / doctor.ps1       # Scan + repair installation; --fix / -fix
├── uninstall.sh / uninstall.ps1 # Remove wiring + links, keep central config
├── build.sh / build.ps1         # Cross-compile native prebuilts (paused for routes)
├── package.json                 # TypeScript devDeps + build/test scripts
├── tsconfig.json                # tsc: src/*.ts → scripts/*.js
├── src/                         # TypeScript source of truth (edit here, then npm run build)
│   ├── manage.ts                # Manager source
│   ├── baseline-recital.ts      # Dispatcher source (canonical)
│   ├── baseline-recital.zig     # Optional native port (paused; mirrors JS behavior)
│   └── test.ts                  # Test source
├── scripts/                     # Committed compiled output deployed by the manager
│   ├── manage.js
│   ├── baseline-recital.js
│   └── test.js
├── presets/
│   ├── minimal/                 # Neutral floor preset (config.json + docs + README)
│   └── default/                 # Author's curated preset (opt-in)
├── assets/route-templates/      # Doc+route authoring references (never deployed/injected)
├── bin/
│   ├── baseline-recital-windows-x64.exe
│   ├── baseline-recital-linux-x64
│   └── SHA256SUMS
├── resources/
│   ├── logo.png                 # Repository image / preview source
│   ├── logo.svg                 # Scalable logo source
│   ├── logo.txt                 # Plain text ASM logo
│   └── logo.ans                 # ANSI ASM logo
├── references/architecture.md   # Internals: routing, counting, injection, hardening
├── SKILL.md                     # Skill manifest for Claude Code
└── README.md                    # This file
```

## Trust boundary

Doc bytes enter the model's context, so treat every `docs/*.md` as trusted configuration: inspect edits, keep docs short, never paste untrusted text. The dispatcher caps `config.json` and each doc at 64 KiB and routes at 64, resolves each `doc` strictly inside the config folder (no `..` escapes), and always exits 0 — a hook fault never blocks the agent. Counters are auto-pruned after 7 days of inactivity.

## Develop

The dispatcher and manager are TypeScript under `src/`, compiled to the committed `scripts/*.js` (what installs and the deployed dispatcher actually run — no build step needed just to install). After editing anything in `src/`, rebuild and commit the regenerated `scripts/*.js`:

```bash
npm install      # one-time: TypeScript + @types/node
npm run build    # tsc: src/*.ts → scripts/*.js
```

## Test

```bash
npm test         # runs tsc, then node scripts/test.js
```

The tests use temporary `CLAUDE_CONFIG_DIR` / `OMNE_HOME` directories and do not touch your real config.

## License

MIT
