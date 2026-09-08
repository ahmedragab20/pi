---
name: harness-diffing
description: Harness policy for the human-in-the-loop diffing workflow. Use when starting or finishing a review, submitting a plan, authoring a mockup, reading a PR, or touching any diffing_* tool or diffing-* skill.
---

# Diffing

Human-in-the-loop review is the default workflow. Follow the `diffing-*` skills; prefer the `diffing_*` extension tools over raw CLI. Always print the review/plan URL **before** `await_review` / `await_plan_review`. Plans and mockup sources live under `~/.diffing/`, never in the consumer tree. Never mutate GitHub without explicit user authorization.

**Read diffs scoped.** `summary` → `--path` files/hunks/slice. Full skill: `harness-diff-read`. `diff-reader` is the fallback for a path-scoped dump only — never the whole tree.

**Mockups are opt-in and lead-authored.** Create one only when the user asked this turn or accepted your `ask_user_question` offer — never because a task looks like "large UI". When authorized, load the `harness-mockup` skill and follow it. Never spawn a worker for mockup HTML.
