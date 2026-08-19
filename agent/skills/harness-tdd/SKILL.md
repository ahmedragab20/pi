---
name: harness-tdd
description: TDD bug loop for this pi harness. Use when writing a failing test, reproducing a bug, or running the lead ↔ tests worker loop.
---

# TDD bug loop (lead ↔ `tests`)

Hypothesis → `Agent` `tests` writes ONE failing test + runs the exact command → lead judges → tighter test (deeper layer) or lead `edit`s the fix → `Agent` `tests` verifies.

- The lead owns hypothesis, loop decisions, and the fix.
- `tests` owns test code and execution only.
- The lead never writes reproduction tests.
