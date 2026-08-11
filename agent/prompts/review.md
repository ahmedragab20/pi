---
description: Start or reopen the diffing review UI for the current working-tree changes and hand it to the human
---
Use the `diffing-start-review` skill (read `~/.agents/skills/diffing-start-review/SKILL.md` first). Launch or reopen the diffing review session for the current repo's working-tree changes and hand it to the human.

- Ensure a diffing web session is running (`review_session_status`, then `start_review_session` if needed). **Print the review URL in your message.**
- Summarize what changed (or use `task` agent `diff-reader` for large diffs) so the human knows what to review.
- Wait for the human's review before making further changes.
