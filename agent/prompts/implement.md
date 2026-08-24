---
description: Explore → draft plan → diffing approval → implement. End-to-end change flow with human sign-off
argument-hint: "<query>"
---
Drive the change end-to-end for: $@

1. **Explore** — `Agent` `subagent_type: explorer` (one spawn, concise brief) to map the relevant code if it's non-trivial.
2. **Plan** — draft a concise implementation plan and submit it to diffing for human approval (`diffing-plan-review` skill; plan file under `~/.diffing/<repo>/plan-sources/`, **print the plan URL**, await verdict, obey it). Large UI: you **may suggest** a mockup via `ask_user_question`; create one only if they asked or accepted. The **lead** writes it (`diffing-mockup-author` → `diffing_mockup_submit`). Never `Agent` a worker for mockup HTML.
3. **Implement** — after approval, implement the substantive parts yourself; delegate mechanical steps to `Agent` workers (`worker`, `tests`, `lint`) per the chore rule.
4. **Verify** — `Agent` `tests` for the exact suite/command; `Agent` `lint`; then summarize the diff via inspect (`harness-diff-read`) and hand it to the human via `diffing-start-review` (`/review`). Print the URL.

Stop at each human gate; never code before the plan is approved, never claim review is done before the human reviewed.
