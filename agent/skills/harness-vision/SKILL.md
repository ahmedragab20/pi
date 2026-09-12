---
name: harness-vision
description: "How pasted images reach the lead: native multimodal input versus the vision-router fallback. Use when the user pastes an image, when a [VISION DESCRIPTION] block appears, or when a description is missing or looks wrong."
---

# Images

A **multimodal lead** (`openai-codex/gpt-6-astra` — the default — plus `gpt-6-astra-1m`, `gpt-5.6-sol` and `gpt-5.6-sol-1m`) sees pasted images natively; nothing routes.

A **text-only lead** — any model whose `input` lacks `image`, today `openai-codex/gpt-5.3-codex-spark` — triggers `vision-router.ts`: it intercepts the paste, forks a headless `pi -p` child, and injects a `[VISION DESCRIPTION]` block before the turn reaches you.

Either way the description is already in your context when your turn starts. **There is no vision subagent — never spawn one.** If a description is missing or clearly wrong, say so and ask the user to re-paste or switch to a multimodal lead with Ctrl+P.
