---
description: Route code, plan, mockup, or PR review through diffing
argument-hint: "[start|finish|plan|mockup|pr|status]"
---
Route this request through the `diffing` skill: $@.

No arguments means start/reopen review. Use `diffing-start-review` for start/review,
`diffing-finish-review` for comments/finish, `diffing-plan-review` for plans, and
`diffing-pr-read` for PR context (`diffing-pr-address` only when asked to fix feedback).
For mockups, load `harness-mockup`; the request is opt-in and the lead authors them.
For status, report the current repository's session. Prefer registered diffing tools.
Print URLs before waiting, obey verdicts, and never mutate GitHub without authorization.
