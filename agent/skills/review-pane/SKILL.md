---
name: review-pane
description: Opt-in independent review in a fresh Herdr pi pane using Astra, priority processing and max thinking. Use only when the user explicitly requests review-pane or an independent Astra review.
disable-model-invocation: true
---
# Review pane

Load `../harness-herdr/SKILL.md` before pane operations. Requires `HERDR_ENV=1` and `HERDR_PANE_ID`; otherwise stop. This workflow does not require Claude CLI.

## Launch

1. Parse the user's scope: blank means all uncommitted changes (staged, unstaged and untracked), `--staged` means the index, or use one Git revision/range such as `main..feature`. Arbitrary shell/Git options are not supported. Ask if a natural-language target cannot be represented without expanding the scope.
2. Inspect caller geometry with Herdr and choose `right` for wide panes, `down` for narrow/tall panes. Explain the launch command, then run:
   `python3 ~/.pi/agent/scripts/review-pane.py spawn --scope="<scope>" --direction=<right|down>`
   Keep the `=` for a scope beginning with `--`. Optional first-round `--max-rounds=N`; default 8. The reviewer is pinned to `openai-codex/gpt-6-astra`, max thinking, with `service_tier: priority` requested. It is not a distinct “fast” model; provider support and billing apply.
3. Note the returned run ID, pane and round/cap. **End the turn immediately.** Do not wait for completion, poll, sleep, or repeatedly inspect status. Do not edit the review scope while the review is running.

## Scope and context

- A single revision uses `git diff REV` semantics: that revision versus the live worktree. `--staged` reviews the index; a range uses Git's corresponding revision/range comparison.
- Contextual `read` calls always inspect the live checkout, not the index or a historical endpoint. Require the reviewer to report mismatched or unavailable target-version context instead of treating another version as evidence. Historical full-file reads are not provided by this workflow.
- Diff pages preserve complete fitting lines and resume at the first omitted line. An individually oversized line is clipped with `truncated_bytes: true`; report that coverage gap even after following the remaining pages.

## Pickup and adjudication

On `REVIEW_RECORDED <id> <LGTM|BLOCKED>`, run:
`python3 ~/.pi/agent/scripts/review-pane.py pickup --run-id=<id>`

Read the durable verdict, not just the notification. Confirm or reject each finding against the actual code. LGTM and BLOCKED are assessments, not authority; fixes remain subject to user scope and safety rules.

### Fix approval policy

- For clear, confirmed, in-scope fixes that are neither critical nor breaking, skip the diffing plan and implement and verify them directly. A BLOCKED verdict, multiple findings, or another review round does not by itself require a plan.
- Request a diffing plan and obtain human approval before critical or breaking fixes. Critical changes include high-impact security/authentication changes, destructive data changes, and changes with substantial production-outage risk. Breaking changes alter existing public APIs, persisted formats, configuration contracts, or supported behavior incompatibly.
- If the fix or its impact is unclear, ask a focused clarification question first; ambiguity alone does not require a diffing plan. Honor an explicit user request for a plan regardless of risk.
- This policy applies to review-pane fixes, not other workflows. It does not bypass consequential-action confirmation, expand the authorized scope, or authorize commits or pushes.

- LGTM: report the result and coverage gaps; stop.
- BLOCKED with confirmed in-scope findings: fix and verify them, then confirm the selected comparison actually contains the fixes before `spawn --prev-run-id=<id> --direction=<right|down>`. Unstaged fixes are invisible to `--staged`; ask before changing the user's staged selection. Worktree edits cannot change a fixed commit-ID range: stop and ask for an explicitly authorized revised target instead of re-reviewing identical commits. This workflow does not authorize committing. Scope, checkout and cap carry over; do not repeat their flags. State the round/cap each time.
- BLOCKED with only rejected findings: explain why and stop; do not fish for approval.
- Incomplete review or startup failure: report the blocker. Do not blindly replay a failed launch.
- At the cap: report remaining findings and let the user decide. Do not reset the loop to bypass the cap.

## Recovery and safety

- `status --run-id=<id>` is for explicit recovery, not polling; `list` finds runs owned by this coordinator pane.
- Pickup does not close panes or delete artifacts. Check the returned pane's live identity and idle state before closing a pane this workflow created; never force-close or target the focused pane by assumption. Ask if ownership or process state is uncertain.
- Runs remain under `~/.pi/agent/tmp/review-pane/`. No automatic pruning, destructive cleanup, model fallback, or force options.
- Reviewer tools: checkout-scoped reads, explicit-file searches, paginated fixed-scope diffs and an immutable verdict recorder. Patches require an exact approved changed-file path, including deleted files; directory pathspecs are rejected. Both sides of detected renames are checked, and a protected origin excludes its destination across the selected comparisons. Git clean/process/smudge filters are disabled for review reads, so patches compare unfiltered local content rather than running custom conversion commands. No arbitrary shell, edits, subagents, MCP or project extensions. The security gate remains loaded. These are application guardrails, not an OS sandbox.
- The existing `/claude-review` workflow remains separate for explicit Claude requests.
