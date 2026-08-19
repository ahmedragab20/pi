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


FAKE_HERDR = r'''#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path

STATE = Path(os.environ["AUTO_PLAN_FAKE_STATE"])


def load():
    return json.loads(STATE.read_text())


def save(state):
    STATE.write_text(json.dumps(state, indent=2) + "\n")


def ok(result):
    print(json.dumps({"ok": True, "result": result}))


def fail(msg):
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def pane_or_die(state, pane_id):
    pane = (state.get("panes") or {}).get(pane_id)
    if not pane or pane.get("closed"):
        fail(f"pane not found: {pane_id}")
    return pane


def main(argv):
    state = load()
    if argv[:2] == ["pane", "get"]:
        ok({"type": "pane_info", "pane": pane_or_die(state, argv[2])})
        return
    if argv[:2] == ["pane", "list"]:
        panes = [p for p in (state.get("panes") or {}).values() if not p.get("closed")]
        ok({"type": "pane_list", "panes": panes})
        return
    if argv[:2] == ["pane", "close"]:
        pane = pane_or_die(state, argv[2])
        pane["closed"] = True
        save(state)
        ok({"type": "pane_info", "pane": pane})
        return
    if argv[:2] == ["pane", "read"]:
        pane = pane_or_die(state, argv[2])
        sys.stdout.write(pane.get("output") or "")
        return
    if argv[:2] == ["pane", "wait-output"]:
        pane = pane_or_die(state, argv[2])
        regex = None
        i = 0
        rest = argv[3:]
        while i < len(rest):
            if rest[i] == "--regex" and i + 1 < len(rest):
                regex = rest[i + 1]
                i += 2
                continue
            i += 1
        text = pane.get("output") or ""
        if state.get("wait_fails"):
            fail("timeout")
        if regex and re.search(regex, text):
            ok({"type": "wait", "matched": True})
            return
        fail("timeout")
    if argv[:2] == ["pane", "current"]:
        pid = state.get("current") or os.environ.get("HERDR_PANE_ID")
        ok({"type": "pane_current", "pane": pane_or_die(state, pid)})
        return
    fail("unhandled: " + " ".join(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
'''


class AutoPlanFinishTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "runs"
        self.home.mkdir()
        self.repo = root / "repo"
        self.repo.mkdir()
        init_repo(self.repo)
        self.bindir = root / "bin"
        self.bindir.mkdir()
        herdr = self.bindir / "herdr"
        herdr.write_text(FAKE_HERDR)
        herdr.chmod(0o755)
        self.state_path = root / "herdr-state.json"
        self.impl = "w1:p1"
        self.rev = "w1:p2"
        self.write_state(
            {
                "current": self.impl,
                "wait_fails": False,
                "panes": {
                    self.impl: {
                        "pane_id": self.impl,
                        "tab_id": "w1:t1",
                        "label": "main",
                        "agent": "pi",
                        "agent_status": "working",
                    },
                    self.rev: {
                        "pane_id": self.rev,
                        "tab_id": "w1:t1",
                        "label": "review:pending",
                        "agent": "pi",
                        "agent_status": "done",
                        "output": "",
                    },
                },
            }
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_state(self, state: dict) -> None:
        self.state_path.write_text(json.dumps(state, indent=2) + "\n")

    def read_state(self) -> dict:
        return json.loads(self.state_path.read_text())

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["AUTO_PLAN_HOME"] = str(self.home)
        env["AUTO_PLAN_FAKE_STATE"] = str(self.state_path)
        env["HERDR_ENV"] = "1"
        env["HERDR_PANE_ID"] = self.impl
        env["PATH"] = f"{self.bindir}:{env.get('PATH', '')}"
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(self.repo),
        )

    def init_ready(self, *, verdict_on_screen: str | None = None) -> str:
        proc = self.run_cli("init", "--cwd", str(self.repo), "--task", "build the feature")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        run_id = payload(proc)["run_id"]
        directory = self.home / run_id
        directory.joinpath("plan.md").write_text("# plan\nDo the thing.\n")
        directory.joinpath("implementer-summary.md").write_text("changed README\n")
        (self.repo / "README").write_text("implemented\n")
        meta = json.loads(directory.joinpath("meta.json").read_text())
        meta["implementer_pane"] = self.impl
        meta["reviewer_pane"] = self.rev
        meta["helper_panes"] = [self.rev]
        directory.joinpath("meta.json").write_text(json.dumps(meta, indent=2) + "\n")
        state = self.read_state()
        state["panes"][self.rev]["label"] = f"review:{run_id}"
        if verdict_on_screen:
            state["panes"][self.rev]["output"] = (
                f"AUTO_PLAN_VERDICT {verdict_on_screen}\n{verdict_on_screen}.\n"
            )
            state["panes"][self.rev]["agent_status"] = "done"
        self.write_state(state)
        return run_id

    def test_wait_verdict_persists_then_closes_reviewer_only(self) -> None:
        run_id = self.init_ready(verdict_on_screen="LGTM")
        proc = self.run_cli("wait-verdict", "--run-id", run_id)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertEqual(got["verdict"], "LGTM")
        self.assertTrue(got["already_done"])
        closed_ids = {row["id"] for row in got["closed"]}
        self.assertIn(self.rev, closed_ids)
        self.assertNotIn(self.impl, closed_ids)
        self.assertIn(self.impl, got["kept"])
        state = self.read_state()
        self.assertTrue(state["panes"][self.rev]["closed"])
        self.assertFalse(state["panes"][self.impl].get("closed"))
        status = json.loads((self.home / run_id / "status.json").read_text())
        self.assertEqual(status["verdict"], "LGTM")
        after = payload(self.run_cli("pickup", "--run-id", run_id))
        self.assertEqual(after["implementer_next"], "report")
        self.assertEqual(after["verdict"], "LGTM")
        self.assertFalse(after["finish_needed"])

    def test_finish_never_closes_implementer_even_if_listed_as_helper(self) -> None:
        run_id = self.init_ready(verdict_on_screen="LGTM")
        meta_path = self.home / run_id / "meta.json"
        meta = json.loads(meta_path.read_text())
        meta["helper_panes"] = [self.rev, self.impl]
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")
        proc = self.run_cli("finish", "--run-id", run_id)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertEqual(got["verdict"], "LGTM")
        closed_ids = {row["id"] for row in got["closed"]}
        self.assertEqual(closed_ids, {self.rev})
        self.assertIn(self.impl, got["kept"])
        state = self.read_state()
        self.assertTrue(state["panes"][self.rev]["closed"])
        self.assertFalse(state["panes"][self.impl].get("closed"))

    def test_finish_discovers_reviewer_by_label_if_id_stale(self) -> None:
        run_id = self.init_ready(verdict_on_screen="BLOCKED")
        meta_path = self.home / run_id / "meta.json"
        meta = json.loads(meta_path.read_text())
        meta["reviewer_pane"] = "w1:p-stale"
        meta["helper_panes"] = ["w1:p-stale"]
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")
        proc = self.run_cli("finish", "--run-id", run_id)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        closed_ids = {row["id"] for row in payload(proc)["closed"]}
        self.assertEqual(closed_ids, {self.rev})
        status = json.loads((self.home / run_id / "status.json").read_text())
        self.assertEqual(status["verdict"], "BLOCKED")

    def test_wait_timeout_does_not_store_a_verdict(self) -> None:
        run_id = self.init_ready()
        state = self.read_state()
        state["wait_fails"] = True
        self.write_state(state)
        proc = self.run_cli("wait-verdict", "--run-id", run_id, "--timeout-ms", "10")
        self.assertNotEqual(proc.returncode, 0)
        status = json.loads((self.home / run_id / "status.json").read_text())
        self.assertNotIn(status.get("verdict"), ("LGTM", "BLOCKED", "timeout"))
        after = payload(self.run_cli("pickup", "--run-id", run_id))
        self.assertEqual(after["implementer_next"], "spawn-reviewer")
        self.assertIsNone(after["verdict"])
        self.assertFalse(self.read_state()["panes"][self.rev].get("closed"))


if __name__ == "__main__":
    unittest.main()
