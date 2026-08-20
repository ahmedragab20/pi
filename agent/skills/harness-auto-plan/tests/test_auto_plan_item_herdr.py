#!/usr/bin/env python3
"""Fake-herdr verification of the item scheduler's herdr contracts.

Drives scripts/auto-plan.py's item leaf commands (claim-item / record-item /
spawn-item / spawn-item-reviewer / wait-item) against a fake `herdr` CLI that
records every split/env/rename/start/prompt so the exact pane contract can be
asserted:

  spawn-item  --no-focus split in the item worktree cwd with
               PI_THINKING_ROUTER=0 plus run/item/role env, labels the pane
               auto:<run>:<item>:impl:<attempt>, starts pi, and prompts with
               --wait --until working --timeout 30000.
  spawn-item  refuses a duplicate implementer without a second split.
  spawn-item-reviewer closes the completed implementer and always makes a
               distinct fresh reviewer pane labelled :review:.
  wait-item   ignores prose markers while the item is not terminal, parks on a
               working-agent timeout, and closes only the matching item-role
               pane once completion is authoritative.

Isolation: each test uses a throwaway temp HOME, a fresh temp git consumer
repo, a temp worktree home, and a fake herdr binary on PATH.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "auto-plan.py"
DEFAULT_PROMPT_TIMEOUT_MS = "30000"
ITEM_ID = "A"
RUN_ID = "run1"


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
    )


def init_consumer(path: Path) -> None:
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    git(path, "config", "user.email", "item-herdr@example.com")
    git(path, "config", "user.name", "item-herdr")
    git(path, "config", "commit.gpgsign", "false")
    (path / "README").write_text("base\n")
    (path / "src").mkdir(exist_ok=True)
    git(path, "add", ".")
    git(path, "commit", "-m", "init")


FAKE_HERDR = r'''#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path

STATE = Path(os.environ["AUTO_PLAN_FAKE_STATE"])


def load():
    return json.loads(STATE.read_text())


def load_or_new():
    if STATE.is_file():
        return load()
    return {"panes": {}, "wait_fails": False}


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


def ensure_pane(state, pane_id):
    panes = state.setdefault("panes", {})
    if pane_id not in panes:
        panes[pane_id] = {
            "pane_id": pane_id,
            "tab_id": "w1:t1",
            "label": "",
            "agent": None,
            "agent_status": "none",
            "cwd": None,
            "output": "",
            "closed": False,
        }
    return panes[pane_id]


def main(argv):
    state = load_or_new()
    if argv[:2] == ["pane", "current"]:
        pid = state.get("current") or os.environ.get("HERDR_PANE_ID")
        ok({"type": "pane_current", "pane": ensure_pane(state, pid) if pid else {}})
        save(state)
        return
    if argv[:2] == ["pane", "get"]:
        pid = argv[2]
        ok({"type": "pane_info", "pane": ensure_pane(state, pid)})
        save(state)
        return
    if argv[:2] == ["pane", "list"]:
        panes = [p for p in (state.get("panes") or {}).values() if not p.get("closed")]
        ok({"type": "pane_list", "panes": panes})
        return
    if argv[:2] == ["pane", "close"]:
        pane = ensure_pane(state, argv[2])
        pane["closed"] = True
        save(state)
        ok({"type": "pane_info", "pane": pane})
        return
    if argv[:2] == ["pane", "read"]:
        pane = ensure_pane(state, argv[2])
        sys.stdout.write(pane.get("output") or "")
        return
    if argv[:2] == ["pane", "rename"]:
        pane = ensure_pane(state, argv[2])
        pane["label"] = argv[3]
        state.setdefault("pane_renames", {})[argv[2]] = argv[3]
        save(state)
        ok({"type": "pane_info", "pane": pane})
        return
    if argv[:2] == ["pane", "split"]:
        rest = argv[2:]
        self_pane = rest[0]
        direction = None
        no_focus = False
        cwd = None
        env = {}
        i = 1
        while i < len(rest):
            if rest[i] == "--direction" and i + 1 < len(rest):
                direction = rest[i + 1]
                i += 2
                continue
            if rest[i] == "--no-focus":
                no_focus = True
                i += 1
                continue
            if rest[i] == "--cwd" and i + 1 < len(rest):
                cwd = rest[i + 1]
                i += 2
                continue
            if rest[i] == "--env" and i + 1 < len(rest):
                key, _, value = rest[i + 1].partition("=")
                env[key] = value
                i += 2
                continue
            i += 1
        state.setdefault("pane_counter", 0)
        state["pane_counter"] += 1
        pid = f"w1:p{state['pane_counter']}"
        ensure_pane(state, pid)
        state["panes"][pid]["cwd"] = cwd
        state.setdefault("split_calls", []).append(
            {
                "self_pane": self_pane,
                "direction": direction,
                "no_focus": no_focus,
                "cwd": cwd,
                "env": env,
                "pane_id": pid,
            }
        )
        save(state)
        ok({"type": "pane_split", "pane": {"pane_id": pid}})
        return
    if argv[:2] == ["pane", "wait-output"]:
        pane_id = argv[2]
        pane = ensure_pane(state, pane_id)
        pattern = None
        i = 3
        while i < len(argv):
            if argv[i] == "--regex" and i + 1 < len(argv):
                pattern = argv[i + 1]
                i += 2
                continue
            i += 1
        text = pane.get("output") or ""
        if state.get("wait_fails"):
            fail("timeout")
        if pattern and re.search(pattern, text):
            ok({"type": "pane_wait", "matched": True})
            return
        fail("timeout")
    if argv[:2] == ["agent", "start"]:
        name = argv[2]
        kind = None
        pane_id = None
        i = 3
        while i < len(argv):
            if argv[i] == "--kind" and i + 1 < len(argv):
                kind = argv[i + 1]
                i += 2
                continue
            if argv[i] == "--pane" and i + 1 < len(argv):
                pane_id = argv[i + 1]
                i += 2
                continue
            i += 1
        pane = ensure_pane(state, pane_id or "")
        pane["agent"] = kind
        pane["agent_status"] = "working"
        state.setdefault("agent_start_calls", []).append(argv)
        save(state)
        ok({"type": "agent_started", "agent": name})
        return
    if argv[:2] == ["agent", "prompt"]:
        pane_id = argv[2]
        pane = ensure_pane(state, pane_id)
        pane["agent_status"] = "working"
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
'''


class ItemHerdrTests(unittest.TestCase):
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
        self.manifest.write_text(json.dumps({"items": [{"id": ITEM_ID, "paths": ["src/a.py"]}]}) + "\n")

        self.bindir = root / "bin"
        self.bindir.mkdir()
        herdr = self.bindir / "herdr"
        herdr.write_text(FAKE_HERDR)
        herdr.chmod(0o755)
        self.state_path = root / "herdr-state.json"
        self.impl = "w1:p1"
        self.pane_counter = 1
        self.write_state(self._fresh_state())

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _fresh_state(self) -> dict:
        return {
            "current": self.impl,
            "wait_fails": False,
            "pane_counter": self.pane_counter,
            "panes": {
                self.impl: {
                    "pane_id": self.impl,
                    "tab_id": "w1:t1",
                    "label": "main",
                    "agent": "pi",
                    "agent_status": "working",
                    "cwd": str(self.repo),
                    "output": "",
                    "closed": False,
                }
            },
        }

    # ---- state / cli helpers --------------------------------------------

    def write_state(self, state: dict) -> None:
        self.state_path.write_text(json.dumps(state, indent=2) + "\n")

    def read_state(self) -> dict:
        return json.loads(self.state_path.read_text())

    def cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["AUTO_PLAN_HOME"] = str(self.home)
        env["AUTO_PLAN_WORKTREE_HOME"] = str(self.worktree_home)
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

    def payload(self, proc: subprocess.CompletedProcess[str]) -> dict:
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        text = (proc.stdout or "").strip()
        self.assertTrue(text, f"empty stdout (stderr={proc.stderr!r})")
        return json.loads(text)

    def items_init(self) -> None:
        got = self.payload(
            self.cli(
                "items-init",
                "--run-id",
                RUN_ID,
                "--manifest",
                str(self.manifest),
                "--max-parallel",
                "2",
            )
        )
        self.assertTrue(got["ok"], got)

    def claim(self) -> dict:
        got = self.payload(
            self.cli(
                "claim-item",
                "--run-id",
                RUN_ID,
                "--item-id",
                ITEM_ID,
                "--role",
                "implementer",
            )
        )
        self.assertTrue(got["ok"], got)
        return got

    def make_change(self, worktree: str) -> None:
        root = Path(worktree)
        (root / "src").mkdir(exist_ok=True)
        (root / "src" / "a.py").write_text("def item():\n    return 1\n")

    def record(self, nonce: str) -> dict:
        got = self.payload(
            self.cli(
                "record-item",
                "--run-id",
                RUN_ID,
                "--item-id",
                ITEM_ID,
                "--nonce",
                nonce,
            )
        )
        self.assertTrue(got["ok"], got)
        return got

    def spawn_item(self) -> dict:
        return self.payload(
            self.cli("spawn-item", "--run-id", RUN_ID, "--item-id", ITEM_ID)
        )

    def spawn_reviewer(self) -> dict:
        return self.payload(
            self.cli(
                "spawn-item-reviewer", "--run-id", RUN_ID, "--item-id", ITEM_ID
            )
        )

    # ---- contract 1: spawn-item -----------------------------------------

    def test_spawn_item_splits_no_focus_in_item_worktree_with_env_and_prompts_pi(self) -> None:
        self.items_init()
        claimed = self.claim()
        spawned = self.spawn_item()
        self.assertTrue(spawned["ok"], spawned)
        self.assertEqual(spawned["role"], "implementer")
        self.assertEqual(spawned["attempt"], 1)
        self.assertEqual(spawned["action"], "wait-item")

        state = self.read_state()
        splits = state.get("split_calls") or []
        self.assertEqual(len(splits), 1, splits)
        split = splits[0]
        # no-focus, in the item worktree cwd
        self.assertTrue(split["no_focus"])
        self.assertEqual(Path(split["cwd"]).resolve(), Path(claimed["worktree"]).resolve())
        env = split["env"]
        self.assertEqual(env.get("PI_THINKING_ROUTER"), "0")
        self.assertEqual(env.get("AUTO_PLAN_RUN_ID"), RUN_ID)
        self.assertEqual(env.get("AUTO_PLAN_ITEM_ID"), ITEM_ID)
        self.assertEqual(env.get("AUTO_PLAN_ROLE"), "implementer")

        # pane is labelled auto:<run>:<item>:impl:<attempt>
        pane_id = spawned["pane_id"]
        expected_label = f"auto:{RUN_ID}:{ITEM_ID}:impl:{spawned['attempt']}"
        self.assertEqual(spawned["label"], expected_label)
        self.assertEqual(
            (state.get("pane_renames") or {}).get(pane_id), expected_label
        )
        self.assertEqual(state["panes"][pane_id]["label"], expected_label)

        # starts pi on the labelled pane (no second split for a reviewer)
        starts = state.get("agent_start_calls") or []
        self.assertEqual(len(starts), 1, starts)
        start = starts[0]
        self.assertEqual(start[:2], ["agent", "start"])
        self.assertEqual(start[start.index("--kind") + 1], "pi")
        self.assertEqual(start[start.index("--pane") + 1], pane_id)

        # prompts with --wait --until working --timeout 30000
        prompts = state.get("agent_prompt_calls") or []
        self.assertEqual(len(prompts), 1, prompts)
        prompt = prompts[0]
        self.assertEqual(prompt[:2], ["agent", "prompt"])
        self.assertIn("--wait", prompt)
        self.assertIn("--until", prompt)
        self.assertIn("working", prompt)
        self.assertIn("--timeout", prompt)
        self.assertEqual(prompt[prompt.index("--timeout") + 1], DEFAULT_PROMPT_TIMEOUT_MS)

    # ---- contract 2: duplicate implementer spawn ------------------------

    def test_done_implementer_spawn_reprompts_same_pane_without_second_split(self) -> None:
        self.items_init()
        self.claim()
        first = self.spawn_item()
        self.assertTrue(first["ok"], first)
        self.assertEqual(len(self.read_state()["split_calls"]), 1)

        # The implementer pane's agent finished ("done"): a second spawn must
        # re-prompt the SAME labelled pane, not split a second implementer and
        # not refuse.
        state = self.read_state()
        state["panes"][first["pane_id"]]["agent_status"] = "done"
        self.write_state(state)
        prompts_before = len((self.read_state().get("agent_prompt_calls") or []))

        second = self.spawn_item()
        self.assertTrue(second["ok"], second)
        self.assertFalse(second.get("spawned", False))
        self.assertEqual(second["pane_id"], first["pane_id"])
        self.assertEqual(second["action"], "wait-item")
        # No second split and no second start; exactly one split, one start.
        state = self.read_state()
        self.assertEqual(len(state["split_calls"]), 1, state["split_calls"])
        self.assertEqual(len(state.get("agent_start_calls") or []), 1)
        # A new agent prompt/retry happened on the SAME pane.
        prompts = state.get("agent_prompt_calls") or []
        self.assertGreater(len(prompts), prompts_before, prompts)
        self.assertEqual(prompts[-1][:2], ["agent", "prompt"])
        self.assertEqual(prompts[-1][2], first["pane_id"])

    def test_working_implementer_spawn_returns_spawned_false_without_second_split(self) -> None:
        self.items_init()
        self.claim()
        first = self.spawn_item()
        self.assertTrue(first["ok"], first)

        # Leave the agent "working" (already handled): a second spawn must not
        # split another implementer.
        second = self.spawn_item()
        self.assertTrue(second["ok"], second)
        self.assertFalse(second.get("spawned", False))
        self.assertEqual(second["pane_id"], first["pane_id"])
        self.assertEqual(second["action"], "wait-item")
        state = self.read_state()
        self.assertEqual(len(state["split_calls"]), 1, state["split_calls"])
        self.assertEqual(len(state.get("agent_start_calls") or []), 1)

    # ---- contract 3: spawn-item-reviewer --------------------------------

    def test_spawn_item_reviewer_closes_completed_implementer_and_makes_fresh_review_pane(self) -> None:
        self.items_init()
        claimed = self.claim()
        self.spawn_item()
        self.make_change(claimed["worktree"])
        rec = self.record(claimed["nonce"])
        self.assertEqual(rec["status"], "implemented")

        impl_pane = self.read_state()["split_calls"][0]["pane_id"]
        reviewer = self.spawn_reviewer()
        self.assertTrue(reviewer["ok"], reviewer)
        self.assertEqual(reviewer["role"], "reviewer")
        self.assertEqual(reviewer["attempt"], 1)

        state = self.read_state()
        pane_id = reviewer["pane_id"]
        # Distinct fresh pane, not a resume of the implementer or old reviewer.
        self.assertNotEqual(pane_id, impl_pane)
        self.assertIn(":review:", reviewer["label"])
        self.assertEqual(
            reviewer["label"],
            f"auto:{RUN_ID}:{ITEM_ID}:review:{reviewer['attempt']}",
        )
        # Two splits: the implementer split plus one brand-new reviewer split.
        self.assertEqual(len(state["split_calls"]), 2, state["split_calls"])
        self.assertEqual(len(state["agent_start_calls"]), 2)
        # The completed implementer pane is closed.
        self.assertTrue(state["panes"][impl_pane]["closed"])
        # The fresh reviewer pane is alive and labelled, not closed.
        self.assertFalse(state["panes"][pane_id].get("closed"))
        self.assertEqual(state["panes"][pane_id]["label"], reviewer["label"])

    # ---- contract 4: wait-item ------------------------------------------

    def test_wait_item_ignores_prose_marker_until_item_terminal(self) -> None:
        self.items_init()
        claimed = self.claim()
        spawned = self.spawn_item()
        pane_id = spawned["pane_id"]

        # Prose/example marker in the pane output, but the item is not terminal.
        state = self.read_state()
        marker_text = (
            f"AUTO_PLAN_ITEM_RECORDED {RUN_ID} {ITEM_ID} implemented"
        )
        state["panes"][pane_id]["output"] = (
            f"The skill doc shows the marker {marker_text} as an example to quote. "
            "The item is still implementing.\n"
        )
        state["panes"][pane_id]["agent_status"] = "working"
        self.write_state(state)

        got = self.payload(
            self.cli(
                "wait-item",
                "--run-id",
                RUN_ID,
                "--item-id",
                ITEM_ID,
                "--role",
                "implementer",
                "--timeout-ms",
                "10",
            )
        )
        # Output carries the exact marker substring and the item is still
        # implementing with the implementer working.
        current = self.read_state()
        self.assertIn(marker_text, current["panes"][pane_id]["output"])
        self.assertEqual(current["panes"][pane_id]["agent_status"], "working")
        # Item still implementing (no authoritative terminal record written).
        scheduler = json.loads(
            (self.home / RUN_ID / "items-state.json").read_text()
        )
        self.assertEqual(
            scheduler["items"][ITEM_ID]["status"], "implementing"
        )
        # Marker alone must not complete/close; it parks, not stalls/complete.
        self.assertNotEqual(got["disposition"], "complete")
        self.assertEqual(got["disposition"], "park")
        self.assertEqual(got.get("closed") or [], [])
        self.assertFalse(current["panes"][pane_id].get("closed"))

    def test_wait_item_requires_matching_impl_pane_and_closes_nothing(self) -> None:
        self.items_init()
        self.claim()
        spawned = self.spawn_item()
        pane_id = spawned["pane_id"]

        # Reuse the stored implementer pane_id but relabel the pane so its
        # label is NOT auto:<run>:<item>:impl:<attempt>.
        state = self.read_state()
        state["panes"][pane_id]["label"] = "unrelated-pane"
        state["panes"][pane_id]["agent_status"] = "working"
        self.write_state(state)

        got = self.payload(
            self.cli(
                "wait-item",
                "--run-id",
                RUN_ID,
                "--item-id",
                ITEM_ID,
                "--role",
                "implementer",
                "--timeout-ms",
                "10",
            )
        )
        self.assertFalse(got["ok"])
        self.assertIn("identity", str(got.get("error", "")).lower())
        # The misidentified pane must not be closed.
        state = self.read_state()
        self.assertFalse(state["panes"][pane_id].get("closed"))

    def test_wait_item_parks_on_timeout_while_working_and_closes_on_terminal(self) -> None:
        self.items_init()
        claimed = self.claim()
        spawned = self.spawn_item()
        pane_id = spawned["pane_id"]

        # Timeout while the implementer is still working -> park, close nothing.
        state = self.read_state()
        state["panes"][pane_id]["output"] = ""
        state["panes"][pane_id]["agent_status"] = "working"
        state["wait_fails"] = True
        self.write_state(state)

        park = self.payload(
            self.cli(
                "wait-item",
                "--run-id",
                RUN_ID,
                "--item-id",
                ITEM_ID,
                "--role",
                "implementer",
                "--timeout-ms",
                "10",
            )
        )
        self.assertEqual(park["disposition"], "park")
        self.assertEqual(park.get("closed") or [], [])
        self.assertFalse(self.read_state()["panes"][pane_id].get("closed"))

        # Authoritative completion (record-item) is terminal -> complete + close.
        self.make_change(claimed["worktree"])
        self.record(claimed["nonce"])
        state = self.read_state()
        state["wait_fails"] = False
        self.write_state(state)
        done = self.payload(
            self.cli(
                "wait-item",
                "--run-id",
                RUN_ID,
                "--item-id",
                ITEM_ID,
                "--role",
                "implementer",
            )
        )
        self.assertEqual(done["disposition"], "complete")
        closed_ids = {row["id"] for row in done["closed"]}
        self.assertIn(pane_id, closed_ids)
        self.assertTrue(self.read_state()["panes"][pane_id]["closed"])

    def test_wait_item_closes_only_matching_item_role_pane(self) -> None:
        self.items_init()
        claimed = self.claim()
        spawned = self.spawn_item()
        impl_pane = spawned["pane_id"]

        # A second (reviewer-role) pane exists for the same item, and a third
        # pane for a *different* item. Completing the implementer must close
        # only its own role pane.
        state = self.read_state()
        rev_pane = "w1:p9"
        other_pane = "w1:p8"
        state.setdefault("panes", {})
        state["panes"][rev_pane] = {
            "pane_id": rev_pane,
            "tab_id": "w1:t1",
            "label": f"auto:{RUN_ID}:{ITEM_ID}:review:1",
            "agent": "pi",
            "agent_status": "done",
            "cwd": str(self.repo),
            "output": "",
            "closed": False,
        }
        state["panes"][other_pane] = {
            "pane_id": other_pane,
            "tab_id": "w1:t1",
            "label": f"auto:{RUN_ID}:OTHER:impl:1",
            "agent": "pi",
            "agent_status": "none",
            "cwd": str(self.repo),
            "output": "",
            "closed": False,
        }
        self.write_state(state)

        self.make_change(claimed["worktree"])
        self.record(claimed["nonce"])
        done = self.payload(
            self.cli(
                "wait-item",
                "--run-id",
                RUN_ID,
                "--item-id",
                ITEM_ID,
                "--role",
                "implementer",
            )
        )
        self.assertEqual(done["disposition"], "complete")
        closed_ids = {row["id"] for row in done["closed"]}
        self.assertIn(impl_pane, closed_ids)
        # Only the matching item-role (implementer) pane is closed.
        self.assertNotIn(rev_pane, closed_ids)
        self.assertNotIn(other_pane, closed_ids)
        state = self.read_state()
        self.assertTrue(state["panes"][impl_pane]["closed"])
        self.assertFalse(state["panes"][rev_pane].get("closed"))
        self.assertFalse(state["panes"][other_pane].get("closed"))


if __name__ == "__main__":
    unittest.main()