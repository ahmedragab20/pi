---
description: Opt-in herdr loop — diffing plan, item scheduler with fresh implementer/reviewer sessions, or single-flow. Not the default /plan or /implement flow
argument-hint: "<what to build>"
---
Opt-in automated plan implementation for: $@

This is **not** the default. Do not start it unless the user invoked `/auto-plan` or explicitly asked for this herdr reviewer loop.

Read `~/.pi/agent/skills/harness-auto-plan/SKILL.md` and follow the **coordinator** role. First action: `pickup --cwd <consumer> --task "<the user request>"`. Obey `implementer_next`. Never spawn a reviewer until the approved plan is implemented (single-flow) or the item is `implemented` (item-flow). Empty working tree → implement, do not split a reviewer pane. For large plans, decompose into the immutable item manifest and drive items through claim → spawn → wait → review → integrate → finalize. All state transitions go through the script; never trust pane transcripts.
