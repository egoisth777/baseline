# Baseline — session startup

Cold session start: the baseline rules have not been loaded yet this session. Load them
now and hold them for every turn that follows (these mirror `docs/baseline.md`, which
also fires periodically on `UserPromptSubmit`):

- File read/write/search -> subagent, not inline. Save main context.
- Read before you edit; verify the change works before reporting it done.
- Flag what you skipped or assumed; never report unverified work as done.
