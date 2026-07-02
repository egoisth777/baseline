# Benchmark results

Generated 2026-07-02T07:43:42.441Z on win32/x64, Node v24.15.0, 32 CPUs, N=20 cold-start runs each (regenerate with `npm run bench`).

Each implementation runs the SAME injection task — read config, match the event, read the doc, print `additionalContext`. `baseline-node` is the real dispatcher (counters + lock + caps + templating); the refs are minimal.

| impl | p50 (ms) | p95 (ms) | peak RSS | notes |
|------|---------:|---------:|---------:|-------|
| baseline-node | 37.2 | 39.7 | n/a | the real dispatcher (counters + lock + caps + templating) |
| ref-node | 32.9 | 40.9 | 47.0 MiB | minimal plain-node hook |
| ref-python | 29.7 | 34.2 | n/a | minimal python hook (python) |
| ref-ts | — | — | — | SKIPPED: no tsx / ts-node available (TS-at-runtime needs one) |

> Peak RSS is not measured on Windows (no portable child-peak-RSS probe); it is reported on Linux/macOS via `/usr/bin/time`.

Budgets live in `bench/budgets.json`; `npm run bench:check` fails when `baseline-node` exceeds them. Budgets are **PROVISIONAL** (Node-path) until the native engine (R-009) lands and final numbers are pinned on a CI reference platform.
