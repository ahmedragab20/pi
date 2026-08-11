# pi — Personal Config (Dotfiles for the Coding Agent Harness)

Personal configuration for [pi](https://pi.dev), the coding agent harness.
This repo is the pi-native port of the opencode AI Engineering System
(subagents + vision routing) merged with the Cursor leader/worker and
diffing-first workflow — stored as a dotfiles-style git repo at `~/.pi`.

**pi is the active harness.**

## Layout

```
~/.pi/
├── agent/                    — all pi config lives here
│   ├── AGENTS.md             — the system rules (routing, chore rule, task
│   │                           contract, TDD loop, diffing rules, no-attribution)
│   ├── agents/               — 21 worker definitions (markdown + frontmatter)
│   ├── extensions/
│   │   ├── subagent/         — task tool: spawns isolated worker processes
│   │   ├── cursor-lazy/      — registers the Cursor provider at startup
│   │   │                       from the disk-cached catalog
│   │   ├── vision-router.ts  — auto vision delegation for pasted images
│   │   ├── sol-1m-alias.ts   — rewrites gpt-5.6-sol-1m → upstream gpt-5.6-sol
│   │   └── context-efficiency.ts
│   ├── prompts/              — /diffing /plan /review /finish /commit
│   │                           (+ /explore /implement)
│   ├── themes/               — rose-pine.json
│   ├── settings.json         — default model, thinking level, compaction
│   ├── models.json           — model definitions
│   └── keybindings.json      — vim-style editing bindings
└── .gitignore
```

`agent/auth.json` and `agent/models-store.json` are gitignored (secrets),
along with machine-specific `trust.json` / cursor-sdk model cache,
`agent/sessions/` (transcripts), `agent/vision/` (pasted images), and the
local `agent/extensions/diffing` symlink.

## How it works

- You are the lead (any model via `/model` or `Ctrl+P`); workers are cheap
  Flash subprocesses that do one chore and hand results back.
- Diffing is the review loop: `/plan` approves before coding, `/review` hands
  the diff to you, `/finish` applies your feedback.
- Extensions hot-reload with `/reload`.

## Usage

- pi reads config from `~/.pi/agent`; this repo is the source of truth.
- Changes to extensions land on `/reload`; refreshed model scoping applies on
  `/new` or restart.
- `pi -c` continues the most recent session, `pi -r` browses sessions.

## Deep docs

Full harness architecture, model inventory, agent table, and diffing workflow:
see [agent/README.md](agent/README.md).
