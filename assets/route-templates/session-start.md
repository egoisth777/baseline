# Route template: inject on a session lifecycle phase

A `SessionStart` route injects a doc when a session begins in a given phase — most
usefully on `compact` (right after context is compacted) or `resume`. The `matcher`
is the lifecycle phase, matched by exact equality.

## docs/<name>.md (injected verbatim)

```text
<instructions to run at the start of this session phase, e.g. "Context was just
compacted. Re-state the current task and what is left, then resume.">
```

## config.json route

```json
{ "id": "<slug>", "event": "SessionStart", "matcher": "compact", "freq": 1, "doc": "docs/<name>.md" }
```

Valid `matcher` values: `startup`, `resume`, `clear`, `compact`. Omit `matcher` to fire
on every session start. Verify `compact` against your Claude Code version before relying
on it.
