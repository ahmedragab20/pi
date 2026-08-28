---
description: Reproduce, narrow, and fix a bug — the reasoning is yours, the grunt work isn't
argument-hint: "<symptom>"
---
Debug: $@

Read the `harness-tdd` skill for the loop. You own the hypothesis, the loop decisions, and the fix. `tests` owns test code and execution only — never write the reproduction test yourself, and never hand the root-cause call to a worker.

1. **Reproduce.** Get the failing signal. Long output → compress with `Agent` `terminal-reader` / `log-reader` before you reason over it.
2. **Narrow.** One hypothesis at a time. `Agent` `tests` writes ONE failing test and runs the exact command you name; `Agent` `worker` adds the exact logging you specify. The single test you're iterating on, you may run yourself.
3. **Call the root cause** — with evidence, in one or two sentences. No "seems like".
4. **Write the fix yourself.** It's the subtle part; it never goes to a worker.
5. **Verify** — `Agent` `tests` re-runs the command. Read the real output, then `/verify` for the full pass.
