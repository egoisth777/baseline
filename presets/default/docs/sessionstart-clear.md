# Baseline — after /clear

The user just ran /clear: the prior context was wiped, so the baseline rules are gone
from this session. Re-load them now and apply them from the very next turn:

- File read/write/search -> subagent, not inline. Save main context.
- Read before you edit; verify the change works before reporting it done.
- Flag what you skipped or assumed; never report unverified work as done.
