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
  ├─ Chores → Agent tool (@tintinweb/pi-subagents) spawns isolated workers
  │           (worker, tests, lint, docs, git, memory, explorer,
  │            terminal-reader, log-reader, diff-reader)
  │           → live widget + FleetView; completion notification or inline result
  │           → run_in_background: true returns an agent id; /agents or x x to stop
  │           → isolation: "worktree" for parallel writers (lead merges)
  ├─ Images (text-only leads) → vision-router auto-runs vision fork
  │           → injects [VISION DESCRIPTION]
  ├─ /goal <task> → long-running loop: criteria + roadmap on disk, plan gate,
  │                 auto-continue until evidenced + human-reviewed
  └─ Human review → diffing is core: /plan (approve before coding),
                    /review (hand the diff to the human), /finish (apply
                    feedback), /diffing (router)
```

The lead owns every request end to end. It reasons, implements substantively,
and delegates only mechanical chores to cheap Flash workers, which run in
isolated sessions with their own context windows. Flash workers use OpenCode
Go GLM-5.3 Flash, then OpenCode Go DeepSeek V4 Flash, then ClinePass Flash as
the last resort. A multimodal lead (`xai/grok-4.6`, `openai-codex/gpt-5.6-sol-1m`,
ClinePass kimi/mimo/qwen) sees pasted images natively and nothing is routed.
A text-only lead (every `cursor/*` model) triggers `extensions/vision-router.ts`,
which forks a headless `pi -p` child down its own model chain and injects a
`[VISION DESCRIPTION]` block before the lead sees the turn. There is no vision
subagent. The lead model is never switched.

**Action flow:** request → route (lead / vision / one scoped worker) → optional
`/plan` approval → implement / delegate → tests & diagnostics → diff review
(`/review` → `/finish`). `/goal <task>` wraps that in a re-anchored cycle loop until
every accepted criterion has evidence and the human has reviewed it. The lead
owns design, debugging, fixes, review; workers do one chore and never recurse.

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
├── AGENTS.md              — always-on card (chore test, phase table,
│                             auto-spawn triggers, worker brief spec,
│                             worker-review gate, images, diffing, herdr)
├── SUBAGENTS.md           — Agent spawn + FleetView / viewer keymaps
├── subagents.json         — disableDefaultAgents, fallbackSubagent none,
│                             workflowsEnabled false, maxSubagentDepth 1
├── skills/harness-tdd/    — TDD bug loop (lead ↔ tests worker)
├── skills/harness-diff-read/ — inspect → path-scoped git → diff-reader
├── skills/harness-mockup/ — opt-in, lead-authored HTML mockups for diffing
├── skills/claude-review/  — independent Claude pane → human-approved fix plan
├── skills/goal/           — /goal loop playbook (cycles, roadmap, orchestration)
├── extensions/
│   ├── 00-paste-chips.ts  — [Image #N] / [Paste #N] chips (no remount)
│   ├── paste-images.ts    — decode pasted images to vision/
│   ├── efficiency/        — compress, fold, Flash compact, deferred tools,
│   │                         memory, thinking-router
│   ├── context-efficiency.ts — early compact on windows < 500k
│   ├── cursor-lazy/       — Cursor provider, loaded on demand by /cursor-load
│   ├── vision-router.ts   — auto vision for pasted images
│   ├── worker-model.ts    — worker model chain (OpenCode Go Flash → DeepSeek V4 Flash → ClinePass)
│   ├── opencode-fallback.ts — shared usage-limit detection
│   ├── security-gate.ts   — confirms risky commands, blocks protected paths
│   ├── todo.ts            — live task list behind /todos
│   ├── goal.ts            — /goal loop: criteria, roadmap, evidence, gates
│   ├── sol-1m-alias.ts    — openai-codex/gpt-5.6-sol-1m → gpt-5.6-sol
│   └── pi-tool-repair.json — grammar recovery for kimi/glm/qwen/minimax
├── npm/                   — pi packages (pi-subagents, vim, …)
├── themes/rose-pine.json  — card chrome + high-contrast TUI syntax
├── agents/                — 10 workers
├── prompts/               — /diffing /plan /review /finish /commit /implement /explore /verify /debug /delegate /claude-review
├── tmp/                   — gitignored: tool-dumps
├── memory/                — gitignored: global MEMORY.md slugs
├── goals/                 — gitignored: per-cwd GOAL.md + state.json
├── tests/                 — bun test for the /goal state machine
└── vision/                — decoded pasted images (pruned after 7 days)
```

## Model Inventory

`settings.json` is authoritative. **Default:** `xai/grok-4.6` @ medium.
**Ctrl+P cycles `enabledModels` (in order):**

| Model | Provider | Role |
| ------- | ---------- | ------ |
| `xai/grok-4.6` | xai | Default lead — 500K context |
| `openai-codex/gpt-5.6-sol` | openai-codex | Lead — 272K window |
| `openai-codex/gpt-5.6-sol-1m` | openai-codex | Lead — 1.05M context |
| `opencode-go/deepseek-v4-pro` | Go bundle | Lead |
| `clinepass/cline-pass/deepseek-v4-pro` | ClinePass | Lead — subscription quota |
| `opencode-go/deepseek-v4-flash` | Go bundle | Worker Flash / cheap compact |
| `clinepass/cline-pass/deepseek-v4-flash` | ClinePass | Worker Flash — subscription quota |
| `opencode-go/glm-5.3` | Go bundle | Lead |
| `clinepass/cline-pass/glm-5.3` | ClinePass | Lead — subscription quota |
| `opencode-go/glm-5.3-flash` | Go bundle | Worker Flash |

Cursor models are deliberately out of the Ctrl+P cycle. The Cursor provider is no longer registered at startup, so `enabledModels` cannot resolve `cursor/*` entries there and listing them only produced boot warnings. Run `/cursor-load` once to register the provider, then pick Cursor models with `/model`.

Everything else stays on `/model` (not the cycle): Terra, MiniMax, and the
remaining ClinePass slugs. `opencode/deepseek-v4-flash-free` is auto-provisioned
outside the cycle and used by `efficiency/cheap-compact.ts` for compaction.

ClinePass is a custom OpenAI-compatible provider in `models.json`
(`https://api.cline.bot/api/v1`). Auth is `$CLINE_API_KEY` — create a key at
[app.cline.bot](https://app.cline.bot) → Settings → API Keys. Hits count against
the ClinePass quota, not per-token billing. Cost figures in `models.json` are
Cline's reference rates for usage display only.

Default lead `xai/grok-4.6` is a custom merge in `models.json`: openai-responses
API, 500K context, $2/$6 (long-context $4/$12 above 200K input), thinking
low/medium/high/xhigh.

`gpt-5.6-sol-1m` is 1.05M context (rewrites to upstream `gpt-5.6-sol`;
long-context pricing above 272K input).

## Agents (workers)

| Agent | Model | Tools | Role |
| ------- | ------- | ------ | ------ |
| `worker` | flash | full | Mechanical impl, CRUD, fixtures, refactors |
| `tests` | flash | full | Write/run tests, report failing assertion |
| `lint` | flash | full | Format, lint, imports, style |
| `docs` | flash | full | READMEs, docs, comments |
| `git` | flash | read, bash | Commit msgs, PR summaries (never commits) |
| `memory` | flash | full | Repository memory |
| `explorer` | flash | read, bash, grep, find, ls | Research/mapping (read-only) |
| `terminal-reader` | flash | none | Compress terminal output |
| `log-reader` | flash | none | Compress logs |
| `diff-reader` | flash | none | Compress a **path-scoped** dump (inspect first) |

Workers are **depth 1** — they never spawn workers. Flash workers use
`opencode-go/glm-5.3-flash`, falling back to `opencode-go/deepseek-v4-flash`,
then `clinepass/cline-pass/deepseek-v4-flash` (last resort) when the earlier
options are unauthed **or out of usage**. Each agent pins its own `thinking`
and `max_turns` in frontmatter. The lead is never switched
(`extensions/worker-model.ts`). Spawn with `Agent({ subagent_type, prompt, description })`.
Background: `run_in_background: true`; await with `get_subagent_result` or `/agents`.
Steer with `steer_subagent` or `@handle`. Parallel writers: `isolation: "worktree"`;
the lead merges. Keymaps: [SUBAGENTS.md](SUBAGENTS.md).

## Token controls

`extensions/efficiency/` plus `context-efficiency.ts`. Reload with `/reload`.

| Command | What |
| --------- | ------ |
| `/microcompact [on\|off\|status]` | Fold old tool dumps in outgoing context |
| `/tools` / `/tools reset` | Deferred package extras vs core set |
| `/memory` / `/memory refresh` | Show memory file + size / print the exact `memory` spawn brief |
| `/thinking-router [on\|off\|status]` | Auto thinking from the prompt |
| `/context-efficiency` | Small-window early compact status |
| `/compact` | Stock compact, summarized by Flash when available |

Huge bash/read results are capped at ingest (dump under `~/.pi/agent/tmp/tool-dumps/`). Core tools stay on; `tool_search` activates the rest. Shift+Tab locks thinking-router until `/thinking-router on`.

Diffs: inspect first (`summary` with `directories` + optional `--exclude lockfiles` → `--path` files/hunks/slice/search; skill `harness-diff-read`). If inspect ignores `--path` or has no session: path-scoped `git diff`. `diff-reader` last, never the whole tree.

`/thinking-router` sets thinking from the prompt (Shift+Tab locks until `/thinking-router on`).

## Diffing is core

Human-in-the-loop review is the default workflow, not an add-on:

| Command | What it does |
| --------- | -------------- |
| `/plan <what>` | Draft a plan → submit to diffing → **await human approval before coding** |
| `/review` | Start/reopen the diffing review UI for working-tree changes, hand to human |
| `/finish` | Process the human's review handoff — apply edits, answer, resolve threads |
| `/diffing <route>` | Router: start / finish / plan / mockup / pr / status |
| `/implement <query>` | explore → plan → diffing approval → implement → verify → review |

Rules enforced in `AGENTS.md`: mockups are opt-in (user asked or accepted a
suggestion) and lead-authored (never a worker); always print the
review/plan/mockup URL before awaiting; plans and mockup sources live under
`~/.diffing/` never in the consumer tree; never mutate GitHub without explicit
authorization. Skills from `~/.agents/skills/diffing*/` are auto-loaded
(including `diffing-mockup-author`).
Read diffs with inspect (`harness-diff-read`); do not dump the whole patch into
`diff-reader`.

## Goal loop (`/goal`)

Keep the lead on one task across re-anchored cycles until every accepted
criterion has evidence, the lead has verified it, and the human has reviewed
it. Chat is not memory — `~/.pi/agent/goals/<cwd-hash>/GOAL.md` is. Reload with
`/reload`.

| Command | What |
| --------- | ------ |
| `/goal <task>` | Editor for criteria → plan-before-code → cycle until done |
| `/goal status` | Phase, cycle, criteria, roadmap, unread agent handles |
| `/goal stop` | Halt auto-continue |
| `/goal continue` | Resume after a gate, stall, interrupt, or reload |
| `/goal file` | Print the GOAL.md path |

The tool holds the gates: evidence must name what was seen (a rubber stamp is
rejected), `set_criteria` carries evidence across a rewrite and refuses to drop
an evidenced criterion without `force`, `write`/`edit` inside the project are
blocked until `goal plan_approved` records the human's verdict, and `goal done`
needs every criterion evidenced **and** a review newer than the last evidence
change. Three cycles with no new evidence and no tree change block the loop.
Compaction happens at a cycle boundary only past 55% of the window. Cycle cap
50; `/goal continue` raises it. Skill: `skills/goal/SKILL.md`.

## Herdr coordination

Inside herdr (`HERDR_ENV=1`), pi and diffing expose two machine-readable markers
so panes coordinate without reading each other's scrollback:

- `DIFFING_READY <url> mode=web|gh-pr pid=<pid>` — diffing server stderr, once
  listening. Open a session with MCP `start_review_session` or a **background**
  `diffing --web --no-open` in this pane — never `herdr pane split` just for
  that. The tool output already has the URL.
- `DIFFING_VERDICT <plan|mockup|review> decision=<…>` — surfaced in the pi pane
  (notify + widget) after each await verdict. Grep via `herdr pane read`.

Recipes (tests during a parked review, parallel agents + `wait agent-status`)
live in the `diffing` skill's "herdr coordination" section. Never edit the
herdr team's own skill (`~/.agents/skills/herdr/`) — keep diffing-specific
recipes in the diffing skill.

## Startup

Cold boot to an interactive TUI is about **1.4 s** — launch to first paint settling.

| Cost | Why |
| ------ | ----- |
| ~345 ms | Unavoidable floor: Node process start + pi's bundle + TUI init |
| ~565 ms | `pi-subagents` module load |
| ~217 ms | `pi-lens` module load (its own `session_start` is only ~25 ms) |
| ~127 ms | `diffing` extension |
| ~117 ms | `herdr-agent-state` — socket round-trip to herdr during `session_start` |

Deferring the Cursor SDK import cut ~630 ms, about a third of the previous boot.
Measured and rejected as non-factors: TypeScript transpilation costs ~5 ms per
extension, and `NODE_COMPILE_CACHE` saves only ~24 ms — the cost is module
execution, not V8 compilation.

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
| `@worker …` | Message / resume / start a subagent (empty prompt) |
| `↓` / `←` (empty prompt) | Jump into FleetView while workers run |
| `!cmd` / `!!cmd` | Run shell, send output to the model / hidden |
| `Alt+Enter` | Queue follow-up message |
| `Ctrl+V` | Paste image → auto vision routing |
| `alt+h/j/k/l` | Vim-style cursor movement in the editor |
| `/tree` `/fork` `/compact` | Session tools |
| `/goal <task>` | Loop until criteria are evidenced + reviewed |
| `/agents` | Manage / view / stop / steer running workers |
| `/microcompact` `/tools` `/memory` `/thinking-router` | Token controls |
| `pi -c` | Continue most recent session |
| `pi -r` | Browse and resume a session |

## Migration map (opencode → pi)

| opencode / Cursor | pi equivalent |
| ------------------- | --------------- |
| `agent/*.md` subagents | `agents/*.md` + `@tintinweb/pi-subagents` (`Agent` tool) |
| `image-router` plugin | `extensions/vision-router.ts` |
| `instructions/ai-engineering-system.md` | `AGENTS.md` |
| `command/diffing.md` | `prompts/diffing.md` + skills |
| Cursor `leader-worker.mdc` | `AGENTS.md` routing + chore rule |
| Cursor `explorer.md` / `worker.md` agents | `agents/explorer.md` / `agents/worker.md` |
| Cursor `no-co-authored-by.mdc` | `AGENTS.md` + `agents/git.md` |
| Cursor `diffing-plan-review.mdc` / `diffing-session-url.mdc` | `AGENTS.md` + `/plan` `/review` |
| Cursor CLI `vimMode` | `keybindings.json` + `externalEditor: nvim` + `pi-vim` |
| Cursor model `grok-4.6` | `/cursor-load`, then `/model` (out of the Ctrl+P cycle) |
| herdr plugin (`herdr-agent-state.js`) | `herdr` skill (auto-loaded) |

## Notes

- Extensions hot-reload with `/reload` after edits.
- Cursor provider is deferred and no longer loads at startup. `/cursor-load` registers it on demand (this is what makes `cursor/*` models selectable), `/cursor-load --refresh` fetches the live Cursor catalog and replaces the cache, `/cursor-unload` unregisters it. Setting the environment variable `PI_CURSOR_EAGER=1` restores the old boot-time registration. Install runtime deps only (`npm install --omit=dev`).
- Child workers are lean: `isolated: true` (no extensions/skills; the brief is the whole context; prevents recursion).
- `settings.json` is the single source of truth for model/thinking/compaction.
- Lead search is FFF in `override` mode (`find`/`grep` are FFF, not fd/rg). Workers still use built-in `find`/`grep` because they spawn `isolated`.
- Piolium is not a global package. Install it in the repo you are auditing.
- TUI: tool/user cards use rose-pine `surface`/`overlay`. Code blocks use the high-contrast rose-pine syntax map (iris keywords, rose functions, foam types/vars, gold strings/numbers). Pasted images and long inserts become `[Image #N]` / `[Paste #N · …]` chips (`extensions/00-paste-chips.ts`).
- Deferred tools: core coding tools stay on; package extras start off (`tool_search` / `/tools`).
- Auth: `opencode-go` and `opencode` API keys are in `~/.pi/agent/auth.json` (via `/login`). Cursor auth is the Cursor provider. ClinePass is `$CLINE_API_KEY` (app.cline.bot → Settings → API Keys).
