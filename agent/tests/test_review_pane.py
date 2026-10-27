"""Coordinator contracts: no real panes or model requests."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("review_pane", Path(__file__).parents[1] / "scripts/review-pane.py")
assert SPEC is not None and SPEC.loader is not None
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)


class ReviewPaneTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).parents[1] / "tmp"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch, prefix="review-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.patch(review, "ROOT", self.root / "runs")
        clean_env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        clean_env.update({"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1",
                          "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                          "GIT_CONFIG_SYSTEM": os.devnull, "GIT_ATTR_NOSYSTEM": "1"})
        self.env = patch.dict(os.environ, clean_env, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def patch(self, obj, name, value):
        p = patch.object(obj, name, value)
        result = p.start()
        self.addCleanup(p.stop)
        return result

    def meta(self, **changes):
        meta = {"run_id": "a" * 32, "cwd": str(self.repo), "scope": "--staged",
                "round": 1, "max_rounds": 2, "coordinator_pane": "w1:p1",
                "reviewer_pane": "w1:p2", "state": "reviewing"}
        meta.update(changes)
        rd = review.run_dir(meta["run_id"])
        rd.mkdir(parents=True, exist_ok=True)
        review.save(rd / "meta.json", meta)
        return meta

    def args(self, *args):
        return review.parser().parse_args(args)

    def test_json_and_missing_files_are_reported_without_traceback(self):
        for command, expected in [("not-json", "invalid JSON"), ("", "invalid JSON")]:
            with self.subTest(command=command), self.assertRaisesRegex(ValueError, expected):
                review.parse_json(command)
        for contents in [None, "invalid-json"]:
            run_id = "b" * 32
            rd = review.run_dir(run_id)
            rd.mkdir(parents=True, exist_ok=True)
            if contents is not None:
                (rd / "meta.json").write_text(contents)
            output = io.StringIO()
            with patch("sys.argv", ["review-pane", "status", "--run-id", run_id]), contextlib.redirect_stdout(output):
                self.assertEqual(review.main(), 1)
            self.assertIn("error", json.loads(output.getvalue()))
        with self.assertRaisesRegex(ValueError, "JSON objects"):
            review.parse_json("[]")

    def test_invalid_ids_scopes_and_symlink_escape_are_rejected(self):
        for value in ["../x", "/tmp/x", "x", "a" * 31]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                review.run_dir(value)
        for value in ["--output=x", "main;pwd", "HEAD -- .", "$(pwd)"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                review.scope_args(value)
        self.assertEqual(review.scope_args("main..feature"), ["main..feature"])
        self.assertEqual(review.scope_args("--staged"), ["--cached"])
        review.ROOT.mkdir()
        (review.ROOT / ("c" * 32)).symlink_to(self.repo, target_is_directory=True)
        with self.assertRaises(ValueError):
            review.run_dir("c" * 32)

    def test_diff_filters_credentials_and_pages_without_external_diff(self):
        calls = []
        def git(cwd, *args):
            calls.append(args)
            return "M\0a.py\0A\0.env\0A\0auth.json\0M\0b.py\0"
        self.patch(review, "git", git)
        result = review.diff(self.meta(), limit=1)
        self.assertEqual(result["text"], "a.py")
        self.assertEqual(result["next_offset"], 1)
        self.assertEqual(result["total_lines"], 2)
        self.assertEqual(result["excluded_paths"], 2)
        self.assertEqual(result["scope"], "--staged")
        self.assertIn("--no-ext-diff", calls[0])
        self.assertIn("--no-textconv", calls[0])
        self.assertEqual(review.diff(self.meta(), offset=1)["text"], "b.py")
        with self.assertRaises(ValueError):
            review.diff(self.meta(), ".env")
        (self.repo / "escape").symlink_to(self.root)
        with self.assertRaises(ValueError):
            review.safe_path(str(self.repo), "escape/outside")

    def test_malformed_git_path_records_fail_closed(self):
        for output in ["R100\0.env\0", "Q\0safe.py\0", "M\0safe.py", "M\0\0"]:
            with self.subTest(output=output), patch.object(review, "git", return_value=output):
                with self.assertRaisesRegex(ValueError, "Git name/status"):
                    review.diff(self.meta())

    def test_working_tree_diff_covers_both_index_and_untracked(self):
        calls = []
        def git(cwd, *args):
            calls.append(args)
            if args[0] == "ls-files":
                return "new.py\0"
            return "M\0index.py\0" if "--cached" in args else "M\0work.py\0"
        self.patch(review, "git", git)
        result = review.diff(self.meta(scope=""))
        self.assertEqual(result["text"], "index.py\nnew.py\nwork.py")
        self.assertEqual(len(calls), 3)

    def test_real_git_staged_unstaged_and_untracked_in_unborn_repository(self):
        review.git(str(self.repo), "init", "--quiet")
        (self.repo / "tracked.py").write_text("value = 1\n")
        review.git(str(self.repo), "add", "--", "tracked.py")
        (self.repo / "tracked.py").write_text("value = 2\n")
        (self.repo / "new.py").write_text("new = True\n")
        meta = self.meta(scope="")
        self.assertEqual(review.diff(meta)["text"], "new.py\ntracked.py")
        patch_text = review.diff(meta, "tracked.py")["text"]
        self.assertIn("--- unstaged ---", patch_text)
        self.assertIn("--- --cached ---", patch_text)
        self.assertIn("+value = 2", patch_text)
        self.assertIn("+value = 1", patch_text)
        meta["scope"] = "--staged"
        self.assertEqual(review.diff(meta)["text"], "tracked.py")
        self.assertNotIn("+value = 2", review.diff(meta, "tracked.py")["text"])

    def test_patch_rejects_directory_requests_before_returning_excluded_contents(self):
        review.git(str(self.repo), "init", "--quiet", "--template=")
        (self.repo / "nested").mkdir()
        (self.repo / "nested/.env").write_text("SYNTHETIC_FIXTURE_ONLY=not-a-secret\n")
        (self.repo / "safe.py").write_text("value = 1\n")
        review.git(str(self.repo), "add", "--", "nested/.env", "safe.py")
        meta = self.meta()
        self.assertEqual(review.diff(meta)["text"], "safe.py")
        self.assertEqual(review.diff(meta)["excluded_paths"], 1)
        for path in [".", "nested", "nested/"]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "exact.*file"):
                review.diff(meta, path)

    def test_protected_rename_origins_remain_excluded_across_comparisons(self):
        review.git(str(self.repo), "init", "--quiet", "--template=")
        (self.repo / ".env").write_text("SYNTHETIC_FIXTURE_ONLY=not-a-secret\n" * 10)
        (self.repo / "ordinary.txt").write_text("ordinary synthetic content\n")
        review.git(str(self.repo), "add", "--", ".env", "ordinary.txt")
        # A tree snapshot provides the old side without creating a commit.
        baseline = review.git(str(self.repo), "write-tree").strip()
        (self.repo / ".env").rename(self.repo / "config.txt")
        (self.repo / "ordinary.txt").rename(self.repo / "renamed.txt")
        review.git(str(self.repo), "add", "--all", "--", ".env", "config.txt", "ordinary.txt", "renamed.txt")
        (self.repo / "config.txt").write_text("SYNTHETIC_FIXTURE_ONLY=not-a-secret\n" * 10 + "extra synthetic line\n")
        # A user setting must not suppress provenance needed by the exclusion policy.
        review.git(str(self.repo), "config", "diff.renames", "false")
        meta = self.meta(scope=baseline)
        with self.subTest(check="discovery"):
            result = review.diff(meta)
            self.assertNotIn("config.txt", result["text"].splitlines())
            self.assertIn("renamed.txt", result["text"].splitlines())
            self.assertGreaterEqual(result["excluded_paths"], 1)
        with self.subTest(check="patch"), self.assertRaisesRegex(ValueError, "approved changed-file"):
            review.diff(meta, "config.txt")
        with self.subTest(check="staged and unstaged union"):
            allowed, excluded = review.changed_paths(str(self.repo), [[], ["--cached", baseline]], True)
            self.assertNotIn("config.txt", allowed)
            self.assertIn("renamed.txt", allowed)
            self.assertGreaterEqual(excluded, 1)

    def test_patch_never_executes_clean_or_process_filters(self):
        for kind in ["clean", "process"]:
            with self.subTest(kind=kind):
                repo = self.repo / kind
                repo.mkdir()
                review.git(str(repo), "init", "--quiet", "--template=")
                (repo / "sample.txt").write_text("before\n")
                review.git(str(repo), "add", "--", "sample.txt")
                marker = repo / "filter-marker"
                code = f"import pathlib,sys; pathlib.Path({str(marker)!r}).write_text('invoked'); "
                code += "sys.stdout.buffer.write(sys.stdin.buffer.read())" if kind == "clean" else "sys.exit(1)"
                driver = shlex.join([sys.executable, "-c", code])
                review.git(str(repo), "config", f"filter.fixture.{kind}", driver)
                review.git(str(repo), "config", "filter.fixture.required", "true")
                (repo / ".gitattributes").write_text("sample.txt filter=fixture\n")
                (repo / "sample.txt").write_text("after\n")
                meta = self.meta(cwd=str(repo), scope="")
                try:
                    result = review.diff(meta, "sample.txt")
                finally:
                    self.assertFalse(marker.exists(), f"configured {kind} filter executed")
                self.assertIn("+after", result["text"])

    def test_exact_patch_supports_deleted_files_but_not_directory_prefixes(self):
        review.git(str(self.repo), "init", "--quiet", "--template=")
        nested = self.repo / "nested"
        nested.mkdir()
        source = nested / "safe.py"
        source.write_text("before\n")
        review.git(str(self.repo), "add", "--", "nested/safe.py")
        source.unlink()
        nested.rmdir()
        meta = self.meta(scope="")
        self.assertIn("-before", review.diff(meta, "nested/safe.py")["text"])
        for path in ["nested", "nested/", "missing.py"]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "exact.*file"):
                review.diff(meta, path)

    def test_byte_limited_pages_resume_at_first_omitted_line(self):
        patch_lines = ["é" * 7000, "a" * 13000, "z" * 17000]
        def git(cwd, *args):
            return "M\0source.py\0" if "--name-status" in args else "\n".join(patch_lines)
        with patch.object(review, "git", git):
            meta = self.meta()
            first = review.diff(meta, "source.py")
            self.assertEqual(first["next_offset"], 2)
            self.assertFalse(first["truncated_bytes"])
            collected = first["text"].splitlines()
            offset = first["next_offset"]
            for _ in range(4):
                if offset is None:
                    break
                page = review.diff(meta, "source.py", offset=offset)
                self.assertLessEqual(len(page["text"].encode("utf-8")), 24000)
                self.assertFalse(page["truncated_bytes"])
                collected.extend(page["text"].splitlines())
                offset = page["next_offset"]
            self.assertIsNone(offset)
            self.assertEqual(collected, ["--- --cached ---", *patch_lines])

    def test_patch_is_path_scoped_and_utf8_byte_bounded(self):
        for char in ["a", "é"]:
            with self.subTest(char=char):
                calls = []
                def git(cwd, *args):
                    calls.append(args)
                    return "M\0source.py\0" if "--name-status" in args else "+" + char * 25000
                with patch.object(review, "git", git):
                    result = review.diff(self.meta(), "source.py", offset=1)
                self.assertTrue(result["truncated_bytes"])
                self.assertIsNone(result["next_offset"])
                self.assertLessEqual(len(result["text"].encode("utf-8")), 24000)
                self.assertGreaterEqual(len(result["text"].encode("utf-8")), 23999)
                self.assertNotIn("\ufffd", result["text"])
                self.assertEqual(calls[-1][-2:], ("--", "source.py"))

    def setup_spawn(self, fail=False):
        calls = []
        self.patch(review, "git", lambda *_: str(self.repo))
        self.patch(review, "diff", lambda *_: {"total_lines": 1})
        def herdr(*args):
            calls.append(args)
            if args[:2] == ("pane", "split"):
                return {"pane": {"pane_id": "w1:p2"}}
            if fail:
                raise RuntimeError("start failed")
            return {}
        self.patch(review, "herdr", herdr)
        return calls

    def test_spawn_pins_model_max_and_readonly_tools_without_wait(self):
        calls = self.setup_spawn()
        result = review.spawn(self.args("spawn", "--scope=--staged", "--direction=down"))
        start = calls[1]
        self.assertEqual(start[start.index("--kind") + 1], "pi")
        self.assertEqual(start[start.index("--model") + 1], "openai-codex/gpt-6-astra")
        self.assertEqual(start[start.index("--thinking") + 1], "max")
        self.assertEqual(start[start.index("--tools") + 1], "read,grep,find,ls,review_diff,review_record")
        for flag in ["--no-mcp", "--no-approve", "--no-extensions", "--no-session"]:
            self.assertIn(flag, start)
        self.assertIn(str(review.AGENT / "extensions/security-gate.ts"), start)
        self.assertIn(str(review.AGENT / "extensions/review-pane/tools.ts"), start)
        self.assertEqual([call[:2] for call in calls],
                         [("pane", "split"), ("agent", "start"), ("agent", "prompt")])
        self.assertTrue(all("--wait" not in call for call in calls))
        self.assertEqual(result["state"], "reviewing")
        self.assertEqual(result["max_rounds"], 8)
        self.assertTrue(result["fast"])

    def test_spawn_guard_and_failure_preserve_artifacts_without_retry_or_close(self):
        calls = self.setup_spawn(fail=True)
        with patch.dict(os.environ, {"HERDR_ENV": "0"}), self.assertRaisesRegex(RuntimeError, "requires"):
            review.spawn(self.args("spawn"))
        self.assertEqual(calls, [])
        with self.assertRaisesRegex(RuntimeError, "retained run"):
            review.spawn(self.args("spawn"))
        self.assertEqual(len(calls), 2)
        meta = json.loads(next(review.ROOT.glob("*/meta.json")).read_text())
        self.assertEqual(meta["state"], "failed")
        self.assertEqual(meta["reviewer_pane"], "w1:p2")

    def test_rounds_inherit_scope_stop_at_cap_and_do_not_continue_lgtm(self):
        self.setup_spawn()
        meta = self.meta()
        rd = review.run_dir(meta["run_id"])
        args = self.args("spawn", "--prev-run-id", meta["run_id"])
        for verdict in [None, "LGTM"]:
            if verdict:
                review.save(rd / "verdict.json", {"verdict": verdict})
            with self.assertRaisesRegex(ValueError, "BLOCKED"):
                review.spawn(args)
        review.save(rd / "verdict.json", {"verdict": "BLOCKED"})
        result = review.spawn(args)
        self.assertEqual((result["round"], result["scope"], result["max_rounds"]), (2, "--staged", 2))
        review.save(review.run_dir(result["run_id"]) / "verdict.json", {"verdict": "BLOCKED"})
        with self.assertRaisesRegex(ValueError, "cap reached"):
            review.spawn(self.args("spawn", "--prev-run-id", result["run_id"]))
        with self.assertRaisesRegex(ValueError, "inherit"):
            review.spawn(self.args("spawn", "--prev-run-id", meta["run_id"], "--max-rounds=99"))

    def test_record_is_authorized_immutable_and_survives_notification_failure(self):
        meta = self.meta()
        args = self.args("record", "--run-id", meta["run_id"], "--verdict=BLOCKED", "--findings=Evidence")
        with self.assertRaisesRegex(RuntimeError, "reviewer_pane"):
            review.record(args)
        self.patch(review, "herdr", lambda *_: (_ for _ in ()).throw(RuntimeError("notify failed")))
        with patch.dict(os.environ, {"HERDR_PANE_ID": "w1:p2"}):
            result = review.record(args)
            self.assertFalse(result["notified"])
            args.verdict, args.findings = "LGTM", "Replacement"
            second = review.record(args)
            self.assertEqual(second["verdict"], "BLOCKED")
            self.assertEqual(second["findings"], "Evidence")
            self.assertTrue(second["already_recorded"])
        result = review.pickup(self.args("pickup", "--run-id", meta["run_id"]))
        self.assertEqual(result["disposition"], "done")
        self.assertEqual(result["findings"], "Evidence")
        self.assertTrue((review.run_dir(meta["run_id"]) / "verdict.json").exists())

    def test_pickup_pending_and_wrong_coordinator_never_control_panes(self):
        meta = self.meta()
        self.patch(review, "herdr", lambda *_: self.fail("pickup must not control panes"))
        args = self.args("pickup", "--run-id", meta["run_id"])
        self.assertEqual(review.pickup(args)["disposition"], "pending")
        with patch.dict(os.environ, {"HERDR_PANE_ID": "w1:p3"}), self.assertRaises(RuntimeError):
            review.pickup(args)


if __name__ == "__main__":
    unittest.main()
