---
name: harness-auto-plan
description: >
  Opt-in herdr+pi automated plan implementation. Draft a diffing plan, implement
  after human approval, then spawn an independent reviewer leader in a herdr
  split at thinking xhigh (high if the model has no xhigh) who loops a worker
  until every finding including nits is fixed and prints LGTM. Use when the
  user runs /auto-plan, asks for automated plan implementation, an auto
  reviewer pane, or a herdr implement-then-review loop. Not the default
  /plan, /implement, or /review flow.
---

# Opt-in auto-plan (herdr + pi)

Not the default. `/plan`, `/implement`, and `/review` stay human-gated. Run this skill only when the user invoked `/auto-plan` or explicitly asked for this loop.

Requires `HERDR_ENV=1`. If it is not `1`, stop: this command needs herdr. Tell the user to use `/implement` + `/review` instead.

Drive herdr **only** through `scripts/auto-plan.py` below. Do not improvise `pane split` / `pane run` / `agent start`.

## Pickup (always first)

Mid-session, after compaction, or when `/auto-plan` is invoked on work already in flight: **do not restart**. Inspect, then do only the next unfinished step.

```
python3 <script> pickup --cwd <consumer>
python3 <script> pickup --run-id <id>
```

Obey `implementer_next` / `reviewer_next`. `init` without `--new` reuses an unfinished run for that cwd.

| `implementer_next` | Do this | Skip |
| --- | --- | --- |
| `init` | `init`, then pickup again | — |
| `explore-or-plan` | Explore if needed, draft/submit plan | implement, spawn |
| `await-plan` | Await the **existing** plan id | new submit |
| `implement` | Implement the approved `plan.md` | re-plan, spawn |
| `spawn-reviewer` | `spawn-reviewer` (idempotent) then `wait-verdict` | re-implement |
| `wait-verdict` | `wait-verdict` | second reviewer pane |
| `report` | Tell the user `verdict` | anything else |

| `reviewer_next` | Do this |
| --- | --- |
| `first-review` | Review the diff, write `findings.md` |
| `worker` | `Agent` worker on every `Status: open` |
| `re-verify` | Re-read files; LGTM or new opens |
| `already-done` | Re-print the two-line verdict only if it is not on screen |

Session overlay (script cannot see the chat): if pickup says `init` but this conversation already submitted/approved a plan or already implemented, `init` then copy that evidence into the run dir (`plan-id.txt`, `plan.md`, `implementer-summary.md`) and pickup again. Do not redo work that already landed.

## Roles

| Role | Who | Owns |
| ------ | ------ | ------ |
| **Implementer** | This pane (the lead that took the task) | Explore, diffing plan, implement the approved plan, spawn reviewer, wait for the verdict |
| **Reviewer** | New herdr split, full pi leader at xhigh (else high) | Review, write findings, spawn workers, re-verify including nits, print `LGTM.` or `BLOCKED` |
| **Worker** | `Agent` `subagent_type: worker` | Implement open findings. Depth 1. Fresh worker each round — do not resume |

The reviewer never edits product files. The implementer never reviews their own work in this loop.

This reviewer ↔ worker loop is an exception to AGENTS.md "at most one resume" / "no ping-pong" / two-attempt cap. It runs until 0 open findings (nits included) or a stalemate.

## Script

`~/.pi/agent/skills/harness-auto-plan/scripts/auto-plan.py`

Always pass the absolute path. Every subcommand prints JSON.

```
python3 <script> pickup [--cwd <consumer>] [--run-id <id>]
python3 <script> init --cwd <consumer> --task "<the task>"   # reuses unfinished run unless --new
python3 <script> thinking [--provider P] [--model M]
python3 <script> spawn-reviewer --run-id <id> [--provider P] [--model M] [--pane <existing>]
python3 <script> wait-verdict --run-id <id> [--timeout-ms N]
```

`spawn-reviewer` splits the current pane (`HERDR_PANE_ID`) to the right with `--no-focus`, starts `pi` via `herdr agent start --kind pi`, then `herdr agent prompt`s the reviewer brief. It picks `--thinking xhigh` when the model map has a non-null `xhigh`, otherwise `high`. It sets `PI_THINKING_ROUTER=0` on the new pane so the word "review" cannot drop thinking. If `agent start` fails after the split, retry with `--pane <id>` — do not split again.

Pass this session's `--provider` / `--model` when you know them (TUI footer). Otherwise the script uses `settings.json`.

## Implementer

0. If `HERDR_ENV` is not `1`, stop. **`pickup --cwd`**. Continue from `implementer_next` only.
1. `init` only when pickup says `init` (or you need `--new`). Store `run_id` and `dir`. Do not put run files in the consumer tree.
2. Large UI (new screens/flows/redesign): the AGENTS.md mockup gate still applies before product code.
3. `explore-or-plan`: explore if non-trivial (`Agent` `explorer`, one spawn). Draft the plan, submit to diffing, **print the plan URL**. Write the id to `<dir>/plan-id.txt` immediately, then await, obey `diffing-plan-review`. Only `approved` continues. Copy the approved body to `<dir>/plan.md`.
4. `await-plan`: await the existing plan id. Do not submit another plan.
5. `implement`: implement the approved plan yourself (substantive). Chores (`tests`, `lint`, …) still go to `Agent`. Write `<dir>/implementer-summary.md` when done (what changed, files, verification, leftover risk).
6. `spawn-reviewer`: call the script (idempotent: live working reviewer → no second pane). Print `pane_id` and `thinking`. Then `wait-verdict`.
7. `wait-verdict`: omit timeout unless the user set one. Safe to retry — it matches output already on screen, including a verdict printed before you waited.
8. `report`: tell the user `verdict` (`LGTM` or `BLOCKED`). Do **not** hand to human `/review` unless they ask.

Do not start the reviewer before implementation and verification are done. After any compact or user "continue", pickup again before acting.

## Reviewer

On every turn (including resume/compaction): `pickup --run-id <id>` and obey `reviewer_next`. Do not start a blank review when `findings.md` already exists.

Read `<dir>/plan.md`, `<dir>/implementer-summary.md`, and the scoped diff (`harness-diff-read`). Review against the approved plan, not the implementer's story.

### Each round

1. Write `<dir>/findings.md` with **only currently open** issues (see format). Snapshot a copy to `<dir>/findings-round-<n>.md`. Update `<dir>/status.json` `round`.
2. If 0 open issues: the **entire** final message is exactly:

```
AUTO_PLAN_VERDICT LGTM
LGTM.
```

   Stop. No extra prose.

3. If any open issue (nits included): `Agent` `subagent_type: worker` with a brief that includes the consumer cwd, the absolute findings path, and:

   - Address **every** `Status: open` issue, including nits. Nothing is too small.
   - Edit product files; do not spawn subagents.
   - For each issue: `Status: fixed` plus a `Response:` line, or `Status: wontfix` with a technical reason.
   - Return: changed files, what you verified, blockers.

4. Re-read the files yourself. Do not trust the worker's Status. Keep `open` if the fix is missing, partial, or a new regression. Accept a `wontfix` only when the rationale is technically sound.
5. Repeat from step 1. Fresh worker every round.

Never print `LGTM.` while any issue is `open`.

## Findings format

```markdown
# Findings — round N

### Issue 1 -- Severity: bug|suggestion|nit
- **File**: path/to/file.ext:LINE
- **Description**: <what is wrong>
- **Suggestion**: <how to fix>
- **Status**: open
```

After a worker: `Status` is `open`, `fixed`, or `wontfix`. Add `- **Response**: ...` on fixed/wontfix.

## Markers

Greppable in the reviewer pane (`herdr pane wait-output` uses these; the script wraps that):

| Line | Meaning |
| ------ | ------ |
| `AUTO_PLAN_VERDICT LGTM` | 0 open issues; followed by `LGTM.` |
| `AUTO_PLAN_VERDICT BLOCKED` | stalemate; dispute follows |

## Stalemate

If the worker sets `wontfix` and the next review re-opens the **same** issue (match **File** + **Description**) twice, stop. Print `AUTO_PLAN_VERDICT BLOCKED` then the two positions. Do not keep looping.

## Run directory

`~/.pi/agent/tmp/auto-plan/<run-id>/` (gitignored). Consumer repo is untouched.

| File | Writer |
| ------ | ------ |
| `meta.json` | script |
| `task.md` | implementer / `init` |
| `plan.md`, `plan-id.txt` | implementer after approval |
| `implementer-summary.md` | implementer before spawn |
| `findings.md`, `findings-round-N.md` | reviewer |
| `status.json` | script + reviewer |
| `reviewer-system.expanded.md` | script at spawn |
