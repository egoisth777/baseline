#!/usr/bin/env python
"""Minimal Python reference hook for the benchmark: the same injection task as the
baseline dispatcher, stripped to essentials -- read config, match the event, read the
doc, print additionalContext. Reads the config path from BENCH_CONFIG and the event
from stdin. Invoke with `python` (or `py -3`); `python3` may be a Windows Store stub."""
import json
import os
import sys


def main():
    try:
        data = json.loads(sys.stdin.read())
        config_path = os.environ["BENCH_CONFIG"]
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        cfg_dir = os.path.dirname(config_path)
        route = next(
            (r for r in cfg.get("routes", []) if r.get("event") == data.get("hook_event_name")),
            None,
        )
        if not route:
            return
        with open(os.path.join(cfg_dir, route["doc"]), "r", encoding="utf-8") as f:
            body = f.read()
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": data["hook_event_name"],
                "additionalContext": body,
            }
        }))
    except Exception:
        # Fail-open like the real dispatcher: emit nothing.
        pass


if __name__ == "__main__":
    main()
