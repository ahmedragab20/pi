---
description: Break the chore work into Flash briefs, run them, then review every line yourself
argument-hint: "<what to delegate>"
---
Delegate the chore work for: $@

1. **Split the task.** Everything that passes the chore test — writable as numbered steps with exact paths and commands, gradable without re-deriving — goes to a worker. Everything else stays yours. If grading the result needs the same thinking as doing it, it was never a chore.
2. **Write real briefs.** Every `Agent` call carries: one-line goal; numbered ordered steps naming exact files and exact changes, none requiring a decision; all inputs upfront; explicit out-of-scope; done criteria the worker verifies itself; capped return format. One goal per call.
3. **Batch independent spawns into one message.** Parallel writers get `isolation: "worktree"` and you merge.
4. **Review every return.** Read the actual diff of every file touched, grade it step by step against the brief, revert out-of-scope edits, fix the nits yourself. A worker's report is a claim, not a result.
5. **Report** what's done, what's verified with evidence, what's left.

Two failed attempts on the same goal → do it yourself or escalate. Never re-spawn a rephrased brief.
