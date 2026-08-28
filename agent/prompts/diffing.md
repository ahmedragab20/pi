---
description: Route diffing work — start/finish a human review, submit a plan, submit an HTML mockup, read or address a PR, check status
argument-hint: "[start|finish|plan|mockup|pr|status]"
---
Use the `diffing` skill family (loaded from `~/.agents/skills/diffing*/`) to route ${@:-$ARGUMENTS} to the strongest available diffing surface — prefer the `diffing` MCP server (tools auto-allowed), then the `diffing` CLI, then the offline workflow.

Route by intent:

- no args / `start` / `review` → `diffing-start-review`: launch or reopen the diffing UI for the current repo and hand it to the human.
- `comments` / `handoff` / `finish` → `diffing-finish-review`: wait for the human's "Send to agent", then apply requested edits, answer questions, and resolve threads.
- `plan <path>` → `diffing-plan-review`: submit the plan at <path> for human approval and obey the verdict before touching code.
- `mockup` / `mockup <html|file|id>` → user asked, so the **lead** authors it — load the `harness-mockup` skill, which owns the full gate/author/review/verdict flow. Never spawn a worker. Read `diffing_design` first, submit HTML for visual review (never write mockup files into the consumer git tree), park, then obey the verdict — inspect open comments, `replace-region` / patch one screen, reply/resolve threads, `diffing_mockup_handoff` after approved. Prefer the `diffing_mockup_*` / `diffing_design` tools when the pi extension is loaded.
- `pr <number|url>` → read with `diffing-pr-read`; if the user asks to address feedback, use `diffing-pr-address` (do not push or mutate GitHub without explicit authorization).
- `status` → call `review_session_status` (MCP) or `diffing url` to report whether a review server is running and what repo it serves.

Always: read the SKILL.md for the route you take — it is the source of truth for the CLI/MCP contract. ALWAYS print the diffing review/plan URL in your message before starting a session or waiting on a verdict. Never write plans, notes, or scratch files into the consumer working tree — keep agent working files under `~/.diffing/`. Summarize diffs with inspect (`harness-diff-read`: `summary` → `--path` files/slice); do not dump the whole patch into `diff-reader`.
