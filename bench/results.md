# Benchmark results

Generated 2026-07-02T08:25:05.359Z on win32/x64, Node v24.15.0, 32 CPUs, N=20 cold-start runs each (regenerate with `npm run bench`).

Each implementation runs the SAME injection task — read config, match the event, read the doc, print `additionalContext`. `baseline-node` is the real dispatcher (counters + lock + caps + templating); the refs are minimal.

| impl | p50 (ms) | p95 (ms) | peak RSS | notes |
|------|---------:|---------:|---------:|-------|
| baseline-node | 37.5 | 41.4 | n/a | the real dispatcher (counters + lock + caps + templating) |
| baseline-native | 5.1 | 6.6 | n/a | the native Zig dispatcher (R-009) — same routes/counters/caps/templating |
| ref-node | 34.4 | 36.8 | 47.0 MiB | minimal plain-node hook |
| ref-python | 30.1 | 32.1 | n/a | minimal python hook (python) |
| ref-ts | — | — | — | SKIPPED: no tsx / ts-node available (TS-at-runtime needs one) |

> Peak RSS is not measured on Windows (no portable child-peak-RSS probe); it is reported on Linux/macOS via `/usr/bin/time`.

Budgets live in `bench/budgets.json`; `npm run bench:check` fails when `baseline-node` exceeds them. The enforced gate is the Node-path `baseline-node` budget (**PROVISIONAL**); `baseline-native` (R-009, the hook hot path) is reported here for comparison. Final budgets pinned on a CI reference platform remain pending.
