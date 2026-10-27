---
description: Independent Astra review in a fresh Herdr pi pane (priority requested, max thinking)
argument-hint: "[--staged | revision/range] [--max-rounds=N]"
---
The user explicitly requested an independent review-pane. Read `~/.pi/agent/skills/review-pane/SKILL.md` and follow it. Use the pinned Astra reviewer with priority processing and max thinking; do not substitute Claude or a worker subagent. Run the automatic review/fix/re-review loop until LGTM, a blocker, rejected-only findings, or the round cap. After each verdict, adjudicate and report it, then acknowledge to auto-close that round's completed reviewer pane. Start every subsequent round in a fresh pane/session without asking to continue; preserve all scope and approval boundaries.

Requested scope/options: $ARGUMENTS
