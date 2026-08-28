---
name: goal
description: Long-running goal loop with re-anchored cycles until every acceptance criterion has evidence, you have verified it, and the human has reviewed it. Use when the user says /goal, wants work to continue until done, or asks to run until criteria pass without trusting chat memory.
---

# Goal loop

One task, worked across many cycles, until every accepted criterion has evidence you saw, you have verified the whole thing, and the human has reviewed it. The extension keeps re-anchoring you; you still own every decision.

Read this file once per cycle if it is not already in context.

## The record

The goal file the `goal` tool prints (`~/.pi/agent/goals/<project>/GOAL.md`). **That file is memory. Chat is not.**

- Re-read the goal file at the start of every cycle. `goal status` prints the same thing.
- Re-read the actual files you are about to change. They may not look like last cycle left them.
- Never edit the goal file with `write` / `edit` — it is regenerated from the tool on every call.
- Never mark a criterion met without proof **you saw this cycle**: a command and its real output, a `file:line`, an assertion that went green. A worker's "tests pass" is a claim; the output you read is the evidence.
- If it is not in the goal file, it did not happen. Do not narrate progress in prose.

## Phases

1. **Draft.** Criteria come from the human (the editor at `/goal` start) or you draft them — each one provable by a command, a file, a test, or a visible behavior. Explore only what you cannot already specify. Then `goal set_criteria`, `goal set_roadmap` with the ordered steps, and write the implementation plan yourself. Submit it with `diffing-plan-review`, **print the URL**, and call `goal await_plan` when you park.
   **Product code is blocked** — `write`/`edit` inside the project fail until you record the verdict with `goal plan_approved` (that is also where you record a human waiver).
2. **Run.** `goal step <Sn> active`, then work that slice: the next roadmap step, or a tight group of criteria. You do the thinking, the subtle edits, and the review of everything a worker returns.
3. **Cycle.** Slice finished, or your context is getting long: `goal cycle` with `summary` + `next`, then **stop talking**. The loop re-anchors you for the next slice and compacts when the window is actually filling up.
4. **Verify.** Every criterion evidenced → read the real diff (`harness-diff-read`), run the real checks (`Agent` `tests` / `lint`), fix the nits yourself.
5. **Review.** `/review` (diffing-start-review), print the URL, `goal await_review`. After the human approves, `goal reviewed`. Work their `/finish` feedback as ordinary slices — new evidence makes the review stale, so it goes back through `/review`.
6. **Done.** `goal done` only when every criterion is evidenced **and** the review is newer than the last evidence change. The tool rejects anything less.

## `goal` tool

| action | when |
| --- | --- |
| `status` | start of a cycle, after a compaction, any time you might be stale |
| `set_criteria` | write the accepted list (`criteria: string[]`). Evidence follows matching text; dropping an evidenced one needs `force` |
| `set_roadmap` | the ordered steps (`roadmap: string[]`). Step state follows matching text |
| `step` | `id` + `state` (`todo`/`active`/`done`) — one step is active at a time |
| `plan_approved` | `note`: the human's verdict and the plan URL, or how they waived it. Unblocks product code |
| `evidence` | the moment a criterion is proven (`id` + `evidence`). `met: false` retracts one that regressed |
| `cycle` | end this slice (`summary`, `next`) |
| `await_plan` / `await_review` | parking on a human gate — print the URL first |
| `reviewed` | the human approved the review |
| `blocked` | you cannot proceed (`reason`) — do not guess |
| `done` | all evidenced + reviewed |

End every working slice with `cycle`, `await_*`, `blocked`, or `done`. Never just stop.

## Orchestration

Two tiers, same as always (`AGENTS.md`): you are the lead, workers are chores-only on a fully specified brief. Inside the loop that split gets sharper, because a cycle boundary is a memory boundary.

| Phase | Spawn | Yours |
| --- | --- | --- |
| Draft | `explorer` for a search you can name | Criteria, roadmap, the plan, every judgment call |
| Run | `worker` for boilerplate/CRUD/fixtures/scoped renames, `tests` for test code, `lint` for format | Logic, integration, the subtle edit, root cause |
| Verify | `tests` runs the command you name; `terminal-reader` / `log-reader` compress the output | Deciding what proves it, reading the real result |
| Review | nothing | The whole diff, nits included |
| Ship | `git` drafts the message, `docs` writes prose | Approving it |

Loop-specific rules:

- **Spawns are background by default. Read every one back before you `cycle`** — `get_subagent_result`. A handle that crosses a cycle boundary unread is tracked in the goal file and reminded to you, but the cheap path is to drain it while you still have the context that produced it.
- **Independent spawns go out in one message.** Parallel writers get `isolation: "worktree"`, and you merge.
- **Never evidence a criterion from a worker's report.** Read the diff, run the check, then evidence what you saw.
- **Two failed attempts on the same slice → `goal blocked`.** Not a third rephrased brief.
- One spawn per goal, at most one resume — the standing no-ping-pong rule applies inside cycles too.

## Todos vs roadmap

- **Roadmap** = the milestones for this goal. Durable, in the goal file, survives every cycle. Keep it current with `goal step`.
- **`todo`** = the mechanical steps inside the slice you are working right now. Use it when a slice has 3+ steps; `todo clear` at the cycle boundary so it never outlives its slice.

The roadmap is what the loop reasons about. Todos are scratch.

## Context

The loop compacts at a cycle boundary only when the window is actually filling — `microcompact` and `auto-compress` already keep a healthy session bounded, and paying for a summary every slice buys nothing.

So treat everything above the cycle marker as **stale, not absent**: it may still be sitting there in full. That is exactly why the goal file, not the transcript, is the record. Compress before you reason — `terminal-reader` / `log-reader` for output, `harness-diff-read` for diffs.

## Anti-hallucination

- Compaction leftovers and your own earlier claims are untrusted. Files and command output are trusted.
- No criterion is met because the plan said it would be, or because last cycle said so.
- The loop blocks itself after three cycles with no new evidence and no change to the tree. If that fires, say what is actually stuck and ask.
- `/goal stop` from the user means stop. `/goal continue` resumes.

## Still in force

`AGENTS.md`, the security rules, plan-before-code, the worker chore test, human review. This loop is the allowed exception to "don't keep going" — not an exception to accuracy, evidence, or the gates.
