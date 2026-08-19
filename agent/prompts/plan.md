---
description: Draft an implementation plan and submit it to diffing for human approval before writing any code
argument-hint: "<what to plan>"
---
Use the `diffing-plan-review` skill (read `~/.agents/skills/diffing-plan-review/SKILL.md` first). Draft a non-trivial implementation plan for: $@

1. Explore as needed (`task` agent `explorer` for non-trivial mapping).
2. Draft the plan markdown under `~/.diffing/<consumer-repo>/plan-sources/` — **never in the consumer working tree**.
3. Ensure a diffing web session (`review_session_status`, then `start_review_session` if needed). CLI fallback: background `diffing --web --no-open` in this pane. **Never `herdr pane split` just to open the session.** **Print the review URL.**
4. Submit via MCP `submit_plan` with inline `body` (preferred) or `diffing plan submit` from the consumer workspace. **Print the plan URL.**
5. `await_plan_review` (or `diffing plan await`) and **obey the verdict**: `approved` → implement; `changes-requested` → revise, resubmit same `planId`, await again; `rejected` → stop; `comment-only` → reply only, do not edit product code.

Do not start coding from an unsubmitted or unapproved plan.
