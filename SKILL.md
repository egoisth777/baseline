---
name: baseline
description: >-
  Control surface for the baseline drift-correction system: a Claude Code
  dispatcher that injects trusted docs at configurable hook events via
  user-configurable injection routes in ~/.omne/cfg/baseline/config.json, so the
  agent recites or receives standing rules before continuing. Use when the user
  asks to view, edit, add, or remove baseline docs or routes; change an
  injection's event, frequency, matcher, or cwd scope; install, verify, check
  status, repair, or uninstall the baseline hook; or manage
  ~/.omne/cfg/baseline/. Trigger on qualified phrases like "baseline-recital",
  "baseline rules", "baseline hook", "baseline drift", "baseline route", "change
  baseline frequency", or "make the agent recite X every N turns".
---

# baseline

A drift-correction system. Over a long session the agent forgets standing rules (e.g. "route file read/write/search through subagents, don't do them inline"). baseline injects small, trusted **docs** into the model's context at chosen hook **events** on configurable **routes**. The classic use is the **recital**: every Nth user prompt the agent must open its reply with a fixed prefix line and restate the rules verbatim before continuing — which both *re-aligns* the agent and *exposes* drift.

Content and routing are kept separate: **docs** (`docs/*.md`) hold the verbatim injected text; **`config.json`** holds routing only (which doc fires at which event, how often, where). The dispatcher injects doc bodies as-is and bakes in no content.

## Architecture (what lives where)

| Piece | Path | Role |
|---|---|---|
| Dispatcher (canonical) | `src/baseline-recital.ts` → `scripts/baseline-recital.js` | TypeScript source of truth; `npm run build` compiles it. Reads the event, loads `config.json`, selects routes, counts per route, injects due docs verbatim. |
| Native port | `src/baseline-recital.zig` | Optional native mirror. **Paused** for the routes feature. |
| Central dispatcher | `~/.omne/hooks/baseline-recital.js` | Canonical deployed hook artifact. |
| Agent dispatcher link | `~/.claude/hooks/baseline-recital.js` | Installed command path wired in settings; links to central. |
| Config folder | `~/.omne/cfg/baseline/` (`config.json` + `docs/` + `README.md`) | **Everything tunable**: routes in `config.json`, injected text in `docs/`. Linked into each agent as a unit. |
| Agent config link | `~/.claude/cfg/baseline/` | Links to the central config folder. Read live via symlink; a copy fallback needs install/update after edits. |
| Counter state | `~/.claude/.baseline-counters.json` | Per-session, per-route firing state keyed `"<session>:<routeId>"`. Auto-pruned. Never edit by hand. |
| Wiring | `~/.claude/settings.json` | Our dispatcher command wired into exactly the events the config uses. `install`/`uninstall` manage it. |
| Manager | `src/manage.ts` → `scripts/manage.js` | install / update / doctor / verify / status / uninstall. Run from repo root. |
| Presets | `presets/minimal/`, `presets/default/` | Repo-shipped config payloads `install` seeds from. `minimal` is the default floor; `default` is the author's curated baseline. |
| Route templates | `assets/route-templates/*.md` | Doc+route authoring references. Never deployed or injected. |

**Key split:** routes/docs are *data* in `cfg/baseline/` (edit anytime; takes effect next firing). The dispatcher is *mechanism* (only changes when you alter how selection/counting/injection works → redeploy via `install`).

For internals (route selection, counting, hardening) read `references/architecture.md`.

## Requirements and runtime

Requires Claude Code and Node.js. Node runs the manager and the dispatcher. The dispatcher is **Node-only** for v1; the native Zig port is paused, so `--runtime prebuilt|build` is refused.

## Trust boundary

Every `docs/*.md` is injected into model context, so treat docs as trusted configuration: inspect edits, keep them short, never paste untrusted text. The dispatcher caps `config.json`/each doc at 64 KiB and routes at 64, resolves each `doc` strictly inside the config folder, and fails open. If `status` reports a copy fallback for the config link, rerun install/update after central edits.

## The two most common tasks

### Edit what is injected, or add a route — usually no reinstall

The config folder is `~/.omne/cfg/baseline/`:

```json
{
  "version": 1,
  "routes": [
    { "id": "baseline", "event": "UserPromptSubmit", "freq": 5, "doc": "docs/baseline.md" }
  ]
}
```

- **Change injected text:** edit the doc the route points at (`docs/baseline.md`). The body is injected verbatim — the prefix/restate scaffolding lives inside the doc. Takes effect next firing.
- **Add a route:** add a `docs/<name>.md` and a `routes[]` entry. Follow `assets/route-templates/`. Then rerun `install`/`update` so settings wiring matches the events your routes use.
- **Change frequency/scope:** edit `freq` / `matcher` / `cwd` on the route.
- Editing only doc text needs no reinstall when `status` reports a symlink. Adding/removing an *event* requires install/update so wiring re-syncs.

### Manage the hook itself

Run the manager from the repo root:

```bash
node scripts/manage.js status      # central root, dispatcher sync, routes, per-event wiring
node scripts/manage.js install     # deploy dispatcher + seed preset + link agent + wire settings
node scripts/manage.js verify      # functional: confirm a route fires
node scripts/manage.js update      # redeploy + re-sync wiring from current config
node scripts/manage.js doctor      # validate config + wiring; --fix to repair
node scripts/manage.js uninstall   # unwire all events + remove agent links (keeps central config)
```

`install --preset default` seeds the author's curated baseline; `--force` replaces an existing config folder (destructive). Or use the platform installers (`./install.sh`, `.\install.ps1`). Commands are idempotent and preserve co-resident hooks — settings edits are surgical.

## Workflow guidance for the agent using this skill

1. **Identify the intent.** Editing docs/routes → it's a `cfg/baseline/` edit. Installing/repairing/removing → it's a `manage.js` run. Adding or removing an *event* always needs install/update afterward (wiring re-sync).
2. **For data edits:** read the relevant doc or `config.json`, make the change, keep docs short, keep `config.json` routing-only (never put injected text in it). Then run `node scripts/manage.js status` to show the live result.
3. **For mechanism changes** (how selection/counting/injection works): edit `src/baseline-recital.ts` first, then `npm run build` to regenerate `scripts/baseline-recital.js`. The Zig port is paused — don't touch it until the dispatcher stabilizes.
4. **Always end with `npm test`** (runs `tsc` then `node scripts/test.js`) **plus `status` or `verify`** so the user sees ground truth. After any settings change, remind them: open `/hooks` once or restart so Claude Code reloads settings.

## Vocabulary

Project terms (route, doc, dispatcher, freq, matcher, cwd scope, preset, route template, config folder, central root) are defined in `.arca/baseline-sp/ubi_lang.md`. Reuse those terms; add a genuinely new concept there first. Never hand-edit the generated `scripts/*.js` or the deployed copy in `~/.omne/hooks/`.
