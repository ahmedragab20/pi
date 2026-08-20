#!/usr/bin/env python3
"""Herdr+pi glue for the opt-in /auto-plan reviewer loop.

Subcommands print JSON. Drive herdr from here — do not copy-paste CLI by hand.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Iterator, NoReturn

_ITEM_MODULE_PATH = Path(__file__).resolve().with_name("auto_plan_items.py")
_ITEM_SPEC = importlib.util.spec_from_file_location(
    "harness_auto_plan_items", _ITEM_MODULE_PATH
)
if _ITEM_SPEC is None or _ITEM_SPEC.loader is None:
    raise ImportError(f"cannot load item scheduler from {_ITEM_MODULE_PATH}")
item_scheduler = importlib.util.module_from_spec(_ITEM_SPEC)
_ITEM_SPEC.loader.exec_module(item_scheduler)

SKILL_DIR = Path(__file__).resolve().parents[1]
AGENT_HOME = Path(__file__).resolve().parents[3]
SETTINGS_PATH = AGENT_HOME / "settings.json"
MODELS_JSON = AGENT_HOME / "models.json"
MODELS_STORE = AGENT_HOME / "models-store.json"
REVIEWER_SYSTEM = SKILL_DIR / "reviewer-system.md"
ITEM_IMPLEMENTER_SYSTEM = SKILL_DIR / "item-implementer-system.md"
ITEM_REVIEWER_SYSTEM = SKILL_DIR / "item-reviewer-system.md"
SKILL_MD = SKILL_DIR / "SKILL.md"

DEFAULT_PROMPT_TIMEOUT_MS = 30_000
DEFAULT_WAIT_SLICE_MS = 300_000
DEFAULT_MAX_REVIEW_ROUNDS = 6
DEFAULT_MAX_NO_PROGRESS = 1

IMPLEMENTER_NEXT_HELP = {
    "init": "No run yet. Call init, then continue.",
    "explore-or-plan": "Explore if needed, then draft/submit the plan. Do not implement or spawn a reviewer.",
    "await-plan": "Plan already submitted. Await that plan id. Do not submit a new plan or spawn a reviewer.",
    "implement": "Plan is approved. Implement it now. Do not re-plan. Do not spawn a reviewer until implementation is done and the consumer tree has a reviewable diff.",
    "items-drive": "Item-flow is active. Drive items-status / claim-item / spawn-item / wait-item / integrate-item. Never edit the consumer checkout and never spawn-reviewer.",
    "finalize-items": "Every item is integrated. Call finalize-items. Do not implement on the consumer and do not spawn-reviewer.",
    "spawn-reviewer": "Implementation is done and there is a reviewable diff. review (spawn+wait+close helpers) or spawn-reviewer then wait-verdict.",
    "wait-verdict": "Reviewer is in flight. wait-verdict (closes helpers after the verdict). Park on a wait slice — the reviewer prompts this pane when it records. Do not spawn another reviewer. Never close this pane.",
    "report": "Verdict recorded or item-flow finished. finish (idempotent; closes leftover helpers, never this pane), then tell the user the verdict.",
}

REVIEWER_NEXT_HELP = {
    "already-done": "Verdict already recorded in verdict.json. Stop. Do not reprint a marker.",
    "first-review": "No findings yet. Review the diff against the approved plan and write findings.md.",
    "worker": "Open findings remain. Agent worker to address every Status: open, then re-verify.",
    "re-verify": "No open findings on disk. Re-read the files; then LGTM or write new opens.",
}


def die(message: str, code: int = 1) -> NoReturn:
    print(json.dumps({"ok": False, "error": message}, indent=2))
    raise SystemExit(code)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2))


def load_json(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def atomic_write_text(path: Path, text: str) -> None:
    """Replace a state file atomically so readers never observe partial JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


@contextlib.contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Serialize state transitions shared by independent pi sessions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


DEFAULT_HERDR_RPC_TIMEOUT = 60


def herdr(*args: str, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    if timeout is None and not (
        len(args) >= 2 and args[0] == "pane" and args[1] == "wait-output"
    ):
        timeout = DEFAULT_HERDR_RPC_TIMEOUT
    return subprocess.run(
        ["herdr", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def herdr_json(*args: str) -> dict[str, Any]:
    proc = herdr(*args)
    if proc.returncode != 0:
        err = (
            proc.stderr or proc.stdout or ""
        ).strip() or f"herdr {' '.join(args)} failed"
        die(err)
    text = (proc.stdout or "").strip()
    if not text:
        die(f"herdr {' '.join(args)} produced no output")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        die(f"herdr {' '.join(args)} did not return JSON: {text[:400]}")


def require_herdr() -> None:
    if os.environ.get("HERDR_ENV") != "1":
        die(
            "HERDR_ENV is not 1. /auto-plan needs herdr. Use /implement + /review instead."
        )
    if not os.environ.get("HERDR_SOCKET_PATH") and not os.environ.get("HERDR_SESSION"):
        # Socket path is normally injected; absence is unusual but not always fatal
        # if the CLI can still talk to the default session.
        pass


def self_pane_id() -> str:
    env_id = os.environ.get("HERDR_PANE_ID")
    if env_id:
        return env_id
    data = herdr_json("pane", "current")
    pane = (data.get("result") or {}).get("pane") or {}
    pane_id = pane.get("pane_id")
    if not pane_id:
        die("could not resolve the current herdr pane id")
    return str(pane_id)


def runs_dir() -> Path:
    override = os.environ.get("AUTO_PLAN_HOME")
    if override:
        return Path(override).expanduser()
    return AGENT_HOME / "tmp" / "auto-plan"


def run_dir(run_id: str) -> Path:
    return runs_dir() / run_id


def read_meta(run_id: str) -> dict[str, Any]:
    path = run_dir(run_id) / "meta.json"
    meta = load_json(path)
    if not isinstance(meta, dict):
        die(f"missing run {run_id} (no {path})")
    return meta


def write_meta(run_id: str, meta: dict[str, Any]) -> None:
    path = run_dir(run_id) / "meta.json"
    atomic_write_text(path, json.dumps(meta, indent=2) + "\n")


def append_event(run_id: str, event: str, **fields: Any) -> None:
    path = run_dir(run_id) / "events.ndjson"
    record = {
        "event_id": uuid.uuid4().hex,
        "timestamp": time.time(),
        "event": event,
        **fields,
    }
    with file_lock(run_dir(run_id) / ".events.lock"):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())


def write_status(run_id: str, **fields: Any) -> dict[str, Any]:
    path = run_dir(run_id) / "status.json"
    lock = run_dir(run_id) / ".status.lock"
    with file_lock(lock):
        current = load_json(path)
        status = current if isinstance(current, dict) else {}
        status.update(fields)
        atomic_write_text(path, json.dumps(status, indent=2) + "\n")
    append_event(run_id, "status", fields=fields)
    return status


def nonempty(path: Path) -> bool:
    return path.is_file() and bool(path.read_text().strip())


def normalize_task(text: str | None) -> str:
    return " ".join((text or "").strip().lower().split())


def read_task(run_id: str) -> str:
    path = run_dir(run_id) / "task.md"
    if not path.is_file():
        return ""
    return path.read_text()


def tasks_equivalent(a: str | None, b: str | None) -> bool:
    na, nb = normalize_task(a), normalize_task(b)
    if not na or not nb:
        return False
    return na == nb


def git_run(cwd: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)


def git_head_sha(cwd: str) -> str | None:
    proc = git_run(cwd, "rev-parse", "HEAD")
    sha = (proc.stdout or "").strip()
    return sha if proc.returncode == 0 and sha else None


def unlink_if_exists(path: str) -> None:
    try:
        Path(path).unlink()
    except FileNotFoundError:
        return


def git_worktree_tree(cwd: str) -> str | None:
    """Write the complete current checkout (including untracked files) as a git tree."""
    descriptor, index_path = tempfile.mkstemp(prefix="auto-plan-index-")
    os.close(descriptor)
    unlink_if_exists(index_path)
    env = os.environ.copy()
    env["GIT_INDEX_FILE"] = index_path
    try:
        for args in (("read-tree", "HEAD"), ("add", "-A")):
            proc = subprocess.run(
                ["git", "-C", cwd, *args],
                capture_output=True,
                text=True,
                env=env,
            )
            if proc.returncode != 0:
                return None
        written = subprocess.run(
            ["git", "-C", cwd, "write-tree"],
            capture_output=True,
            text=True,
            env=env,
        )
        tree = (written.stdout or "").strip()
        return tree if written.returncode == 0 and tree else None
    finally:
        unlink_if_exists(index_path)


def git_worktree_fingerprint(cwd: str) -> str | None:
    """Hash HEAD plus tracked and untracked working-tree content."""
    head = git_head_sha(cwd)
    if not head:
        return None
    digest = hashlib.sha256()
    digest.update(head.encode())
    tracked = git_run(cwd, "diff", "--binary", "HEAD", "--")
    if tracked.returncode != 0:
        return None
    digest.update(tracked.stdout.encode())
    untracked = git_run(cwd, "ls-files", "--others", "--exclude-standard", "-z")
    if untracked.returncode != 0:
        return None
    root = Path(cwd)
    for relative in sorted(filter(None, untracked.stdout.split("\0"))):
        digest.update(relative.encode())
        path = root / relative
        try:
            if path.is_symlink():
                digest.update(b"L")
                digest.update(os.readlink(path).encode())
            elif path.is_file():
                digest.update(b"F")
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
            else:
                digest.update(b"O")
        except OSError:
            return None
    return digest.hexdigest()


def git_reviewable(
    cwd: str | None,
    base_sha: str | None,
    base_fingerprint: str | None = None,
    base_tree: str | None = None,
) -> dict[str, Any]:
    """Whether the consumer tree has anything a reviewer could inspect.

    Reviewable if the working tree is dirty, HEAD moved off base_sha, or
    (when base_sha is missing, older runs) there are commits not in upstream.
    A clean tree at the run's base is not reviewable — implement first.
    """
    out: dict[str, Any] = {
        "reviewable": False,
        "dirty": False,
        "head_moved": False,
        "ahead": 0,
        "base_sha": base_sha,
        "base_fingerprint": base_fingerprint,
        "fingerprint": None,
        "base_tree": base_tree,
        "tree": None,
        "head": None,
        "upstream": None,
        "reason": "no cwd",
    }
    if not cwd:
        return out
    try:
        resolved = str(Path(cwd).expanduser().resolve())
    except OSError:
        out["reason"] = "cwd unreadable"
        return out
    if not Path(resolved).is_dir():
        out["reason"] = "cwd missing"
        return out
    inside = git_run(resolved, "rev-parse", "--is-inside-work-tree")
    if inside.returncode != 0 or (inside.stdout or "").strip() != "true":
        out["reason"] = "not a git repo"
        return out
    head = git_head_sha(resolved)
    out["head"] = head
    current_tree = git_worktree_tree(resolved)
    fingerprint = git_worktree_fingerprint(resolved) if not base_tree else None
    out["fingerprint"] = fingerprint
    out["tree"] = current_tree
    porcelain = git_run(resolved, "status", "--porcelain")
    out["dirty"] = bool((porcelain.stdout or "").strip())
    if base_sha and head and head != base_sha:
        out["head_moved"] = True
    diff_vs_base = False
    if base_sha:
        d = git_run(resolved, "diff", "--stat", base_sha)
        if d.returncode == 0 and (d.stdout or "").strip():
            diff_vs_base = True
        cached = git_run(resolved, "diff", "--cached", "--stat")
        if (cached.stdout or "").strip():
            diff_vs_base = True
    upstream = None
    up = git_run(resolved, "rev-parse", "--abbrev-ref", "@{upstream}")
    if up.returncode == 0 and (up.stdout or "").strip():
        upstream = (up.stdout or "").strip()
    else:
        for cand in ("origin/HEAD", "origin/main", "origin/master", "main", "master"):
            verify = git_run(resolved, "rev-parse", "--verify", cand)
            if verify.returncode == 0:
                upstream = cand
                break
    out["upstream"] = upstream
    if upstream and head:
        counted = git_run(resolved, "rev-list", "--count", f"{upstream}..HEAD")
        if counted.returncode == 0:
            try:
                out["ahead"] = int((counted.stdout or "0").strip() or "0")
            except ValueError:
                out["ahead"] = 0
    if base_tree and current_tree:
        out["reviewable"] = current_tree != base_tree
        out["reason"] = (
            "snapshot tree changed since init"
            if out["reviewable"]
            else "no snapshot-tree change since init"
        )
    elif base_fingerprint and fingerprint:
        out["reviewable"] = fingerprint != base_fingerprint
        out["reason"] = (
            "working tree changed since init"
            if out["reviewable"]
            else "no working-tree change since init"
        )
    elif base_sha:
        out["reviewable"] = bool(out["dirty"] or out["head_moved"] or diff_vs_base)
        out["reason"] = "diff vs base" if out["reviewable"] else "no diff vs base_sha"
    else:
        out["reviewable"] = bool(out["dirty"] or out["ahead"] > 0)
        out["reason"] = (
            "dirty or ahead of upstream"
            if out["reviewable"]
            else "clean tree, no base_sha"
        )
    return out


def count_open_findings(text: str) -> int:
    """Single shared parser for both run-level and item-level findings."""
    return item_scheduler.count_open_findings(text)


def _result(data: dict[str, Any]) -> dict[str, Any]:
    result = data.get("result")
    return result if isinstance(result, dict) else data


def pane_from_payload(data: dict[str, Any]) -> dict[str, Any]:
    result = _result(data)
    pane = result.get("pane") or data.get("pane") or {}
    return pane if isinstance(pane, dict) else {}


def pane_info(pane_id: str | None) -> dict[str, Any]:
    if not pane_id:
        return {"id": None, "alive": False}
    if os.environ.get("HERDR_ENV") != "1":
        return {"id": pane_id, "alive": None, "reason": "not in herdr"}
    proc = herdr("pane", "get", str(pane_id))
    if proc.returncode != 0:
        return {"id": pane_id, "alive": False}
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return {"id": pane_id, "alive": True}
    pane = pane_from_payload(data)
    return {
        "id": pane_id,
        "alive": True,
        "agent": pane.get("agent") or pane.get("display_agent"),
        "agent_status": pane.get("agent_status"),
        "cwd": pane.get("cwd") or pane.get("foreground_cwd"),
        "label": pane.get("label") or pane.get("title"),
        "tab_id": pane.get("tab_id"),
    }


def list_panes() -> list[dict[str, Any]]:
    if os.environ.get("HERDR_ENV") != "1":
        return []
    proc = herdr("pane", "list")
    if proc.returncode != 0:
        return []
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return []
    result = _result(data)
    panes = result.get("panes") or data.get("panes") or []
    if isinstance(panes, dict):
        panes = [panes]
    if not isinstance(panes, list):
        return []
    return [p for p in panes if isinstance(p, dict) and p.get("pane_id")]


def review_label(run_id: str) -> str:
    return f"review:{run_id}"


def review_agent_name(run_id: str) -> str:
    return f"review-{run_id}"


def pane_matches_run(pane: dict[str, Any], run_id: str) -> bool:
    label = str(pane.get("label") or pane.get("title") or "")
    agent = str(
        pane.get("agent") or pane.get("display_agent") or pane.get("name") or ""
    )
    marker = review_label(run_id)
    return (
        label == marker
        or label.startswith(marker + " ")
        or agent == review_agent_name(run_id)
    )


def helper_ids_for_run(run_id: str, meta: dict[str, Any]) -> list[str]:
    ids: list[str] = []

    def add(pane_id: Any) -> None:
        text = str(pane_id or "").strip()
        if text and text not in ids:
            ids.append(text)

    add(meta.get("reviewer_pane"))
    helpers = meta.get("helper_panes")
    if isinstance(helpers, list):
        for item in helpers:
            add(item)
    for pane in list_panes():
        if pane_matches_run(pane, run_id):
            add(pane.get("pane_id"))
    return ids


def protected_pane_ids(
    meta: dict[str, Any], extra: list[str] | None = None
) -> list[str]:
    keep: list[str] = []

    def add(pane_id: Any) -> None:
        text = str(pane_id or "").strip()
        if text and text not in keep:
            keep.append(text)

    add(meta.get("implementer_pane"))
    add(os.environ.get("HERDR_PANE_ID"))
    if extra:
        for item in extra:
            add(item)
    return keep


def track_helper(meta: dict[str, Any], pane_id: str | None) -> list[str]:
    helpers: list[str] = []
    existing = meta.get("helper_panes")
    if isinstance(existing, list):
        for item in existing:
            text = str(item or "").strip()
            if text and text not in helpers:
                helpers.append(text)
    text = str(pane_id or "").strip()
    if text and text not in helpers:
        helpers.append(text)
    meta["helper_panes"] = helpers
    return helpers


def authoritative_verdict(run_id: str) -> dict[str, Any] | None:
    doc = load_json(run_dir(run_id) / "verdict.json")
    if not isinstance(doc, dict):
        return None
    if doc.get("run_id") != run_id or doc.get("verdict") not in ("LGTM", "BLOCKED"):
        return None
    return doc


def notify_session_leader(run_id: str, prompt: str) -> dict[str, Any]:
    """Wake the parked coordinator pane. Helpers never close themselves."""
    if os.environ.get("HERDR_ENV") != "1":
        return {"ok": False, "prompted": False, "reason": "not in herdr"}
    meta = load_json(run_dir(run_id) / "meta.json")
    if not isinstance(meta, dict):
        return {"ok": False, "prompted": False, "reason": "missing run"}
    leader = str(meta.get("implementer_pane") or "").strip()
    if not leader:
        return {"ok": False, "prompted": False, "reason": "no implementer pane"}
    self_id = str(os.environ.get("HERDR_PANE_ID") or "").strip()
    if self_id and self_id == leader:
        return {
            "ok": True,
            "prompted": False,
            "pane_id": leader,
            "reason": "already on leader pane",
        }
    info = pane_info(leader)
    if not info.get("alive"):
        return {
            "ok": False,
            "prompted": False,
            "pane_id": leader,
            "reason": "leader pane gone",
        }
    if info.get("agent_status") == "blocked":
        _notify_leader_toast(run_id, prompt)
        return {
            "ok": False,
            "prompted": False,
            "pane_id": leader,
            "reason": "leader blocked",
            "agent_status": "blocked",
        }
    _notify_leader_toast(run_id, prompt)
    try:
        proc = herdr(
            "agent",
            "prompt",
            leader,
            prompt,
            "--wait",
            "--until",
            "working",
            "--timeout",
            str(DEFAULT_PROMPT_TIMEOUT_MS),
        )
    except subprocess.TimeoutExpired:
        append_event(
            run_id, "leader-wake", ok=False, pane_id=leader, error="prompt timed out"
        )
        return {
            "ok": False,
            "prompted": False,
            "pane_id": leader,
            "reason": "leader prompt timed out",
        }
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "agent prompt failed").strip()
        append_event(run_id, "leader-wake", ok=False, pane_id=leader, error=err)
        return {
            "ok": False,
            "prompted": False,
            "pane_id": leader,
            "reason": err,
        }
    append_event(run_id, "leader-wake", ok=True, pane_id=leader)
    return {
        "ok": True,
        "prompted": True,
        "pane_id": leader,
        "agent_status": info.get("agent_status"),
    }


def _notify_leader_toast(run_id: str, prompt: str) -> None:
    title = f"auto-plan {run_id}"
    body = " ".join(prompt.split())[:240]
    try:
        herdr(
            "notification",
            "show",
            title,
            "--body",
            body,
            "--sound",
            "done",
        )
    except (OSError, subprocess.TimeoutExpired):
        return


def persist_verdict(
    run_id: str,
    verdict: str,
    *,
    reason: str | None = None,
) -> dict[str, Any]:
    with file_lock(run_dir(run_id) / ".verdict.lock"):
        existing = authoritative_verdict(run_id)
        if existing:
            return existing
        phase = "lgtm" if verdict == "LGTM" else "blocked"
        doc = {
            "run_id": run_id,
            "verdict": verdict,
            "reason": reason,
        }
        atomic_write_text(
            run_dir(run_id) / "verdict.json",
            json.dumps(doc, indent=2) + "\n",
        )
        write_status(
            run_id,
            phase=phase,
            verdict=verdict,
            verdict_source="verdict.json",
            block_reason=reason if verdict == "BLOCKED" else None,
        )
        return doc


def close_helpers(
    run_id: str,
    *,
    keep: list[str] | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    meta = read_meta(run_id)
    protected = protected_pane_ids(meta, keep)
    candidates = helper_ids_for_run(run_id, meta)
    closed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    if os.environ.get("HERDR_ENV") != "1":
        return {
            "closed": closed,
            "skipped": [{"id": pid, "reason": "not in herdr"} for pid in candidates],
            "kept": protected,
            "dry_run": dry_run,
        }
    for pane_id in candidates:
        if pane_id in protected:
            skipped.append({"id": pane_id, "reason": "protected"})
            continue
        info = pane_info(pane_id)
        if not info.get("alive"):
            skipped.append({"id": pane_id, "reason": "already-gone"})
            continue
        if not pane_matches_run(info, run_id):
            skipped.append({"id": pane_id, "reason": "identity-mismatch"})
            continue
        if dry_run:
            closed.append({"id": pane_id, "ok": True, "dry_run": True})
            continue
        proc = herdr("pane", "close", pane_id)
        if proc.returncode == 0:
            closed.append({"id": pane_id, "ok": True})
        else:
            err = (proc.stderr or proc.stdout or "pane close failed").strip()
            skipped.append({"id": pane_id, "reason": err, "ok": False})
    return {"closed": closed, "skipped": skipped, "kept": protected, "dry_run": dry_run}


def resolve_reviewer_pane(run_id: str, meta: dict[str, Any]) -> str | None:
    stored = meta.get("reviewer_pane")
    stored_id = str(stored).strip() if stored else None
    stored_info = pane_info(stored_id)
    if stored_id and stored_info.get("alive") and pane_matches_run(stored_info, run_id):
        return stored_id
    for pane_id in helper_ids_for_run(run_id, meta):
        if pane_id in protected_pane_ids(meta):
            continue
        info = pane_info(pane_id)
        if info.get("alive") and pane_matches_run(info, run_id):
            # Inspection is read-only. The spawn transition owns durable pane
            # metadata updates under `.spawn.lock`.
            return pane_id
    return None


def run_mtime(directory: Path) -> float:
    latest = 0.0
    if not directory.is_dir():
        return latest
    for child in directory.iterdir():
        try:
            latest = max(latest, child.stat().st_mtime)
        except OSError:
            continue
    return latest


def inspect_run(run_id: str) -> dict[str, Any]:
    directory = run_dir(run_id)
    meta = load_json(directory / "meta.json")
    if not isinstance(meta, dict):
        return {"ok": False, "run_id": run_id, "error": "missing run"}
    status = load_json(directory / "status.json")
    if not isinstance(status, dict):
        status = {}

    files = {
        "task": nonempty(directory / "task.md"),
        "plan_id": nonempty(directory / "plan-id.txt"),
        "plan": nonempty(directory / "plan.md"),
        "implementer_summary": nonempty(directory / "implementer-summary.md"),
        "findings": nonempty(directory / "findings.md"),
    }
    open_findings = 0
    if files["findings"]:
        open_findings = count_open_findings((directory / "findings.md").read_text())

    reviewer_pane = resolve_reviewer_pane(run_id, meta)
    reviewer = pane_info(reviewer_pane)
    verdict_doc = authoritative_verdict(run_id)
    verdict = verdict_doc.get("verdict") if verdict_doc else None
    base_sha = meta.get("base_sha") if isinstance(meta.get("base_sha"), str) else None
    base_fingerprint = (
        meta.get("base_fingerprint")
        if isinstance(meta.get("base_fingerprint"), str)
        else None
    )
    base_tree = (
        meta.get("base_tree") if isinstance(meta.get("base_tree"), str) else None
    )
    git = git_reviewable(
        str(meta.get("cwd") or ""),
        base_sha,
        base_fingerprint,
        base_tree,
    )
    reviewable = bool(git.get("reviewable"))

    completed: list[str] = ["init"]
    if files["plan_id"]:
        completed.append("plan-submitted")
    if files["plan"]:
        completed.append("plan-approved")
    if files["implementer_summary"] and reviewable:
        completed.append("implemented")
    if reviewer_pane:
        completed.append("reviewer-spawned")
    if reviewer.get("alive"):
        completed.append("reviewer-alive")
    if files["findings"]:
        completed.append("findings")
    if verdict:
        completed.append("verdict")

    pi_working = (
        reviewer.get("alive")
        and reviewer.get("agent") == "pi"
        and reviewer.get("agent_status") == "working"
    )
    pi_present = reviewer.get("alive") and reviewer.get("agent") == "pi"

    items_state = item_scheduler.load_state(run_id)
    if verdict:
        implementer_next = "report"
    elif isinstance(items_state, dict) and items_state.get("items"):
        item_rows = list((items_state.get("items") or {}).values())
        statuses = [str(row.get("status") or "") for row in item_rows]
        if items_state.get("status") == "finalized":
            implementer_next = "report"
        elif statuses and all(status == "integrated" for status in statuses):
            implementer_next = "finalize-items"
        elif (
            statuses
            and all(status in ("blocked", "integrated") for status in statuses)
            and any(status == "blocked" for status in statuses)
        ):
            implementer_next = "report"
        else:
            implementer_next = "items-drive"
    elif pi_working:
        implementer_next = "wait-verdict"
    elif files["implementer_summary"] and reviewable:
        implementer_next = "spawn-reviewer"
    elif files["plan"]:
        implementer_next = "implement"
    elif files["plan_id"]:
        implementer_next = "await-plan"
    else:
        implementer_next = "explore-or-plan"

    if verdict:
        reviewer_next = "already-done"
    elif not files["findings"]:
        reviewer_next = "first-review"
    elif open_findings > 0:
        reviewer_next = "worker"
    else:
        reviewer_next = "re-verify"

    phase = (
        "lgtm"
        if verdict == "LGTM"
        else "blocked"
        if verdict == "BLOCKED"
        else implementer_next
    )
    implementer_help = IMPLEMENTER_NEXT_HELP[implementer_next]
    if (
        implementer_next == "implement"
        and files["implementer_summary"]
        and not reviewable
    ):
        implementer_help = (
            "implementer-summary.md exists but the consumer tree has no reviewable diff. "
            "Implement the approved plan first. Do not spawn a reviewer."
        )
    protected = protected_pane_ids(meta)
    helper_ids = helper_ids_for_run(run_id, meta)
    helpers = [pane_info(pid) for pid in helper_ids]
    finish_needed = bool(
        verdict
        and any(
            h.get("alive") and h.get("id") and str(h.get("id")) not in protected
            for h in helpers
        )
    )
    if implementer_next == "report" and finish_needed:
        implementer_help = (
            "Verdict recorded. Call finish to close leftover helper panes "
            "(never this pane), then tell the user the verdict."
        )
    return {
        "ok": True,
        "run_id": run_id,
        "dir": str(directory),
        "cwd": meta.get("cwd"),
        "phase": phase,
        "completed": completed,
        "implementer_next": implementer_next,
        "implementer_help": implementer_help,
        "reviewer_next": reviewer_next,
        "reviewer_help": REVIEWER_NEXT_HELP[reviewer_next],
        "files": files,
        "reviewable": reviewable,
        "git": git,
        "open_findings": open_findings,
        "round": status.get("round") or 0,
        "verdict": verdict,
        "reviewer": reviewer,
        "helpers": helpers,
        "finish_needed": finish_needed,
        "pi_present": bool(pi_present),
        "mtime": run_mtime(directory),
        "meta": {
            "implementer_pane": meta.get("implementer_pane"),
            "reviewer_pane": reviewer_pane,
            "helper_panes": meta.get("helper_panes") or [],
            "thinking": meta.get("thinking"),
            "provider": meta.get("provider"),
            "model": meta.get("model"),
            "base_sha": base_sha,
            "base_fingerprint": base_fingerprint,
            "base_tree": base_tree,
        },
    }


def same_cwd(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    try:
        return Path(a).expanduser().resolve() == Path(b).expanduser().resolve()
    except OSError:
        return os.path.normpath(a) == os.path.normpath(b)


def list_runs_for_cwd(cwd: str | None) -> list[dict[str, Any]]:
    root = runs_dir()
    if not root.is_dir():
        return []
    found: list[dict[str, Any]] = []
    for child in root.iterdir():
        if not (child / "meta.json").is_file():
            continue
        snap = inspect_run(child.name)
        if not snap.get("ok"):
            continue
        if cwd and not same_cwd(str(snap.get("cwd") or ""), cwd):
            continue
        found.append(snap)

    def sort_mtime(snapshot: dict[str, Any]) -> float:
        try:
            return float(snapshot.get("mtime") or 0)
        except (TypeError, ValueError):
            return 0.0

    found.sort(key=sort_mtime, reverse=True)
    return found


def pick_run(
    cwd: str | None, run_id: str | None, task: str | None = None
) -> dict[str, Any] | None:
    if run_id:
        snap = inspect_run(run_id)
        return snap if snap.get("ok") else None
    runs = list_runs_for_cwd(cwd)
    if task:
        runs = [
            r
            for r in runs
            if tasks_equivalent(task, read_task(str(r.get("run_id") or "")))
        ]
    if not runs:
        return None
    unfinished = [r for r in runs if r.get("implementer_next") != "report"]
    return (unfinished or runs)[0]


def iter_models(doc: Any) -> list[tuple[str, dict[str, Any]]]:
    """Yield (provider, model_dict) from models.json or models-store.json."""
    out: list[tuple[str, dict[str, Any]]] = []
    if not isinstance(doc, dict):
        return out
    providers = doc.get("providers")
    root = providers if isinstance(providers, dict) else doc
    if not isinstance(root, dict):
        return out
    for provider, block in root.items():
        if not isinstance(block, dict):
            continue
        models = block.get("models")
        if not isinstance(models, list):
            continue
        for model in models:
            if isinstance(model, dict) and isinstance(model.get("id"), str):
                out.append((str(provider), model))
    return out


def thinking_level(provider: str | None, model: str | None) -> dict[str, Any]:
    settings = load_json(SETTINGS_PATH) or {}
    provider = (
        provider or os.environ.get("PI_PROVIDER") or settings.get("defaultProvider")
    )
    model = model or os.environ.get("PI_MODEL") or settings.get("defaultModel")
    if not provider or not model:
        return {
            "thinking": "high",
            "provider": provider,
            "model": model,
            "reason": "no provider/model; defaulting to high",
        }

    found: dict[str, Any] | None = None
    for path in (MODELS_JSON, MODELS_STORE):
        for prov, entry in iter_models(load_json(path)):
            if entry.get("id") != model:
                continue
            if prov == provider or entry.get("provider") == provider:
                found = entry
                break
        if found:
            break
    if found is None:
        for _, entry in iter_models(load_json(MODELS_JSON)):
            if entry.get("id") == model:
                found = entry
                break
        if found is None:
            for _, entry in iter_models(load_json(MODELS_STORE)):
                if entry.get("id") == model:
                    found = entry
                    break

    mapping = (found or {}).get("thinkingLevelMap") or {}
    xhigh = mapping.get("xhigh")
    if isinstance(xhigh, str) and xhigh:
        thinking = "xhigh"
        reason = f"{provider}/{model} maps xhigh -> {xhigh}"
    elif mapping.get("high"):
        thinking = "high"
        reason = f"{provider}/{model} has no xhigh; using high"
    else:
        thinking = "high"
        reason = f"{provider}/{model} thinking map missing xhigh/high; using high"
    return {
        "thinking": thinking,
        "provider": provider,
        "model": model,
        "reason": reason,
    }


def cmd_init(args: argparse.Namespace) -> None:
    cwd = str(Path(args.cwd).expanduser().resolve()) if args.cwd else os.getcwd()
    task = args.task or ""
    if args.task_file:
        task = Path(args.task_file).read_text()
    task = task.strip()
    lock_key = hashlib.sha256(f"{cwd}\0{normalize_task(task)}".encode()).hexdigest()
    init_lock = runs_dir() / ".locks" / f"init-{lock_key}.lock"

    with file_lock(init_lock):
        if not args.new:
            existing = pick_run(cwd, None, task=task or None)
            if existing and existing.get("implementer_next") != "report":
                run_id = str(existing["run_id"])
                directory = run_dir(run_id)
                if task and not nonempty(directory / "task.md"):
                    atomic_write_text(directory / "task.md", task + "\n")
                snap = inspect_run(run_id)
                emit({**snap, "resumed": True, "created": False})
                return

        run_id = uuid.uuid4().hex[:8]
        directory = run_dir(run_id)
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)

        atomic_write_text(directory / "task.md", task + ("\n" if task else ""))
        atomic_write_text(directory / "cwd.txt", cwd + "\n")

        meta = {
            "run_id": run_id,
            "cwd": cwd,
            "implementer_pane": os.environ.get("HERDR_PANE_ID"),
            "reviewer_pane": None,
            "helper_panes": [],
            "thinking": None,
            "provider": None,
            "model": None,
            "base_sha": git_head_sha(cwd),
            "base_fingerprint": None,
            "base_tree": git_worktree_tree(cwd),
            "verdict_nonce": uuid.uuid4().hex,
        }
        write_meta(run_id, meta)
        write_status(run_id, phase="planning", round=0, verdict=None)
        snap = inspect_run(run_id)
        emit({**snap, "resumed": False, "created": True})


def cmd_thinking(args: argparse.Namespace) -> None:
    emit({"ok": True, **thinking_level(args.provider, args.model)})


def expand_reviewer_system(run_id: str) -> Path:
    directory = run_dir(run_id)
    meta = read_meta(run_id)
    template = REVIEWER_SYSTEM.read_text()
    body = (
        template.replace("{{RUN_ID}}", run_id)
        .replace("{{RUN_DIR}}", str(directory))
        .replace("{{SKILL_MD}}", str(SKILL_MD))
        .replace("{{SCRIPT}}", str(Path(__file__).resolve()))
        .replace("{{VERDICT_NONCE}}", str(meta.get("verdict_nonce") or ""))
    )
    path = directory / "reviewer-system.expanded.md"
    path.write_text(body)
    return path


def reviewer_prompt(run_id: str, *, resume: bool = False) -> str:
    directory = run_dir(run_id)
    snap = inspect_run(run_id)
    if resume or snap.get("reviewer_next") != "first-review":
        return (
            f"Resume run {run_id}. "
            f"Skill: {SKILL_MD} (Reviewer role only). "
            f"Run dir: {directory}. "
            f"reviewer_next={snap.get('reviewer_next')}. "
            f"{snap.get('reviewer_help')} "
            "Read status.json and findings.md. Continue — do not start a blank review."
        )
    return (
        f"Review run {run_id}. "
        f"Skill: {SKILL_MD} (Reviewer role only). "
        f"Run dir: {directory}. "
        "Start the first review now."
    )


def pane_id_from_split(data: dict[str, Any]) -> str:
    result = data.get("result") or data
    pane = result.get("pane") or result
    pane_id = pane.get("pane_id") if isinstance(pane, dict) else None
    if not pane_id:
        die(f"pane split response missing pane_id: {json.dumps(data)[:400]}")
    return str(pane_id)


def cmd_spawn_reviewer(args: argparse.Namespace) -> None:
    emit(spawn_reviewer(args))


def spawn_reviewer(args: argparse.Namespace) -> dict[str, Any]:
    run_id = args.run_id
    with file_lock(run_dir(run_id) / ".spawn.lock"):
        return _spawn_reviewer_locked(args)


def _spawn_reviewer_locked(args: argparse.Namespace) -> dict[str, Any]:
    run_id = args.run_id
    snap = inspect_run(run_id)
    if not snap.get("ok"):
        die(str(snap.get("error") or f"missing run {run_id}"))
    if snap.get("implementer_next") == "report":
        return {**snap, "spawned": False, "reason": "verdict already recorded"}
    nxt = snap.get("implementer_next")
    if nxt not in ("spawn-reviewer", "wait-verdict"):
        die(
            f"refusing spawn-reviewer: implementer_next is {nxt}. "
            f"{snap.get('implementer_help')} "
            "Do not spawn a reviewer before implementation is complete."
        )
    require_herdr()
    meta = read_meta(run_id)
    cwd = args.cwd or meta.get("cwd") or os.getcwd()
    resolved = thinking_level(args.provider, args.model)
    thinking = resolved["thinking"]
    provider = resolved.get("provider")
    model = resolved.get("model")
    self_pane = args.self_pane or self_pane_id()
    system_path = expand_reviewer_system(run_id)
    existing_pane = args.pane or resolve_reviewer_pane(run_id, meta)
    existing = pane_info(existing_pane)
    if (
        existing_pane
        and existing.get("alive")
        and not args.pane
        and not pane_matches_run(existing, run_id)
    ):
        existing_pane = None
        existing = {"id": None, "alive": False}
    resume = (
        bool(snap.get("files", {}).get("findings"))
        or snap.get("reviewer_next") != "first-review"
    )
    prompt = reviewer_prompt(run_id, resume=resume)
    agent_name = review_agent_name(run_id)

    def record_pane(pane_id: str, *, reviewing: bool = True) -> None:
        meta.update(
            {
                "implementer_pane": self_pane or meta.get("implementer_pane"),
                "reviewer_pane": pane_id,
                "thinking": thinking,
                "provider": provider,
                "model": model,
            }
        )
        track_helper(meta, pane_id)
        write_meta(run_id, meta)
        if reviewing:
            write_status(run_id, phase="reviewing")

    if (
        not args.dry_run
        and existing.get("alive")
        and existing.get("agent") == "pi"
        and existing.get("agent_status") == "working"
    ):
        record_pane(str(existing_pane))
        return {
            "ok": True,
            "run_id": run_id,
            "pane_id": existing_pane,
            "resumed": True,
            "spawned": False,
            "action": "wait-verdict",
            "thinking": thinking,
            **{k: snap[k] for k in ("implementer_next", "reviewer_next") if k in snap},
        }

    if not args.dry_run and existing.get("alive") and existing.get("agent") == "pi":
        # Idle/done/blocked pi: resume prompt, do not split a second reviewer.
        prompt_proc = herdr(
            "agent",
            "prompt",
            str(existing_pane),
            prompt,
            "--wait",
            "--until",
            "working",
            "--timeout",
            str(DEFAULT_PROMPT_TIMEOUT_MS),
        )
        if prompt_proc.returncode != 0:
            die(
                (
                    prompt_proc.stderr
                    or prompt_proc.stdout
                    or "herdr agent prompt failed"
                ).strip()
                + f" (pane={existing_pane})"
            )
        record_pane(str(existing_pane))
        return {
            "ok": True,
            "run_id": run_id,
            "pane_id": existing_pane,
            "resumed": True,
            "spawned": False,
            "action": "wait-verdict",
            "thinking": thinking,
            "prompted": True,
        }

    if existing.get("alive") and existing_pane and not args.pane:
        # Pane still there (shell, crashed pi). Reuse it instead of splitting.
        args.pane = str(existing_pane)

    start_args = [
        "agent",
        "start",
        agent_name,
        "--kind",
        "pi",
        "--pane",
        "{pane_id}",
        "--",
        "--thinking",
        thinking,
        "--name",
        f"auto-plan-review-{run_id}",
        "--append-system-prompt",
        str(system_path),
    ]
    if provider:
        start_args.extend(["--provider", str(provider)])
    if model:
        start_args.extend(["--model", str(model)])

    planned = {
        "split": None
        if args.pane
        else [
            "pane",
            "split",
            self_pane,
            "--direction",
            "right",
            "--no-focus",
            "--cwd",
            str(cwd),
            "--env",
            "PI_THINKING_ROUTER=0",
        ],
        "start": start_args,
        "prompt": [
            "agent",
            "prompt",
            "{pane_id}",
            prompt,
            "--wait",
            "--until",
            "working",
            "--timeout",
            str(DEFAULT_PROMPT_TIMEOUT_MS),
        ],
        "rename": ["pane", "rename", "{pane_id}", f"review:{run_id}"],
    }

    if args.dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "run_id": run_id,
            "self_pane": self_pane,
            "reuse_pane": args.pane,
            "thinking": thinking,
            "provider": provider,
            "model": model,
            "reason": resolved.get("reason"),
            "planned": planned,
        }

    if args.pane:
        pane_id = args.pane
    else:
        split = herdr_json(
            "pane",
            "split",
            self_pane,
            "--direction",
            "right",
            "--no-focus",
            "--cwd",
            str(cwd),
            "--env",
            "PI_THINKING_ROUTER=0",
        )
        pane_id = pane_id_from_split(split)

    rename = herdr("pane", "rename", pane_id, review_label(run_id))
    if rename.returncode != 0:
        err = (rename.stderr or rename.stdout or "pane rename failed").strip()
        die(f"could not claim reviewer pane {pane_id}: {err}")
    record_pane(pane_id, reviewing=False)

    start_cmd = [
        a.replace("{pane_id}", pane_id) if a == "{pane_id}" else a for a in start_args
    ]
    start_proc = herdr(*start_cmd)
    start_attempts = 1
    if start_proc.returncode != 0:
        # A new split can briefly precede its interactive shell. Retry once in
        # the same pane; never create a second split for this transient race.
        start_attempts = 2
        start_proc = herdr(*start_cmd)
    if start_proc.returncode != 0:
        err = (
            start_proc.stderr or start_proc.stdout or "herdr agent start failed"
        ).strip()
        die(
            f"reviewer pane {pane_id} was claimed but agent start failed twice: {err}. "
            f"Retry with --pane {pane_id}; do not split again."
        )

    try:
        start = json.loads(start_proc.stdout or "{}")
    except json.JSONDecodeError:
        start = {"stdout": start_proc.stdout}

    prompt_proc = herdr(
        "agent",
        "prompt",
        pane_id,
        prompt,
        "--wait",
        "--until",
        "working",
        "--timeout",
        str(DEFAULT_PROMPT_TIMEOUT_MS),
    )
    if prompt_proc.returncode != 0:
        record_pane(pane_id, reviewing=False)
        die(
            (
                prompt_proc.stderr or prompt_proc.stdout or "herdr agent prompt failed"
            ).strip()
            + f" (pane={pane_id})"
        )

    record_pane(pane_id)
    write_status(run_id, phase="reviewing", verdict=None)

    return {
        "ok": True,
        "run_id": run_id,
        "pane_id": pane_id,
        "self_pane": self_pane,
        "thinking": thinking,
        "provider": provider,
        "model": model,
        "reason": resolved.get("reason"),
        "agent_name": agent_name,
        "start": start,
        "start_attempts": start_attempts,
        "rename_ok": True,
        "spawned": True,
        "resumed": False,
    }


def cmd_diff_snapshot(args: argparse.Namespace) -> None:
    run_id = args.run_id
    meta = load_json(run_dir(run_id) / "meta.json")
    if not isinstance(meta, dict):
        emit({"ok": False, "run_id": run_id, "error": "missing run"})
        return
    cwd = str(meta.get("cwd") or "")
    base_tree = str(meta.get("base_tree") or "")
    current_tree = git_worktree_tree(cwd)
    if not base_tree or not current_tree:
        emit({"ok": False, "run_id": run_id, "error": "snapshot tree is unavailable"})
        return
    changed = git_run(cwd, "diff", "--name-only", base_tree, current_tree, "--")
    paths = [line for line in (changed.stdout or "").splitlines() if line]
    emit(
        {
            "ok": True,
            "run_id": run_id,
            "cwd": cwd,
            "base_tree": base_tree,
            "current_tree": current_tree,
            "changed_paths": paths,
            "diff_args": ["git", "-C", cwd, "diff", base_tree, current_tree, "--"],
        }
    )


def cmd_record_verdict(args: argparse.Namespace) -> None:
    run_id = args.run_id
    meta = load_json(run_dir(run_id) / "meta.json")
    if not isinstance(meta, dict):
        emit({"ok": False, "run_id": run_id, "error": "missing run"})
        return
    expected = str(meta.get("verdict_nonce") or "")
    if not expected or args.nonce != expected:
        emit({"ok": False, "run_id": run_id, "error": "invalid verdict nonce"})
        return
    findings_path = run_dir(run_id) / "findings.md"
    if args.verdict == "LGTM" and not findings_path.is_file():
        emit(
            {
                "ok": False,
                "run_id": run_id,
                "error": "cannot record LGTM without findings.md",
            }
        )
        return
    open_findings = (
        count_open_findings(findings_path.read_text()) if findings_path.is_file() else 0
    )
    status_doc = load_json(run_dir(run_id) / "status.json")
    review_round = safe_int(
        status_doc.get("round") if isinstance(status_doc, dict) else 0
    )
    if args.verdict == "LGTM" and open_findings:
        emit(
            {
                "ok": False,
                "run_id": run_id,
                "error": f"cannot record LGTM with {open_findings} open findings",
            }
        )
        return
    if args.verdict == "LGTM" and review_round < 1:
        emit(
            {
                "ok": False,
                "run_id": run_id,
                "error": "cannot record LGTM before review-checkpoint",
            }
        )
        return
    reason = args.reason or ("reviewer-blocked" if args.verdict == "BLOCKED" else None)
    doc = persist_verdict(run_id, args.verdict, reason=reason)
    recorded = str(doc.get("verdict"))
    if recorded != args.verdict:
        emit(
            {
                "ok": False,
                **doc,
                "error": f"run already has authoritative verdict {recorded}",
            }
        )
        return
    marker = f"AUTO_PLAN_RECORDED {run_id} {recorded}"
    leader = notify_session_leader(
        run_id,
        (
            f"{marker}. pickup --run-id {run_id} and continue from implementer_next "
            "(wait-verdict or finish). Do not spawn another reviewer. "
            "Do not close this pane."
        ),
    )
    emit(
        {
            "ok": True,
            **doc,
            "marker": marker,
            "leader": leader,
        }
    )


def normalized_findings_signature(text: str, git_fingerprint: str | None) -> str:
    normalized = "\n".join(
        line.strip().lower() for line in text.splitlines() if line.strip()
    )
    return hashlib.sha256(f"{normalized}\0{git_fingerprint or ''}".encode()).hexdigest()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def cmd_review_checkpoint(args: argparse.Namespace) -> None:
    run_id = args.run_id
    directory = run_dir(run_id)
    meta = load_json(directory / "meta.json")
    expected = (
        str((meta or {}).get("verdict_nonce") or "") if isinstance(meta, dict) else ""
    )
    if not expected or getattr(args, "nonce", None) != expected:
        emit({"ok": False, "run_id": run_id, "error": "invalid verdict nonce"})
        return
    findings_path = directory / "findings.md"
    if not findings_path.is_file():
        emit({"ok": False, "run_id": run_id, "error": "missing findings.md"})
        return
    text = findings_path.read_text()
    open_findings = count_open_findings(text)
    meta = read_meta(run_id)
    fingerprint = git_worktree_fingerprint(str(meta.get("cwd") or ""))
    signature = normalized_findings_signature(text, fingerprint)
    checkpoint_lock = directory / ".checkpoint.lock"
    with file_lock(checkpoint_lock):
        current = load_json(directory / "status.json")
        status = current if isinstance(current, dict) else {}
        round_number = safe_int(status.get("round")) + 1
        previous_signature = status.get("review_signature")
        no_progress = (
            safe_int(status.get("no_progress")) + 1
            if open_findings and previous_signature == signature
            else 0
        )
        atomic_write_text(directory / f"findings-round-{round_number}.md", text)
        write_status(
            run_id,
            phase="reviewing",
            round=round_number,
            open_findings=open_findings,
            review_signature=signature,
            no_progress=no_progress,
        )
    reason = None
    if open_findings and round_number >= DEFAULT_MAX_REVIEW_ROUNDS:
        reason = "max-review-rounds"
    elif no_progress >= DEFAULT_MAX_NO_PROGRESS:
        reason = "no-progress"
    if reason:
        persist_verdict(run_id, "BLOCKED", reason=reason)
        emit(
            {
                "ok": False,
                "run_id": run_id,
                "error": reason,
                "round": round_number,
                "open_findings": open_findings,
                "marker": f"AUTO_PLAN_RECORDED {run_id} BLOCKED",
            }
        )
        return
    emit(
        {
            "ok": True,
            "run_id": run_id,
            "round": round_number,
            "open_findings": open_findings,
            "action": "worker" if open_findings else "verify-clean",
        }
    )


def item_agent_label(run_id: str, item_id: str, role: str, attempt: int) -> str:
    short_role = "impl" if role == "implementer" else "review"
    return f"auto:{run_id}:{item_id}:{short_role}:{attempt}"


def pane_matches_item(
    pane: dict[str, Any],
    run_id: str,
    item_id: str,
    role: str | None = None,
) -> bool:
    label = str(pane.get("label") or pane.get("title") or "")
    base = f"auto:{run_id}:{item_id}:"
    if not label.startswith(base):
        return False
    if role is None:
        return True
    marker = ":impl:" if role == "implementer" else ":review:"
    return marker in label


def item_panes(
    run_id: str, item_id: str, role: str | None = None
) -> list[dict[str, Any]]:
    return [
        pane for pane in list_panes() if pane_matches_item(pane, run_id, item_id, role)
    ]


def close_item_panes(
    run_id: str, item_id: str, role: str | None = None
) -> list[dict[str, Any]]:
    closed: list[dict[str, Any]] = []
    if os.environ.get("HERDR_ENV") != "1":
        return closed
    protected = {str(os.environ.get("HERDR_PANE_ID") or ""), self_pane_id()}
    for pane in item_panes(run_id, item_id, role):
        pane_id = str(pane.get("pane_id") or "")
        if not pane_id or pane_id in protected:
            continue
        current = pane_info(pane_id)
        if not current.get("alive") or not pane_matches_item(
            current, run_id, item_id, role
        ):
            continue
        proc = herdr("pane", "close", pane_id)
        closed.append({"id": pane_id, "ok": proc.returncode == 0})
    return closed


def expand_item_system(
    run_id: str,
    item_id: str,
    role: str,
    item: dict[str, Any],
) -> Path:
    template_path = (
        ITEM_IMPLEMENTER_SYSTEM if role == "implementer" else ITEM_REVIEWER_SYSTEM
    )
    body = template_path.read_text()
    replacements = {
        "{{RUN_ID}}": run_id,
        "{{ITEM_ID}}": item_id,
        "{{ASSIGNMENT}}": str(item_scheduler.item_dir(run_id, item_id) / "meta.json"),
        "{{WORKTREE}}": str(item.get("worktree") or ""),
        "{{NONCE}}": str(
            item.get("review_nonce") if role == "reviewer" else item.get("nonce")
        ),
        "{{SKILL_MD}}": str(SKILL_MD),
        "{{SCRIPT}}": str(Path(__file__).resolve()),
    }
    for marker, value in replacements.items():
        body = body.replace(marker, value)
    path = item_scheduler.item_dir(run_id, item_id) / f"{role}-system.md"
    atomic_write_text(path, body)
    return path


def release_item_spawn_claim(
    run_id: str,
    item_id: str,
    claim_token: str,
    role: str,
) -> None:
    with item_scheduler.scheduler_lock(run_id):
        state = item_scheduler.load_state(run_id)
        item = (state or {}).get("items", {}).get(item_id) if state else None
        if not isinstance(item, dict):
            return
        claim = item.get("spawn_claim")
        if not isinstance(claim, dict) or claim.get("token") != claim_token:
            return
        item.pop("spawn_claim", None)
        if role == "reviewer" and item.get("status") == "reviewing":
            item["status"] = "implemented"
        item_scheduler.save_state(run_id, state)


def spawn_item_agent(args: argparse.Namespace, role: str) -> dict[str, Any]:
    require_herdr()
    run_id = args.run_id
    item_id = args.item_id
    claim_token = uuid.uuid4().hex
    reuse_pane: str | None = None
    attempt = 0
    with item_scheduler.scheduler_lock(run_id):
        state = item_scheduler.load_state(run_id)
        if not state:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "item scheduler is not initialized",
            }
        item = state.get("items", {}).get(item_id)
        if not isinstance(item, dict):
            return {"ok": False, "run_id": run_id, "error": f"unknown item {item_id}"}
        expected = "implementing" if role == "implementer" else "implemented"
        allowed = (expected,) if role == "implementer" else ("implemented", "reviewing")
        if item.get("status") not in allowed:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": f"{role} cannot start from status {item.get('status')}; expected {expected}",
            }
        agents = item.get("agents") or {}
        existing_agent = agents.get(role) or {}
        existing_pane_id = str(existing_agent.get("pane_id") or "")
        existing_info = pane_info(existing_pane_id)
        if existing_info.get("alive") and pane_matches_item(
            existing_info, run_id, item_id, role
        ):
            if existing_info.get("agent_status") == "working":
                return {
                    "ok": True,
                    "run_id": run_id,
                    "item_id": item_id,
                    "role": role,
                    "pane_id": existing_pane_id,
                    "spawned": False,
                    "action": "wait-item",
                }
            if role == "implementer":
                reuse_pane = existing_pane_id
        if reuse_pane:
            pass
        else:
            spawning = item.get("spawn_claim")
            if isinstance(spawning, dict) and spawning.get("role") == role:
                return {
                    "ok": False,
                    "run_id": run_id,
                    "item_id": item_id,
                    "error": f"{role} spawn already claimed",
                }
            attempt_key = "attempt" if role == "implementer" else "review_attempt"
            attempt = safe_int(item.get(attempt_key))
            if role == "reviewer":
                attempt += 1
                item[attempt_key] = attempt
                item["status"] = "reviewing"
                # The reviewer gets its own authority key so the implementer can
                # never self-approve by recording a review verdict.
                item["review_nonce"] = uuid.uuid4().hex
            item["spawn_claim"] = {"token": claim_token, "role": role}
            item_scheduler.save_state(run_id, state)

    if reuse_pane:
        system_path = expand_item_system(
            run_id, item_id, role, item_scheduler.load_state(run_id)["items"][item_id]
        )
        prompt = (
            f"Resume auto-plan run {run_id}, item {item_id}, role {role}. "
            f"Read {system_path} and {item_scheduler.item_dir(run_id, item_id) / 'meta.json'}; execute now."
        )
        prompted = herdr(
            "agent",
            "prompt",
            reuse_pane,
            prompt,
            "--wait",
            "--until",
            "working",
            "--timeout",
            str(DEFAULT_PROMPT_TIMEOUT_MS),
        )
        if prompted.returncode != 0:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "pane_id": reuse_pane,
                "error": (
                    prompted.stderr or prompted.stdout or "item prompt failed"
                ).strip(),
            }
        return {
            "ok": True,
            "run_id": run_id,
            "item_id": item_id,
            "role": role,
            "pane_id": reuse_pane,
            "spawned": False,
            "action": "wait-item",
        }

    # A reviewer is always a fresh session. The completed implementer pane is
    # closed only after its durable item result exists.
    if role == "reviewer":
        close_item_panes(run_id, item_id, "implementer")
        close_item_panes(run_id, item_id, "reviewer")

    state = item_scheduler.load_state(run_id)
    item = (state or {}).get("items", {}).get(item_id) if state else None
    if not isinstance(item, dict):
        return {
            "ok": False,
            "run_id": run_id,
            "item_id": item_id,
            "error": "item state disappeared",
        }
    resolved = thinking_level(args.provider, args.model)
    thinking = resolved["thinking"]
    provider = resolved.get("provider")
    model = resolved.get("model")
    self_pane = args.self_pane or self_pane_id()
    label = item_agent_label(run_id, item_id, role, attempt)
    system_path = expand_item_system(run_id, item_id, role, item)
    split_proc = herdr(
        "pane",
        "split",
        self_pane,
        "--direction",
        "right",
        "--no-focus",
        "--cwd",
        str(item["worktree"]),
        "--env",
        "PI_THINKING_ROUTER=0",
        "--env",
        f"AUTO_PLAN_RUN_ID={run_id}",
        "--env",
        f"AUTO_PLAN_ITEM_ID={item_id}",
        "--env",
        f"AUTO_PLAN_ROLE={role}",
    )
    if split_proc.returncode != 0:
        release_item_spawn_claim(run_id, item_id, claim_token, role)
        return {
            "ok": False,
            "run_id": run_id,
            "item_id": item_id,
            "error": (
                split_proc.stderr or split_proc.stdout or "item pane split failed"
            ).strip(),
        }
    try:
        split = json.loads(split_proc.stdout or "{}")
    except json.JSONDecodeError:
        split = {}
    result = split.get("result") or split
    pane = result.get("pane") if isinstance(result, dict) else None
    pane_id = str((pane or {}).get("pane_id") or "") if isinstance(pane, dict) else ""
    if not pane_id:
        release_item_spawn_claim(run_id, item_id, claim_token, role)
        return {
            "ok": False,
            "run_id": run_id,
            "item_id": item_id,
            "error": "invalid pane split response",
        }
    renamed = herdr("pane", "rename", pane_id, label)
    if renamed.returncode != 0:
        release_item_spawn_claim(run_id, item_id, claim_token, role)
        close_item_panes(run_id, item_id, role)
        return {
            "ok": False,
            "run_id": run_id,
            "item_id": item_id,
            "error": "could not label item pane",
        }

    agent_name = f"auto-{run_id}-{item_id}-{role}-{attempt}"
    start_args = [
        "agent",
        "start",
        agent_name,
        "--kind",
        "pi",
        "--pane",
        pane_id,
        "--",
        "--thinking",
        thinking,
        "--name",
        agent_name,
        "--append-system-prompt",
        str(system_path),
    ]
    if provider:
        start_args.extend(["--provider", str(provider)])
    if model:
        start_args.extend(["--model", str(model)])
    started = herdr(*start_args)
    start_attempts = 1
    if started.returncode != 0:
        start_attempts = 2
        started = herdr(*start_args)
    if started.returncode != 0:
        release_item_spawn_claim(run_id, item_id, claim_token, role)
        return {
            "ok": False,
            "run_id": run_id,
            "item_id": item_id,
            "pane_id": pane_id,
            "error": "item agent start failed twice; reuse the labelled pane",
        }
    prompt = (
        f"Start auto-plan run {run_id}, item {item_id}, role {role}. "
        f"Read {system_path} and {item_scheduler.item_dir(run_id, item_id) / 'meta.json'}; execute now."
    )
    prompted = herdr(
        "agent",
        "prompt",
        pane_id,
        prompt,
        "--wait",
        "--until",
        "working",
        "--timeout",
        str(DEFAULT_PROMPT_TIMEOUT_MS),
    )
    if prompted.returncode != 0:
        release_item_spawn_claim(run_id, item_id, claim_token, role)
        return {
            "ok": False,
            "run_id": run_id,
            "item_id": item_id,
            "pane_id": pane_id,
            "error": (
                prompted.stderr or prompted.stdout or "item prompt failed"
            ).strip(),
        }
    with item_scheduler.scheduler_lock(run_id):
        state = item_scheduler.load_state(run_id)
        item = (state or {}).get("items", {}).get(item_id) if state else None
        if isinstance(item, dict):
            claim = item.get("spawn_claim")
            if isinstance(claim, dict) and claim.get("token") == claim_token:
                item.pop("spawn_claim", None)
                item.setdefault("agents", {})[role] = {
                    "pane_id": pane_id,
                    "label": label,
                    "attempt": attempt,
                }
                item_scheduler.save_state(run_id, state)
    return {
        "ok": True,
        "run_id": run_id,
        "item_id": item_id,
        "role": role,
        "attempt": attempt,
        "pane_id": pane_id,
        "label": label,
        "thinking": thinking,
        "start_attempts": start_attempts,
        "action": "wait-item",
    }


def cmd_spawn_item(args: argparse.Namespace) -> None:
    emit(spawn_item_agent(args, "implementer"))


def cmd_spawn_item_reviewer(args: argparse.Namespace) -> None:
    emit(spawn_item_agent(args, "reviewer"))


def item_terminal(item: dict[str, Any], role: str) -> bool:
    status = str(item.get("status") or "")
    if role == "implementer":
        return status in (
            "implemented",
            "reviewing",
            "approved",
            "integrated",
            "blocked",
        )
    return status in ("approved", "integrated", "blocked")


def cmd_wait_item(args: argparse.Namespace) -> None:
    require_herdr()
    run_id = args.run_id
    item_id = args.item_id
    role = args.role
    state = item_scheduler.load_state(run_id)
    item = (state or {}).get("items", {}).get(item_id) if state else None
    if not isinstance(item, dict):
        emit(
            {"ok": False, "run_id": run_id, "item_id": item_id, "error": "unknown item"}
        )
        return
    if item_terminal(item, role):
        emit(
            {
                "ok": True,
                "run_id": run_id,
                "item_id": item_id,
                "role": role,
                "status": item.get("status"),
                "disposition": "complete",
                "closed": close_item_panes(run_id, item_id, role),
            }
        )
        return
    agents = item.get("agents") or {}
    pane_id = str((agents.get(role) or {}).get("pane_id") or "")
    info = pane_info(pane_id)
    if not info.get("alive") or not pane_matches_item(info, run_id, item_id, role):
        emit(
            {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "role": role,
                "error": "item pane is missing or its identity changed",
            }
        )
        return
    marker = (
        "AUTO_PLAN_ITEM_RECORDED"
        if role == "implementer"
        else "AUTO_PLAN_ITEM_REVIEWED"
    )
    proc = herdr(
        "pane",
        "wait-output",
        pane_id,
        "--regex",
        rf"{marker} {run_id} {item_id} ",
        "--source",
        "recent-unwrapped",
        "--timeout",
        str(args.timeout_ms if args.timeout_ms is not None else DEFAULT_WAIT_SLICE_MS),
    )
    state = item_scheduler.load_state(run_id)
    item = (state or {}).get("items", {}).get(item_id) if state else None
    if isinstance(item, dict) and item_terminal(item, role):
        emit(
            {
                "ok": True,
                "run_id": run_id,
                "item_id": item_id,
                "role": role,
                "status": item.get("status"),
                "disposition": "complete",
                "closed": close_item_panes(run_id, item_id, role),
            }
        )
        return
    current = pane_info(pane_id)
    disposition = "park" if current.get("agent_status") == "working" else "stalled"
    emit(
        {
            "ok": True,
            "run_id": run_id,
            "item_id": item_id,
            "role": role,
            "status": item.get("status") if isinstance(item, dict) else None,
            "disposition": disposition,
            "agent_status": current.get("agent_status"),
            "closed": [],
        }
    )


def cmd_items_init(args: argparse.Namespace) -> None:
    emit(item_scheduler.cmd_items_init(args))


def cmd_items_status(args: argparse.Namespace) -> None:
    emit(item_scheduler.cmd_items_status(args))


def cmd_claim_item(args: argparse.Namespace) -> None:
    emit(item_scheduler.cmd_claim_item(args))


def cmd_record_item(args: argparse.Namespace) -> None:
    result = item_scheduler.cmd_record_item(args)
    if result.get("ok"):
        marker = str(result.get("marker") or "").strip() or (
            f"AUTO_PLAN_ITEM_RECORDED {args.run_id} {args.item_id} implemented"
        )
        result["leader"] = notify_session_leader(
            args.run_id,
            (
                f"{marker}. pickup --run-id {args.run_id} and continue from "
                "implementer_next (wait-item / spawn-item-reviewer / integrate-item). "
                "Do not close this pane."
            ),
        )
    emit(result)


def cmd_item_review_checkpoint(args: argparse.Namespace) -> None:
    emit(item_scheduler.cmd_item_review_checkpoint(args))


def cmd_record_item_review(args: argparse.Namespace) -> None:
    result = item_scheduler.cmd_record_item_review(args)
    if result.get("ok"):
        marker = str(result.get("marker") or "").strip() or (
            f"AUTO_PLAN_ITEM_REVIEWED {args.run_id} {args.item_id} {args.verdict}"
        )
        result["leader"] = notify_session_leader(
            args.run_id,
            (
                f"{marker}. pickup --run-id {args.run_id} and continue from "
                "implementer_next (wait-item / integrate-item). Do not close this pane."
            ),
        )
    emit(result)


def cmd_integrate_item(args: argparse.Namespace) -> None:
    result = item_scheduler.cmd_integrate_item(args)
    if result.get("ok"):
        result["closed"] = close_item_panes(args.run_id, args.item_id)
    emit(result)


def cmd_finalize_items(args: argparse.Namespace) -> None:
    emit(item_scheduler.cmd_finalize_items(args))


def cmd_pickup(args: argparse.Namespace) -> None:
    cwd = None
    if args.cwd:
        cwd = str(Path(args.cwd).expanduser().resolve())
    elif not args.run_id:
        cwd = os.getcwd()
    snap = pick_run(cwd, args.run_id, task=args.task or None)
    if snap is None:
        emit(
            {
                "ok": True,
                "run_id": None,
                "cwd": cwd,
                "completed": [],
                "implementer_next": "init",
                "implementer_help": IMPLEMENTER_NEXT_HELP["init"],
                "reviewer_next": None,
                "candidates": [],
            }
        )
        return
    candidates = []
    if cwd and not args.run_id:
        for row in list_runs_for_cwd(cwd):
            candidates.append(
                {
                    "run_id": row.get("run_id"),
                    "implementer_next": row.get("implementer_next"),
                    "verdict": row.get("verdict"),
                    "mtime": row.get("mtime"),
                }
            )
    emit({**snap, "candidates": candidates})


def cmd_wait_verdict(args: argparse.Namespace) -> None:
    emit(
        wait_verdict(
            args.run_id, pane=args.pane, timeout_ms=args.timeout_ms, keep=args.keep
        )
    )


def wait_verdict(
    run_id: str,
    *,
    pane: str | None = None,
    timeout_ms: int | None = None,
    keep: list[str] | None = None,
) -> dict[str, Any]:
    require_herdr()
    snap = inspect_run(run_id)
    if snap.get("verdict") in ("LGTM", "BLOCKED"):
        closed = close_helpers(run_id, keep=keep)
        return {
            "ok": True,
            "run_id": run_id,
            "pane_id": (snap.get("reviewer") or {}).get("id"),
            "verdict": snap["verdict"],
            "already_done": True,
            **closed,
        }
    meta = read_meta(run_id)
    stored = str(meta.get("reviewer_pane") or "").strip()
    stored_view = pane_info(stored) if stored else {"alive": False}
    if (
        stored
        and stored_view.get("alive")
        and not pane_matches_run(stored_view, run_id)
    ):
        return {
            "ok": False,
            "run_id": run_id,
            "pane_id": stored,
            "verdict": None,
            "error": "identity mismatch: stored reviewer pane is not this run",
            "closed": [],
        }
    pane_id = pane or resolve_reviewer_pane(run_id, meta)
    if not pane_id:
        die("no reviewer pane on this run — spawn-reviewer first")
    pane_view = pane_info(pane_id)
    if pane_view.get("alive") and not pane_matches_run(pane_view, run_id):
        return {
            "ok": False,
            "run_id": run_id,
            "pane_id": pane_id,
            "verdict": None,
            "error": "identity mismatch: stored reviewer pane is not this run",
            "closed": [],
        }

    wait_args = [
        "pane",
        "wait-output",
        str(pane_id),
        "--regex",
        rf"AUTO_PLAN_RECORDED {run_id} (LGTM|BLOCKED)",
        "--source",
        "recent-unwrapped",
        "--timeout",
        str(timeout_ms if timeout_ms is not None else DEFAULT_WAIT_SLICE_MS),
    ]

    proc = herdr(*wait_args)
    verdict_doc = authoritative_verdict(run_id)
    verdict = verdict_doc.get("verdict") if verdict_doc else None
    if verdict in ("LGTM", "BLOCKED"):
        closed = close_helpers(run_id, keep=keep)
        return {
            "ok": True,
            "run_id": run_id,
            "pane_id": pane_id,
            "verdict": verdict,
            "already_done": False,
            **closed,
        }

    if proc.returncode != 0:
        info = pane_info(pane_id)
        write_status(run_id, phase="waiting", last_error="wait slice elapsed")
        if not info.get("alive"):
            die(
                f"reviewer pane {pane_id} gone without a verdict. Retry spawn-reviewer --run-id {run_id}."
            )
        disposition = "park" if info.get("agent_status") == "working" else "stalled"
        return {
            "ok": True,
            "run_id": run_id,
            "pane_id": pane_id,
            "verdict": None,
            "disposition": disposition,
            "agent_status": info.get("agent_status"),
            "closed": [],
            "skipped": [],
            "kept": protected_pane_ids(meta, keep),
        }
    info = pane_info(pane_id)
    disposition = "park" if info.get("agent_status") == "working" else "stalled"
    return {
        "ok": True,
        "run_id": run_id,
        "pane_id": pane_id,
        "verdict": None,
        "disposition": disposition,
        "agent_status": info.get("agent_status"),
        "closed": [],
        "skipped": [],
        "kept": protected_pane_ids(meta, keep),
    }


def cmd_finish(args: argparse.Namespace) -> None:
    run_id = args.run_id
    snap = inspect_run(run_id)
    if not snap.get("ok"):
        die(str(snap.get("error") or f"missing run {run_id}"))
    if snap.get("verdict") not in ("LGTM", "BLOCKED") and not args.force:
        emit(
            {
                "ok": False,
                "run_id": run_id,
                "verdict": None,
                "error": "refusing to close helpers before an authoritative verdict; use --force for recovery",
                "closed": [],
            }
        )
        return
    closed = close_helpers(run_id, keep=args.keep, dry_run=bool(args.dry_run))
    emit(
        {
            "ok": True,
            "run_id": run_id,
            "verdict": snap.get("verdict"),
            "implementer_next": snap.get("implementer_next"),
            **closed,
        }
    )


def cmd_review(args: argparse.Namespace) -> None:
    spawned = spawn_reviewer(args)
    if spawned.get("dry_run"):
        emit({"ok": True, "run_id": args.run_id, "spawned": spawned})
        return
    waited = wait_verdict(
        args.run_id,
        pane=getattr(args, "pane", None) or spawned.get("pane_id"),
        timeout_ms=getattr(args, "timeout_ms", None),
        keep=getattr(args, "keep", None),
    )
    emit(
        {
            "ok": True,
            "run_id": args.run_id,
            "verdict": waited.get("verdict"),
            "pane_id": waited.get("pane_id"),
            "spawned": spawned.get("spawned"),
            "resumed": spawned.get("resumed"),
            "already_done": waited.get("already_done"),
            "closed": waited.get("closed"),
            "skipped": waited.get("skipped"),
            "kept": waited.get("kept"),
            "thinking": spawned.get("thinking") or waited.get("thinking"),
            "disposition": waited.get("disposition") or "complete",
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Opt-in /auto-plan herdr glue")
    sub = parser.add_subparsers(dest="cmd", required=True)

    init = sub.add_parser("init")
    init.add_argument("--cwd")
    init.add_argument("--task", default="")
    init.add_argument("--task-file")
    init.add_argument(
        "--new",
        action="store_true",
        help="Force a new run even if one is in progress for this cwd",
    )
    init.set_defaults(func=cmd_init)

    pickup = sub.add_parser("pickup")
    pickup.add_argument("--cwd")
    pickup.add_argument("--run-id")
    pickup.add_argument(
        "--task",
        default="",
        help="Only resume a run whose task.md matches. A different task starts init, not spawn-reviewer.",
    )
    pickup.set_defaults(func=cmd_pickup)

    snapshot = sub.add_parser("diff-snapshot")
    snapshot.add_argument("--run-id", required=True)
    snapshot.set_defaults(func=cmd_diff_snapshot)

    record = sub.add_parser("record-verdict")
    record.add_argument("--run-id", required=True)
    record.add_argument("--verdict", required=True, choices=("LGTM", "BLOCKED"))
    record.add_argument("--nonce", required=True)
    record.add_argument("--reason")
    record.set_defaults(func=cmd_record_verdict)

    checkpoint = sub.add_parser("review-checkpoint")
    checkpoint.add_argument("--run-id", required=True)
    checkpoint.add_argument("--nonce", required=True)
    checkpoint.set_defaults(func=cmd_review_checkpoint)

    items_init = sub.add_parser("items-init")
    items_init.add_argument("--run-id", required=True)
    items_init.add_argument("--manifest", required=True)
    items_init.add_argument("--max-parallel", type=int, default=1)
    items_init.set_defaults(func=cmd_items_init)

    items_status = sub.add_parser("items-status")
    items_status.add_argument("--run-id", required=True)
    items_status.set_defaults(func=cmd_items_status)

    claim_item = sub.add_parser("claim-item")
    claim_item.add_argument("--run-id", required=True)
    claim_item.add_argument("--item-id", required=True)
    claim_item.add_argument(
        "--role", required=True, choices=("implementer", "reviewer")
    )
    claim_item.set_defaults(func=cmd_claim_item)

    record_item = sub.add_parser("record-item")
    record_item.add_argument("--run-id", required=True)
    record_item.add_argument("--item-id", required=True)
    record_item.add_argument("--nonce", required=True)
    record_item.set_defaults(func=cmd_record_item)

    spawn_item = sub.add_parser("spawn-item")
    spawn_item.add_argument("--run-id", required=True)
    spawn_item.add_argument("--item-id", required=True)
    spawn_item.add_argument("--provider")
    spawn_item.add_argument("--model")
    spawn_item.add_argument("--self-pane")
    spawn_item.set_defaults(func=cmd_spawn_item)

    spawn_item_reviewer = sub.add_parser("spawn-item-reviewer")
    spawn_item_reviewer.add_argument("--run-id", required=True)
    spawn_item_reviewer.add_argument("--item-id", required=True)
    spawn_item_reviewer.add_argument("--provider")
    spawn_item_reviewer.add_argument("--model")
    spawn_item_reviewer.add_argument("--self-pane")
    spawn_item_reviewer.set_defaults(func=cmd_spawn_item_reviewer)

    wait_item = sub.add_parser("wait-item")
    wait_item.add_argument("--run-id", required=True)
    wait_item.add_argument("--item-id", required=True)
    wait_item.add_argument("--role", required=True, choices=("implementer", "reviewer"))
    wait_item.add_argument("--timeout-ms", type=int)
    wait_item.set_defaults(func=cmd_wait_item)

    item_checkpoint = sub.add_parser("item-review-checkpoint")
    item_checkpoint.add_argument("--run-id", required=True)
    item_checkpoint.add_argument("--item-id", required=True)
    item_checkpoint.add_argument("--nonce", required=True)
    item_checkpoint.set_defaults(func=cmd_item_review_checkpoint)

    record_item_review = sub.add_parser("record-item-review")
    record_item_review.add_argument("--run-id", required=True)
    record_item_review.add_argument("--item-id", required=True)
    record_item_review.add_argument("--nonce", required=True)
    record_item_review.add_argument(
        "--verdict", required=True, choices=("LGTM", "BLOCKED")
    )
    record_item_review.add_argument("--reason")
    record_item_review.set_defaults(func=cmd_record_item_review)

    integrate_item = sub.add_parser("integrate-item")
    integrate_item.add_argument("--run-id", required=True)
    integrate_item.add_argument("--item-id", required=True)
    integrate_item.set_defaults(func=cmd_integrate_item)

    finalize_items = sub.add_parser("finalize-items")
    finalize_items.add_argument("--run-id", required=True)
    finalize_items.set_defaults(func=cmd_finalize_items)

    thinking = sub.add_parser("thinking")
    thinking.add_argument("--provider")
    thinking.add_argument("--model")
    thinking.set_defaults(func=cmd_thinking)

    spawn = sub.add_parser("spawn-reviewer")
    spawn.add_argument("--run-id", required=True)
    spawn.add_argument("--cwd")
    spawn.add_argument("--provider")
    spawn.add_argument("--model")
    spawn.add_argument("--self-pane")
    spawn.add_argument("--pane", help="Reuse an existing shell pane; skip split")
    spawn.add_argument("--dry-run", action="store_true")
    spawn.set_defaults(func=cmd_spawn_reviewer)

    wait = sub.add_parser("wait-verdict")
    wait.add_argument("--run-id", required=True)
    wait.add_argument("--pane")
    wait.add_argument("--timeout-ms", type=int)
    wait.add_argument(
        "--keep",
        action="append",
        default=None,
        help="Extra pane ids that must never be closed (implementer pane is always kept)",
    )
    wait.set_defaults(func=cmd_wait_verdict)

    finish = sub.add_parser("finish")
    finish.add_argument("--run-id", required=True)
    finish.add_argument("--dry-run", action="store_true")
    finish.add_argument(
        "--force",
        action="store_true",
        help="Recovery only: close owned helpers without a verdict",
    )
    finish.add_argument(
        "--keep",
        action="append",
        default=None,
        help="Extra pane ids that must never be closed (implementer pane is always kept)",
    )
    finish.set_defaults(func=cmd_finish)

    review = sub.add_parser("review")
    review.add_argument("--run-id", required=True)
    review.add_argument("--cwd")
    review.add_argument("--provider")
    review.add_argument("--model")
    review.add_argument("--self-pane")
    review.add_argument("--pane", help="Reuse an existing shell pane; skip split")
    review.add_argument("--dry-run", action="store_true")
    review.add_argument("--timeout-ms", type=int)
    review.add_argument(
        "--keep",
        action="append",
        default=None,
        help="Extra pane ids that must never be closed (implementer pane is always kept)",
    )
    review.set_defaults(func=cmd_review)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
