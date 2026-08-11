---
description: Write a Conventional Commits commit message for the staged/working changes
argument-hint: "[scope]"
---
Write a commit message for the current staged/working changes${1:+ scoped to: $1}.

Always use **Conventional Commits** (`type(scope): subject`; body only when the "why" isn't obvious).

Source of truth, in order:

1. **Project rules, if they exist** — check for CONTRIBUTING.md, a commitlint config (`commitlint.config.*`, `.commitlintrc*`, or the `commitlint` field in package.json), or any project docs specifying commit style. If found, follow them exactly (allowed types, scopes, casing, footer conventions).
2. **Otherwise, match the repo's history** — read recent commits (`git log --oneline -20` or similar) and follow the style actually used: types, scoping, casing, body/footer habits.

Hard rules that always apply, no matter what project rules say:

- **No `Co-authored-by:` trailers, no agent/bot attribution — commits are authored by the human only.** Strip any such trailer from the proposed message.
- Subject short (≤50 chars where the project doesn't say otherwise), imperative mood, no trailing period.

Delegate to `task` agent `git` only if you prefer a worker; either way apply the rules above.
