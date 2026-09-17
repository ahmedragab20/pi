---
name: harness-e2e
description: Write, run, and debug end-to-end tests and visual regression checks for web apps. Use when adding or fixing Playwright specs, verifying a UI change end to end, or comparing screenshots.
---

# E2E and visual verification

Two layers, don't mix them:

- **Exploring and one-off checks:** `agent_browser` (see `harness-browser`). Cheap, nothing gets committed.
- **Committed tests:** the project's own `@playwright/test`. Never add browser tooling to the harness for a project's tests.

## Writing a spec

1. Start the dev server in its own herdr pane or in the background. Never block the lead on it.
2. Walk the flow once with `agent_browser`: `snapshot -i -c` gives the roles and names locators need.
3. Write locators from that snapshot: `getByRole("button", { name: "Save" })`, `getByLabel`, `getByTestId`. No CSS chains, no `nth()` unless order is the behavior under test.
4. Assert what the user sees: `toBeVisible`, `toHaveText`, `toHaveURL`. Web-first assertions wait on their own; never `waitForTimeout`.
5. Mock only external boundaries (`page.route` for third-party APIs). Keep the app's own backend real when practical.

## Running (token-cheap)

- Focused first: `npx playwright test path/to/spec.ts --reporter=line --max-failures=1`.
- Then the affected project or suite. The full suite is a worker chore: give the exact command and ask for the first failure verbatim.
- On failure, read `test-results/**/error-context.md` first. It holds the error and an aria snapshot of the page. Open the trace or screenshots only if that isn't enough.
- Never `--update-snapshots` to make a failure go away. Update baselines only for an intended visual change, and say so.

## Visual regression

- Committed: `await expect(page).toHaveScreenshot()` with a fixed viewport, `animations: "disabled"`, and masks for dynamic regions (times, avatars).
- Ad hoc, before or after a change: `agent_browser` `screenshot before.png`, apply the change, `reload`, then `diff screenshot --baseline before.png`. No image comes back when nothing changed.
- Check at least one narrow viewport (`set viewport 390 844`) for layout work.

## Delegation

A worker can run suites, capture screenshots, and diff them with its read-only `browser_verify`. The lead decides what proves the change and reads the real output.
