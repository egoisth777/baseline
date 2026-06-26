# Route template: inject on a session lifecycle phase

A `SessionStart` route injects a doc when a session begins in a given phase — most
usefully on `compact` (right after context is compacted) or `resume`. Target the
phase by suffixing the event as `SessionStart.<phase>`.

## docs/<name>.md (injected verbatim)

```text
<instructions to run at the start of this session phase, e.g. "Context was just
compacted. Re-state the current task and what is left, then resume.">
```

## config.json route

```json
{ "id": "<slug>", "event": "SessionStart.compact", "freq": 1, "doc": "docs/<name>.md" }
```

Valid phase suffixes: `SessionStart.startup`, `SessionStart.compact`, `SessionStart.clear`
(`SessionStart.resume` is accepted but currently unused). Use a bare `SessionStart` to fire
on every session start. Verify `compact` against your agent version before relying
on it.
