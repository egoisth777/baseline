# Route template: recital on every Nth user prompt

A recital route restates trusted rules into context every Nth user prompt so drift
surfaces in the recited text. Copy the doc into `cfg/baseline/docs/` and the route
into `cfg/baseline/config.json` `routes[]`, then re-run install/update.

## docs/<name>.md (injected verbatim)

```text
Open your reply with "<PREFIX>:", then restate each rule below verbatim before
continuing. If you broke one this turn, say so and fix it now.
- <rule one, short — this text enters context>
- <rule two>
```

## config.json route

```json
{ "id": "<slug>", "event": "UserPromptSubmit", "freq": 5, "doc": "docs/<name>.md" }
```

`freq` is how many user prompts between firings.
The whole doc body is injected as-is — the prefix/restate scaffolding lives in the doc,
not in code.
