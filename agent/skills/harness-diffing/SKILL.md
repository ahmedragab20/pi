---
name: harness-diffing
description: Human-in-the-loop diffing and risk-based review policy.
---
# Diffing

Use human review when the change is consequential, risky, substantial, or the user asks;
small routine edits may use lead judgment without a mandatory web gate. Preserve
consequential-action authorization. Print review/plan URLs before waiting and obey
human verdicts. Plans and mockup sources stay under `~/.diffing/`. Mockups are opt-in,
lead-authored, and never delegated. Read diffs scoped before compression.
