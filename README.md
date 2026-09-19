# pi — Personal Config

This repository is the source of truth for pi’s global configuration under `agent/`.
The default lead remains `openai-codex/gpt-6-astra` at low thinking. Normal work is
lead-owned and direct; delegate only substantial, independent, bounded chores.

## Optional worker

`agent/agents/worker.md` pins `openai-codex/gpt-5.6-luna` at medium thinking,
40 turns plus two wrap-up turns. No nested delegation or automatic model fallback.
Global settings allow one background and one foreground spawn slot; keep at most two
worker jobs active, including resumes. `/agents` remains available; FleetView, native
worker widgets, agent-mention routing, and scheduling are off. The shared UI row
shows worker lifecycle events without enabling those extra surfaces.

Workers use `isolated: false` with only the security gate active, and no inherited
skills, context files, or parent conversation. Frontmatter wins over caller parameters.
The loader discovers extension factories before filtering active handlers; this is not
an OS sandbox. Give the worker a goal, scope, and checks, then inspect its actual result.

Keep the browser, vision, diffing, mockup, herdr, and vim workflows and their security
boundaries. Images are native for multimodal leads; a text-only lead uses the registered
vision-router fallback, never a worker that cannot see images. Mockups remain opt-in and
lead-authored. Consequential actions require authorization. The security gate is
a preflight guardrail, not an OS sandbox. Never expose or commit secrets; keep the
extension `node_modules` symlink intact.

`agent_browser` (agent-browser 0.38, headless) is the only browser tool. Clicks and typing
run without prompts; calls marked `consequential` and uploads confirm unless the page is a
local dev server, and `/browser-confirm strict` restores per-click prompts. Workers load a
read-only `browser_verify` (`extensions/browser/browser-verify.ts`) for screenshots, diffs, console, and network
checks. Committed e2e tests use each project's own `@playwright/test` (`harness-e2e`).
Credential, workspace-path, and upload protections remain in place. Keep the browser
extension's `node_modules` intact.

Canonical check: `npm run check --prefix agent/npm`.

## Daily controls

`Ctrl+P` cycles lead models; `Shift+Tab` changes thinking level; `Ctrl+T`/`Alt+T`
toggles thinking display; `Ctrl+O` expands tool output. `Ctrl+C` clears the editor
then exits if empty; `Ctrl+D` exits from an empty editor; `Ctrl+X` copies a message.
`Esc` enters Vim normal mode, then passes through to Pi's interrupt action when
already in normal mode. `Ctrl+G` opens the external editor; `@file` references a
file; `!cmd` runs a shell command; `Alt+Enter` queues a follow-up; `Ctrl+V` pastes an
image; `alt+h/j/k/l` moves in the editor. Use `/tree`, `/fork`, `/compact`, `/review`,
`/finish`, `/plan`, `/diffing`, `/fast`, `/btw`, `/visualise`, and `/agents` as appropriate. `pi -c` resumes the latest session; `pi -r` browses sessions.
Astra/Sol 1M model aliases and lens/vim integrations remain enabled.
`/commit` drafts a message; `/commit-push` explicitly requests a scoped commit and push.

The native UI uses one activity row, a prioritized footer, and compact tool output.
Thinking visibility follows the saved preference. `/ui` shows full status and configured controls;
`/ui preview` opens synthetic examples; `/todos` is scrollable; `/timing` shows elapsed
time. See [the UI guide](agent/UI.md) for design conventions, ownership, verification,
activation, rollback, and compatibility limits.

Risky-command confirmations stay within 80% of terminal height. Use `↑`/`↓`,
`Page Up`/`Page Down`, or `Home`/`End` to scroll the complete command; `Tab` or
`←`/`→` chooses No/Yes, and `Enter` confirms. No is selected by default;
`Esc` or `Ctrl+C` cancels. Approval controls stay visible while scrolling.
While a risky-command dialog is open, Pi reports “Risky command approval” to
herdr's attention state, clearing it when the dialog closes. Background alerts
follow your existing herdr notification/sound settings; command text is not sent.

`ask_user_question` also reports “Question awaiting answer” while waiting for you.
`question-attention.ts` bridges the question tool's public wait event to the same
herdr attention signal, clearing it after an answer, cancellation, or error.
Question and answer text are never included; RPC/print runs do not alert a local pane.

Native compaction remains enabled and deferred tools remain available. Optional
worker-model and context-efficiency features are disabled by default; custom
compress/fold/memory code is dormant. `pi-intercom` and `pi-tool-repair` resources
are disabled by default, though packages remain installed. Re-enable these deliberately
through `agent/settings.json` resource filters and `agent/extensions/efficiency/index.ts`
registrations. Worker fallback is disabled; the existing vision fallback remains enabled.

## User-message jump patch (re-apply after pi updates)

`alt+up` / `alt+down` jump between user messages with a non-destructive
viewport scroll (like the built-in marked-message jump, but user-only).
Two small patches to the installed pi:

1. `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js`
   — remove the OSC 133 prompt markers from assistant rows, so marked rows
   are user messages only. In `render(width)`, drop the marker lines:

```js
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
// ...and in render(width), remove:
//   lines[0] = OSC133_ZONE_START + lines[0];
//   lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
```

   (Bonus: the built-in `ctrl+shift+up/down` fullscreen jump becomes
   user-message-only too.)

1. `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js`
   (`.../@earendil-works/pi-coding-agent/node_modules/...`) — make
   `scrollToPrompt(direction)` return `false` when no marker row is found
   (instead of bare `return`), then in `handleViewportInput` after
   `const isRelease = isKeyRelease(data);` insert:

```js
// PI HARNESS PATCH: alt+up / alt+down jump between user messages.
// User rows carry the OSC 133 prompt marker; assistant rows no
// longer do (assistant-message.js patch), so scrollToPrompt only
// lands on user messages. Non-destructive viewport scroll.
if (!this.hasOverlay() && matchesKey(data, "alt+up")) {
    if (!isRelease && !this.scrollToPrompt(-1))
        this.flash("Already at the first user message");
    return { consume: true };
}
if (!this.hasOverlay() && matchesKey(data, "alt+down")) {
    if (!isRelease && !this.scrollToPrompt(1))
        this.flash("Already at the latest user message");
    return { consume: true };
}
```

   `matchesKey` is already exported by `./keys.js`; add it to the existing
   `import { isKeyRelease } from "./keys.js";`.

## Maintenance

`agent/AGENTS.md` holds concise working/testing guidance; `agent/APPEND_SYSTEM.md`
holds hard safety rules. Restart Pi after changing extension or worker configuration
so its tool schemas and hooks are rebuilt. Do not reload while workers are active.

Existing histories, images, tool dumps, backups, models, and development checkouts are
preserved. Disabled sources and their tests remain during the trial; re-enable through
the scoped settings/entry-point changes if needed. This configuration has not been
benchmarked for speed or token savings.
