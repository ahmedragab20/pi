# pi — Personal AI Engineering Harness

Global config for [pi](https://pi.dev) — the pi-native port of the opencode AI
Engineering System (subagents + vision routing) merged with the Cursor
leader/worker and diffing-first workflow. Built for a nerd neovim user: vim
keybindings, nvim external editor, cheap Flash workers, human-in-the-loop
review everywhere.

The original opencode config lives at `~/.config/opencode/` and remains as a
reference; **pi is now the active harness.**

## Architecture — Smart Lead, Workers Follow

```
You → pi (the lead, any model via /model or Ctrl+P)
  ├─ Chores → task tool spawns isolated worker pi processes
  │           (worker, tests, lint, docs, git, memory, explorer,
  │            terminal-reader, log-reader, diff-reader + *-paid twins)
  │           → each hands its result back to the lead
  │           → free worker down → retry once with *-paid twin
  ├─ Images (non-vision leads) → vision-router auto-runs vision
  │           (gpt-5.6-luna) → vision-free (mimo) fallback → injects
  │           [VISION DESCRIPTION]
  └─ Human review → diffing is core: /plan (approve before coding),
                    /review (hand the diff to the human), /finish (apply
                    feedback), /diffing (router)
```

The lead owns every request end to end. It reasons, implements substantively,
and delegates only mechanical chores to cheap Flash workers, which run in
fresh `pi` processes with their own context windows and hand results back.
Each free worker has a `*-paid` twin (same role, paid DeepSeek V4 Flash) for
one retry when the free tier is unavailable.

**Action flow:** request → route (lead / vision / one scoped worker) → optional
`/plan` approval → implement / delegate → tests & diagnostics → diff review
(`/review` → `/finish`). The lead owns design, debugging, fixes, review;
workers do one chore and never recurse; vision describes images for the lead
with one `vision-free` fallback.

> **Accuracy overrides cost.** Never choose a cheaper path if it increases the
> chance of incorrect implementation, unsafe command, or data loss.

## Layout

```
~/.pi/agent/
├── settings.json          — default model (cursor/grok-4.5), thinking low
│                             level, compaction, retry, 19-model
│                             enabledModels cycle set, nvim editor;
│                             gpt-5.6-sol-1m is opt-in, not default
├── models.json            — model definitions (openai-codex/gpt-5.6-sol-1m:
│                             1.05M context, long-context pricing above 272K)
├── keybindings.json       — vim-style editing bindings
├── AGENTS.md              — THE AI Engineering System (routing, chore rule,
│                             task contract, TDD loop, diffing rules, no-attribution)
├── extensions/
│   ├── subagent/          — task tool: spawn workers (index.ts, agents.ts)
│   ├── cursor-lazy/       — registers the Cursor provider at startup from the
│   │                         disk-cached catalog (/cursor-load [--refresh],
│   │                         /cursor-unload)
│   ├── vision-router.ts   — auto vision delegation for pasted images
│   └── sol-1m-alias.ts    — rewrites only openai-codex/gpt-5.6-sol-1m requests
│                             → upstream gpt-5.6-sol
├── agents/                — 21 worker definitions (markdown + frontmatter)
├── prompts/               — /diffing /plan /review /finish /commit /implement /explore
└── vision/                — decoded pasted images (for manual vision fallback)
```

## Model Inventory

The approved scope is the 19 models in `enabledModels` (`agent/settings.json` is
authoritative).

| Model | Provider | Role |
|-------|----------|------|
| `openai-codex/gpt-5.6-sol` | openai-codex | Lead — low thinking, 272K window |
| `openai-codex/gpt-5.6-sol-1m` | openai-codex | Lead — opt-in 1.05M-context alias (rewrites to upstream `gpt-5.6-sol`; long-context pricing above 272K input) |
| `openai-codex/gpt-5.6-terra` | openai-codex | Lead — reasoning |
| `openai-codex/gpt-5.6-luna` | openai-codex | Lead — fast, vision |
| `cursor/grok-4.5` | Cursor | Lead — default, low thinking |
| `cursor/grok-4.5:fast` | Cursor | Lead — fast variant |
| `cursor/composer-2.5` | Cursor | Lead — Composer |
| `cursor/kimi-k3` | Cursor | Lead — coding |
| `cursor/glm-5.2` | Cursor | Lead — coding |
| `cursor/claude-fable-5@300k` | Cursor | Lead — Claude, standard 300K |
| `cursor/claude-fable-5@1m` | Cursor | Lead — Claude, opt-in 1M |
| `cursor/claude-opus-5@300k` | Cursor | Lead — Claude, standard 300K |
| `cursor/claude-opus-5@1m` | Cursor | Lead — Claude, opt-in 1M |
| `opencode-go/deepseek-v4-flash` | Go bundle | Paid worker twin |
| `opencode-go/glm-5.2` | Go bundle | Lead — coding |
| `opencode-go/kimi-k3` | Go bundle | Lead — coding |
| `opencode-go/minimax-m3` | Go bundle | Lead |
| `opencode-go/qwen3.8-max` | Go bundle | Lead — coding |
| `opencode-go/grok-4.5` | Go bundle | Lead |

`enabledModels` covers leads + the paid worker twin only. Worker free twins
(`opencode/deepseek-v4-flash-free`, `opencode/mimo-v2.5-free`) are
auto-provisioned outside the scope and still used by `agents/*.md`.

Cycle leads with `Ctrl+P` (set via `enabledModels`). Default is
`cursor/grok-4.5` at low thinking level. `openai-codex/gpt-5.6-sol` runs at
low effort with the standard 272K window; `gpt-5.6-sol-1m` is opt-in for
1.05M context. Same pattern on Cursor
Fable/Opus: `@300k` is the standard entry, `@1m` is opt-in.

## Agents (workers)

| Agent | Model | Tools | Role |
|-------|-------|-------|------|
| `worker` | flash-free | full | Mechanical impl, CRUD, fixtures, refactors |
| `tests` | flash-free | full | Write/run tests, report failing assertion |
| `lint` | flash-free | full | Format, lint, imports, style |
| `docs` | flash-free | full | READMEs, docs, comments |
| `git` | flash-free | read, bash | Commit msgs, PR summaries (never commits) |
| `memory` | flash-free | full | Repository memory |
| `explorer` | flash-free | read, bash, grep, find, ls | Research/mapping (read-only, from Cursor) |
| `terminal-reader` | flash-free | none | Compress terminal output → packet |
| `log-reader` | flash-free | none | Compress logs → packet |
| `diff-reader` | flash-free | none | Compress diffs → packet |
| `vision` | gpt-5.6-luna | read, bash | Describe images (auto-routed) |
| `vision-free` | mimo-free | read, bash | Free vision fallback |
| `*-paid` | deepseek-v4-flash | same | One retry when free tier is down |

Workers are **depth 1** — they never spawn workers.

## Diffing is core

Human-in-the-loop review is the default workflow, not an add-on:

| Command | What it does |
|---------|--------------|
| `/plan <what>` | Draft a plan → submit to diffing → **await human approval before coding** |
| `/review` | Start/reopen the diffing review UI for working-tree changes, hand to human |
| `/finish` | Process the human's review handoff — apply edits, answer, resolve threads |
| `/diffing <route>` | Router: start / finish / plan / pr / status |
| `/implement <query>` | explore → plan → diffing approval → implement → verify → review |

Rules enforced in `AGENTS.md`: always print the review/plan URL before
awaiting; plans live under `~/.diffing/` never in the consumer tree; never
mutate GitHub without explicit authorization. Skills from
`~/.agents/skills/diffing*/` are auto-loaded.

## Day-to-day

| Gesture | What |
|---------|------|
| `Ctrl+P` | Cycle lead model |
| `Shift+Tab` | Cycle thinking level |
| `Ctrl+G` | Open external editor (nvim) |
| `@file` | Reference a file in the prompt |
| `!cmd` / `!!cmd` | Run shell, send output to model / hidden |
| `Alt+Enter` | Queue follow-up message |
| `Ctrl+V` | Paste image → auto vision routing |
| `alt+h/j/k/l` | Vim-style cursor movement in the editor |
| `/tree` `/fork` `/compact` | Session tools |
| `pi -c` | Continue most recent session |
| `pi -r` | Browse and resume a session |

## Migration map (opencode → pi)

| opencode / Cursor | pi equivalent |
|-------------------|---------------|
| `agent/*.md` subagents | `agents/*.md` + `task` extension (isolated pi processes) |
| `image-router` plugin | `extensions/vision-router.ts` |
| `instructions/ai-engineering-system.md` | `AGENTS.md` |
| `command/diffing.md` | `prompts/diffing.md` + skills |
| Cursor `leader-worker.mdc` | `AGENTS.md` routing + chore rule |
| Cursor `explorer.md` / `worker.md` agents | `agents/explorer.md` / `agents/worker.md` |
| Cursor `no-co-authored-by.mdc` | `AGENTS.md` + `agents/git.md` |
| Cursor `diffing-plan-review.mdc` / `diffing-session-url.mdc` | `AGENTS.md` + `/plan` `/review` |
| Cursor CLI `vimMode` | `keybindings.json` + `externalEditor: nvim` |
| Cursor model `grok-4.5 high` | `enabledModels` includes `cursor/grok-4.5` (and `:fast` variant) |
| herdr plugin (`herdr-agent-state.js`) | `herdr` skill (auto-loaded) |

## Notes

- Extensions hot-reload with `/reload` after edits.
- Cursor provider registers at startup from `pi-cursor-sdk`'s disk-cached catalog (`extensions/cursor-lazy/`): `/cursor-load` confirms the provider is loaded, `/cursor-load --refresh` fetches the live Cursor catalog (refreshed scoping applies on `/new` or restart), `/cursor-unload` unregisters it.
- Child worker processes are lean: `--no-extensions --no-skills --no-prompt-templates --no-context-files` (the brief is the whole context; prevents recursion).
- `settings.json` is the single source of truth for model/thinking/compaction.
- Auth: `opencode-go` and `opencode` API keys are in `~/.pi/agent/auth.json` (via `/login`).
