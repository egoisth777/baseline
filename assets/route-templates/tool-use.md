# Route template: inject on a tool call

`PreToolUse` / `PostToolUse` routes inject a doc around matching tool calls for the
next model turn. The `matcher` is an **unanchored, case-sensitive regex** tested
against the tool name. These fire on every matching call, so bound the volume with
`matcher` and `freq`. Tool routes only ever add context; they never deny or rewrite
the current tool call.

## docs/<name>.md (injected verbatim)

```text
<reminder relevant after this tool is observed, e.g. "After Bash output: verify the
result before reporting the work done.">
```

## config.json route

```json
{ "id": "<slug>", "event": "PreToolUse", "matcher": "Bash", "freq": 3, "doc": "docs/<name>.md" }
```

`matcher: "Bash"` matches any tool whose name contains `Bash`. Use `^Bash$` to match
only the exact tool. `PostToolUse` has the same shape and fires after the call instead.
