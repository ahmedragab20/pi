---
description: Write a Conventional Commits commit message for the staged/working changes (caveman-commit skill)
argument-hint: "[scope]"
---
Use the `caveman-commit` skill (read `~/.agents/skills/caveman-commit/SKILL.md`). Write a commit message for the current staged/working changes${1:+ scoped to: $1}.

Rules:
- Conventional Commits format; subject ≤50 chars; body only when the "why" isn't obvious.
- **No `Co-authored-by:` trailers, no agent/bot attribution — commits are authored by the human only.** Strip any such trailer from the proposed message.
- Delegate to `task` agent `git` only if you prefer a worker; either way apply the no-attribution rule.
