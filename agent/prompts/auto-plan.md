---
description: Opt-in herdr loop — diffing plan, lead implements, independent xhigh reviewer pane until LGTM. Not the default /plan or /implement flow
argument-hint: "<what to build>"
---
Opt-in automated plan implementation for: $@

This is **not** the default. Do not start it unless the user invoked `/auto-plan` or explicitly asked for this herdr reviewer loop.

Read `~/.pi/agent/skills/harness-auto-plan/SKILL.md` and follow the **Implementer** role. First action: `pickup --cwd <consumer> --task "<the user request>"`. Obey `implementer_next`. Never spawn a reviewer until `implementer_next` is `spawn-reviewer` — that is after the approved plan is implemented and the consumer tree has a reviewable diff. Empty working tree → implement, do not split a reviewer pane.
