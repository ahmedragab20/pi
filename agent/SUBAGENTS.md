# Subagents — spawn + keymaps

Workers run through `@tintinweb/pi-subagents` (`Agent`, `get_subagent_result`,
`steer_subagent`). Built-in Explore / Plan / general-purpose are disabled;
only the harness agents in `agents/*.md` are advertised. Manage them with
`/agents`.

## Spawn (lead)

```
Agent({
  subagent_type: "explorer",
  prompt: "Find files that handle auth. Return paths + what each does.",
  description: "Map auth files",
})
```

| Want | Pass |
| --- | --- |
| Don't wait | `run_in_background: true` |
| A handle you can address later | `name: "auth-audit"` → `@auth-audit` |
| Isolated git copy | `isolation: "worktree"` |
| Redirect a running worker | `steer_subagent({ agent_id, message })` |
| Wait / read a background result | `get_subagent_result({ agent_id, wait: true })` |
| Continue a finished worker | `Agent({ …, resume: "<id>" })` or `@handle …` |

Foreground blocks until done. Background returns an id and notifies on
completion. Esc during `get_subagent_result wait: true` cancels the wait
only — the worker keeps running.

**Do not pass `model` or `thinking`.** Each agent file pins its own
`thinking` and `max_turns`, and `extensions/worker-model.ts` fills the model:
`opencode-go/glm-5.3-flash` → `opencode-go/deepseek-v4-flash`, skipping any provider that is
unauthed or out of usage. A spawn that fails on a usage limit is retried once
on the next model in the chain and the tool result is replaced, so the lead
never sees the quota error. The lead model is never switched.

## Config (`subagents.json`)

| Key | Value | Why |
| --- | --- | --- |
| `disableDefaultAgents` | `true` | Only harness agents are advertised |
| `fallbackSubagent` | `"none"` | An unknown `subagent_type` is refused, not silently rerouted |
| `workflowsEnabled` | `false` | `SubagentWorkflow` costs ~5k tokens of system prompt every turn. Fan out with parallel `Agent` calls instead |
| `maxSubagentDepth` | `1` | Depth 1 enforced by the runtime, not by prose. Workers cannot spawn workers |

Leave `scopeModels` off. It validates spawn models against `enabledModels`,
and `worker-model.ts` supplies chain models that are not all in that list —
turning it on hard-errors those spawns.

## FleetView (below the editor, while workers run)

Only when the **prompt is empty**. `alt+j` / `alt+k` still move the cursor.

| Key | Action |
| --- | --- |
| `↓` or `←` | Focus the list (`●` on `main`) |
| `↑` / `↓` | Move selection |
| `Enter` | Open that agent's conversation |
| `Esc` or `↑` on `main` | Back to the prompt |
| any other key | Drop focus; key goes to the editor |

Selecting `main` is the same as Esc. Finished rows linger a few seconds.

## Conversation overlay (`/agents` or FleetView Enter)

| Key | Action |
| --- | --- |
| `↑` `↓` / `k` `j` | Scroll one line |
| `PgUp` `PgDn` / `Shift+↑` `Shift+↓` | Page |
| `Home` / `End` | Top / bottom (End resumes auto-follow) |
| `Enter` | Steer composer (running agents) |
| `Enter` (with text) | Send the steering message |
| `Esc` or empty `Enter` | Close composer (or overlay, if no composer) |
| `q` | Close overlay |
| `x` then `x` | Stop the running agent |

Scroll up to pause auto-follow. `x` arms; any other key disarms.

## Mentions (prompt)

| Input | Goes to |
| --- | --- |
| `@explorer check the RPC path` | that worker (message / resume / start) |
| `@main …` | the lead (`@main` stripped) |
| `@explorer` (no message) | the lead — bare handle is not a send |
| `hey @explorer …` | the lead — only a **leading** `@` is routed |

`@` still completes files. Agent rows appear first. A `name:` passed at spawn
is addressable the same way, alongside the type-derived handle.

## Other

| Key / command | Action |
| --- | --- |
| `/agents` | List, view, stop, create, settings |
| `ctrl+o` | Expand a completed `Agent` result in the chat |
| Esc (foreground `Agent`) | Abort that blocking spawn |

Widget (above the editor) shows background workers by default. Toggle widget,
FleetView, and mentions in `/agents` → Settings.
