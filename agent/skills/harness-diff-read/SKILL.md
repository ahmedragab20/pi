---
name: harness-diff-read
description: Read working-tree, PR, or commit diffs with scoped inspect APIs. Use when summarizing changes, preparing /review, or compressing a large patch. Prefer inspect over dumping git diff into diff-reader.
---

# Read diffs scoped

Stop at the first step that yields enough evidence. Never paste the whole tree into a worker because inspect felt slow.

Cursor's `diffing` MCP may be bound to a **different repo**. Prefer the pi bridge (`pi__diffing_*`) or `diffing inspect` against this cwd's active session.

Carry `generation` from `summary` into later calls. On stale generation (HTTP 409), re-run `summary` and restart that traversal.

## Inspect (step 1)

```
diffing inspect summary [--exclude lockfiles]
diffing inspect files   [--path GLOB] [--cursor N] [--limit N]
diffing inspect hunks   (--file N | --path GLOB) …
diffing inspect slice   (--file N | --path GLOB) [--max-lines N] [--max-bytes N]
diffing inspect search  <text> [--path GLOB]
```

- Scope with `--path` (`agent/extensions/**`, `**/foo.ts`, exact file). Filtered `nextCursor` indexes the **filtered** list; each row still has the global `file` index.
- `slice` / `hunks`: `--path` XOR `--file`. Path must resolve to exactly one file.
- `summary` may include `directories` buckets. `--exclude lockfiles` drops lock/generated basenames from **counts only**.

## Unhelpful inspect → fall through (do not retry with a full dump)

- No session / inspect exit 3
- `--path` ignored (unfiltered `total`, or `slice --path A` returns a different file) — old review server; restart the session or fall through
- Generation mismatch, `complete: false` with empty files, binary-only hits
- Needed path is not in the session (untracked outside review scope)

If a review is already the goal, `start_review_session` / `/review`. Otherwise do **not** block on the UI.

## Path-scoped git (step 3)

```
git diff --stat -- <dir-or-files>
git diff -- <dir-or-files>
```

Small diffs: the lead reads them. Large: step 4.

## `task` `diff-reader` (step 4)

Only with a **path-scoped** patch or an inspect slice already pulled. Never the whole tree. Worker is `no-tools` — it cannot call diffing.

Brief shape:

```
Compress this scoped diff only.
Return: Changed APIs; Risky files (path + why); Behavior changes; Migration notes.
Scope: <paths>
<diff or slice>
```

## Give up (step 5)

If the scoped dump is still huge and the packet is weak, tell the user inspect/session is the right tool. Do not loop.
