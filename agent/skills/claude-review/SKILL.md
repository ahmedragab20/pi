---
name: claude-review
description: |
  Use when the user asks for an independent Claude review of target changes
  followed by a human-approved diffing fixes plan. Compatibility requires
  herdr, Claude CLI, and diffing web plan review.
---

# Claude Review: independent review → human-approved fix plan

Drives `scripts/claude_review.py` to spawn a Claude CLI pane that reviews
a target (working tree, staged, commit range, PR), collects `findings.md`,
then builds a human-approved fix plan through diffing web.

## Invariants

1. `HERDR_ENV=1` is required. Without it, stop — do not proceed.
2. The user's exact target text is preserved verbatim. Never reinterpret a
   PR/range/commit target as working tree.
3. A stored pane id is never trusted alone; the run marker + terminal
   identity must still match before close.
4. Every `CR-N` finding is presented to the human. Never auto-resolve, mark
   addressed, or implement any Claude finding.
5. Only the human approves through diffing plan UI. Never self-approve.

## Invocation and target handling

Require `HERDR_ENV=1`. If absent, print "Set HERDR_ENV=1 first" and stop.

If no target argument is provided, default to the current working-tree
changes — both tracked and untracked files. Pass this default explicitly
as `--target "working tree (tracked + untracked)"`.

If the user provides a target, pass it exactly: do not expand a PR number,
do not resolve a commit range to working-tree, do not rephrase.

Valid targets: working tree, staged, `<commit>`, `<from>..<to>`,
`<branch>`, `PR#<N>`, or any git revision.

## Start / park / resume

### Start

First confirm the existing environment has `HERDR_ENV=1`; never set or fake it. Then run:

```bash
python3 <skill-dir>/scripts/claude_review.py start --cwd "$PWD" --target "<exact target>"
```

`start` creates a right split without focus, runs Claude CLI model
`claude-opus-5` at `xhigh` in plan/read-only mode, and records run
metadata under `~/.pi/agent/tmp/claude-review/`.

The coordinator stores and returns `review_repo_cwd`, `diffing_repo_cwd`,
and `is_linked_worktree`. Claude reviews always execute in
`review_repo_cwd` (the linked worktree when invoked there). All diffing
session selection, start, and submission uses `diffing_repo_cwd` — the
main/canonical worktree returned by status.

After `start` succeeds, **end your turn and park**. Do not poll.

### Resume

The worker wakes the original pi pane with `CLAUDE_REVIEW_READY`. On
resume, run:

```bash
python3 <skill-dir>/scripts/claude_review.py status --run-id <id>
```

- **still running**: return "Claude review still in progress" and park
  again.
- **failed**: read `<run-dir>/error.log` (or `findings.md` when no error
  log exists), report the failure evidence, and do not submit a plan. Stop.
- **complete**: read `<run-dir>/findings.md` completely. Every `CR-N` is
  open external review feedback.

### Close

```bash
python3 <skill-dir>/scripts/claude_review.py close --run-id <id>
```

`close` verifies the run marker and terminal identity match. Do not guess
pane ids. Close the Claude pane **before** opening diffing.

## Plan schema

Build a markdown fixes plan with these sections in order:

| Section | Contents |
| --- | --- |
| `Claude review findings` | All findings verbatim or faithfully complete — IDs, severity, path:line, impact, proposed fix. If clean, state "No issues found." |
| `Finding disposition` | Every `CR-N` listed as `Open — pending human plan approval`. None resolved or implemented. |
| `Files to edit` | All consumer files with line ranges, per finding |
| `Implementation steps` | Ordered steps mapping each `CR-N` to planned edits |
| `Validation` | Tests or commands to verify each fix |
| `Risks` | Side effects, edge cases, dependencies |

Plan source goes in the run directory (`<run-dir>/fix-plan.md`), never in
the consumer tree.

The fixes plan is a normal plan under the canonical repository
(`diffing_repo_cwd`). It may be a new plan within that repository, but
must not create a separate repository or worktree entry. Plan paths and
findings still refer to the reviewed worktree changes.

A clean review produces a no-op verification plan (validate that no
changes are needed).

## Verdict handling

- If `findings.md` exists with content: every `CR-N` is an open finding.
  Report every one in the main pi session (ID, severity, path:line,
  impact, proposed fix). Never silently drop any.
- A successful report containing `No findings.` means the review is clean.
  Report that and still submit a verification plan.
- An absent or empty `findings.md`, non-zero exit, or Claude CLI error is a
  review failure. Report evidence and stop. No plan is submitted.

## Diffing plan review protocol

Follow `diffing-plan-review`:

1. Prefer inline MCP `submit_plan` in the consumer repo / web session.
2. Title: `Fix plan for Claude review: <target>`.
3. Source: `claude-review`.
4. Model: `claude-opus-5`.
5. Print the URL and end your turn. Do not await unless the human says
   they are reviewing now.
6. Only `approved` authorizes later implementation. Approval does **not**
   resolve Claude findings.
7. `changes-requested`, `rejected`, comment-only, and `pending` never
   implement.
8. Never call any comment resolve operation automatically. Only the human
   verifies through diffing plan approval.

### Worktree handling

When `is_linked_worktree=true`:

- Never submit through an MCP client bound to the linked worktree.
- Never create a diffing repository entry keyed by the worktree path.
  Always reuse or select the canonical repository's normal web session.
- If MCP cannot target the canonical repository, use diffing CLI with
  `cwd` set to `diffing_repo_cwd` instead.
- The fixes plan remains a normal plan under the canonical repository
  (`diffing_repo_cwd`). It may be a new plan within that repository, but
  must not create a separate repository or worktree entry.
- Plan paths and findings still refer to the reviewed worktree changes.

## Recovery

| Situation | Action |
| --- | --- |
| `start` fails | Check herdr, claude CLI installation, write permissions; report the error |
| `status` shows stale/failed | Inspect `<run-dir>/error.log`; report evidence |
| `close` identity mismatch | Do not close; report and ask the human |
| Pane compacted | Use `status` to check run state from persisted metadata |
| Target ambiguous | Ask the human, do not guess |
