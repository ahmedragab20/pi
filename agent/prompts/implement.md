---
description: Explore → draft plan → diffing approval → implement. End-to-end change flow with human sign-off
argument-hint: "<query>"
---
Drive the change end-to-end for: $@

1. **Explore** — `task` agent `explorer` (single task, concise brief) to map the relevant code if it's non-trivial.
2. **Plan** — draft a concise implementation plan and submit it to diffing for human approval (`diffing-plan-review` skill; plan file under `~/.diffing/<repo>/plan-sources/`, **print the plan URL**, await verdict, obey it).
3. **Implement** — after approval, implement the substantive parts yourself; delegate mechanical steps to `task` agents (`worker`, `tests`, `lint`) per the chore rule.
4. **Verify** — `task` `tests` for the exact suite/command; `task` `lint`; then summarize the diff via inspect (`harness-diff-read`) and hand it to the human via `diffing-start-review` (`/review`). Print the URL.

Stop at each human gate; never code before the plan is approved, never claim review is done before the human reviewed.
