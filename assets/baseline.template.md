---
interval: 5
prefix: LI BASELINE ALIGNED:
---
# Baseline — minimal rules the agent re-aligns to every Nth turn.
#
# Frontmatter (between the --- fences):
#   interval : fire the recital every Nth user prompt (positive integer)
#   prefix   : the line the agent must open its reply with on a fire
#
# Body: one rule per line. Blank lines and #-comment lines are ignored.
# Edit freely — baseline-recital.js reads this file at runtime, so changes to
# rules / interval / prefix take effect on the next prompt with NO reinstall.
# Keep rules short (caveman-compressed): this text is injected into context.

File read/write/search -> subagent (cavecrew-investigator/builder, Explore), not inline. Save main ctx.
