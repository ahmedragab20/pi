---
description: Independent Claude review of the target changes, then a human-approved diffing fix plan
argument-hint: "[target]"
---
Use the `claude-review` skill (read `~/.pi/agent/skills/claude-review/SKILL.md` first). Requires `HERDR_ENV=1` — if it is not set, say so and stop.

Target: ${@:-working tree (tracked + untracked)}. Pass the user's target text **verbatim** — never reinterpret a PR/range/commit target as working tree.

1. `start` the reviewer pane, then **end your turn and park.** Do not poll.
2. On the `CLAUDE_REVIEW_READY` wake-up, run `status`; read `findings.md` in full.
3. Report **every** `CR-N` finding in this session (id, severity, path:line, impact, proposed fix). Never silently drop one, never auto-resolve one, never implement one.
4. `close` the reviewer pane before opening diffing.
5. Build the fixes plan per the skill's schema and submit it for human approval. Only the human approves; only `approved` authorizes implementation.

You adjudicate the findings — a Claude finding is not automatically right. Confirm or kill each one against the real code before it goes in the plan.
