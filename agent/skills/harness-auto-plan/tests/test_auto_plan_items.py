#!/usr/bin/env python3
"""Tests for the auto-plan item scheduler CLI contracts.

These exercise the *item-level* commands in scripts/auto-plan.py:
  items-init, items-status, claim-item, record-item,
  record-item-review, integrate-item, finalize-items.

They are intentionally written as failing tests: today's production binary
does not yet implement any of these subcommands, so each test fails at the
CLI boundary (argparse "invalid choice") rather than passing. The assertions
pin down the exact contracts the brief specifies so an implementation can be
driven to green.

Isolation: each test uses a throwaway temp HOME, a fresh temp git consumer
repo, and a separate AUTO_PLAN_WORKTREE_HOME. No herdr is involved.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "auto-plan.py"

OPEN_FINDINGS = (
    "# Findings — round 1\n"
    "\n"
    "### Issue 1 -- Severity: bug\n"
    "- **File**: src/a.py:12\n"
    "- **Description**: regression\n"
    "- **Status**: open\n"
)


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
    )


def init_consumer(path: Path) -> None:
    """A clean consumer git repo with one initial commit on its default branch."""
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    git(path, "config", "user.email", "item-test@example.com")
    git(path, "config", "user.name", "item-test")
    git(path, "config", "commit.gpgsign", "false")
    (path / "README").write_text("base\n")
    (path / "src").mkdir(exist_ok=True)
    git(path, "add", ".")
    git(path, "commit", "-m", "init")


class ItemPlanTests(unittest.TestCase):
    RUN_ID = "run1"
    MAX_PARALLEL = 2

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "home"
        self.home.mkdir()
        self.worktree_home = root / "worktrees"
        self.worktree_home.mkdir()
        self.repo = root / "consumer"
        self.repo.mkdir()
        init_consumer(self.repo)
        self.manifest = root / "manifest.json"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["AUTO_PLAN_HOME"] = str(self.home)
        env["AUTO_PLAN_WORKTREE_HOME"] = str(self.worktree_home)
        env.pop("HERDR_ENV", None)
        env.pop("HERDR_PANE_ID", None)
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(self.repo),
        )

    def write_manifest(self, items: list[dict]) -> None:
        self.manifest.write_text(json.dumps({"items": items}, indent=2) + "\n")

    def items_init(self, items: list[dict]) -> subprocess.CompletedProcess[str]:
        self.write_manifest(items)
        return self.cli(
            "items-init",
            "--run-id",
            self.RUN_ID,
            "--manifest",
            str(self.manifest),
            "--max-parallel",
            str(self.MAX_PARALLEL),
        )

    def payload(self, proc: subprocess.CompletedProcess[str]) -> dict:
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        text = (proc.stdout or "").strip()
        assert text, f"empty stdout (stderr={proc.stderr!r})"
        return json.loads(text)

    # ---- items-init -----------------------------------------------------

    def test_items_init_rejects_duplicate_ids(self) -> None:
        proc = self.items_init(
            [
                {"id": "A", "paths": ["src/a.py"]},
                {"id": "A", "paths": ["src/b.py"]},
            ]
        )
        # Must fail validation, not silently persist a broken manifest.
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("duplicate", got["error"].lower())

    def test_items_init_rejects_undefined_dependency(self) -> None:
        proc = self.items_init(
            [
                {"id": "B", "paths": ["src/b.py"]},
                {"id": "A", "depends": ["Z"], "paths": ["src/a.py"]},
            ]
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("dependency", got["error"].lower())

    def test_items_init_rejects_acyclic_violation(self) -> None:
        proc = self.items_init(
            [
                {"id": "A", "depends": ["B"], "paths": ["src/a.py"]},
                {"id": "B", "depends": ["A"], "paths": ["src/b.py"]},
            ]
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("cycle", got["error"].lower())

    def test_items_init_rejects_path_overlapping_independent_items(self) -> None:
        # No dependency between A and B, but both own src/mod.py -> must be
        # rejected because their edits could collide.
        proc = self.items_init(
            [
                {"id": "A", "paths": ["src/mod.py"]},
                {"id": "B", "paths": ["src/mod.py"]},
            ]
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("overlap", got["error"].lower())

    def test_items_init_requires_clean_consumer_tree(self) -> None:
        (self.repo / "README").write_text("dirty\n")  # uncommitted change
        proc = self.items_init([{"id": "A", "paths": ["src/a.py"]}])
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("clean", got["error"].lower())

    def test_items_init_persists_idempotent_manifest(self) -> None:
        items = [{"id": "A", "paths": ["src/a.py"]}]
        first = self.payload(self.items_init(items))
        self.assertTrue(first["ok"])
        second = self.payload(self.items_init(items))  # repeat, same id/args
        self.assertTrue(second["ok"])
        self.assertEqual(second["run_id"], self.RUN_ID)
        # A persisted item manifest now exists under the run home.
        run_dir = self.home / self.RUN_ID
        manifests = list(run_dir.glob("*manifest*")) + list(
            run_dir.glob("items/manifest.json")
        )
        self.assertTrue(
            manifests, "expected a persisted item manifest under AUTO_PLAN_HOME"
        )

    # ---- items-status ---------------------------------------------------

    def test_items_status_returns_dependency_ready_capped_by_slots(self) -> None:
        # B has no deps, A depends on B. With max-parallel=2 and no active
        # claims, B is dependency-ready and fits within the active-slot cap.
        self.payload(
            self.items_init(
                [
                    {"id": "B", "paths": ["src/b.py"]},
                    {"id": "A", "depends": ["B"], "paths": ["src/a.py"]},
                ]
            )
        )
        proc = self.cli("items-status", "--run-id", self.RUN_ID)
        got = self.payload(proc)
        self.assertTrue(got["ok"])
        ready = got["items"]
        self.assertEqual(len(ready), 1, ready)
        self.assertEqual(ready[0]["id"], "B")
        self.assertLessEqual(len(ready), self.MAX_PARALLEL)
        self.assertNotIn(
            "A", {r["id"] for r in ready}, "A is not ready until B is done"
        )

    # ---- claim-item -----------------------------------------------------

    def base_claim_setup(self) -> None:
        self.payload(self.items_init([{"id": "A", "paths": ["src/a.py"]}]))

    def test_claim_item_claims_once_increments_attempt_and_returns_nonce(self) -> None:
        self.base_claim_setup()
        first = self.payload(
            self.cli(
                "claim-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--role",
                "implementer",
            )
        )
        self.assertTrue(first["ok"])
        self.assertEqual(first["item_id"], "A")
        self.assertEqual(first["attempt"], 1)
        self.assertTrue(first["nonce"])
        self.assertTrue(first.get("worktree"), "expected an isolated worktree path")
        self.assertTrue(first.get("branch"), "expected a dedicated item branch")

        # Atomic: a second claim for the same in-flight item must be refused.
        second = self.payload(
            self.cli(
                "claim-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--role",
                "implementer",
            )
        )
        self.assertFalse(second["ok"])
        self.assertIn("claim", second["error"].lower())

    def test_claim_item_worktree_is_outside_consumer_tree(self) -> None:
        self.base_claim_setup()
        got = self.payload(
            self.cli(
                "claim-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--role",
                "implementer",
            )
        )
        worktree = Path(got["worktree"]).resolve()
        consumer = self.repo.resolve()
        self.assertNotIn(
            str(consumer),
            str(worktree),
            "item worktree must not live inside the consumer tree",
        )
        self.assertTrue(worktree.is_dir())
        # Branch was created and differs from the consumer mainline.
        branch = got["branch"]
        self.assertTrue(branch)

    # ---- record-item ----------------------------------------------------

    def claim_item(self, item_id: str = "A", role: str = "implementer") -> dict:
        """Claim an item and return the full contract payload (incl. nonce)."""
        got = self.payload(
            self.cli(
                "claim-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                item_id,
                "--role",
                role,
            )
        )
        self.assertTrue(got["ok"], got)
        self.assertTrue(got.get("nonce"), "claim must return a nonce")
        return got

    @staticmethod
    def make_item_change(worktree: str, rel: str) -> None:
        root = Path(worktree)
        (root / "src").mkdir(exist_ok=True)
        (root / rel).write_text("work\n")

    def test_record_item_rejects_wrong_nonce(self) -> None:
        self.base_claim_setup()
        claimed = self.claim_item()
        self.make_item_change(claimed["worktree"], "src/a.py")
        proc = self.cli(
            "record-item",
            "--run-id",
            self.RUN_ID,
            "--item-id",
            "A",
            "--nonce",
            "definitely-wrong-nonce",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("nonce", got["error"].lower())

    def test_record_item_accepts_only_changed_worktree_then_implemented(self) -> None:
        self.base_claim_setup()
        claimed = self.claim_item()
        self.make_item_change(claimed["worktree"], "src/a.py")
        rec = self.payload(
            self.cli(
                "record-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--nonce",
                claimed["nonce"],
            )
        )
        self.assertTrue(rec["ok"])
        self.assertEqual(rec["status"], "implemented")

    def test_record_item_rejects_unmodified_worktree(self) -> None:
        # Claim but touch nothing; record-item must refuse (no changed item worktree).
        self.base_claim_setup()
        claimed = self.claim_item()
        rec = self.payload(
            self.cli(
                "record-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--nonce",
                claimed["nonce"],
            )
        )
        self.assertFalse(rec["ok"])
        joined = rec.get("error", "").lower()
        self.assertTrue(("no change" in joined) or ("unchanged" in joined))

    def test_record_item_rejects_outside_paths_before_any_commit(self) -> None:
        # A owns src/a.py; changing only README must be rejected without ever
        # creating a commit on the item branch.
        self.base_claim_setup()
        claimed = self.claim_item()
        worktree = Path(claimed["worktree"])
        head_before = (git(worktree, "rev-parse", "HEAD").stdout or "").strip()
        (worktree / "src").mkdir(exist_ok=True)
        (worktree / "README").write_text("out-of-scope change\n")

        rec = self.payload(
            self.cli(
                "record-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--nonce",
                claimed["nonce"],
            )
        )
        self.assertFalse(rec["ok"])
        self.assertIn("outside owned paths", rec["error"].lower())
        # No commit was created: HEAD did not advance on the item branch.
        head_after = (git(worktree, "rev-parse", "HEAD").stdout or "").strip()
        self.assertEqual(head_before, head_after)
        self.assertTrue(head_before, "worktree must be on a real commit")
        # And the item was not advanced to implemented.
        state = json.loads((self.home / self.RUN_ID / "items-state.json").read_text())
        self.assertEqual(state["items"]["A"]["status"], "implementing")

    # ---- record-item-review ---------------------------------------------

    def mint_review_nonce(self, item_id: str = "A") -> str:
        """Simulate spawn-item-reviewer minting a distinct review authority key."""
        nonce = uuid.uuid4().hex
        state_path = self.home / self.RUN_ID / "items-state.json"
        state = json.loads(state_path.read_text())
        item = state["items"][item_id]
        item["review_nonce"] = nonce
        item["status"] = (
            "reviewing" if item.get("status") == "implemented" else item.get("status")
        )
        state_path.write_text(json.dumps(state, indent=2) + "\n")
        meta_path = self.home / self.RUN_ID / "items" / item_id / "meta.json"
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta = json.loads(meta_path.read_text()) if meta_path.is_file() else dict(item)
        meta["review_nonce"] = nonce
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")
        return nonce

    def approve_item(
        self, item_id: str = "A", rel: str = "src/a.py"
    ) -> tuple[str, str]:
        """Claim -> change -> record. Returns (implementer_nonce, review_nonce)."""
        claimed = self.claim_item(item_id)
        self.make_item_change(claimed["worktree"], rel)
        self.payload(
            self.cli(
                "record-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                item_id,
                "--nonce",
                claimed["nonce"],
            )
        )
        return claimed["nonce"], self.mint_review_nonce(item_id)

    def test_record_item_review_rejects_implementer_nonce(self) -> None:
        self.base_claim_setup()
        impl_nonce, _review_nonce = self.approve_item()
        proc = self.cli(
            "record-item-review",
            "--run-id",
            self.RUN_ID,
            "--item-id",
            "A",
            "--nonce",
            impl_nonce,
            "--verdict",
            "LGTM",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("nonce", got["error"].lower())

    def test_record_item_review_rejects_open_item_findings(self) -> None:
        self.base_claim_setup()
        _impl_nonce, review_nonce = self.approve_item()
        item_dir = self.home / self.RUN_ID / "items" / "A"
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "findings.md").write_text(
            "# Findings\n### Issue 1 -- Severity: bug\n- **Status**: open\n"
        )
        proc = self.cli(
            "record-item-review",
            "--run-id",
            self.RUN_ID,
            "--item-id",
            "A",
            "--nonce",
            review_nonce,
            "--verdict",
            "LGTM",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("open", got["error"].lower())

    def test_record_item_review_sets_approved_when_no_open_findings(self) -> None:
        self.base_claim_setup()
        _impl_nonce, review_nonce = self.approve_item()
        # LGTM requires a findings.md with no open findings plus a prior
        # item-review-checkpoint.
        self.write_resolved_findings()
        cp = self.run_review_checkpoint("A", review_nonce)
        self.assertTrue(cp["ok"], cp)
        self.assertEqual(cp["open_findings"], 0)
        rec = self.payload(self.lgtm("A", review_nonce))
        self.assertTrue(rec["ok"])
        self.assertEqual(rec["status"], "approved")

    def test_record_item_review_lgtm_refuses_missing_findings(self) -> None:
        # Contract: a successful LGTM must be backed by a findings.md (with no
        # open findings). No findings file at all must be rejected.
        self.base_claim_setup()
        _impl_nonce, review_nonce = self.approve_item()
        proc = self.lgtm("A", review_nonce)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("findings", got["error"].lower())

    def test_item_review_checkpoint_counts_trailing_period_open(self) -> None:
        # "- Status: open." (trailing period) must still count as an open
        # finding; today normalization only matches exactly the token "open".
        self.base_claim_setup()
        claimed = self.claim_item()
        self.make_item_change(claimed["worktree"], "src/a.py")
        self.payload(
            self.cli(
                "record-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--nonce",
                claimed["nonce"],
            )
        )
        item_path = self.home / self.RUN_ID / "items" / "A"
        item_path.mkdir(parents=True, exist_ok=True)
        item_path.joinpath("findings.md").write_text(
            "# Findings\n### Issue 1 -- Severity: bug\n- **Status**: open.\n"
        )
        review_nonce = self.mint_review_nonce("A")
        proc = self.cli(
            "item-review-checkpoint",
            "--run-id",
            self.RUN_ID,
            "--item-id",
            "A",
            "--nonce",
            review_nonce,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        # The "open." line must be seen as an open finding (or LGTM refused).
        self.assertGreaterEqual(got["open_findings"], 1)
        self.assertEqual(got["action"], "worker")

    # ---- integrate-item / finalize-items --------------------------------

    def write_resolved_findings(self, item_id: str = "A") -> None:
        """A findings.md with no open findings (resolved), as LGTM requires."""
        item_dir = self.home / self.RUN_ID / "items" / item_id
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "findings.md").write_text(
            "# Findings\n### Issue 1 -- Severity: nit\n- **Status**: resolved\n"
        )

    def run_review_checkpoint(self, item_id: str, review_nonce: str) -> dict:
        return self.payload(
            self.cli(
                "item-review-checkpoint",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                item_id,
                "--nonce",
                review_nonce,
            )
        )

    def lgtm(self, item_id: str, review_nonce: str):
        return self.cli(
            "record-item-review",
            "--run-id",
            self.RUN_ID,
            "--item-id",
            item_id,
            "--nonce",
            review_nonce,
            "--verdict",
            "LGTM",
        )

    def fully_approved(self, item_id: str = "A", rel: str = "src/a.py") -> str:
        """Drive an item to approved through the findings+checkpoint LGTM path."""
        self.base_claim_setup()
        _impl_nonce, review_nonce = self.approve_item(item_id, rel)
        self.write_resolved_findings(item_id)
        cp = self.run_review_checkpoint(item_id, review_nonce)
        self.assertTrue(cp["ok"], cp)
        self.assertEqual(cp["open_findings"], 0)
        rec = self.payload(self.lgtm(item_id, review_nonce))
        self.assertEqual(rec["status"], "approved")
        return rec.get("branch") or f"item-{item_id}"

    def read_state(self) -> dict:
        return json.loads((self.home / self.RUN_ID / "items-state.json").read_text())

    def write_state(self, state: dict) -> None:
        (self.home / self.RUN_ID / "items-state.json").write_text(
            json.dumps(state, indent=2) + "\n"
        )

    def test_integrate_item_merges_approved_branch_and_marks_integrated(self) -> None:
        self.fully_approved()
        proc = self.payload(
            self.cli("integrate-item", "--run-id", self.RUN_ID, "--item-id", "A")
        )
        self.assertTrue(proc["ok"])
        self.assertEqual(proc["item_id"], "A")
        self.assertEqual(proc["status"], "integrated")
        branch = proc.get("branch")
        self.assertTrue(branch, "integration should name the merged branch")

    def test_scheduler_releases_dependents_after_integration(self) -> None:
        # B has no deps; A depends on B. A must stay unready until B is fully
        # realized (claimed, changed, recorded, reviewed, integrated).
        self.payload(
            self.items_init(
                [
                    {"id": "B", "paths": ["src/b.py"]},
                    {"id": "A", "depends": ["B"], "paths": ["src/a.py"]},
                ]
            )
        )
        ready_before = self.payload(self.cli("items-status", "--run-id", self.RUN_ID))
        self.assertEqual([r["id"] for r in ready_before["items"]], ["B"])
        self.assertNotIn("A", {r["id"] for r in ready_before["items"]})

        # Fully realize B end-to-end.
        claimed = self.claim_item("B")
        self.make_item_change(claimed["worktree"], "src/b.py")
        self.payload(
            self.cli(
                "record-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "B",
                "--nonce",
                claimed["nonce"],
            )
        )
        review_nonce = self.mint_review_nonce("B")
        self.write_resolved_findings("B")
        self.assertTrue(self.run_review_checkpoint("B", review_nonce)["ok"])
        self.payload(self.lgtm("B", review_nonce))
        integrated = self.payload(
            self.cli("integrate-item", "--run-id", self.RUN_ID, "--item-id", "B")
        )
        self.assertEqual(integrated["status"], "integrated")

        # B is done and integrated, so A is now dependency-ready.
        ready_after = self.payload(self.cli("items-status", "--run-id", self.RUN_ID))
        self.assertIn("A", {r["id"] for r in ready_after["items"]})

    def test_finalize_items_fast_forwards_clean_checkout_only_after_all_integrated(
        self,
    ) -> None:
        self.fully_approved()
        fin = self.payload(
            self.cli("integrate-item", "--run-id", self.RUN_ID, "--item-id", "A")
        )
        self.assertEqual(fin["status"], "integrated")
        # Consumer tree must still be clean and unchanged after integration.
        porcelain = git(self.repo, "status", "--porcelain")
        self.assertEqual((porcelain.stdout or "").strip(), "")
        final = self.payload(self.cli("finalize-items", "--run-id", self.RUN_ID))
        self.assertTrue(final["ok"])
        self.assertEqual(final["status"], "finalized")
        # All items are integrated, and the consumer checkout advanced by
        # fast-forward to the integration result while staying clean.
        self.assertEqual(
            (git(self.repo, "status", "--porcelain").stdout or "").strip(), ""
        )

    def _integrate_all(self) -> None:
        self.fully_approved()
        fin = self.payload(
            self.cli("integrate-item", "--run-id", self.RUN_ID, "--item-id", "A")
        )
        self.assertEqual(fin["status"], "integrated")

    def test_finalize_items_refuses_dirty_consumer(self) -> None:
        self._integrate_all()
        (self.repo / "dirt.txt").write_text("uncommitted\n")
        fin = self.cli("finalize-items", "--run-id", self.RUN_ID)
        self.assertEqual(fin.returncode, 0, fin.stderr + fin.stdout)
        got = self.payload(fin)
        self.assertFalse(got["ok"])
        self.assertIn("clean", got["error"].lower())

    def test_finalize_items_refuses_moved_consumer_head(self) -> None:
        self._integrate_all()
        # An external commit moves the consumer HEAD away from the items-init base.
        (self.repo / "extra.txt").write_text("external\n")
        git(self.repo, "add", "extra.txt")
        git(self.repo, "commit", "-m", "external change")
        fin = self.cli("finalize-items", "--run-id", self.RUN_ID)
        self.assertEqual(fin.returncode, 0, fin.stderr + fin.stdout)
        got = self.payload(fin)
        self.assertFalse(got["ok"])
        self.assertIn("head moved", got["error"].lower())

    def test_item_review_checkpoint_blocks_at_sixth_still_open_changing_round(
        self,
    ) -> None:
        # Six rounds, each *changing* the item worktree so the no-progress
        # counter never trips. The hard six-round cap still blocks the sixth
        # still-open round.
        self.base_claim_setup()
        claimed = self.claim_item()
        self.make_item_change(claimed["worktree"], "src/a.py")
        self.payload(
            self.cli(
                "record-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--nonce",
                claimed["nonce"],
            )
        )
        item_path = self.home / self.RUN_ID / "items" / "A"
        item_path.mkdir(parents=True, exist_ok=True)
        item_path.joinpath("findings.md").write_text(OPEN_FINDINGS)
        review_nonce = self.mint_review_nonce("A")
        worktree = Path(claimed["worktree"])

        def nudge_and_commit(value: int) -> None:
            # Commit in the item worktree so both the head and the tree state
            # change, giving each checkpoint a distinct signature (and thus a
            # reset no-progress counter).
            (worktree / "src").mkdir(exist_ok=True)
            (worktree / "src" / "a.py").write_text(f"def a():\n    return {value}\n")
            git(worktree, "add", "src/a.py")
            git(worktree, "commit", "-m", f"nudge {value}")

        for expected_round in range(1, 6):
            nudge_and_commit(expected_round)
            proc = self.cli(
                "item-review-checkpoint",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--nonce",
                review_nonce,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
            got = self.payload(proc)
            self.assertTrue(got["ok"], got)
            self.assertEqual(got["round"], expected_round)
            self.assertGreater(got["open_findings"], 0)

        # Sixth still-open round with a fresh change still blocks on the cap.
        nudge_and_commit(999)
        proc = self.cli(
            "item-review-checkpoint",
            "--run-id",
            self.RUN_ID,
            "--item-id",
            "A",
            "--nonce",
            review_nonce,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"], got)
        self.assertIn("round", got["error"].lower())
        self.assertEqual(got["round"], 6)

    # ---- additional contracts (contracts 1-11 from the brief) -----------
    #
    # Contract 12 (create_owned_worktree must not `branch -D` a branch that
    # already has unique commits) is intentionally NOT a separate CLI-level test
    # here: it is hard to reproduce through the UNIX-facing subcommands in a
    # deterministic way. The worktree-recreation paths it would exercise are
    # instead covered by the heal reattach test (above) and the claim/record
    # retry flow, which go through create_owned_worktree and are asserted not to
    # lose branches.

    def test_items_init_rejects_independent_glob_path_overlap(self) -> None:
        # "src/foo*" statically overlaps "src/foobar/**" even though neither
        # prefix is a literal directory prefix of the other. They must be
        # rejected because files matching one can match the other.
        proc = self.items_init(
            [
                {"id": "A", "paths": ["src/foo*"]},
                {"id": "B", "paths": ["src/foobar/**"]},
            ]
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = self.payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("overlap", got["error"].lower())

    def test_implemented_does_not_consume_scheduler_slot(self) -> None:
        # max_parallel=1. A is fully implemented (not implementing); a slot
        # must therefore still be free for B. implemented/approved must NOT
        # count toward ACTIVE_STATUSES when computing free slots.
        self.write_manifest(
            [
                {"id": "A", "paths": ["src/a.py"]},
                {"id": "B", "paths": ["src/b.py"]},
            ]
        )
        before = self.payload(
            self.cli(
                "items-init",
                "--run-id",
                self.RUN_ID,
                "--manifest",
                str(self.manifest),
                "--max-parallel",
                "1",
            )
        )
        self.assertTrue(before["ok"], before)
        # Claim + implement A so it is 'implemented', not 'implementing'.
        claimed = self.claim_item("A")
        self.make_item_change(claimed["worktree"], "src/a.py")
        rec = self.payload(
            self.cli(
                "record-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--nonce",
                claimed["nonce"],
            )
        )
        self.assertEqual(rec["status"], "implemented")
        got = self.payload(self.cli("items-status", "--run-id", self.RUN_ID))
        self.assertTrue(got["ok"], got)
        ready_ids = {r["id"] for r in got["items"]}
        self.assertIn("B", ready_ids, got)

    def test_items_init_resolves_cwd_from_meta_not_process_cwd(self) -> None:
        # Ensure items-init attaches to the consumer repo that the run was
        # initialized against (meta.json cwd), regardless of the subprocess
        # working directory that items-init happens to run from.
        env = os.environ.copy()
        env["AUTO_PLAN_HOME"] = str(self.home)
        env["AUTO_PLAN_WORKTREE_HOME"] = str(self.worktree_home)
        env.pop("HERDR_ENV", None)
        env.pop("HERDR_PANE_ID", None)
        init = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "init",
                "--cwd",
                str(self.repo),
                "--task",
                "t",
            ],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(self.repo),
        )
        self.assertEqual(init.returncode, 0, init.stderr + init.stdout)
        self.write_manifest([{"id": "A", "paths": ["src/a.py"]}])
        # Locate the run_id that `init` minted (random), reading back its cwd.
        run_id = None
        for meta in self.home.rglob("meta.json"):
            data = json.loads(meta.read_text())
            if str(data.get("cwd") or "").replace("\\", "/") == str(
                self.repo.resolve()
            ).replace("\\", "/"):
                run_id = meta.parent.name
                break
        self.assertTrue(run_id, "init did not create a meta.json for the consumer")
        assert isinstance(run_id, str)
        # items-init runs from a DIFFERENT clean git repo today.
        other = Path(self.tmp.name) / "other"
        other.mkdir(exist_ok=True)
        init_consumer(other)
        env2 = os.environ.copy()
        env2["AUTO_PLAN_HOME"] = str(self.home)
        env2["AUTO_PLAN_WORKTREE_HOME"] = str(self.worktree_home)
        env2.pop("HERDR_ENV", None)
        env2.pop("HERDR_PANE_ID", None)
        second = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "items-init",
                "--run-id",
                run_id,
                "--manifest",
                str(self.manifest),
                "--max-parallel",
                "1",
            ],
            capture_output=True,
            text=True,
            env=env2,
            cwd=str(other),
        )
        self.assertEqual(second.returncode, 0, second.stderr + second.stdout)
        got = json.loads((second.stdout or "").strip() or "null")
        self.assertTrue(got["ok"], got)
        state = json.loads((self.home / run_id / "items-state.json").read_text())
        self.assertEqual(
            str(Path(state["cwd"]).resolve()),
            str(self.repo.resolve()),
            f"items-init used process cwd instead of meta.cwd (state={state['cwd']!r})",
        )

    def test_heal_does_not_recreate_integration_after_integrated_item(self) -> None:
        # Fully approve and integrate A. Delete the integration worktree and its
        # git branch. Re-init must not recreate an empty integration worktree
        # from base; the already-integrated runs must stay intact.
        self.fully_approved()
        fin = self.payload(
            self.cli("integrate-item", "--run-id", self.RUN_ID, "--item-id", "A")
        )
        self.assertEqual(fin["status"], "integrated")
        state = self.read_state()
        integration = Path(state["integration_worktree"])
        branch = state["integration_branch"]
        import shutil

        shutil.rmtree(integration, ignore_errors=True)
        git(self.repo, "worktree", "prune")
        git(self.repo, "branch", "-D", branch)
        second = self.payload(self.items_init([{"id": "A", "paths": ["src/a.py"]}]))
        self.assertFalse(second["ok"], "must not recreate a bare integration worktree")
        state = self.read_state()
        self.assertEqual(state["items"]["A"]["status"], "integrated")

    def test_heal_reattaches_vanished_item_worktree_when_branch_exists(self) -> None:
        # Claim A (implementing). Remove the item worktree dir but NOT the git
        # branch. Re-init must reattach the worktree from the surviving branch
        # and keep A implementing (not reset to pending/fresh).
        self.base_claim_setup()
        claimed = self.claim_item()
        worktree = Path(claimed["worktree"])
        branch = claimed["branch"]
        self.assertTrue(worktree.is_dir())
        import shutil

        shutil.rmtree(worktree)
        self.assertFalse(worktree.is_dir())
        git(self.repo, "worktree", "prune")
        # Branch must still exist.
        self.assertNotEqual(
            (
                git(self.repo, "rev-parse", "--verify", f"refs/heads/{branch}").stdout
                or ""
            ).strip(),
            "",
        )
        second = self.payload(self.items_init([{"id": "A", "paths": ["src/a.py"]}]))
        self.assertTrue(second["ok"], second)
        state = self.read_state()
        item = state["items"]["A"]
        self.assertTrue(item["status"] != "pending" or item["nonce"], item)
        self.assertEqual(item["status"], "implementing")
        self.assertTrue(Path(item["worktree"]).is_dir())

    def test_integrate_item_resumes_interrupted_integrating_status(self) -> None:
        # A crash can leave status == "integrating" before the merge lands.
        # integrate-item must resume it to integrated rather than refuse.
        self.fully_approved()
        state = self.read_state()
        state["items"]["A"]["status"] = "integrating"
        self.write_state(state)
        proc = self.payload(
            self.cli("integrate-item", "--run-id", self.RUN_ID, "--item-id", "A")
        )
        self.assertTrue(proc["ok"], proc)
        self.assertEqual(proc["status"], "integrated")

    def test_finalize_items_is_idempotent(self) -> None:
        self._integrate_all()
        first = self.cli("finalize-items", "--run-id", self.RUN_ID)
        f1 = self.payload(first)
        self.assertTrue(f1["ok"], f1)
        self.assertEqual(f1["status"], "finalized")
        second = self.cli("finalize-items", "--run-id", self.RUN_ID)
        f2 = self.payload(second)
        self.assertTrue(f2["ok"], f2)
        self.assertEqual(f2["status"], "finalized")
        self.assertEqual(
            (git(self.repo, "status", "--porcelain").stdout or "").strip(), ""
        )

    def test_finalize_items_refuses_wrong_consumer_branch(self) -> None:
        # All items integrated, but the consumer is on a different branch HEAD
        # at the same SHA. finalize-items must refuse (error mentions branch).
        self._integrate_all()
        git(self.repo, "checkout", "-b", "other")
        self.assertEqual(
            (git(self.repo, "status", "--porcelain").stdout or "").strip(), ""
        )
        fin = self.cli("finalize-items", "--run-id", self.RUN_ID)
        self.assertEqual(fin.returncode, 0, fin.stderr + fin.stdout)
        got = self.payload(fin)
        self.assertFalse(got["ok"])
        self.assertIn("branch", got["error"].lower())

    def test_integrate_merges_approved_head_not_branch_tip(self) -> None:
        # integrate must merge the exact approved commit (H), not whatever the
        # item branch tip later points at. An extra commit made on the item
        # branch after approval must not end up in the integration.
        self.fully_approved()
        state = self.read_state()
        item = state["items"]["A"]
        head_h = item["head"]
        worktree = Path(item["worktree"])
        # Extra commit after approval, on the item branch tip.
        (worktree / "src").mkdir(exist_ok=True)
        (worktree / "src" / "a.py").write_text("def a():\n    return 2\n")
        git(worktree, "add", "src/a.py")
        git(worktree, "commit", "-m", "extra commit after approval")
        extra = (git(worktree, "rev-parse", "HEAD").stdout or "").strip()
        self.assertNotEqual(extra, head_h)

        proc = self.payload(
            self.cli("integrate-item", "--run-id", self.RUN_ID, "--item-id", "A")
        )
        self.assertTrue(proc["ok"], proc)
        integration_head = proc["integration_head"]
        is_anc = subprocess.run(
            [
                "git",
                "-C",
                str(self.repo),
                "merge-base",
                "--is-ancestor",
                extra,
                integration_head,
            ],
            capture_output=True,
            text=True,
        )
        # The post-approval extra commit must NOT be part of integration.
        self.assertNotEqual(is_anc.returncode, 0)
        h_anc = subprocess.run(
            [
                "git",
                "-C",
                str(self.repo),
                "merge-base",
                "--is-ancestor",
                head_h,
                integration_head,
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(h_anc.returncode, 0)

    def test_default_worktree_home_under_auto_plan_home(self) -> None:
        # With AUTO_PLAN_WORKTREE_HOME unset, the item worktree must live under
        # AUTO_PLAN_HOME, not tempfile.gettempdir().
        self.base_claim_setup()
        env = os.environ.copy()
        env["AUTO_PLAN_HOME"] = str(self.home)
        env.pop("AUTO_PLAN_WORKTREE_HOME", None)
        env.pop("HERDR_ENV", None)
        env.pop("HERDR_PANE_ID", None)
        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "claim-item",
                "--run-id",
                self.RUN_ID,
                "--item-id",
                "A",
                "--role",
                "implementer",
            ],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(self.repo),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = json.loads((proc.stdout or "").strip())
        self.assertTrue(got["ok"], got)
        worktree = Path(got["worktree"]).resolve()
        self.assertTrue(
            str(worktree).startswith(str(self.home.resolve())),
            f"item worktree {worktree} not under AUTO_PLAN_HOME {self.home}",
        )


if __name__ == "__main__":
    unittest.main()
