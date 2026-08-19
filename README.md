# pi — Personal Config (Dotfiles for the Coding Agent Harness)

Personal configuration for [pi](https://pi.dev), the coding agent harness.
This repo is the pi-native port of the opencode AI Engineering System
(subagents + vision routing) merged with the Cursor leader/worker and
diffing-first workflow — stored as a dotfiles-style git repo at `~/.pi`.

**pi is the active harness.** Default lead: `xai/grok-4.6` @ medium.

## Layout

```
~/.pi/
├── agent/                    — all pi config lives here
│   ├── AGENTS.md             — always-on rules (routing, chore, task
│   │                           contract, scoped diffs, no-attribution)
│   ├── skills/
│   │   ├── harness-tdd/      — TDD bug loop (on demand)
│   │   ├── harness-diff-read/ — inspect → git → diff-reader
│   │   └── harness-auto-plan/ — opt-in herdr plan→implement→reviewer LGTM loop
│   ├── agents/               — 11 visible workers + hidden paid/vision-free
│   ├── extensions/
│   │   ├── 00-fff-defaults.ts — PI_FFF_MODE=override, no $HOME index
│   │   ├── 00-paste-chips.ts — [Image #N] / [Paste #N] chips
│   │   ├── paste-images.ts   — decode pasted images to agent/vision/
│   │   ├── subagent/         — task: background jobs, packets, worktrees,
│   │   │                       spawn-layer paid retry (index, agents, jobs)
│   │   ├── efficiency/       — compress, fold, Flash compact, deferred
│   │   │                       tools, memory inject, git checkpoints,
│   │   │                       thinking-router
│   │   ├── context-efficiency.ts — early compact on small windows
│   │   ├── cursor-lazy/      — Cursor provider from disk-cached catalog
│   │   ├── vision-router.ts  — auto vision for pasted images
│   │   ├── sol-1m-alias.ts   — gpt-5.6-sol-1m → upstream gpt-5.6-sol
│   │   └── pi-tool-repair.json
│   ├── npm/                  — pi packages (fff, vim, …)
│   ├── prompts/              — /diffing /plan /review /finish /commit
│   │                           /explore /implement /auto-plan
│   ├── themes/               — rose-pine (high-contrast TUI syntax)
│   ├── settings.json         — xai/grok-4.6 default, Ctrl+P cycle,
│   │                           compact TUI, nvim editor
│   ├── models.json           — model definitions
│   └── keybindings.json      — vim-style editing; Ctrl+C interrupts
└── .gitignore
```

Gitignored: `auth.json`, `models-store.json`, `trust.json`, Cursor SDK
cache, `sessions/`, `vision/`, `tmp/` (tool-dumps, packets, worktrees),
`memory/`, `waiting/`, and the local `extensions/diffing` symlink.

Piolium is not loaded globally. Install it in the target repo when you audit.

## How it works

- You are the lead (any model via `/model` or `Ctrl+P`); workers are cheap
  Flash subprocesses. Blocking `task` is default; `background: true` returns
  a job id. Results are a stub + packet path; quota retries once in spawn.
- Diffs: inspect first (`summary` → `--path` files/slice). Path-scoped
  `git diff` next. `diff-reader` last, never the whole tree.
- Diffing review loop: `/plan` before coding, `/review` hands the diff to
  you, `/finish` applies feedback. Opt-in `/auto-plan` (herdr only) adds an
  independent xhigh reviewer pane that loops a worker until `LGTM.`
- Extensions hot-reload with `/reload`.

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

## Usage

- pi reads config from `~/.pi/agent`; this repo is the source of truth.
- Changes to extensions land on `/reload`; refreshed model scoping applies on
  `/new` or restart.
- `pi -c` continues the most recent session, `pi -r` browses sessions.

## Deep docs

Full architecture, model inventory, agent table, token commands, and
diffing workflow: [agent/README.md](agent/README.md).
