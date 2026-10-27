---
name: harness-herdr
description: Pane and session rules when running inside herdr (HERDR_ENV=1). Use before splitting a pane, running a command in another pane, reading pane output, or starting an independent review session.
---

# Herdr

Inside herdr (`HERDR_ENV=1`):

- **Never split a pane just to open a diffing session** — it's a background process, not a neighbor terminal. Prefer MCP `start_review_session`; CLI fallback is a **background** `diffing --web --no-open` in this pane.
- **Do split** for work that genuinely needs its own terminal: a dev server, a long test run, a log tail. Recipe: `herdr pane split <id> --direction right --no-focus` → parse `result.pane.pane_id` → `herdr pane run <new> "<cmd>"` → `herdr wait output` instead of polling.
- `DIFFING_VERDICT <kind> decision=…` surfaces in the pi pane after each await verdict; greppable via `herdr pane read`.
- The default opt-in independent second opinion is `review-pane` (`/review-pane`): a fresh pi pane using `openai-codex/gpt-6-astra`, priority processing and max thinking. End the turn after launch; never poll or block for its verdict. Keep scope unchanged while it runs and adjudicate findings yourself.
- Use `claude-review` (`/claude-review`) only when the user explicitly requests Claude. Never start either independent review workflow on your own initiative.
- Never edit herdr's own skill (`~/.agents/skills/herdr/`).
