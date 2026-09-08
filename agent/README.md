# pi — Personal AI Engineering Harness

Global config for [pi](https://pi.dev): a lead/worker engineering harness with
subagents, vision routing and a diffing-first review workflow. Built for a nerd
neovim user — vim keybindings, nvim external editor, cheap Luna workers,
human-in-the-loop review everywhere.

**pi is the active harness.** Default lead: `openai-codex/gpt-6-astra` @ low.

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
  └─ Human review → diffing is core: /plan (approve before coding),
                    /review (hand the diff to the human), /finish (apply
                    feedback), /diffing (router)
```

The lead owns every request end to end. It reasons, implements substantively,
and delegates only mechanical chores to cheap Luna workers, which run in
isolated sessions with their own context windows. Luna workers use
`gpt-5.6-luna` on the Codex provider, then the same model on the Go bundle.
A multimodal lead (`openai-codex/gpt-6-astra`, `openai-codex/gpt-6-astra-1m`,
`openai-codex/gpt-5.6-sol`, or `openai-codex/gpt-5.6-sol-1m`)
sees pasted images natively and nothing is routed.
A text-only lead — any model whose `input` lacks `image`, today
`openai-codex/gpt-5.3-codex-spark` — triggers `extensions/vision-router.ts`,
which forks a headless `pi -p` child down its own model chain and injects a
`[VISION DESCRIPTION]` block before the lead sees the turn. There is no vision
subagent. The lead model is never switched.

**Action flow:** request → route (lead / vision / one scoped worker) → optional
`/plan` approval → implement / delegate → tests & diagnostics → diff review
(`/review` → `/finish`). The lead owns design, debugging, fixes, and review;
workers do one chore and never recurse.

> **Accuracy overrides cost.** Never choose a cheaper path if it increases the
> chance of incorrect implementation, unsafe command, or data loss.

## Layout

```
~/.pi/agent/
├── settings.json          — default openai-codex/gpt-6-astra @ low, Ctrl+P cycle
│                             (enabledModels), compact TUI, nvim editor
├── models.json            — model definitions (openai-codex/gpt-5.6-sol-1m and
│                             gpt-6-astra-1m: 1.05M context, long-context
│                             pricing above 272K)
├── keybindings.json       — vim-style editing; Ctrl+C interrupts, Esc is vim
├── AGENTS.md              — always-on card (chore test, phase table,
│                             auto-spawn triggers, worker brief spec,
│                             worker-review gate, images, diffing, herdr)
├── APPEND_SYSTEM.md       — hard security rules appended to every system prompt
├── SUBAGENTS.md           — Agent spawn + FleetView / viewer keymaps
├── subagents.json         — disableDefaultAgents, fallbackSubagent none,
│                             workflowsEnabled false, maxSubagentDepth 1
├── skills/harness-tdd/    — TDD bug loop (lead ↔ tests worker)
├── skills/harness-diff-read/ — inspect → path-scoped git → diff-reader
├── skills/harness-mockup/ — opt-in, lead-authored HTML mockups for diffing
├── skills/claude-review/  — independent Claude pane → human-approved fix plan
├── skills/harness-browser/ — browser control rules (loaded on demand)
├── skills/harness-vision/ — pasted-image / vision-router rules (on demand)
├── skills/harness-diffing/ — diffing workflow policy (on demand)
├── skills/harness-herdr/  — herdr pane rules (on demand)
├── extensions/
│   ├── 00-paste-chips.ts  — [Image #N] / [Paste #N] chips (no remount)
│   ├── paste-images.ts    — decode pasted images to vision/
│   ├── efficiency/        — compress, fold, compaction coordinator,
│   │                         deferred tools, memory
│   ├── context-efficiency.ts — early compact on windows < 500k
│   ├── vision-router.ts   — auto vision for pasted images
│   ├── worker-model.ts    — worker model chain (Codex Luna → Go bundle Luna)
│   ├── process/           — shared helpers: agent thinking levels, child spawn
│   ├── usage-limits.ts    — shared quota / usage-limit detection
│   ├── security-gate.ts   — confirms risky commands, blocks protected paths
│   ├── security/          — canonical path resolution behind security-gate
│   ├── browser/           — agent_browser (agent-browser CLI) + Playwright
│   │                         fallback; screenshots return inline images
│   ├── todo.ts            — live task list behind /todos
│   ├── github-pr.ts       — current branch PR discovery, footer ID, agent context
│   ├── btw.ts             — /btw side question overlay (no tools, no history)
│   ├── visualise.ts       — /visualise architecture/topic flow diagrams
│   ├── fast.ts            — /fast toggles OpenAI priority processing
│   ├── compact-footer.ts  — footer context-usage percent + chrome
│   ├── working-timer.ts   — status bar elapsed time + thinking level
│   ├── herdr-agent-state.ts — herdr-managed state reporting (do not hand-edit)
│   ├── diffing            — symlink to the diffing product's pi extension
│   ├── astra-1m-alias.ts  — openai-codex/gpt-6-astra-1m → gpt-6-astra
│   ├── sol-1m-alias.ts    — openai-codex/gpt-5.6-sol-1m → gpt-5.6-sol
│   └── pi-tool-repair.json — grammar recovery for kimi/glm/qwen/minimax
├── npm/                   — pi packages (subagents, vim, lens, intercom,
│                             tool-repair, ask-user-question)
├── themes/rose-pine.json  — card chrome + high-contrast TUI syntax
├── agents/                — 10 workers
├── prompts/               — /diffing /plan /review /finish /commit /commit-push
│                             /implement /explore /verify /debug /delegate /claude-review
├── tests/                 — bun tests for extensions and gates
├── tsconfig.json          — strict typecheck over extensions/ and tests/
├── models-store.json      — cached provider model catalogs
├── trust.json             — per-directory project trust decisions
├── visualisations/        — /visualise output (tracked)
├── tmp/                   — gitignored: tool-dumps
├── memory/                — gitignored: global MEMORY.md slugs
├── browser-artifacts/     — gitignored: browser screenshots and PDFs
├── collaborations/        — gitignored: intercom collaboration state
├── intercom/              — gitignored: pending asks + extension state
├── goals/                 — gitignored: leftover goal state, extension removed
├── sessions/              — gitignored: session JSONL
├── sessions-archive/      — gitignored: rolled-off sessions
├── auth.json              — gitignored: provider credentials (never commit)
└── vision/                — decoded pasted images (pruned after 7 days)
```

## Model Inventory

`settings.json` is authoritative. **Default:** `openai-codex/gpt-6-astra` @ low.
**Ctrl+P cycles `enabledModels` (in order):**

| Model | Provider | Role |
| ------- | ---------- | ------ |
| `openai-codex/gpt-6-astra` | openai-codex | Default lead |
| `openai-codex/gpt-6-astra-1m` | openai-codex | Lead — 1M alias |
| `openai-codex/gpt-5.3-codex-spark` | openai-codex | Lead — text-only |
| `openai-codex/gpt-5.6-sol` | openai-codex | Lead — 272K window |
| `openai-codex/gpt-5.6-sol-1m` | openai-codex | Lead — 1.05M context |

Everything else stays on `/model` (not the cycle).

Default lead `openai-codex/gpt-6-astra` uses the built-in Codex provider @ low
thinking. `openai-codex` and `anthropic` are the only configured providers.

`gpt-6-astra-1m` rewrites to upstream `gpt-6-astra` via `astra-1m-alias.ts`.
`gpt-5.6-sol-1m` is 1.05M context (rewrites to upstream `gpt-5.6-sol`;
long-context pricing above 272K input).

## Agents (workers)

| Agent | Model | Tools | Role |
| ------- | ------- | ------ | ------ |
| `worker` | luna | full | Mechanical impl, CRUD, fixtures, refactors |
| `tests` | luna | full | Write/run tests, report failing assertion |
| `lint` | luna | full | Format, lint, imports, style |
| `docs` | luna | full | READMEs, docs, comments |
| `git` | luna | read, bash | Commit msgs, PR summaries (never commits) |
| `memory` | luna | full | Repository memory |
| `explorer` | luna | read, bash, grep, find, ls | Research/mapping (read-only) |
| `terminal-reader` | luna | none | Compress terminal output |
| `log-reader` | luna | none | Compress logs |
| `diff-reader` | luna | none | Compress a **path-scoped** dump (inspect first) |

Workers are **depth 1** — they never spawn workers. Luna workers use
`openai-codex/gpt-5.6-luna`, falling back to `openai-codex/gpt-5.3-codex-spark`
when the first option is unauthed **or out of usage**. Each agent pins its own `thinking`
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
| `/context-efficiency` | Small-window early compact status |
| `/compact` | Stock compact, summarized by the active lead model |

Huge bash/read results are capped at ingest (dump under `~/.pi/agent/tmp/tool-dumps/`). Core tools stay on; `tool_search` activates the rest.

Diffs: inspect first (`summary` with `directories` + optional `--exclude lockfiles` → `--path` files/hunks/slice/search; skill `harness-diff-read`). If inspect ignores `--path` or has no session: path-scoped `git diff`. `diff-reader` last, never the whole tree.

Thinking is manual: Shift+Tab or `/thinking` selects the level for the next assistant request. It does not change a request already streaming or an existing worker session. Ctrl+S in `/thinking` saves the startup default.

## GitHub PR awareness

`extensions/github-pr.ts` surfaces the open PR for the current branch. Requires the GitHub CLI `gh` installed and authenticated, and a checkout with a GitHub remote; run `/reload` to load it.

- Footer shows `PR #123` (with a draft suffix for drafts) beside the branch name.
- The agent receives the detected open PR URL/number, so "check the PR" refers to this branch's PR.
- Discovery uses read-only `gh pr view` and respects tracking branches/forks.
- Refresh: local branch state checked every 5s in the UI and before model calls; GitHub queries cached 60s when idle and forced before each new prompt.
- A closed/merged/no-PR state clears the badge. If auth/network/`gh` is unavailable, the badge is hidden and context is reported as unknown (not confirmed no PR).
- Detached HEAD has no PR association.
- `GH_REPO` override and `PI_OFFLINE=1/true/yes` disable discovery to avoid the wrong repo or network calls.
- Metadata is transient — never stored in the session. No automatic GitHub mutations.

## Side questions (`/btw`)

Ask something about the current session without adding it to the transcript or interrupting the lead. Isolated `complete()` — full conversation context, no tools, overlay, in-memory history only. Reload with `/reload`.

| Command | What |
| --------- | ------ |
| `/btw <question>` | Answer in a dismissible overlay from session context only |
| `/btw` | Reopen the last side question |

Works while the lead is streaming. Esc / Enter / Space dismiss. ↑↓ scroll, ←→ or `[` `]` step history, `c` copies the answer, `x` clears earlier side questions.

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

Measured and rejected as non-factors: TypeScript transpilation costs ~5 ms per
extension, and `NODE_COMPILE_CACHE` saves only ~24 ms — the cost is module
execution, not V8 compilation.

## Day-to-day

| Gesture | What |
| --------- | ------ |
| `Ctrl+P` | Cycle lead model (`enabledModels` in settings.json) |
| `Shift+Tab` | Cycle thinking level (default low) |
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
| `/agents` | Manage / view / stop / steer running workers |
| `/microcompact` `/tools` `/memory` | Token controls |
| `/fast` | Toggle OpenAI priority processing (on\|off\|status) |
| `/visualise [topic]` | Architecture / topic / thinking flow diagram |
| `pi -c` | Continue most recent session |
| `pi -r` | Browse and resume a session |

## Notes

- Extensions hot-reload with `/reload` after edits.
- Child workers are lean: `isolated: true` (no extensions/skills; the brief is the whole context; prevents recursion).
- `settings.json` is the single source of truth for model/thinking/compaction.
- Lead search is FFF in `override` mode (`find`/`grep` are FFF, not fd/rg). Workers still use built-in `find`/`grep` because they spawn `isolated`.
- Piolium is not a global package. Install it in the repo you are auditing.
- TUI: tool/user cards use rose-pine `surface`/`overlay`. Code blocks use the high-contrast rose-pine syntax map (iris keywords, rose functions, foam types/vars, gold strings/numbers). Pasted images and long inserts become `[Image #N]` / `[Paste #N · …]` chips (`extensions/00-paste-chips.ts`).
- Deferred tools: core coding tools stay on; package extras start off (`tool_search` / `/tools`).
- Auth: `openai-codex` and `anthropic` credentials are in `~/.pi/agent/auth.json` (via `/login`).

## Hardening and regression checks

Canonical regression command: `npm run check --prefix agent/npm`.

The browser tool only accepts validated per-action options and HTTP(S) URLs;
JavaScript and global-flag overrides are blocked. Interactive mutations always
prompt, even with `consequential=false` — including nested find actions.
Uploads and image/PDF outputs are limited to the workspace and
browser-artifacts directories, with protected symlink checks. Browser names
are scoped to the pi extension session and cleaned up on shutdown. Memory
refresh is initialized after resume/tree. Tool dump filenames include a
content hash and are written with exclusive 0600 permissions. Vision output is
bounded to 1 MiB with a single 90-second fallback deadline and TERM→KILL on
actual non-exit. The working indicator reads supported provider effort/budget at dispatch;
unknown payloads display `selected <level>` rather than claiming confirmed effort. Editor selection affects the next request.

The security gate remains preflight guardrails, not an OS sandbox.
Provider-routing policy and dependency portability are unchanged.
