---
name: harness-auto-plan
description: >
  Opt-in herdr+pi automated plan implementation. After human plan approval,
  execute small plans in one lead or decompose large plans into dependency-aware,
  worktree-isolated items handled by fresh implementer and reviewer sessions.
  Use only for /auto-plan or an explicit herdr implementation loop request.
---

# Auto-plan v2: bounded, fresh, conflict-safe

`/auto-plan` is opt-in. Normal `/plan`, `/implement`, and `/review` remain human-gated.

Requires `HERDR_ENV=1`. Otherwise stop and suggest `/implement` + `/review`.

Drive herdr only through:

```text
~/.pi/agent/skills/harness-auto-plan/scripts/auto-plan.py
```

Every command emits JSON. Pane output is a notification channel, never state authority.

## Invariants

1. Pickup before every action, including after compaction or `continue`.
2. Human-approved plan before product code.
3. Large work uses immutable items, isolated worktrees, fresh implementers, and fresh item reviewers.
4. Parallel items never own overlapping paths. Integration is always serial.
5. State writes are atomic and locked. `events.ndjson` is the append-only cross-session journal.
6. A stored pane id is never trusted alone; its run/item/role label must still match.
7. Prompt submission is bounded to 30 seconds. Waits use five-minute slices and park.
8. Review stops at zero open findings, unchanged no-progress, round six, or a technical blocker.
9. Only `verdict.json` or item state is authoritative. Never parse a verdict from prose/transcripts.
10. `finish` and item cleanup never close the coordinator pane.

## Initial pickup and plan gate

```bash
python3 <script> pickup --cwd <consumer> --task "<exact user request>"
python3 <script> init --cwd <consumer> --task "<exact user request>"
python3 <script> pickup --run-id <id>
```

Always pass the request with `--task`; exact normalized task matching prevents a different request from taking a stale run.

Follow `implementer_next`:

| State | Action |
| --- | --- |
| `init` | `init`, then pickup again |
| `explore-or-plan` | Explore once if needed; submit the plan to diffing |
| `await-plan` | Await the existing plan id |
| `implement` | Choose single-flow or item-flow below |
| `spawn-reviewer` | Single-flow only: `review` |
| `wait-verdict` | `wait-verdict`; park on a wait slice — the reviewer prompts this pane when it records |
| `items-drive` | Drive item-flow only: `items-status`/`claim-item`/`spawn-item`/`wait-item`/`integrate-item`; never edit the consumer |
| `finalize-items` | All items integrated: `finalize-items` |
| `report` | `finish`, then report the authoritative verdict when items-state is finalized or all items are blocked |

After compaction, `pickup` is authoritative for item-flow too — follow `implementer_next` the same way; never reconstruct item-flow state from chat.

Store `plan-id.txt` immediately after submission. Print the diffing plan URL before awaiting. Only `approved` proceeds. Copy the approved version to `plan.md`.

Large UI work still requires the AGENTS.md mockup approval gate.

## Choose execution mode

Use **single-flow** only when the plan is genuinely indivisible, edits one tightly-coupled area, and parallel sessions would add no value.

Use **item-flow** when any apply:

- multiple independent deliverables;
- multiple packages/services/screens;
- work can be dependency-ordered;
- the task is large enough to benefit from fresh contexts;
- two agents could safely work at once on disjoint paths.

Do not force concurrency. `--max-parallel 1` gives the same fresh-session protocol one item at a time.

# Item-flow coordinator

The coordinator stays in the original pane and never edits item worktrees.

## 1. Write the immutable manifest

Place it in the run directory, never the consumer tree:

```json
{
  "items": [
    {
      "id": "api",
      "title": "Add API contract",
      "description": "Exact approved-plan scope and acceptance checks",
      "paths": ["src/api/**", "tests/api/**"],
      "depends": []
    },
    {
      "id": "ui",
      "title": "Connect UI",
      "description": "Consume the approved API contract",
      "paths": ["src/ui/**", "tests/ui/**"],
      "depends": ["api"]
    }
  ]
}
```

Requirements:

- IDs are stable and unique.
- Descriptions are independently executable and verifiable.
- `paths` are exclusive ownership boundaries.
- Every dependency names another item.
- The graph is acyclic.
- Independent items cannot overlap paths; the script rejects them.
- If overlap is necessary, make the later item depend on the earlier one.

Initialize from a clean consumer checkout:

```bash
python3 <script> items-init --run-id <id> --manifest <manifest.json> --max-parallel <1..16>
```

This creates a run integration branch/worktree outside the consumer checkout. Repeating the exact command is idempotent; a changed manifest is rejected.

## 2. Schedule ready items

```bash
python3 <script> items-status --run-id <id>
```

Only returned `items` are ready. The list is dependency-aware and capped by free parallel slots.

For each ready item, claim then spawn. Ready items may be launched concurrently, but each command pair is serial per item:

```bash
python3 <script> claim-item --run-id <id> --item-id <item> --role implementer
python3 <script> spawn-item --run-id <id> --item-id <item> --provider <p> --model <m>
python3 <script> wait-item --run-id <id> --item-id <item> --role implementer
```

`claim-item` atomically creates a dedicated branch/worktree and nonce. A second claim is refused. `spawn-item` creates a fresh labelled herdr pane:

```text
auto:<run-id>:<item-id>:impl:<attempt>
```

The item implementer reads its persisted assignment, edits only owned paths, verifies, then calls `record-item`. That command validates the nonce, rejects out-of-scope paths before commit, requires a real diff, commits it, updates item state, and emits a notification marker.

`wait-item` uses a five-minute slice by default:

- `complete`: continue;
- `park`: item is still working; end the coordinator turn — the helper prompts this pane when it records; call `wait-item` again if asked;
- `stalled`: inspect/recover the existing labelled pane; do not split blindly;
- identity mismatch: stop instead of reading or closing an unrelated pane.

## 3. Fresh item review

After authoritative item status is `implemented`:

```bash
python3 <script> spawn-item-reviewer --run-id <id> --item-id <item> --provider <p> --model <m>
python3 <script> wait-item --run-id <id> --item-id <item> --role reviewer
```

The completed implementer pane is closed only after its durable result exists. Every item gets a fresh reviewer pane:

```text
auto:<run-id>:<item-id>:review:<attempt>
```

The reviewer never edits product files. It writes `items/<item>/findings.md`, including nits, then runs:

```bash
python3 <script> item-review-checkpoint --run-id <id> --item-id <item>
```

Checkpoint results:

- `worker`: spawn one fresh `Agent` worker to address every open issue, then re-read and review again;
- `verify-clean`: independently re-verify, then record LGTM;
- `blocked`: stop; the code-enforced round/no-progress budget fired.

The reviewer records the terminal result with the assignment nonce:

```bash
python3 <script> record-item-review --run-id <id> --item-id <item> --nonce <nonce> --verdict LGTM
python3 <script> record-item-review --run-id <id> --item-id <item> --nonce <nonce> --verdict BLOCKED --reason "<technical reason>"
```

LGTM is refused while any finding is open. Review fixes outside owned paths are refused before commit.

## 4. Integrate serially

Approved item branches merge into the integration worktree one at a time:

```bash
python3 <script> integrate-item --run-id <id> --item-id <item>
```

A merge conflict aborts the merge and marks the item `BLOCKED`; never ask another item session to resolve a cross-item integration conflict concurrently.

After each integration, call `items-status` again. Newly satisfied dependents become ready.

## 5. Finalize

When every item is `integrated`:

```bash
python3 <script> finalize-items --run-id <id>
```

Finalization refuses unless the original consumer checkout is clean and still at the recorded base commit. It fast-forwards to the integration result and removes run-owned worktrees/branches. If the consumer moved, stop and reconcile explicitly; never overwrite it.

# Single-flow

Single-flow keeps the original lead implementation path but uses the hardened snapshot/review protocol.

1. Implement the approved plan and verify it.
2. Write `implementer-summary.md`.
3. `pickup` must say `spawn-reviewer`.
4. Inspect the exact run delta with:

```bash
python3 <script> diff-snapshot --run-id <id>
```

The returned base/current git trees include untracked files and exclude unchanged pre-run dirt.

1. Start and wait in bounded slices:

```bash
python3 <script> review --run-id <id> --provider <p> --model <m>
python3 <script> wait-verdict --run-id <id>
```

The reviewer writes `findings.md`, calls `review-checkpoint` every pass, uses fresh workers, and records a terminal verdict through `record-verdict` with the run nonce. It does not print the old transcript verdict marker.

`finish` refuses to close helpers without an authoritative verdict. `finish --force` is recovery-only.

## Single-flow reviewer commands

```bash
python3 <script> review-checkpoint --run-id <id> --nonce <nonce>
python3 <script> record-verdict --run-id <id> --nonce <nonce> --verdict LGTM
python3 <script> record-verdict --run-id <id> --nonce <nonce> --verdict BLOCKED --reason "<reason>"
```

LGTM requires zero open findings. `record-verdict` atomically creates `verdict.json` and prompts the parked coordinator pane. `AUTO_PLAN_RECORDED ...` is only a wake-up marker. Helpers never close themselves.

# Bounds and recovery

- Prompt acceptance timeout: 30 seconds.
- Wait slice: 300 seconds, then `park` if still working.
- Review cap: sixth still-open round becomes `BLOCKED`.
- No progress: one repeated identical open-findings + git-state signature becomes `BLOCKED` on the second checkpoint.
- Agent start: one automatic retry in the same labelled pane; never make a second split for the same transient failure.
- Concurrent `init`, claims, state transitions, and events are file-locked.
- JSON state uses atomic replacement.
- `events.ndjson` is append-only and safe for cross-session handoff.
- Pane IDs may compact. Discovery and cleanup require the matching run/item label.
- After compaction, use `pickup`, `items-status`, and persisted item metadata. Never reconstruct state from chat.

# Run storage

```text
~/.pi/agent/tmp/auto-plan/<run-id>/
```

Key files:

| File | Purpose |
| --- | --- |
| `meta.json` | Run identity, base snapshot tree, nonce, owned panes |
| `status.json` | Current single-flow state and review counters |
| `events.ndjson` | Append-only communication journal |
| `plan.md`, `plan-id.txt` | Human-approved plan evidence |
| `implementer-summary.md` | Single-flow implementation handoff |
| `findings.md`, `findings-round-N.md` | Single-flow review state |
| `verdict.json` | Authoritative single-flow terminal verdict |
| `items/manifest.json` | Immutable item graph |
| `items-state.json` | Scheduler/integration state |
| `items/<id>/meta.json` | Durable item assignment, nonce, worktree, status |
| `items/<id>/findings*.md` | Item review handoff and round history |

The consumer tree contains only finalized product changes.
