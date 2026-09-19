# Native Pi UI

Quiet by default, rich on demand. This presentation layer targets Pi 0.85.1 and
keeps Rosé Pine, fullscreen, Vim, paste chips, and existing safety boundaries.
It does not change models, reasoning levels, tools, or execution policy.

## Daily use

- `/ui`: workspace, Git, model, context estimate, latest cache hit rate, timing,
  task progress, integration statuses, and configured shortcut hints.
- `/ui preview`: a scrollable, explicitly synthetic component gallery. It runs
  no tools or models and does not change tasks or editor input.
- `/todos`: the current branch's task list. Long text wraps; every item is reachable.
- `/agents`: worker details. `/timing`: elapsed time for the current or last run.
- `/btw`: isolated side questions, with the existing history and copy controls.
- `Ctrl+O`: expand/collapse tool output. `Ctrl+T` or `Alt+T`: show/hide thinking.
  These are display controls; collapsed evidence remains available to the model.
- `Esc`: close owned panels. In the Vim editor, first Escape enters normal mode;
  Escape in normal mode passes through to Pi's interrupt action.
- `Ctrl+C`: clear the editor, then exit if empty. `Ctrl+D`: exit from an empty
  editor. `Ctrl+X` copies a message; it does not clear the editor.
- `Alt+Enter`: queue a follow-up. Native queue handling is unchanged.

Panels use configured selector arrows and page keys, plus Home/End. Their footer
shows the visible range and close/scroll controls. Extremely narrow panes may
truncate hints; widen the pane or use Escape. Fullscreen transcript navigation
continues outside overlays. `/hotkeys` is the full keybinding reference; `/ui`
shows common controls from the active keybinding manager, not a hardcoded map.

Thinking visibility follows the saved `hideThinkingBlock` preference. The quiet
recommendation is `true`; the current saved choice is `false` and was preserved
when it changed during verification. Tool output starts collapsed on startup and
a new session; reload, resume, and tree navigation do not repeatedly reset an
in-session expansion choice. No editor remount is performed by the UI layer.

## Design contract

- **Hierarchy:** operation/target first, outcome second, details on expansion.
  Assistant answers follow `AGENTS.md`: answer-first questions, findings-first
  reviews, and outcome/verification/gaps for implementation. This is writing
  guidance, not a deterministic prose formatter.
- **Color and vocabulary:** `accent` for running, `warning` for waiting/attention,
  `success` for confirmed completion, `error` for failure, `muted`/`dim` for
  secondary or cancelled state. Symbols supplement readable labels: ○ queued,
  ⠋ running, ? waiting, ✓ done, ✗ failed, – cancelled. Running indicators cycle
  `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` every 80 ms, including background workers, vision,
  and the synthetic preview. Animation stops when work settles or the preview
  closes. Never infer success from an abort or invent progress percentages.
- **Spacing:** compact native tool shells, one normal activity row above the
  editor, one prioritized footer. Owned overlays use square `┌ ┐ └ ┘` corners,
  continuous `─ │` borders, a title, body, and fixed controls; no rounded corners,
  extra decorative banners, or duplicate persistent statuses.
- **Width:** use real TUI ANSI/Unicode width, wrapping, and truncation helpers.
  Titles are terminal-control-safe single lines. Preserve result whitespace;
  wrap expanded bodies so their tails remain accessible. Never apply title
  normalization or display truncation to result evidence or model messages.
- **Theme:** render from live semantic theme tokens; do not cache styled strings
  across invalidation. No hardcoded palette or replacement theme is needed.

## Ownership

`extensions/ui/index.ts` owns normal activity and `/ui`. `activity.ts` holds
presentation state; `presentation.ts` and `panel.ts` provide the small shared
vocabulary, live components, width-priority fitting, and scrollable overlays.

`compact-footer.ts` owns stable identity and status. Unknown extension statuses
remain eligible for the visible row; additional statuses are indicated with a
count when space permits. Actionable status takes priority over model/project
metadata. Elevated context usage takes priority over ordinary identity fields.
Cache percentage appears directly beside `ctx` in the footer; `/ui` also shows
cache and integration telemetry. All statuses remain in its
scrollable details, including fields dropped from a narrow footer.

`todo.ts`, `working-timer.ts`, and `vision-router.ts` publish local snapshots or
activity through `ui/events.ts`; they do not each create their own activity row.
Worker and approval indicators reflect lifecycle events, not polling guesses.
Native retry, compaction, queue, permission, and question flows remain owned by
Pi or their existing extensions. Completed failures/cancellation remain visible
until a new run or relevant lifecycle reset.

`question-attention.ts` bridges `rpiv:ask-user:blocked` to `herdr:blocked` in TUI
sessions. Herdr reports “Question awaiting answer” until the questionnaire's
input wait ends, including cancellation and errors. Overlapping waits stay
blocked until all finish; reload/shutdown clears the bridge's own attention.
No question text, options, or answers are forwarded. This bridge works even if
the shared UI chrome is disabled and uses herdr's existing notification settings.

Todo, vision, and browser cards use shared presentation helpers. Native read,
edit, write, and bash rendering remains untouched, including highlighting,
diffs, truncation notices, and images. Browser headers omit typed values and URL
credentials/query/fragment; expanded output and failures retain wrapped detail.
Pi itself composes image attachments after the custom result renderer.

For a new local integration:

1. Reuse semantic helpers rather than copying ANSI colors or width arithmetic.
2. Publish presentation-only activity with a stable ID; remove it when consumed.
3. Reply to snapshot requests when state must survive extension load order.
4. Unsubscribe listeners and dispose timers on shutdown/reload.
5. Keep execution, schemas, results, confirmations, and editor ownership separate.
6. Test narrow widths, long Unicode text, invalidation, failures, and cleanup.

No renderer registry patching or duplicate tool registration is used. Third-party
ask-user, subagent, and lens cards keep their own renderers. Helpers are not a
universal plugin framework.

## Activation and rollback

Finish the current turn and let all workers stop before activating changes.
Restart Pi, optionally resuming with `pi -c` or `pi -r`, for a clean load of the
settings and extensions. Set `hideThinkingBlock: true` if you want the recommended
hidden-thinking default. `/reload` while idle refreshes extensions, but a restart
is the recommended way to apply a changed thinking-display default. This task
never hot-reloaded the live working session.

After restart, open `/ui preview`, resize the terminal, scroll to the bottom,
close it, and inspect `/todos`. Use the regular expansion/thinking shortcuts to
choose a different display for the session.

To keep or restore visible thinking by default, use `hideThinkingBlock: false`
in `agent/settings.json`. To disable the new chrome, use `pi config` to
disable the local `extensions/ui/index.ts` and `extensions/compact-footer.ts`
resources, then restart while idle. This restores native chrome; `/todos` and
`/timing` still work, but their unified activity row and `/ui` are absent.
Re-enable those same resources to restore it. Do not disable safety/browser/Vim
resources or remove the shared helper files imported by other local extensions.
For a complete rollback, reverse only this presentation change's reviewed hunks;
never reset the whole checkout or overwrite the unrelated npm manifest edits.
No session, credential, image, or history deletion is needed.

## Updates

Normal `pi update` and `pi update --extensions` operations do not replace these
local files under `agent/extensions/`. The implementation is version-controlled
here, outside npm's `node_modules/` and Pi's managed `agent/git/` clones. Do not
move customizations into those package directories or edit the generated
`herdr-agent-state.ts`; herdr may overwrite that file on update. Question attention
uses a separate local bridge and the question package's public blocked event.
Dependency versions and lockfiles may change during package updates as expected.

File preservation is not a guarantee of future API compatibility. This work was
verified with Pi 0.85.1; fullscreen is experimental, and upstream UI APIs or
third-party event contracts can change. After updating, run `npm run check --prefix
agent/npm` and `python3 agent/tests/ui-terminal-smoke.py` from this repository,
then restart while idle and check `/ui preview` and one real question/herdr alert.
The standard check includes the local UI and question-attention regressions.
These checks detect covered regressions; they neither block updates nor promise
compatibility with versions that have not been tested.

The older **user-message jump patch** documented in the repository README is an
installed-Pi patch, unrelated to this UI work. It is still overwritten by Pi
updates and must be reapplied separately if you want that behavior.

## Verification and boundaries

Run from the repository root:

```sh
npm run check --prefix agent/npm
bun test agent/tests/ui-regressions.test.ts agent/tests/unified-ui.test.ts agent/tests/question-attention.test.ts
bun test --preload ./agent/tests/extension-stubs.ts agent/tests/browser-ui.test.ts agent/tests/editor-ui.test.ts
python3 agent/tests/ui-terminal-smoke.py
```

`npm run check` includes the new UI suites via `test:ui`; the explicit Bun
commands above are useful for focused reruns. The PTY check remains separate.
Tests use installed TUI width utilities, synthetic task/image data, and isolated persistence. The PTY
check runs installed Pi and pi-vim with Rosé Pine, an empty HOME, offline mode,
no session persistence, and an input handler that prevents model calls. It checks
resize, scrolling, expansion, dialog return, draft preservation, Vim mode changes,
and native multiline paste expansion. Clipboard mirroring is disabled only in
that sandbox. Artifacts remain in ignored `agent/tmp/ui-smoke-*` directories.

Limitations: fullscreen is experimental upstream. These custom panels are TUI
only, not an RPC frontend. Worker activity is event-local, not reconstructed from
private worker histories; task state is reconstructed from the current branch.
Vision cards keep their existing session-local job lifetime. Real provider calls,
OS clipboard/image display protocols, mouse gestures, and every host terminal or
IME combination are not covered by the synthetic PTY test. No installed-package
patch was added or changed as part of this UI work.
