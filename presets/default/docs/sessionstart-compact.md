# Baseline — after compaction

The conversation was just compacted into a summary, which may have dropped the baseline
rules. Re-assert them now so they survive the compaction. First, restate in one line what
the current task is and what is left, then resume — and do not trust a claim that is not
visible in the summary above; re-check it instead.

- File read/write/search -> subagent, not inline. Save main context.
- Read before you edit; verify the change works before reporting it done.
- Flag what you skipped or assumed; never report unverified work as done.
