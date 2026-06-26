# Route template: inject on a tool call

`PreToolUse` / `PostToolUse` routes inject a doc around tool calls for the
next model turn. They fire on every tool call, so bound the volume with `freq`.
Tool routes only ever add context; they never deny or rewrite the current tool call.

> **Per-tool narrowing is not currently supported.** A `PreToolUse` / `PostToolUse`
> route fires for **all** tools, not a chosen one; narrowing a route to a specific tool
> is deferred to a future issue.

## docs/<name>.md (injected verbatim)

```text
<reminder relevant after this tool is observed, e.g. "After Bash output: verify the
result before reporting the work done.">
```

## config.json route

```json
{ "id": "<slug>", "event": "PreToolUse", "freq": 3, "doc": "docs/<name>.md" }
```

`PostToolUse` has the same shape and fires after the call instead.
