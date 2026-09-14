---
description: Independent Claude review followed by a human-approved fix plan
argument-hint: "[target]"
---
Read the `claude-review` skill for this target: $@. If empty, review working-tree changes
including untracked files. Require HERDR_ENV=1; otherwise stop. Preserve a supplied
target verbatim, park after starting, report every CR-N finding, close the reviewer, and
submit the skill's fixes plan for human approval. Never implement or auto-resolve a
finding; only an approved verdict authorizes fixes. Keep the required URL and verdict
workflow.
