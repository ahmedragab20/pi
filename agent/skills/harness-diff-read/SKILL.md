---
name: harness-diff-read
description: Read scoped working-tree, PR, or commit diffs when reviewing or summarizing changes.
---

# Read diffs scoped

Confirm the review session belongs to the current repository. Prefer registered diffing
tools or `diffing inspect` from this checkout; do not use a client bound to another repo.
Start with a summary, then inspect the relevant paths:

```text
diffing inspect summary
diffing inspect files --path GLOB --cursor N --limit N
diffing inspect hunks --path PATH
diffing inspect slice --path PATH --max-lines N --max-bytes N
diffing inspect search TEXT --path GLOB
```

For hunks/slice, use `--path` or `--file`, not both; the path must identify one file.
Carry the summary's generation when the API supports it; refresh on a stale generation.
Follow pagination rather than assuming the first page is complete.

If there is no session, a path is missing, or scope is ignored, use
`git diff -- <paths>` (and `--cached` for staged changes). Inspect relevant untracked
files separately. Do not open a review UI merely to read a small diff.

Read small patches directly. For substantial bounded compression, optionally use the
single worker with an exact scope and requested evidence. Verify its findings against
the real changes. Stop when evidence is sufficient; do not repeat reads or dump the
whole tree into a worker.
