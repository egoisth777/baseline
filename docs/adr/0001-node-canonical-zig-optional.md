# Node runtime (authored in TypeScript) is canonical; Zig native is an optional mirror

Status: accepted

The baseline hook ships in two runtimes: a Node hook authored in `src/baseline-recital.ts`
(compiled to `scripts/baseline-recital.js`) and an optional native binary built from
`scripts/baseline-recital.zig`. We treat **the Node runtime as canonical** — it has zero
dependencies and runs anywhere `node` exists (including macOS, which has no prebuilt
binary, and machines without the Zig toolchain) — and the Zig binary as an **opt-in speed
path that must mirror Node behavior**. The Node hook is always deployed, even when a native
binary is wired, so it remains the reference implementation.

## Considered options

- **Node canonical, Zig optional mirror (chosen).** Node is the floor that always works;
  Zig is an optimization layered on top for faster process startup.
- **Zig as the primary/replacement runtime.** Rejected: it would require a toolchain or a
  per-platform prebuilt for every install, has no macOS artifact, and offers no benefit
  beyond startup latency.

## Consequences

- For the user-configurable injection routes feature, **native Zig is paused for v1**. The
  dispatcher (JSON config parsing, per-event matchers, tool-name regex, per-route counters)
  is implemented in TypeScript/Node only. A native install must not silently ignore routed
  config, so native runtime is unavailable for routed configs until a fast-follow issue
  ports the stabilized dispatcher to Zig.
- The case for eventually porting to Zig *grows* once `PreToolUse`/`PostToolUse` routes
  exist, because the hook can then fire on every tool call, where Node's ~50–100 ms startup
  is a per-call tax that Zig's ~1 ms startup would erase.
