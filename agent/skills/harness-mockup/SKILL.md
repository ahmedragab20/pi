---
name: harness-mockup
description: Author and revise HTML mockups for diffing visual review. Use only when the user asked for a mockup this turn or accepted an offer. The lead writes every mockup — never a worker.
---

# HTML mockups (lead-authored, opt-in)

Mockups drain a lot of tokens. **The lead writes every mockup and every revision.** Never spawn `Agent` `worker` — or any subagent — to author, revise, or check mockup HTML.

## Gate — create one only when

- the user asked for one **this turn**, or
- you offered one via `ask_user_question` and they accepted.

A `/diffing mockup` command counts as asking. Do **not** auto-create because a task is "large UI", a redesign, or a new screen. Offering is optional; skipping the offer is fine. If they already said no this turn, don't ask again.

## Author

1. Load `diffing-mockup-author`. Call `diffing_design` `show` — extract a draft if none exists, and do **not** publish unless the human asked. Use those tokens. Do not invent Inter + indigo + Tailwind CDN.
2. **You write the HTML.** Every distinct state is its own screen id. Real product copy, design-system colors, `data-diffing` region names.
3. Self-contained: inline CSS, no build step, no tabs/accordions/modals/toggles/JS that swaps content.
4. Stage files only under `~/.diffing/<repo>-<hash>/mockup-sources/` — **never** inside the consumer git tree.

## Review

Load `diffing-mockup-review` and use the pi extension tools:

`diffing_mockup_submit` (html/screens inline; optional `mode` / `designSystem` / `planId`) → share the `/mockup/<id>` URL → **park**. Call `diffing_mockup_await` only when the human is reviewing right now. Fix submit hints (in-page state, generic style) before parking.

The diffing verdict is the gate. **Do not implement product UI first.**

## Obey the verdict

| Verdict | Do |
| --- | --- |
| `approved` | `diffing_mockup_handoff`, then implement |
| `changes-requested` | `diffing_mockup_inspect` open comments → **you** revise **one screen at a time** with `diffing_mockup_screen` (`replace-region` when the comment has a `data-diffing` target, else `patch`) → `diffing_mockup_threads` reply + resolve → resubmit the same `mockupId`. Do not implement. Do not spawn a worker. |
| `rejected` | Stop and rethink |

Product implementation starts only after the verdict is `approved`.
