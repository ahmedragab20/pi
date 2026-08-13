# pi — Personal AI Engineering Harness

Global config for [pi](https://pi.dev) — the pi-native port of the opencode AI
Engineering System (subagents + vision routing) merged with the Cursor
leader/worker and diffing-first workflow. Built for a nerd neovim user: vim
keybindings, nvim external editor, cheap Flash workers, human-in-the-loop
review everywhere.

**pi is the active harness.** Default lead: `xai/grok-4.6` @ medium.

## Architecture — Smart Lead, Workers Follow

```
You → pi (the lead, any model via /model or Ctrl+P)
  ├─ Chores → task tool spawns isolated worker pi processes
  │           (11 visible: worker, tests, lint, docs, git, memory, explorer,
  │            terminal-reader, log-reader, diff-reader, vision)
  │           → packet stub back to the lead; full output on disk
  │           → quota/rate-limit retries once (paid Flash / vision-free)
  │           → background: true returns a job id; /task-cancel to stop
  │           → parallel writers get detached git worktrees (lead merges)
  ├─ Images (non-vision leads) → vision-router auto-runs vision
  │           (opencode-go/gpt-5.6-luna) → vision-free (mimo) fallback
  │           → injects [VISION DESCRIPTION]
  └─ Human review → diffing is core: /plan (approve before coding),
                    /review (hand the diff to the human), /finish (apply
                    feedback), /diffing (router)
```

The lead owns every request end to end. It reasons, implements substantively,
and delegates only mechanical chores to cheap Flash workers, which run in
fresh `pi` processes with their own context windows and hand a stub + packet
path back. Spawn retries quota/rate-limit/auth once on paid Flash (`fallbackModel`)
or `vision-free` (`fallbackAgent`). Hidden `*-paid` files still resolve if named.

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
├── settings.json          — default xai/grok-4.6 @ medium, Ctrl+P cycle
│                             (enabledModels), compact TUI, nvim editor
├── models.json            — model definitions (xai/grok-4.6: 500K context,
│                             $2/$6, long-context $4/$12 above 200K input;
│                             openai-codex/gpt-5.6-sol-1m: 1.05M context,
│                             long-context pricing above 272K)
├── keybindings.json       — vim-style editing; Ctrl+C interrupts, Esc is vim
├── AGENTS.md              — always-on card (routing, chore, task contract,
│                             scoped diffs, no-attribution)
├── skills/harness-tdd/    — TDD bug loop (progressive disclosure)
├── skills/harness-diff-read/ — inspect → path-scoped git → diff-reader
├── extensions/
│   ├── 00-fff-defaults.ts — PI_FFF_MODE=override, FFF_ENABLE_HOME_SCAN=0
│   ├── 00-paste-chips.ts  — [Image #N] / [Paste #N] chips (no remount)
│   ├── paste-images.ts    — decode pasted images to vision/
│   ├── subagent/          — task: jobs, packets, worktrees, paid retry
│   ├── harness-ux/        — /tasks, /palette, live "◐ N tasks" footer
│   ├── efficiency/        — compress, fold, Flash compact, deferred tools,
│   │                         memory, git checkpoints, thinking-router
│   ├── context-efficiency.ts — early compact on windows < 500k
│   ├── cursor-lazy/       — Cursor provider from disk-cached catalog
│   ├── vision-router.ts   — auto vision for pasted images
│   ├── sol-1m-alias.ts    — openai-codex/gpt-5.6-sol-1m → gpt-5.6-sol
│   └── pi-tool-repair.json — grammar recovery for kimi/glm/qwen/minimax
├── npm/                   — pi packages (fff, lens, vim, zentui, …)
├── zentui.json            — OpenCode editor + Starship footer (default)
├── themes/rose-pine.json  — card chrome + high-contrast TUI syntax
├── agents/                — 11 visible workers + hidden paid/vision-free twins
├── prompts/               — /diffing /plan /review /finish /commit /implement /explore
├── tmp/                   — gitignored: tool-dumps, packets, worktrees
├── memory/                — gitignored: global MEMORY.md slugs
└── vision/                — decoded pasted images (pruned after 7 days)
```

## Model Inventory

`settings.json` is authoritative. **Default:** `xai` / `grok-4.6` @ medium.
**Ctrl+P cycles `enabledModels` (in order):**

| Model | Provider | Role |
| ------- | ---------- | ------ |
| `opencode-go/deepseek-v4-pro` | Go bundle | Lead |
| `xai/grok-4.6` | xai | Default lead — 500K context |
| `cursor/grok-4.6` | Cursor | Lead |
| `openai-codex/gpt-5.6-sol` | openai-codex | Lead — 272K window |
| `cursor/claude-fable-5@300k` | Cursor | Lead — Claude, standard 300K |
| `opencode-go/kimi-k3` | Go bundle | Lead — coding |
| `opencode-go/deepseek-v4-flash` | Go bundle | Paid worker twin / cheap compact |
| `cursor/composer-2.5` | Cursor | Lead |
| `openai-codex/gpt-5.6-sol-1m` | openai-codex | Opt-in 1.05M context |
| `cursor/claude-opus-5@300k` | Cursor | Lead — Opus, standard 300K |
| `cursor/kimi-k3` | Cursor | Lead |

Everything else stays on `/model` (not the cycle): Terra, Luna, GLM, Opus `@1m`,
Fable `@1m`, MiniMax, Qwen. Worker free twins (`opencode/deepseek-v4-flash-free`,
`opencode/mimo-v2.5-free`) are auto-provisioned outside the cycle and still
used by `agents/*.md`.

Default lead `xai/grok-4.6` is a custom merge in `models.json`: openai-responses
API, 500K context, $2/$6 (long-context $4/$12 above 200K input), thinking
low/medium/high/xhigh.

`gpt-5.6-sol-1m` is opt-in 1.05M context (rewrites to upstream `gpt-5.6-sol`;
long-context pricing above 272K input). Same pattern on Cursor Fable/Opus:
`@300k` is the standard entry, `@1m` is opt-in.

## Agents (workers)

| Agent | Model | Tools | Role |
| ------- | ------- | ------ | ------ |
| `worker` | flash-free | full | Mechanical impl, CRUD, fixtures, refactors |
| `tests` | flash-free | full | Write/run tests, report failing assertion |
| `lint` | flash-free | full | Format, lint, imports, style |
| `docs` | flash-free | full | READMEs, docs, comments |
| `git` | flash-free | read, bash | Commit msgs, PR summaries (never commits) |
| `memory` | flash-free | full | Repository memory |
| `explorer` | flash-free | read, bash, grep, find, ls | Research/mapping (read-only) |
| `terminal-reader` | flash-free | none | Compress terminal output → packet |
| `log-reader` | flash-free | none | Compress logs → packet |
| `diff-reader` | flash-free | none | Compress a **path-scoped** dump → packet (inspect first) |
| `vision` | gpt-5.6-luna | read, bash | Describe images (auto-routed) |

Workers are **depth 1** — they never spawn workers. Each primary (except vision)
has `fallbackModel: opencode-go/deepseek-v4-flash`. Vision retries `vision-free`.
Hidden `*-paid` / `vision-free` files still resolve if you pass the name.

Background jobs: `background: true` on `task` (not with chain). `/task-await [id]`,
`/task-cancel [id]`. Parallel 2+ writers auto-detach to
`~/.pi/agent/tmp/worktrees/<jobId>`; the lead merges. Packets live under
`~/.pi/agent/tmp/packets/`.

## Token controls

`extensions/efficiency/` plus `context-efficiency.ts`. Reload with `/reload`.

| Command | What |
| --------- | ------ |
| `/microcompact [on\|off\|status]` | Fold old tool dumps in outgoing context |
| `/tools` / `/tools reset` | Deferred extras (pi-lens) vs core set |
| `/memory` / `/memory refresh` | Show / how to refresh MEMORY.md |
| `/thinking-router [on\|off\|status]` | Auto thinking from the prompt |
| `/context-efficiency` | Small-window early compact status |
| `/compact` | Stock compact, summarized by Flash when available |

Huge bash/read results are capped at ingest (dump under `~/.pi/agent/tmp/tool-dumps/`). Core tools stay on; `tool_search` activates the rest. Shift+Tab locks thinking-router until `/thinking-router on`.

Diffs: inspect first (`summary` with `directories` + optional `--exclude lockfiles` → `--path` files/hunks/slice/search; skill `harness-diff-read`). If inspect ignores `--path` or has no session: path-scoped `git diff`. `diff-reader` last, never the whole tree.

`/fork` offers to restore a per-turn `git stash create` checkpoint. `/thinking-router` sets thinking from the prompt (Shift+Tab locks until `/thinking-router on`).

## Diffing is core

Human-in-the-loop review is the default workflow, not an add-on:

| Command | What it does |
| --------- | -------------- |
| `/plan <what>` | Draft a plan → submit to diffing → **await human approval before coding** |
| `/review` | Start/reopen the diffing review UI for working-tree changes, hand to human |
| `/finish` | Process the human's review handoff — apply edits, answer, resolve threads |
| `/diffing <route>` | Router: start / finish / plan / pr / status |
| `/implement <query>` | explore → plan → diffing approval → implement → verify → review |

Rules enforced in `AGENTS.md`: always print the review/plan URL before
awaiting; plans live under `~/.diffing/` never in the consumer tree; never
mutate GitHub without explicit authorization. Skills from
`~/.agents/skills/diffing*/` are auto-loaded. Read diffs with inspect
(`harness-diff-read`); do not dump the whole patch into `diff-reader`.

## Day-to-day

| Gesture | What |
| --------- | ------ |
| `Ctrl+P` | Cycle lead model (`enabledModels` in settings.json) |
| `Shift+Tab` | Cycle thinking level (default medium) |
| `Ctrl+C` | Interrupt / abort the agent |
| `Ctrl+X` | Clear the editor (first) / exit (second) |
| `Esc` | pi-vim: Insert → Normal (does not abort) |
| `Ctrl+G` | Open external editor (nvim) |
| `@file` | Reference a file in the prompt |
| `!cmd` / `!!cmd` | Run shell, send output to the model / hidden |
| `Alt+Enter` | Queue follow-up message |
| `Ctrl+V` | Paste image → auto vision routing |
| `alt+h/j/k/l` | Vim-style cursor movement in the editor |
| `/tree` `/fork` `/compact` | Session tools |
| `/tasks` `/task-await` `/task-cancel` | Task Center / wait / cancel background jobs |
| `/palette` | Fuzzy command palette (sessions, actions, models) |
| `/microcompact` `/tools` `/memory` `/thinking-router` | Token controls |
| `pi -c` | Continue most recent session |
| `pi -r` | Browse and resume a session |

## Migration map (opencode → pi)

| opencode / Cursor | pi equivalent |
| ------------------- | --------------- |
| `agent/*.md` subagents | `agents/*.md` + `task` extension (isolated pi processes) |
| `image-router` plugin | `extensions/vision-router.ts` |
| `instructions/ai-engineering-system.md` | `AGENTS.md` |
| `command/diffing.md` | `prompts/diffing.md` + skills |
| Cursor `leader-worker.mdc` | `AGENTS.md` routing + chore rule |
| Cursor `explorer.md` / `worker.md` agents | `agents/explorer.md` / `agents/worker.md` |
| Cursor `no-co-authored-by.mdc` | `AGENTS.md` + `agents/git.md` |
| Cursor `diffing-plan-review.mdc` / `diffing-session-url.mdc` | `AGENTS.md` + `/plan` `/review` |
| Cursor CLI `vimMode` | `keybindings.json` + `externalEditor: nvim` + `pi-vim` |
| Cursor model `grok-4.6` | `enabledModels` includes `cursor/grok-4.6` |
| herdr plugin (`herdr-agent-state.js`) | `herdr` skill (auto-loaded) |

## Notes

- Extensions hot-reload with `/reload` after edits.
- Cursor provider registers at startup from `pi-cursor-sdk`'s disk-cached catalog (`extensions/cursor-lazy/`): `/cursor-load` confirms the provider is loaded, `/cursor-load --refresh` fetches the live Cursor catalog (refreshed scoping applies on `/new` or restart), `/cursor-unload` unregisters it. Install runtime deps only (`npm install --omit=dev`).
- Child worker processes are lean: `--no-extensions --no-skills --no-prompt-templates --no-context-files` (the brief is the whole context; prevents recursion).
- `settings.json` is the single source of truth for model/thinking/compaction.
- Lead search is FFF in `override` mode (`find`/`grep` are FFF, not fd/rg). Workers still use built-in `find`/`grep` because they spawn with `--no-extensions`.
- Piolium is not a global package. Install it in the repo you are auditing.
- pi-lens config lives at `~/.pi-lens/config.json` (widget/tests/opengrep off).
- TUI: `pi-zentui` draws the OpenCode-style editor and the Starship footer (`/zentui` to tweak). Tool/user cards use rose-pine `surface`/`overlay`. Code blocks use the high-contrast rose-pine syntax map (iris keywords, rose functions, foam types/vars, gold strings/numbers). Pasted images and long inserts become `[Image #N]` / `[Paste #N · …]` chips (`extensions/00-paste-chips.ts`).
- Deferred tools: core coding tools stay on; pi-lens LSP/ast-grep and package extras start off (`tool_search` / `/tools`).
- Auth: `opencode-go` and `opencode` API keys are in `~/.pi/agent/auth.json` (via `/login`). Cursor auth is the Cursor provider.
