# baseline

<p align="center">
  <img src="resources/logo.png" alt="BASELINE stencil ruler logo" width="720">
</p>

<p align="center">
  <a href="resources/logo.ans">ANSI logo</a> |
  <a href="resources/logo.txt">plain text logo</a>
</p>

A drift-correction system for Claude Code and Codex. Over a long session the agent forgets standing rules (e.g. "route file operations through subagents, don't do them inline"). baseline periodically injects small, trusted text into the model's context at chosen hook events — most often a **recital**: every Nth user prompt the agent must open its reply with a fixed prefix line and restate the rules verbatim before continuing. Reciting both re-aligns the agent (generating the rule primes the next action) and exposes drift (you see in the recital whether it got the rules right).

Inspired by the Blade Runner 2049 baseline test.

## What it is

baseline generalizes "recite the rules every N prompts" into **user-configurable injection routes**. A route binds a trusted **doc** (the verbatim text to inject) to a hook **event**, on its own **frequency**, optionally scoped to a session phase, a tool, or a working directory. You can run the classic recital every 5 prompts, drop compact-resume instructions on session resume, or remind the agent before certain tool calls — each independently.

Two things are kept strictly separate:

- **Docs** (`docs/*.md`) hold *what* is injected — the exact text, verbatim. No wrapper is added by code, so any "open with this line, restate verbatim" scaffolding lives inside the doc.
- **`config.json`** holds *when/where* — routing only: which doc fires at which event, how often, and under what scope. It carries no injected text.

This package targets Claude Code and Codex. Both use the same Node dispatcher and route config; install links the installed dispatcher and config folder into each agent's config directory and wires the hook event config each agent reads.

Canonical goal docs live under `.arca/baseline-sp/goal/`: `vision.md`, `architecture.md`, and `vocabulary.md`, with `plain.md` recording the current decision summary. They define stable external contracts as the CLI lifecycle, config schema, hook stdin/stdout protocol, and plugin manifests. Static docs are the current default; dynamic placeholder replacement is future opt-in.

## How it works

One small **dispatcher** runs on each wired hook event. It reads the event JSON the harness passes on stdin, loads `cfg/baseline/config.json`, selects the routes matching the `(event, cwd)`, bumps each route's own per-session counter, and on a route's Nth match prints a JSON object whose `additionalContext` field the agent injects into the model's context as a system reminder. The dispatcher carries **zero baked content**: if the config or docs are gone it injects nothing and exits clean, and `doctor` reports the fault.

Supported injecting events: `UserPromptSubmit`, `SessionStart` (optionally a lifecycle phase via the event form `SessionStart.<phase>`, e.g. `SessionStart.compact`), `PreToolUse` / `PostToolUse`.

## Requirements

- **Claude Code or Codex** — the agent harness
- **Node.js** — runs the installer/manager and the dispatcher

**Platforms:** the wired v1 dispatcher is Node-only and works anywhere the target agent and Node.js work. A verified Zig native artifact exists but is paused/not wired; Rust is the future native CLI/dispatcher target.

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
1. Deploys the canonical dispatcher and shared runtime contracts to the **install root** (`BASELINE_HOME`, else `~/.baseline`), at `~/.baseline/hooks/baseline-recital.js` and `~/.baseline/hooks/contracts.js`.
2. Establishes the **config folder** — your routes + docs (`config.json` + `docs/`). It lives wherever you point `BASELINE_CFG` (else `~/.baseline/cfg`); when `BASELINE_CFG` is set, `~/.baseline/cfg` is a symlink to it. If empty, it is seeded from a repo **preset** — `default` by plain install (`--preset minimal` for the neutral floor).
3. **Links** each agent's config dir back into the install root — for example `~/.claude/hooks/baseline-recital.js` + `~/.claude/hooks/contracts.js` and `~/.codex/hooks/baseline-recital.js` + `~/.codex/hooks/contracts.js` → the install-root hook artifacts, with each agent's `cfg/baseline/` → `~/.baseline/cfg` (your config folder).
4. Deploys the installed control-surface payload. Claude gets the skills-dir plugin as `baseline@skills-dir`; Codex gets the plugin cache at `$CODEX_HOME/plugins/cache/baseline/baseline/local` plus `[plugins."baseline@baseline"]` in `$CODEX_HOME/config.toml`. Control-surface plugins carry **no hooks** — they only make baseline discoverable, not active.
5. Wires Claude Code `~/.claude/settings.json` and Codex `~/.codex/hooks.json` for **exactly** the events the config's routes use, and unwires events no route references.

When `status` reports a symlink, editing your config folder (`BASELINE_CFG`, else `~/.baseline/cfg`) changes live behavior for every wired agent at once. On Windows without symlink privilege the link layer degrades to a hardlink (dispatcher/contracts) or a plain copy (config folder and skill/plugin payloads); `status`/`doctor` report which mechanism is in effect, and a copy needs a reinstall/update after edits.

The **install root** (regenerable artifacts: dispatcher + skill payload) is `~/.baseline` by default; override it with `BASELINE_HOME`. The **config folder** (your routes + docs) defaults to `~/.baseline/cfg`, or set `BASELINE_CFG` to keep it anywhere — e.g. a version-controlled dotfiles repo — in which case `~/.baseline/cfg` becomes a symlink to it. Config and artifacts never share a directory. Claude's config dir comes from `CLAUDE_CONFIG_DIR` or `~/.claude`; Codex's comes from `CODEX_HOME` or `~/.codex`. After install, open `/hooks` in each agent once (or restart) so hook config reloads.

## The config folder (the everyday task)

Everything you tune lives in your config folder — `BASELINE_CFG` if set, else `~/.baseline/cfg`:

```text
<config folder>/   # BASELINE_CFG, else ~/.baseline/cfg
  config.json     # routes: when/where/how-often/which doc
  docs/           # the verbatim text each route injects
    baseline.md
  README.md       # editing guidance (never injected — no route points at it)
```

This folder holds **only configuration** — no install artifacts. The dispatcher and skill payload live separately under the install root (`~/.baseline`), so you can keep this folder in a dotfiles repo and sync it across machines.

Edit a **doc** to change what is injected (takes effect on the next firing — no reinstall). Edit **`config.json`** to add a route, change a route's `event`/`freq`/`cwd`, or point it at a different doc. After changing the *set of events* your routes use, rerun `install`/`update` so hook wiring stays in sync.

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
- `event` — required, one of `UserPromptSubmit`, `SessionStart`, `PreToolUse`, `PostToolUse`, and the sole resolver of *when* a route fires. To target a session phase, suffix the event — `SessionStart.startup` / `SessionStart.compact` / `SessionStart.clear` (`SessionStart.resume` is accepted but currently unused).
- `doc` — required, path relative to the config folder; must stay inside it.
- `freq` — optional positive integer, default `1`. Fires when `count % freq == 0`.
- `cwd` — optional path prefix. Fires only when the session working directory is at or under it.

To add a new injection, copy a pair from `assets/route-templates/` (a doc + its matching route) or ask the plugin to author one. See the `README.md` in your config folder for the runtime caps.

### Presets

`install` deploys exactly one preset into the config folder if none exists:

- `presets/default/` — the curated baseline (multi-route). Applied by a plain `install`.
- `presets/minimal/` — the neutral floor: one `baseline` / `UserPromptSubmit` / `freq 5` route with project-agnostic guardrails. Opt-in: `install --preset minimal`.

`install` never overwrites an existing config folder without `--force` (which replaces it wholesale — your edits are lost).

## Managing baseline

| Command | Description |
|---------|-------------|
| `status` | Shows the install root, config folder (and whether it's external), dispatcher sync, every route, and per-agent per-event wiring + link health. |
| `install [--preset <n>] [--force]` | Deploys the dispatcher, seeds the config preset, links each agent, wires hook config for the config's events. Idempotent. |
| `verify` | Functional test: drives the wired dispatcher and confirms a route fires with `additionalContext`. |
| `update` | Redeploys the dispatcher and re-syncs hook wiring from the current config (keeps the config folder). |
| `doctor` | Validates `config.json` + every route + per-event wiring; reports OK/WARN/FAIL and exits nonzero on any fault. `--fix` repairs and re-scans. |
| `uninstall` | Unwires baseline across all events and removes per-agent links. Preserves the config folder. |

```bash
node scripts/manage.js status
node scripts/manage.js install            # seeds default; --preset minimal for the neutral floor
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

All commands are idempotent and preserve any co-resident hooks (e.g. other skills). Hook-config edits are surgical. `install`/`uninstall` refuse to rewrite malformed `settings.json`/`hooks.json`; fix the JSON first so existing hooks are not lost.

## Repository layout

```
baseline/
├── install.sh / install.ps1     # Installer (bash / PowerShell)
├── update.sh / update.ps1       # Pull latest + redeploy (bash / PowerShell)
├── doctor.sh / doctor.ps1       # Scan + repair installation; --fix / -fix
├── uninstall.sh / uninstall.ps1 # Remove wiring + links, keep config folder
├── build.sh / build.ps1         # Cross-compile Zig native artifacts (paused/not wired for v1)
├── package.json                 # TypeScript devDeps + build/test scripts
├── tsconfig.json                # tsc: src/*.ts → scripts/*.js
├── src/                         # TypeScript source of truth (edit here, then npm run build)
│   ├── manage.ts                # Manager source
│   ├── baseline-recital.ts      # Dispatcher source (canonical)
│   ├── baseline-recital.zig     # Verified native hook port artifact (paused/not wired)
│   ├── contracts.ts             # Shared dispatcher/manager contract helpers
│   └── test.ts                  # Test source
├── scripts/                     # Committed compiled output deployed by the manager
│   ├── manage.js
│   ├── baseline-recital.js
│   ├── contracts.js
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
├── .arca/baseline-sp/goal/      # Canonical goal docs: vision.md, architecture.md, vocabulary.md, plain.md
├── .claude-plugin/plugin.json   # Claude plugin manifest (skill-only; deployed as baseline@skills-dir)
├── .codex-plugin/plugin.json    # Codex plugin manifest
├── skills/baseline/SKILL.md     # Codex plugin skill wrapper
├── SKILL.md                     # Root skill instructions
└── README.md                    # This file
```

## Trust boundary

Doc bytes enter the model's context, so treat every `docs/*.md` as trusted configuration: inspect edits, keep docs short, never paste untrusted text. The dispatcher caps `config.json` and each doc at 64 KiB, skips docs over 10,000 characters, caps the combined hook context at 10,000 characters, limits routes to 64, resolves each `doc` strictly inside the config folder after realpath checks (no `..` or symlink escapes), and always exits 0 — a hook fault never blocks the agent. Counters are locked during update and auto-pruned after 7 days of inactivity.

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

The tests use temporary `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `BASELINE_HOME`, and `BASELINE_CFG` directories and do not touch your real config.

## License

MIT
