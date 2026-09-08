---
name: harness-herdr
description: Pane and session rules when running inside herdr (HERDR_ENV=1). Use before splitting a pane, running a command in another pane, reading pane output, or starting an independent review session.
---

# Herdr

Inside herdr (`HERDR_ENV=1`):

- **Never split a pane just to open a diffing session** — it's a background process, not a neighbor terminal. Prefer MCP `start_review_session`; CLI fallback is a **background** `diffing --web --no-open` in this pane.
- **Do split** for work that genuinely needs its own terminal: a dev server, a long test run, a log tail. Recipe: `herdr pane split <id> --direction right --no-focus` → parse `result.pane.pane_id` → `herdr pane run <new> "<cmd>"` → `herdr wait output` instead of polling.
- `DIFFING_VERDICT <kind> decision=…` surfaces in the pi pane after each await verdict; greppable via `herdr pane read`.
- An independent second opinion on your own work is the `claude-review` skill (`/claude-review`) — a fresh Claude pane that never saw you write the code. Opt-in only; never start it on your own initiative.
- Never edit herdr's own skill (`~/.agents/skills/herdr/`).
