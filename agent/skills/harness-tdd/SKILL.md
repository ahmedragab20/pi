---
name: harness-tdd
description: Lead-owned regression loop for debugging.
---
# TDD bug loop

The lead states a hypothesis, writes the smallest meaningful failing regression,
confirms the intended failure, fixes the cause, then runs relevant broader checks.
The single worker is optional; if used, it performs only a bounded,
explicitly scoped supporting chore. The lead owns the hypothesis, loop decisions, fix,
and review.
