---
name: harness-vision
description: Native image handling and registered vision-router fallback.
---
# Images

Multimodal leads see pasted images natively. For a text-only lead, the registered
`vision-router` fallback supplies a bounded description before the turn. There is no
vision Agent: never suggest or spawn a worker fallback that cannot see images. If the
description is missing or wrong, ask the user to re-paste or switch to a multimodal lead.
