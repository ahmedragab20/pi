#!/usr/bin/env python3
"""Pickup / spawn-reviewer gates: implement first, never review an empty tree."""

from __future__ import annotations

import concurrent.futures
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


def run_cli(
    home: Path, *args: str, cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
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

    def write_items_state(
        self, run_id: str, *, status: str, item_statuses: dict[str, str]
    ) -> None:
        items = {
            item_id: {
                "id": item_id,
                "status": item_status,
                "paths": ["src/a.py"],
                "depends": [],
            }
            for item_id, item_status in item_statuses.items()
        }
        state = {
            "version": 1,
            "run_id": run_id,
            "cwd": str(self.repo.resolve()),
            "consumer_branch": "main",
            "base_sha": "0",
            "manifest_key": "x",
            "max_parallel": 1,
            "integration_worktree": "",
            "integration_branch": "",
            "integration_head": "",
            "status": status,
            "items": items,
        }
        path = self.home / run_id / "items-state.json"
        path.write_text(json.dumps(state, indent=2))

    def test_pickup_items_state_pending_is_items_drive(self) -> None:
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.write_run_file(run_id, "plan.md", "# plan\nDo it.\n")
        self.write_items_state(run_id, status="running", item_statuses={"A": "pending"})
        self.write_run_file(run_id, "implementer-summary.md", "claimed done\n")
        (self.repo / "README").write_text("dirty\n")
        got = self.pickup(run_id=run_id)
        self.assertEqual(got["implementer_next"], "items-drive")

    def test_pickup_items_all_integrated_is_finalize_items(self) -> None:
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.write_items_state(
            run_id, status="running", item_statuses={"A": "integrated"}
        )
        self.write_run_file(run_id, "plan.md", "# plan\nDo it.\n")
        got = self.pickup(run_id=run_id)
        self.assertEqual(got["implementer_next"], "finalize-items")

    def test_pickup_items_finalized_is_report(self) -> None:
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.write_items_state(
            run_id, status="finalized", item_statuses={"A": "integrated"}
        )
        self.write_run_file(run_id, "plan.md", "# plan\nDo it.\n")
        got = self.pickup(run_id=run_id)
        self.assertEqual(got["implementer_next"], "report")

    def test_pickup_items_all_blocked_is_report(self) -> None:
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.write_items_state(run_id, status="running", item_statuses={"A": "blocked"})
        self.write_run_file(run_id, "plan.md", "# plan\nDo it.\n")
        got = self.pickup(run_id=run_id)
        self.assertEqual(got["implementer_next"], "report")

    def test_init_after_finalized_does_not_resume_as_implement(self) -> None:
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.write_items_state(
            run_id, status="finalized", item_statuses={"A": "integrated"}
        )
        self.write_run_file(run_id, "plan.md", "# plan\nDo it.\n")
        # Same cwd+task pickup: finalized run is reported, never resumed.
        got = self.pickup(cwd=str(self.repo), task="build the feature")
        self.assertEqual(got["implementer_next"], "report")
        # A brand-new init of the same task must not reuse the finalized run.
        new = self.init_run("build the feature", new=True)
        self.assertTrue(new["created"])
        self.assertNotEqual(new["run_id"], run_id)

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

    def test_dirty_at_init_is_not_reviewable_until_content_change(self) -> None:
        # Pre-existing working-tree dirtiness must not be credited to this run.
        (self.repo / "README").write_text("pre-existing uncommitted change\n")
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]
        self.assertFalse(snap["reviewable"])
        self.write_run_file(run_id, "plan.md", "# plan\nDo the thing.\n")
        self.write_run_file(run_id, "implementer-summary.md", "changed README\n")
        got = self.pickup(run_id=run_id)
        self.assertEqual(got["implementer_next"], "implement")
        self.assertFalse(got["reviewable"])
        # A real, subsequent content change flips it reviewable.
        (self.repo / "README").write_text("implemented by the run\n")
        after = self.pickup(run_id=run_id)
        self.assertTrue(after["reviewable"])
        self.assertEqual(after["implementer_next"], "spawn-reviewer")

    def diff_snapshot(self, run_id: str) -> dict:
        proc = run_cli(self.home, "diff-snapshot", "--run-id", run_id)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        return payload(proc)

    # ---- edge-case: diff-snapshot from a dirty init ---------------------

    def test_diff_snapshot_dirty_init_excludes_preexisting_dirt_includes_task_change(
        self,
    ) -> None:
        # Init while the consumer tree is already dirty: that dirt is *not*
        # credited to this run, so the base/current tree diff must be empty.
        (self.repo / "README").write_text("pre-existing uncommitted change\n")
        snap = self.init_run("build the feature")
        run_id = snap["run_id"]

        first = self.diff_snapshot(run_id)
        self.assertTrue(first["ok"], first)
        self.assertTrue(first["base_tree"])
        self.assertTrue(first["current_tree"])
        self.assertEqual(first["changed_paths"], [], first["changed_paths"])
        self.assertIn("--", first["diff_args"])

        # A real, subsequent task change flips only the new path into the diff;
        # the unchanged pre-existing dirt stays excluded.
        (self.repo / "feature.txt").write_text("implemented\n")
        second = self.diff_snapshot(run_id)
        self.assertTrue(second["ok"], second)
        self.assertNotEqual(second["current_tree"], second["base_tree"])
        self.assertIn("feature.txt", second["changed_paths"])
        self.assertNotIn("README", second["changed_paths"])

    # ---- edge-case: events.ndjson integrity under concurrency -----------

    def test_concurrent_init_events_ndjson_remains_one_object_per_line(self) -> None:
        def do_init():
            args = ["init", "--cwd", str(self.repo), "--task", "concurrent task"]
            proc = run_cli(self.home, *args)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return payload(proc)["run_id"]

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            ids = list(ex.map(lambda _: do_init(), range(6)))
        # Still exactly one shared run (and thus one shared events file).
        self.assertEqual(len(set(ids)), 1)
        run_id = ids[0]
        events_path = self.home / run_id / "events.ndjson"
        self.assertTrue(events_path.is_file(), "no events.ndjson written")

        # Every line is exactly one standalone JSON object (a concatenated or
        # torn line would make json.loads raise here).
        parsed = []
        lines = events_path.read_text().splitlines()
        self.assertTrue(lines, "events.ndjson must not be empty")
        for line in lines:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            self.assertIsInstance(obj, dict)
            self.assertIn("event", obj)
            parsed.append(obj)
        self.assertTrue(any(e.get("event") == "status" for e in parsed))

    def test_concurrent_init_same_cwd_task_yields_one_run(self) -> None:
        def do_init():
            args = ["init", "--cwd", str(self.repo), "--task", "concurrent task"]
            proc = run_cli(self.home, *args)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return payload(proc)["run_id"]

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            ids = list(ex.map(lambda _: do_init(), range(2)))
        self.assertEqual(len(set(ids)), 1)


FAKE_HERDR = r"""#!/usr/bin/env python3
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
    if argv[:2] == ["agent", "prompt"]:
        # The script now waits until the reviewer starts working so the prompt
        # is actually submitted instead of sitting in the composer.
        state.setdefault("agent_prompt_calls", []).append(argv)
        save(state)
        ok({"type": "agent_prompt", "accepted": True})
        return
    if argv[:2] == ["notification", "show"]:
        state.setdefault("notification_calls", []).append(argv)
        save(state)
        ok({"type": "notification_show", "shown": True, "reason": "shown"})
        return
    fail("unhandled: " + " ".join(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
"""


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

    def init_ready(self, *, verdict: str | None = None) -> str:
        """Ready a run; verdict, if given, is recorded authoritatively via
        record-verdict against meta.verdict_nonce (never screen-only text)."""
        proc = self.run_cli(
            "init", "--cwd", str(self.repo), "--task", "build the feature"
        )
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
        if verdict:
            state["panes"][self.rev]["agent_status"] = "done"
        self.write_state(state)
        if verdict:
            # Zero-open findings + nonce-gated record-verdict is the only
            # authoritative way a verdict is stored; a pane marker alone.
            directory.joinpath("findings.md").write_text(ZERO_OPEN_FINDINGS)
            meta = json.loads(directory.joinpath("meta.json").read_text())
            nonce = str(meta["verdict_nonce"])
            cp = self.run_cli("review-checkpoint", "--run-id", run_id, "--nonce", nonce)
            self.assertEqual(cp.returncode, 0, cp.stderr + cp.stdout)
            self.assertTrue(payload(cp)["ok"], cp.stderr + cp.stdout)
            rec = self.run_cli(
                "record-verdict",
                "--run-id",
                run_id,
                "--verdict",
                verdict,
                "--nonce",
                nonce,
            )
            self.assertEqual(rec.returncode, 0, rec.stderr + rec.stdout)
            self.assertTrue(payload(rec)["ok"], rec.stderr + rec.stdout)
        return run_id

    def test_wait_verdict_persists_then_closes_reviewer_only(self) -> None:
        run_id = self.init_ready(verdict="LGTM")
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

    def test_finish_never_closes_stale_reviewer_pane_mismatching_identity(self) -> None:
        run_id = self.init_ready(verdict="LGTM")
        meta_path = self.home / run_id / "meta.json"
        meta = json.loads(meta_path.read_text())
        stale = "w1:p-other"
        state = self.read_state()
        # A live pane whose label/identity does <not> match this run.
        state["panes"][stale] = {
            "pane_id": stale,
            "tab_id": "w1:t2",
            "label": "shell",
            "agent": None,
            "agent_status": "none",
            "output": "",
        }
        meta["reviewer_pane"] = stale
        meta["helper_panes"] = [stale, self.rev]
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")
        self.write_state(state)
        proc = self.run_cli("finish", "--run-id", run_id)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        closed_ids = {row["id"] for row in got["closed"]}
        self.assertNotIn(stale, closed_ids)
        self.assertIn(self.rev, closed_ids)
        state = self.read_state()
        self.assertFalse(state["panes"][stale].get("closed"))
        self.assertTrue(state["panes"][self.rev].get("closed"))

    def test_prose_verdict_text_without_run_file_does_not_persist_lgtm(self) -> None:
        run_id = self.init_ready()
        state = self.read_state()
        # Only prose/example text contains the marker; no authoritative verdict.
        state["panes"][self.rev]["output"] = (
            "The skill doc shows AUTO_PLAN_VERDICT LGTM as an example string to quote. "
            "Do not print the literal marker in prose.\n"
        )
        state["panes"][self.rev]["agent_status"] = "done"
        self.write_state(state)
        proc = self.run_cli("wait-verdict", "--run-id", run_id)
        status = json.loads((self.home / run_id / "status.json").read_text())
        self.assertNotEqual(status.get("verdict"), "LGTM")
        self.assertNotEqual(status.get("verdict"), "BLOCKED")
        self.assertFalse(self.read_state()["panes"][self.rev].get("closed"))

    def test_prompt_always_passes_wait_until_working_timeout_30000(self) -> None:
        run_id = self.init_ready()
        proc = self.run_cli("spawn-reviewer", "--run-id", run_id)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        calls = self.read_state().get("agent_prompt_calls", [])
        self.assertTrue(calls, "spawn-reviewer should invoke herdr agent prompt")
        for argv in calls:
            self.assertEqual(argv[:2], ["agent", "prompt"])
            self.assertIn("--wait", argv)
            self.assertIn("--until", argv)
            self.assertIn("working", argv)
            self.assertIn("--timeout", argv)
            self.assertEqual(argv[argv.index("--timeout") + 1], "30000")

    def test_finish_never_closes_implementer_even_if_listed_as_helper(self) -> None:
        run_id = self.init_ready(verdict="LGTM")
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
        run_id = self.init_ready(verdict="BLOCKED")
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
        # Park disposition applies only while the reviewer is actively working.
        state["panes"][self.rev]["agent_status"] = "working"
        state["panes"][self.rev]["output"] = ""
        state["wait_fails"] = True
        self.write_state(state)
        proc = self.run_cli("wait-verdict", "--run-id", run_id, "--timeout-ms", "10")
        # Authoritative protocol: exit 0 and park — store no verdict, close no pane.
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertEqual(got["disposition"], "park")
        status = json.loads((self.home / run_id / "status.json").read_text())
        self.assertNotIn(status.get("verdict"), ("LGTM", "BLOCKED", "timeout"))
        after = payload(self.run_cli("pickup", "--run-id", run_id))
        self.assertEqual(after["implementer_next"], "wait-verdict")
        self.assertIsNone(after["verdict"])
        self.assertFalse(self.read_state()["panes"][self.rev].get("closed"))

    def test_wait_verdict_stale_recorded_marker_without_file_parks(self) -> None:
        run_id = self.init_ready()
        state = self.read_state()
        state["panes"][self.rev]["output"] = f"AUTO_PLAN_RECORDED {run_id} LGTM"
        state["panes"][self.rev]["agent_status"] = "working"
        self.write_state(state)
        proc = self.run_cli("wait-verdict", "--run-id", run_id)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertEqual(got["disposition"], "park")
        self.assertFalse((self.home / run_id / "verdict.json").is_file())
        self.assertFalse(self.read_state()["panes"][self.rev].get("closed"))

    def test_wait_verdict_foreign_pane_identity_mismatch(self) -> None:
        run_id = self.init_ready()
        foreign = "w1:p-foreign"
        state = self.read_state()
        state["panes"][foreign] = {
            "pane_id": foreign,
            "tab_id": "w1:t9",
            "label": "shell",
            "agent": "pi",
            "agent_status": "working",
            "output": "",
        }
        meta_path = self.home / run_id / "meta.json"
        meta = json.loads(meta_path.read_text())
        meta["reviewer_pane"] = foreign
        meta["helper_panes"] = [foreign]
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")
        self.write_state(state)
        proc = self.run_cli("wait-verdict", "--run-id", run_id)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertFalse(got.get("ok"))
        self.assertIn("identity", (got.get("error") or "").lower())
        self.assertFalse(self.read_state()["panes"][foreign].get("closed"))
        self.assertFalse((self.home / run_id / "verdict.json").is_file())


OPEN_FINDINGS = (
    "# Findings — round 1\n"
    "\n"
    "### Issue 1 -- Severity: bug\n"
    "- **File**: src/app.py:12\n"
    "- **Description**: regression in login\n"
    "- **Status**: open\n"
)

ZERO_OPEN_FINDINGS = (
    "# Findings — round 1\n"
    "\n"
    "### Issue 1 -- Severity: nit\n"
    "- **File**: src/app.py:12\n"
    "- **Description**: cosmetic\n"
    "- **Status**: fixed\n"
)


class NewVerdictProtocolTests(unittest.TestCase):
    """record-verdict / review-checkpoint / wait-verdict park semantics."""

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
                        "agent_status": "working",
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

    def cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return self.cli_from(self.impl, *args)

    def cli_from(self, pane_id: str, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["AUTO_PLAN_HOME"] = str(self.home)
        env["AUTO_PLAN_FAKE_STATE"] = str(self.state_path)
        env["HERDR_ENV"] = "1"
        env["HERDR_PANE_ID"] = pane_id
        env["PATH"] = f"{self.bindir}:{env.get('PATH', '')}"
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(self.repo),
        )

    def fresh_run(self) -> str:
        proc = self.cli("init", "--cwd", str(self.repo), "--task", "build the feature")
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
        self.write_state(state)
        return run_id

    @staticmethod
    def nonce(run_id: str, home: Path) -> str:
        meta = json.loads((home / run_id / "meta.json").read_text())
        return str(meta["verdict_nonce"])

    def test_record_verdict_rejects_wrong_nonce(self) -> None:
        run_id = self.fresh_run()
        proc = self.cli(
            "record-verdict",
            "--run-id",
            run_id,
            "--verdict",
            "LGTM",
            "--nonce",
            "definitely-not-the-nonce",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("nonce", got["error"].lower())

    def test_record_verdict_rejects_lgtm_while_findings_open(self) -> None:
        run_id = self.fresh_run()
        (self.home / run_id / "findings.md").write_text(OPEN_FINDINGS)
        nonce = self.nonce(run_id, self.home)
        proc = self.cli(
            "record-verdict", "--run-id", run_id, "--verdict", "LGTM", "--nonce", nonce
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertFalse(got["ok"])
        self.assertIn("open", got["error"].lower())

    def test_record_verdict_from_helper_prompts_idle_leader_and_does_not_close(
        self,
    ) -> None:
        run_id = self.fresh_run()
        (self.home / run_id / "findings.md").write_text(ZERO_OPEN_FINDINGS)
        nonce = self.nonce(run_id, self.home)
        cp = self.cli(
            "review-checkpoint", "--run-id", run_id, "--nonce", nonce
        )
        self.assertEqual(cp.returncode, 0, cp.stderr + cp.stdout)
        self.assertTrue(payload(cp)["ok"], cp.stderr + cp.stdout)
        state = self.read_state()
        # Screenshot case: coordinator parked after wait-verdict, reviewer records.
        state["panes"][self.impl]["agent_status"] = "idle"
        state["panes"][self.rev]["agent_status"] = "working"
        self.write_state(state)
        rec = self.cli_from(
            self.rev,
            "record-verdict",
            "--run-id",
            run_id,
            "--verdict",
            "LGTM",
            "--nonce",
            nonce,
        )
        self.assertEqual(rec.returncode, 0, rec.stderr + rec.stdout)
        got = payload(rec)
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["verdict"], "LGTM")
        leader = got.get("leader") or {}
        self.assertTrue(leader.get("prompted"), got)
        self.assertEqual(leader.get("pane_id"), self.impl)
        prompts = self.read_state().get("agent_prompt_calls") or []
        self.assertTrue(prompts, "helper must prompt the session leader")
        last = prompts[-1]
        self.assertEqual(last[:3], ["agent", "prompt", self.impl])
        self.assertIn("--wait", last)
        self.assertIn("working", last)
        self.assertIn(f"AUTO_PLAN_RECORDED {run_id} LGTM", last[3])
        after = self.read_state()
        self.assertFalse(after["panes"][self.rev].get("closed"))
        self.assertFalse(after["panes"][self.impl].get("closed"))

    def test_record_verdict_from_leader_pane_does_not_reprompt_self(self) -> None:
        run_id = self.fresh_run()
        (self.home / run_id / "findings.md").write_text(ZERO_OPEN_FINDINGS)
        nonce = self.nonce(run_id, self.home)
        cp = self.cli(
            "review-checkpoint", "--run-id", run_id, "--nonce", nonce
        )
        self.assertEqual(cp.returncode, 0, cp.stderr + cp.stdout)
        rec = self.cli(
            "record-verdict",
            "--run-id",
            run_id,
            "--verdict",
            "LGTM",
            "--nonce",
            nonce,
        )
        self.assertEqual(rec.returncode, 0, rec.stderr + rec.stdout)
        got = payload(rec)
        self.assertTrue(got["ok"], got)
        leader = got.get("leader") or {}
        self.assertFalse(leader.get("prompted"))
        self.assertEqual(leader.get("reason"), "already on leader pane")
        self.assertFalse(self.read_state().get("agent_prompt_calls"))

    def test_record_verdict_valid_zero_open_writes_authoritative_pickup_finish(
        self,
    ) -> None:
        run_id = self.fresh_run()
        (self.home / run_id / "findings.md").write_text(ZERO_OPEN_FINDINGS)
        nonce = self.nonce(run_id, self.home)
        cp = self.cli("review-checkpoint", "--run-id", run_id, "--nonce", nonce)
        self.assertEqual(cp.returncode, 0, cp.stderr + cp.stdout)
        self.assertTrue(payload(cp)["ok"], cp.stderr + cp.stdout)
        rec = self.cli(
            "record-verdict", "--run-id", run_id, "--verdict", "LGTM", "--nonce", nonce
        )
        self.assertEqual(rec.returncode, 0, rec.stderr + rec.stdout)
        verdict_path = self.home / run_id / "verdict.json"
        self.assertTrue(verdict_path.is_file())
        authoritative = json.loads(verdict_path.read_text())
        self.assertEqual(authoritative["verdict"], "LGTM")
        after = payload(self.cli("pickup", "--run-id", run_id))
        self.assertEqual(after["verdict"], "LGTM")
        self.assertEqual(after["implementer_next"], "report")
        fin = self.cli("finish", "--run-id", run_id)
        self.assertEqual(fin.returncode, 0, fin.stderr + fin.stdout)
        closed_ids = {row["id"] for row in payload(fin)["closed"]}
        self.assertIn(self.rev, closed_ids)
        self.assertNotIn(self.impl, closed_ids)
        state = self.read_state()
        self.assertTrue(state["panes"][self.rev]["closed"])
        self.assertFalse(state["panes"][self.impl].get("closed"))

    def test_review_checkpoint_increments_round_and_no_progress_blocks(self) -> None:
        run_id = self.fresh_run()
        (self.home / run_id / "findings.md").write_text(OPEN_FINDINGS)
        first = self.cli(
            "review-checkpoint",
            "--run-id",
            run_id,
            "--nonce",
            self.nonce(run_id, self.home),
        )
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        status = json.loads((self.home / run_id / "status.json").read_text())
        self.assertEqual(status["round"], 1)
        # Same open finding, git state untouched by the reviewer.
        second = self.cli(
            "review-checkpoint",
            "--run-id",
            run_id,
            "--nonce",
            self.nonce(run_id, self.home),
        )
        self.assertEqual(second.returncode, 0, second.stderr + second.stdout)
        got = payload(second)
        self.assertFalse(got["ok"])
        self.assertIn("no-progress", got["error"].lower())
        after = payload(self.cli("pickup", "--run-id", run_id))
        after_verdict = after.get("verdict")
        if after_verdict is not None:
            self.assertEqual(after_verdict, "BLOCKED")
        else:
            blocked = json.loads((self.home / run_id / "status.json").read_text())
            self.assertEqual(blocked.get("verdict"), "BLOCKED")
            self.assertEqual(blocked.get("block_reason"), "no-progress")

    def test_review_checkpoint_blocks_at_sixth_still_open_round(self) -> None:
        # Six rounds, each *changing* the review/git fingerprint so the
        # no-progress counter never trips. The hard six-round cap still blocks:
        # the sixth still-open round must fail with max-review-rounds.
        run_id = self.fresh_run()
        (self.home / run_id / "findings.md").write_text(OPEN_FINDINGS)
        n = 0
        for expected_round in range(1, 6):
            n += 1
            (self.repo / "nudge.txt").write_text(f"round {n}\n")
            proc = self.cli(
                "review-checkpoint",
                "--run-id",
                run_id,
                "--nonce",
                self.nonce(run_id, self.home),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
            got = payload(proc)
            self.assertTrue(got["ok"], got)
            self.assertEqual(got["round"], expected_round)
            self.assertGreater(got["open_findings"], 0)

        # Sixth still-open round: even though we changed the fingerprint again,
        # the round cap fires and the run is blocked.
        n += 1
        (self.repo / "nudge.txt").write_text(f"round {n}\n")
        proc = self.cli(
            "review-checkpoint",
            "--run-id",
            run_id,
            "--nonce",
            self.nonce(run_id, self.home),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertFalse(got["ok"], got)
        self.assertIn("round", got["error"].lower())
        self.assertEqual(got["round"], 6)
        status = json.loads((self.home / run_id / "status.json").read_text())
        self.assertEqual(status.get("round"), 6)
        self.assertEqual(status.get("verdict"), "BLOCKED")

    def test_wait_verdict_timeout_working_reviewer_parks(self) -> None:
        run_id = self.fresh_run()
        state = self.read_state()
        state["panes"][self.rev]["agent_status"] = "working"
        state["panes"][self.rev]["output"] = ""
        state["wait_fails"] = True
        self.write_state(state)
        proc = self.cli("wait-verdict", "--run-id", run_id, "--timeout-ms", "10")
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        got = payload(proc)
        self.assertEqual(got["disposition"], "park")
        status = json.loads((self.home / run_id / "status.json").read_text())
        self.assertNotIn(status.get("verdict"), ("LGTM", "BLOCKED", "timeout"))
        self.assertFalse(self.read_state()["panes"][self.rev].get("closed"))

    def test_review_checkpoint_rejects_wrong_or_missing_nonce(self) -> None:
        run_id = self.fresh_run()
        missing = self.cli("review-checkpoint", "--run-id", run_id)
        self.assertNotEqual(missing.returncode, 0)
        status_path = self.home / run_id / "status.json"
        round_now = 0
        if status_path.is_file():
            round_now = json.loads(status_path.read_text()).get("round") or 0
        self.assertEqual(round_now, 0)
        wrong = self.cli(
            "review-checkpoint",
            "--run-id",
            run_id,
            "--nonce",
            "not-the-nonce",
        )
        self.assertEqual(wrong.returncode, 0, wrong.stderr + wrong.stdout)
        got = payload(wrong)
        self.assertFalse(got["ok"])
        self.assertIn("nonce", (got.get("error") or "").lower())
        if status_path.is_file():
            round_now = json.loads(status_path.read_text()).get("round") or 0
        self.assertEqual(round_now, 0)

    def test_record_verdict_lgtm_requires_findings_file(self) -> None:
        run_id = self.fresh_run()
        nonce = self.nonce(run_id, self.home)
        rec = self.cli(
            "record-verdict", "--run-id", run_id, "--verdict", "LGTM", "--nonce", nonce
        )
        self.assertEqual(rec.returncode, 0, rec.stderr + rec.stdout)
        self.assertFalse(payload(rec)["ok"])

    def test_record_verdict_lgtm_requires_checkpoint(self) -> None:
        run_id = self.fresh_run()
        (self.home / run_id / "findings.md").write_text(ZERO_OPEN_FINDINGS)
        nonce = self.nonce(run_id, self.home)
        rec = self.cli(
            "record-verdict", "--run-id", run_id, "--verdict", "LGTM", "--nonce", nonce
        )
        self.assertEqual(rec.returncode, 0, rec.stderr + rec.stdout)
        self.assertFalse(payload(rec)["ok"])

    def test_pickup_already_done_help_omits_auto_plan_verdict(self) -> None:
        run_id = self.fresh_run()
        (self.home / run_id / "findings.md").write_text(ZERO_OPEN_FINDINGS)
        nonce = self.nonce(run_id, self.home)
        cp = self.cli("review-checkpoint", "--run-id", run_id, "--nonce", nonce)
        self.assertEqual(cp.returncode, 0, cp.stderr + cp.stdout)
        rec = self.cli(
            "record-verdict", "--run-id", run_id, "--verdict", "LGTM", "--nonce", nonce
        )
        self.assertEqual(rec.returncode, 0, rec.stderr + rec.stdout)
        self.assertTrue(payload(rec)["ok"])
        after = payload(self.cli("pickup", "--run-id", run_id))
        self.assertNotIn("AUTO_PLAN_VERDICT", after.get("reviewer_help") or "")


if __name__ == "__main__":
    unittest.main()
