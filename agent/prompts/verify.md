---
description: Lead verification pass over the current changes — read the real diff, grade it, run the checks
---
Verify the current changes yourself. This is the lead's gate, not a worker's.

1. **Read the real diff.** `git status` + inspect scoped (`summary` → `--path` files/slice; skill `harness-diff-read`). Every file that changed, including anything a worker touched.
2. **Grade it against the original ask** — every requirement the user stated, not just the easy ones. Anything outside the stated scope gets reverted.
3. **Nits count** — naming, style drift, dead code, leftover debug prints, commented-out blocks, unnecessary reformatting, wrong error-handling shape, missing edge case. Fix them yourself; don't ship them because "it works".
4. **Run the checks.** Delegate the full suite to `Agent` `tests` with the exact command; delegate lint to `Agent` `lint`. Read the real output — a green claim with no output behind it is not evidence.
5. **Report plainly:** what's done, what's verified (with the evidence), what's left.

Do not claim anything passes without output you actually saw.
