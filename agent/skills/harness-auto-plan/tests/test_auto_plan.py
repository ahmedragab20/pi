#!/usr/bin/env python3
"""Pickup / spawn-reviewer gates: implement first, never review an empty tree."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "auto-plan.py"


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
    )


def init_repo(path: Path) -> None:
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    git(path, "config", "user.email", "auto-plan-test@example.com")
    git(path, "config", "user.name", "auto-plan-test")
    git(path, "config", "commit.gpgsign", "false")
    (path / "README").write_text("base\n")
    git(path, "add", "README")
    git(path, "commit", "-m", "init")


def run_cli(home: Path, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["AUTO_PLAN_HOME"] = str(home)
    env.pop("HERDR_ENV", None)
    env.pop("HERDR_PANE_ID", None)
    env.pop("HERDR_SOCKET_PATH", None)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(cwd) if cwd else None,
    )


def payload(proc: subprocess.CompletedProcess[str]) -> dict:
    text = (proc.stdout or "").strip()
    assert text, f"empty stdout (stderr={proc.stderr!r})"
    return json.loads(text)


class AutoPlanOrderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "runs"
        self.home.mkdir()
        self.repo = root / "repo"
        self.repo.mkdir()
        init_repo(self.repo)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def init_run(self, task: str, new: bool = False) -> dict:
        args = ["init", "--cwd", str(self.repo), "--task", task]
        if new:
            args.append("--new")
        proc = run_cli(self.home, *args)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return payload(proc)

    def pickup(self, **kwargs: str) -> dict:
        args = ["pickup"]
        for key, value in kwargs.items():
            args.extend([f"--{key.replace('_', '-')}", value])
        proc = run_cli(self.home, *args)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return payload(proc)

    def spawn(self, run_id: str) -> subprocess.CompletedProcess[str]:
        return run_cli(self.home, "spawn-reviewer", "--run-id", run_id)

    def write_run_file(self, run_id: str, name: str, text: str) -> None:
        path = self.home / run_id / name
        path.write_text(text)

    def test_new_run_is_explore_not_spawn(self) -> None:
        snap = self.init_run("build the feature")
        self.assertEqual(snap["implementer_next"], "explore-or-plan")
        self.assertFalse(snap["reviewable"])
        refused = self.spawn(snap["run_id"])
        self.assertNotEqual(refused.returncode, 0)
        err = payload(refused)
        self.assertIn("refusing spawn-reviewer", err["error"])
        self.assertIn("explore-or-plan", err["error"])

    def test_approved_plan_without_diff_is_implement(self) -> None:
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.write_run_file(run_id, "plan.md", "# plan\nDo the thing.\n")
        self.write_run_file(run_id, "implementer-summary.md", "claimed done\n")
        got = self.pickup(run_id=run_id)
        self.assertEqual(got["implementer_next"], "implement")
        self.assertFalse(got["reviewable"])
        refused = self.spawn(run_id)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("implement", payload(refused)["error"])

    def test_summary_plus_dirty_tree_is_spawn_reviewer(self) -> None:
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.write_run_file(run_id, "plan.md", "# plan\nDo the thing.\n")
        self.write_run_file(run_id, "implementer-summary.md", "changed README\n")
        (self.repo / "README").write_text("implemented\n")
        got = self.pickup(run_id=run_id)
        self.assertTrue(got["reviewable"])
        self.assertEqual(got["implementer_next"], "spawn-reviewer")

    def test_summary_plus_commit_is_spawn_reviewer(self) -> None:
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.write_run_file(run_id, "plan.md", "# plan\nDo the thing.\n")
        self.write_run_file(run_id, "implementer-summary.md", "committed\n")
        (self.repo / "feature.txt").write_text("x\n")
        git(self.repo, "add", "feature.txt")
        git(self.repo, "commit", "-m", "feat: implement")
        got = self.pickup(run_id=run_id)
        self.assertTrue(got["reviewable"])
        self.assertEqual(got["implementer_next"], "spawn-reviewer")

    def test_different_task_does_not_resume_stale_spawn(self) -> None:
        first = self.init_run("old leftover task")
        self.write_run_file(first["run_id"], "plan.md", "# old plan\n")
        self.write_run_file(first["run_id"], "implementer-summary.md", "old work\n")
        (self.repo / "README").write_text("old implementation still dirty\n")
        stale = self.pickup(cwd=str(self.repo), task="old leftover task")
        self.assertEqual(stale["implementer_next"], "spawn-reviewer")

        other = self.pickup(cwd=str(self.repo), task="brand new task")
        self.assertEqual(other["implementer_next"], "init")
        self.assertIsNone(other["run_id"])

        created = self.init_run("brand new task")
        self.assertTrue(created["created"])
        self.assertNotEqual(created["run_id"], first["run_id"])
        self.assertEqual(created["implementer_next"], "explore-or-plan")

    def test_same_task_reuses_unfinished_run(self) -> None:
        first = self.init_run("same task")
        again = self.init_run("same task")
        self.assertTrue(again["resumed"])
        self.assertEqual(again["run_id"], first["run_id"])


if __name__ == "__main__":
    unittest.main()
