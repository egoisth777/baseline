# baseline config folder

This folder is the single source of truth for what baseline injects and when.
It is **not** injected into the model — no route points at this README, so editing
guidance can live here in plain prose. Everything a route injects lives in `docs/`.

```text
config.json   routing only: which doc fires at which event, how often, where
docs/         the verbatim text each route injects (one doc per route)
```

## This preset (minimal)

The **minimal** preset seeds a single route — the bare baseline, and nothing else:

```json
{ "id": "baseline", "event": "UserPromptSubmit", "freq": 5, "doc": "docs/baseline.md" }
```

It injects `docs/baseline.md` once every 5 user turns and wires only `UserPromptSubmit`.
Add more routes as you need them — see the **default** preset for an example that also
re-asserts the baseline at session boundaries.

## Edit what is injected

Open the doc a route points at (e.g. `docs/baseline.md`) and edit its text. The doc
body is injected **verbatim** — no wrapper is added by code, so any "open with this
line, restate verbatim" scaffolding must be written inside the doc itself. Changes
take effect on the next firing; no reinstall is needed when you only edit doc text.

## Add a route

A route is one entry in `config.json` `routes[]`:

```json
{ "id": "my-route", "event": "SessionStart.compact", "freq": 1, "doc": "docs/my-route.md" }
```

- `id` — required, unique, slug-shaped (`^[a-z0-9][a-z0-9-]*$`). Keys the route's counter.
- `event` — required, one of `UserPromptSubmit`, `SessionStart`, `PreToolUse`, `PostToolUse`.
  To target a session phase, suffix the event: `SessionStart.compact` (also `.startup` /
  `.clear`; `.resume` is accepted but currently unused).
- `doc` — required, path relative to this folder; must stay inside it (no `..`, no absolute paths).
- `freq` — optional, positive integer, default `1`. The route fires when `count % freq == 0`.
- `cwd` — optional, path prefix. The route fires only when the session working directory
  is at or under it.

Add the doc under `docs/`, add the route, then **re-run install/update** so hook
wiring stays in sync with the events your routes use. See `assets/route-templates/`
in the baseline repo for ready-to-copy doc+route pairs, or ask the plugin to author one.

## Runtime caps

- `config.json` ≤ 64 KiB; at most 64 routes.
- each doc ≤ 64 KiB and ≤ 10,000 characters (an over-cap doc is skipped, others still fire).
- combined hook context ≤ 10,000 characters.
- the dispatcher is fail-open: a missing/malformed config or a broken route injects
  nothing and never blocks the agent. Run `doctor` to see faults.
