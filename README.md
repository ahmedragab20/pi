# pi — Personal Config (Dotfiles for the Coding Agent Harness)

Personal configuration for [pi](https://pi.dev), the coding agent harness.
This repo is the pi-native port of the opencode AI Engineering System
(subagents + vision routing) merged with the Cursor leader/worker and
diffing-first workflow — stored as a dotfiles-style git repo at `~/.pi`.

**pi is the active harness.** Default lead: `cursor/grok-4.6` @ medium.

## Layout

```
~/.pi/
├── agent/                    — all pi config lives here
│   ├── AGENTS.md             — always-on rules (routing, chore, task
│   │                           contract, scoped diffs, no-attribution)
│   ├── skills/
│   │   ├── harness-tdd/      — TDD bug loop (on demand)
│   │   └── harness-diff-read/ — inspect → git → diff-reader
│   ├── agents/               — 11 visible workers + hidden paid/vision-free
│   ├── extensions/
│   │   ├── 00-fff-defaults.ts — PI_FFF_MODE=override, no $HOME index
│   │   ├── 00-paste-chips.ts — [Image #N] / [Paste #N] chips
│   │   ├── paste-images.ts   — decode pasted images to agent/vision/
│   │   ├── subagent/         — task: background jobs, packets, worktrees,
│   │   │                       spawn-layer paid retry (index, agents, jobs)
│   │   ├── harness-ux/       — /tasks Task Center, /palette, live footer
│   │   ├── efficiency/       — compress, fold, Flash compact, deferred
│   │   │                       tools, memory inject, git checkpoints,
│   │   │                       thinking-router
│   │   ├── context-efficiency.ts — early compact on small windows
│   │   ├── cursor-lazy/      — Cursor provider from disk-cached catalog
│   │   ├── vision-router.ts  — auto vision for pasted images
│   │   ├── sol-1m-alias.ts   — gpt-5.6-sol-1m → upstream gpt-5.6-sol
│   │   └── pi-tool-repair.json
│   ├── npm/                  — pi packages (fff, lens, vim, zentui, …)
│   ├── zentui.json           — OpenCode editor + Starship footer
│   ├── prompts/              — /diffing /plan /review /finish /commit
│   │                           /explore /implement
│   ├── themes/               — rose-pine (high-contrast TUI syntax)
│   ├── settings.json         — cursor/grok-4.6 default, Ctrl+P cycle,
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
  you, `/finish` applies feedback.
- Extensions hot-reload with `/reload`.

## Usage

- pi reads config from `~/.pi/agent`; this repo is the source of truth.
- Changes to extensions land on `/reload`; refreshed model scoping applies on
  `/new` or restart.
- `pi -c` continues the most recent session, `pi -r` browses sessions.

## Deep docs

Full architecture, model inventory, agent table, token commands, and
diffing workflow: [agent/README.md](agent/README.md).
