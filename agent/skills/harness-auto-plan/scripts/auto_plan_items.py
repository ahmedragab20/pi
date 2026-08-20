#!/usr/bin/env python3
"""Durable, worktree-isolated item scheduler for harness-auto-plan."""

from __future__ import annotations

import contextlib
import fcntl
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Iterator

ACTIVE_STATUSES = {
    "implementing",
    "reviewing",
}
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def runs_dir() -> Path:
    override = os.environ.get("AUTO_PLAN_HOME")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".pi" / "agent" / "tmp" / "auto-plan"


def item_worktree_root() -> Path:
    override = os.environ.get("AUTO_PLAN_WORKTREE_HOME")
    if override:
        return Path(override).expanduser()
    return runs_dir() / "worktrees"


def run_dir(run_id: str) -> Path:
    return runs_dir() / run_id


def state_path(run_id: str) -> Path:
    return run_dir(run_id) / "items-state.json"


def item_dir(run_id: str, item_id: str) -> Path:
    return run_dir(run_id) / "items" / item_id


def atomic_write_text(path: Path, text: str) -> None:
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
def scheduler_lock(run_id: str) -> Iterator[None]:
    path = run_dir(run_id) / ".items.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def append_event(run_id: str, event: str, **fields: Any) -> None:
    path = run_dir(run_id) / "events.ndjson"
    record = {
        "event_id": uuid.uuid4().hex,
        "timestamp": time.time(),
        "event": event,
        **fields,
    }
    lock = run_dir(run_id) / ".events.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a+") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            with path.open("a") as handle:
                handle.write(json.dumps(record, sort_keys=True) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def save_state(run_id: str, state: dict[str, Any]) -> None:
    atomic_write_text(state_path(run_id), json.dumps(state, indent=2) + "\n")
    items = state.get("items") or {}
    for item_id, item in items.items():
        directory = item_dir(run_id, str(item_id))
        directory.mkdir(parents=True, exist_ok=True)
        atomic_write_text(directory / "meta.json", json.dumps(item, indent=2) + "\n")
    append_event(
        run_id,
        "items-state",
        status=state.get("status"),
        items={item_id: item.get("status") for item_id, item in items.items()},
    )


def load_state(run_id: str) -> dict[str, Any] | None:
    state = load_json(state_path(run_id))
    return state if isinstance(state, dict) else None


def git(cwd: str | Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
    )


def git_ok(cwd: str | Path, *args: str) -> tuple[bool, str]:
    proc = git(cwd, *args)
    output = (proc.stderr or proc.stdout or "").strip()
    return proc.returncode == 0, output


def git_value(cwd: str | Path, *args: str) -> str | None:
    proc = git(cwd, *args)
    value = (proc.stdout or "").strip()
    return value if proc.returncode == 0 and value else None


def clean_repo(cwd: str | Path) -> bool:
    proc = git(cwd, "status", "--porcelain")
    return proc.returncode == 0 and not (proc.stdout or "").strip()


def create_owned_worktree(
    cwd: str,
    branch: str,
    path: Path,
    base_sha: str,
) -> subprocess.CompletedProcess[str]:
    """Create a run-owned worktree, cleaning only a stale empty same-run path."""
    proc = git(cwd, "worktree", "add", "-b", branch, str(path), base_sha)
    if proc.returncode == 0:
        return proc
    owned_prefix = "auto-plan/"
    if not branch.startswith(owned_prefix):
        return proc
    existing = git_value(cwd, "rev-parse", "--verify", branch)
    if existing:
        # Never delete a branch that already exists — reattach it.
        if path.exists():
            git(cwd, "worktree", "remove", "--force", str(path))
            git(cwd, "worktree", "prune")
        return git(cwd, "worktree", "add", str(path), branch)
    if path.exists():
        git(cwd, "worktree", "remove", "--force", str(path))
        git(cwd, "worktree", "prune")
    return git(cwd, "worktree", "add", "-b", branch, str(path), base_sha)


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def canonical_manifest(items: list[dict[str, Any]], max_parallel: int) -> str:
    return json.dumps(
        {"items": items, "max_parallel": max_parallel},
        sort_keys=True,
        separators=(",", ":"),
    )


def static_path_prefix(pattern: str) -> str:
    normalized = pattern.strip().replace("\\", "/").lstrip("./")
    wildcard = min(
        [normalized.find(char) for char in "*[?" if char in normalized]
        or [len(normalized)]
    )
    prefix = normalized[:wildcard].rstrip("/")
    return prefix


def paths_overlap(left: str, right: str) -> bool:
    a = static_path_prefix(left)
    b = static_path_prefix(right)
    if not a or not b:
        return True
    if a == b:
        return True
    if a.startswith(b.rstrip("/") + "/") or b.startswith(a.rstrip("/") + "/"):
        return True
    # Suffix globs: src/foo* owns src/foobar even though prefixes differ.
    if fnmatch.fnmatchcase(b, left) or fnmatch.fnmatchcase(a, right):
        return True
    if fnmatch.fnmatchcase(b + "/x", left) or fnmatch.fnmatchcase(a + "/x", right):
        return True
    return False


def dependency_reach(items: dict[str, dict[str, Any]], start: str, target: str) -> bool:
    pending = list(items[start].get("depends") or [])
    seen: set[str] = set()
    while pending:
        current = str(pending.pop())
        if current == target:
            return True
        if current in seen or current not in items:
            continue
        seen.add(current)
        pending.extend(items[current].get("depends") or [])
    return False


def validate_manifest(raw: Any) -> tuple[list[dict[str, Any]] | None, str | None]:
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
        return None, "manifest must contain an items array"
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw["items"]):
        if not isinstance(entry, dict):
            return None, f"item {index} must be an object"
        item_id = str(entry.get("id") or "").strip()
        if not ITEM_ID_RE.fullmatch(item_id):
            return None, f"invalid item id: {item_id!r}"
        if item_id in seen:
            return None, f"duplicate item id: {item_id}"
        seen.add(item_id)
        paths = entry.get("paths")
        if (
            not isinstance(paths, list)
            or not paths
            or not all(isinstance(p, str) and p.strip() for p in paths)
        ):
            return None, f"item {item_id} requires non-empty paths"
        depends = entry.get("depends") or entry.get("depends_on") or []
        if not isinstance(depends, list) or not all(
            isinstance(dep, str) for dep in depends
        ):
            return None, f"item {item_id} dependencies must be an array"
        normalized.append(
            {
                "id": item_id,
                "title": str(entry.get("title") or item_id),
                "description": str(entry.get("description") or ""),
                "paths": [str(path).strip().replace("\\", "/") for path in paths],
                "depends": [str(dep) for dep in depends],
            }
        )
    by_id = {item["id"]: item for item in normalized}
    for item in normalized:
        for dependency in item["depends"]:
            if dependency not in by_id:
                return None, f"undefined dependency {dependency} for {item['id']}"
            if dependency == item["id"]:
                return None, f"dependency cycle at {item['id']}"

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(item_id: str) -> bool:
        if item_id in visiting:
            return False
        if item_id in visited:
            return True
        visiting.add(item_id)
        for dependency in by_id[item_id]["depends"]:
            if not visit(dependency):
                return False
        visiting.remove(item_id)
        visited.add(item_id)
        return True

    if any(not visit(item_id) for item_id in by_id):
        return None, "dependency cycle detected"

    ids = list(by_id)
    for index, left_id in enumerate(ids):
        for right_id in ids[index + 1 :]:
            if dependency_reach(by_id, left_id, right_id) or dependency_reach(
                by_id, right_id, left_id
            ):
                continue
            if any(
                paths_overlap(left, right)
                for left in by_id[left_id]["paths"]
                for right in by_id[right_id]["paths"]
            ):
                return (
                    None,
                    f"path overlap between independent items {left_id} and {right_id}",
                )
    return normalized, None


def scheduler_snapshot(state: dict[str, Any]) -> dict[str, Any]:
    items = state.get("items") or {}
    active = [item for item in items.values() if item.get("status") in ACTIVE_STATUSES]
    slots = max(0, safe_int(state.get("max_parallel"), 1) - len(active))
    ready: list[dict[str, Any]] = []
    for item in items.values():
        if item.get("status") != "pending":
            continue
        dependencies = item.get("depends") or []
        if all(
            (items.get(dep) or {}).get("status") == "integrated" for dep in dependencies
        ):
            ready.append(
                {
                    "id": item["id"],
                    "title": item.get("title"),
                    "paths": item.get("paths") or [],
                    "depends": dependencies,
                    "status": "ready",
                }
            )
    ready = ready[:slots]
    return {
        "ok": True,
        "run_id": state["run_id"],
        "status": state.get("status"),
        "items": ready,
        "active": len(active),
        "slots": slots,
        "counts": {
            status: sum(1 for item in items.values() if item.get("status") == status)
            for status in sorted({str(item.get("status")) for item in items.values()})
        },
    }


def heal_run_worktrees(state: dict[str, Any], cwd: str) -> str | None:
    """Re-attach vanished worktrees. Never recreate integration from base."""
    integration = Path(str(state.get("integration_worktree") or ""))
    integration_ok = integration.is_dir() and bool(
        git_value(integration, "rev-parse", "--git-dir")
    )
    if not integration_ok:
        branch = str(state.get("integration_branch") or "")
        if not branch:
            return "run state has no integration branch"
        git(cwd, "worktree", "prune")
        has_branch = git_value(cwd, "rev-parse", "--verify", branch)
        if not has_branch:
            progressed = any(
                str(item.get("status"))
                in {
                    "implemented",
                    "reviewing",
                    "approved",
                    "integrating",
                    "integrated",
                }
                for item in (state.get("items") or {}).values()
            )
            if progressed:
                return (
                    "integration branch is gone and items already progressed; "
                    "refusing to recreate from base"
                )
            proc = git(
                cwd,
                "worktree",
                "add",
                "-b",
                branch,
                str(integration),
                str(state.get("base_sha") or "HEAD"),
            )
        else:
            integration.parent.mkdir(parents=True, exist_ok=True)
            proc = git(cwd, "worktree", "add", str(integration), branch)
        if proc.returncode != 0:
            return (
                proc.stderr or proc.stdout or "could not reattach integration worktree"
            ).strip()
    changed = False
    for item in (state.get("items") or {}).values():
        worktree = item.get("worktree")
        if not (
            isinstance(worktree, str)
            and worktree
            and not Path(worktree).is_dir()
            and item.get("status") in ("implementing", "reviewing")
        ):
            continue
        branch = str(item.get("branch") or "")
        path = Path(worktree)
        if branch and git_value(cwd, "rev-parse", "--verify", branch):
            path.parent.mkdir(parents=True, exist_ok=True)
            git(cwd, "worktree", "prune")
            attached = git(cwd, "worktree", "add", str(path), branch)
            if attached.returncode == 0:
                continue
        item.update(
            {
                "status": "pending",
                "nonce": None,
                "review_nonce": None,
                "worktree": None,
                "branch": None,
                "spawn_claim": None,
            }
        )
        changed = True
    if changed:
        save_state(str(state["run_id"]), state)
    return None


def cmd_items_init(args: Any) -> dict[str, Any]:
    run_id = args.run_id
    manifest = load_json(Path(args.manifest).expanduser())
    normalized, error = validate_manifest(manifest)
    if error:
        return {"ok": False, "run_id": run_id, "error": error}
    max_parallel = safe_int(args.max_parallel)
    if max_parallel < 1 or max_parallel > 16:
        return {
            "ok": False,
            "run_id": run_id,
            "error": "max-parallel must be between 1 and 16",
        }
    meta = load_json(run_dir(run_id) / "meta.json")
    meta_cwd = ""
    if isinstance(meta, dict) and isinstance(meta.get("cwd"), str) and meta["cwd"]:
        meta_cwd = str(Path(meta["cwd"]).expanduser().resolve())
    cwd = meta_cwd or str(Path.cwd().resolve())
    if not clean_repo(cwd):
        return {
            "ok": False,
            "run_id": run_id,
            "error": "consumer checkout must be clean",
        }
    if normalized is None:
        return {"ok": False, "run_id": run_id, "error": "manifest normalization failed"}
    manifest_key = canonical_manifest(normalized, max_parallel)
    with scheduler_lock(run_id):
        existing = load_state(run_id)
        if existing:
            if (
                existing.get("manifest_key") != manifest_key
                or existing.get("cwd") != cwd
            ):
                return {
                    "ok": False,
                    "run_id": run_id,
                    "error": "run already has a different item manifest",
                }
            heal_error = heal_run_worktrees(existing, cwd)
            if heal_error:
                return {"ok": False, "run_id": run_id, "error": heal_error}
            return {**scheduler_snapshot(existing), "created": False}

        base_sha = git_value(cwd, "rev-parse", "HEAD")
        branch_name = git_value(cwd, "symbolic-ref", "--short", "HEAD")
        if not base_sha or not branch_name:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "consumer must be on a git branch",
            }
        root = (item_worktree_root() / run_id).resolve()
        integration = root / "integration"
        root.mkdir(parents=True, exist_ok=True)
        integration_branch = f"auto-plan/{run_id}/integration"
        proc = create_owned_worktree(cwd, integration_branch, integration, base_sha)
        if proc.returncode != 0:
            return {
                "ok": False,
                "run_id": run_id,
                "error": (
                    proc.stderr
                    or proc.stdout
                    or "could not create integration worktree"
                ).strip(),
            }
        items = {
            item["id"]: {
                **item,
                "status": "pending",
                "attempt": 0,
                "review_attempt": 0,
                "review_round": 0,
                "review_signature": None,
                "review_no_progress": 0,
                "nonce": None,
                "worktree": None,
                "branch": None,
                "base_sha": None,
                "head": None,
                "block_reason": None,
            }
            for item in normalized
        }
        state = {
            "version": 1,
            "run_id": run_id,
            "cwd": cwd,
            "consumer_branch": branch_name,
            "base_sha": base_sha,
            "manifest_key": manifest_key,
            "max_parallel": max_parallel,
            "integration_worktree": str(integration),
            "integration_branch": integration_branch,
            "integration_head": base_sha,
            "status": "running",
            "items": items,
        }
        directory = run_dir(run_id) / "items"
        directory.mkdir(parents=True, exist_ok=True)
        atomic_write_text(
            directory / "manifest.json",
            json.dumps({"items": normalized}, indent=2) + "\n",
        )
        save_state(run_id, state)
        return {**scheduler_snapshot(state), "created": True}


def cmd_items_status(args: Any) -> dict[str, Any]:
    with scheduler_lock(args.run_id):
        state = load_state(args.run_id)
        if not state:
            return {
                "ok": False,
                "run_id": args.run_id,
                "error": "item scheduler is not initialized",
            }
        return scheduler_snapshot(state)


def item_matches_path(item: dict[str, Any], changed: str) -> bool:
    path = changed.replace("\\", "/")
    for pattern in item.get("paths") or []:
        normalized = str(pattern).lstrip("./")
        if fnmatch.fnmatchcase(path, normalized):
            return True
        prefix = static_path_prefix(normalized)
        if prefix and (path == prefix or path.startswith(prefix.rstrip("/") + "/")):
            return True
    return False


def claim_ready(
    state: dict[str, Any], item_id: str
) -> tuple[dict[str, Any] | None, str | None]:
    item = (state.get("items") or {}).get(item_id)
    if not isinstance(item, dict):
        return None, f"unknown item {item_id}"
    if item.get("status") != "pending":
        return (
            None,
            f"item {item_id} cannot be claimed from status {item.get('status')}",
        )
    for dependency in item.get("depends") or []:
        if state["items"][dependency].get("status") != "integrated":
            return None, f"item {item_id} dependency {dependency} is not integrated"
    active = sum(
        1 for row in state["items"].values() if row.get("status") in ACTIVE_STATUSES
    )
    if active >= safe_int(state.get("max_parallel"), 1):
        return None, "no scheduler slots available for claim"
    return item, None


def cmd_claim_item(args: Any) -> dict[str, Any]:
    run_id = args.run_id
    item_id = args.item_id
    with scheduler_lock(run_id):
        state = load_state(run_id)
        if not state:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "item scheduler is not initialized",
            }
        if args.role != "implementer":
            return {
                "ok": False,
                "run_id": run_id,
                "error": "reviewers use the implemented item worktree",
            }
        item, error = claim_ready(state, item_id)
        if error:
            return {"ok": False, "run_id": run_id, "item_id": item_id, "error": error}
        if item is None:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "claim state disappeared",
            }
        attempt = safe_int(item.get("attempt")) + 1
        integration = state["integration_worktree"]
        base_sha = git_value(integration, "rev-parse", "HEAD")
        if not base_sha:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "integration worktree has no HEAD",
            }
        branch = f"auto-plan/{run_id}/{item_id}-{attempt}"
        worktree = (
            item_worktree_root() / run_id / "items" / f"{item_id}-{attempt}"
        ).resolve()
        worktree.parent.mkdir(parents=True, exist_ok=True)
        proc = create_owned_worktree(str(state["cwd"]), branch, worktree, base_sha)
        if proc.returncode != 0:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": (
                    proc.stderr or proc.stdout or "could not create item worktree"
                ).strip(),
            }
        nonce = uuid.uuid4().hex
        item.update(
            {
                "status": "implementing",
                "attempt": attempt,
                "nonce": nonce,
                "worktree": str(worktree),
                "branch": branch,
                "base_sha": base_sha,
                "head": base_sha,
            }
        )
        save_state(run_id, state)
        return {
            "ok": True,
            "run_id": run_id,
            "item_id": item_id,
            "role": "implementer",
            "attempt": attempt,
            "nonce": nonce,
            "worktree": str(worktree),
            "branch": branch,
            "base_sha": base_sha,
            "assignment": str(item_dir(run_id, item_id) / "meta.json"),
        }


def changed_paths(worktree: str, base_sha: str) -> list[str]:
    proc = git(worktree, "diff", "--name-only", f"{base_sha}..HEAD", "--")
    if proc.returncode != 0:
        return []
    return [line.strip() for line in (proc.stdout or "").splitlines() if line.strip()]


def pending_changed_paths(worktree: str) -> list[str]:
    paths: set[str] = set()
    for args in (
        ("diff", "--name-only", "--"),
        ("diff", "--cached", "--name-only", "--"),
        ("ls-files", "--others", "--exclude-standard"),
    ):
        proc = git(worktree, *args)
        if proc.returncode == 0:
            paths.update(
                line.strip()
                for line in (proc.stdout or "").splitlines()
                if line.strip()
            )
    return sorted(paths)


def commit_if_dirty(worktree: str, message: str) -> tuple[bool, str | None]:
    status = git(worktree, "status", "--porcelain")
    if status.returncode != 0:
        return False, (status.stderr or status.stdout or "git status failed").strip()
    if not (status.stdout or "").strip():
        return True, None
    added = git(worktree, "add", "-A")
    if added.returncode != 0:
        return False, (added.stderr or added.stdout or "git add failed").strip()
    committed = git(worktree, "commit", "-m", message)
    if committed.returncode != 0:
        return False, (
            committed.stderr or committed.stdout or "git commit failed"
        ).strip()
    return True, None


def cmd_record_item(args: Any) -> dict[str, Any]:
    run_id = args.run_id
    item_id = args.item_id
    with scheduler_lock(run_id):
        state = load_state(run_id)
        if not state:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "item scheduler is not initialized",
            }
        item = state.get("items", {}).get(item_id)
        if not isinstance(item, dict):
            return {"ok": False, "run_id": run_id, "error": f"unknown item {item_id}"}
        if args.nonce != item.get("nonce"):
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "invalid item nonce",
            }
        if item.get("status") != "implementing":
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": f"item status is {item.get('status')}",
            }
        worktree = str(item["worktree"])
        before = git_value(worktree, "rev-parse", "HEAD")
        dirty = not clean_repo(worktree)
        if not dirty and before == item.get("base_sha"):
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "item worktree has no changes",
            }
        pending_outside = [
            path
            for path in pending_changed_paths(worktree)
            if not item_matches_path(item, path)
        ]
        if pending_outside:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": f"changes outside owned paths: {', '.join(pending_outside)}",
            }
        ok, error = commit_if_dirty(worktree, f"feat(auto-plan): implement {item_id}")
        if not ok:
            return {"ok": False, "run_id": run_id, "item_id": item_id, "error": error}
        head = git_value(worktree, "rev-parse", "HEAD")
        if not head or head == item.get("base_sha"):
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "item worktree is unchanged",
            }
        paths = changed_paths(worktree, str(item["base_sha"]))
        outside = [path for path in paths if not item_matches_path(item, path)]
        if outside:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": f"changes outside owned paths: {', '.join(outside)}",
            }
        item.update({"status": "implemented", "head": head})
        save_state(run_id, state)
        return {
            "ok": True,
            "run_id": run_id,
            "item_id": item_id,
            "status": "implemented",
            "head": head,
            "branch": item["branch"],
            "worktree": worktree,
            "marker": f"AUTO_PLAN_ITEM_RECORDED {run_id} {item_id} implemented",
        }


def count_open_findings(text: str) -> int:
    count = 0
    punctuation = ". ,;:!*`'"
    for line in text.splitlines():
        normalized = line.strip().lower().replace("**", "")
        if normalized.startswith("- status:"):
            rest = normalized.split(":", 1)[1]
        elif normalized.startswith("status:"):
            rest = normalized.split(":", 1)[1]
        else:
            continue
        token = (rest.strip().split() or [""])[0].strip(punctuation)
        if token == "open":
            count += 1
    return count


def cmd_item_review_checkpoint(args: Any) -> dict[str, Any]:
    run_id = args.run_id
    item_id = args.item_id
    with scheduler_lock(run_id):
        state = load_state(run_id)
        if not state:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "item scheduler is not initialized",
            }
        item = state.get("items", {}).get(item_id)
        if not isinstance(item, dict):
            return {"ok": False, "run_id": run_id, "error": f"unknown item {item_id}"}
        if getattr(args, "nonce", None) != item.get("review_nonce"):
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "invalid review nonce",
            }
        if item.get("status") not in ("implemented", "reviewing"):
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": f"item status is {item.get('status')}",
            }
        findings = item_dir(run_id, item_id) / "findings.md"
        if not findings.is_file():
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "missing item findings.md",
            }
        text = findings.read_text()
        open_findings = count_open_findings(text)
        worktree = str(item.get("worktree") or "")
        head = git_value(worktree, "rev-parse", "HEAD") or ""
        porcelain = git(worktree, "status", "--porcelain")
        tree_state = (
            (porcelain.stdout or "") if porcelain.returncode == 0 else "unreadable"
        )
        normalized = "\n".join(
            line.strip().lower() for line in text.splitlines() if line.strip()
        )
        signature = hashlib.sha256(
            f"{normalized}\0{head}\0{tree_state}".encode()
        ).hexdigest()
        round_number = safe_int(item.get("review_round")) + 1
        no_progress = (
            safe_int(item.get("review_no_progress")) + 1
            if open_findings and item.get("review_signature") == signature
            else 0
        )
        atomic_write_text(
            item_dir(run_id, item_id) / f"findings-round-{round_number}.md", text
        )
        item.update(
            {
                "status": "reviewing",
                "review_round": round_number,
                "review_signature": signature,
                "review_no_progress": no_progress,
            }
        )
        reason = None
        if open_findings and round_number >= 6:
            reason = "max-review-rounds"
        elif no_progress >= 1:
            reason = "no-progress"
        if reason:
            item.update({"status": "blocked", "block_reason": reason})
        save_state(run_id, state)
        if reason:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": reason,
                "status": "blocked",
                "round": round_number,
                "marker": f"AUTO_PLAN_ITEM_REVIEWED {run_id} {item_id} blocked",
            }
        return {
            "ok": True,
            "run_id": run_id,
            "item_id": item_id,
            "round": round_number,
            "open_findings": open_findings,
            "action": "worker" if open_findings else "verify-clean",
        }


def cmd_record_item_review(args: Any) -> dict[str, Any]:
    run_id = args.run_id
    item_id = args.item_id
    with scheduler_lock(run_id):
        state = load_state(run_id)
        if not state:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "item scheduler is not initialized",
            }
        item = state.get("items", {}).get(item_id)
        if not isinstance(item, dict):
            return {"ok": False, "run_id": run_id, "error": f"unknown item {item_id}"}
        if args.nonce != item.get("review_nonce"):
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "invalid review nonce",
            }
        if item.get("status") not in ("implemented", "reviewing"):
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": f"item status is {item.get('status')}",
            }
        findings = item_dir(run_id, item_id) / "findings.md"
        if args.verdict == "LGTM" and not findings.is_file():
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "cannot approve without findings.md",
            }
        open_findings = (
            count_open_findings(findings.read_text()) if findings.is_file() else 0
        )
        if args.verdict == "LGTM" and open_findings:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": f"cannot approve with {open_findings} open findings",
            }
        if args.verdict == "LGTM" and safe_int(item.get("review_round")) < 1:
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "cannot approve before item-review-checkpoint",
            }
        if args.verdict == "BLOCKED":
            # Preserve the worker's partial fixes on the item branch instead of
            # losing them to the later force-removal of the worktree.
            ok, error = commit_if_dirty(
                str(item["worktree"]),
                f"chore(auto-plan): preserve partial review fixes for {item_id}",
            )
            if not ok:
                return {
                    "ok": False,
                    "run_id": run_id,
                    "item_id": item_id,
                    "error": error,
                }
            item.update(
                {
                    "status": "blocked",
                    "block_reason": args.reason or "reviewer-blocked",
                    "head": git_value(str(item["worktree"]), "rev-parse", "HEAD")
                    or item.get("head"),
                }
            )
        else:
            review_outside = [
                path
                for path in pending_changed_paths(str(item["worktree"]))
                if not item_matches_path(item, path)
            ]
            if review_outside:
                return {
                    "ok": False,
                    "run_id": run_id,
                    "item_id": item_id,
                    "error": f"review changes outside owned paths: {', '.join(review_outside)}",
                }
            ok, error = commit_if_dirty(
                str(item["worktree"]), f"fix(auto-plan): address review for {item_id}"
            )
            if not ok:
                return {
                    "ok": False,
                    "run_id": run_id,
                    "item_id": item_id,
                    "error": error,
                }
            head = git_value(str(item["worktree"]), "rev-parse", "HEAD")
            paths = changed_paths(str(item["worktree"]), str(item["base_sha"]))
            outside = [path for path in paths if not item_matches_path(item, path)]
            if outside:
                return {
                    "ok": False,
                    "run_id": run_id,
                    "item_id": item_id,
                    "error": f"review changes outside owned paths: {', '.join(outside)}",
                }
            item.update({"status": "approved", "head": head})
        save_state(run_id, state)
        return {
            "ok": True,
            "run_id": run_id,
            "item_id": item_id,
            "status": item["status"],
            "branch": item.get("branch"),
            "head": item.get("head"),
            "reason": item.get("block_reason"),
            "marker": f"AUTO_PLAN_ITEM_REVIEWED {run_id} {item_id} {item['status']}",
        }


def cmd_integrate_item(args: Any) -> dict[str, Any]:
    run_id = args.run_id
    item_id = args.item_id
    with scheduler_lock(run_id):
        state = load_state(run_id)
        if not state:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "item scheduler is not initialized",
            }
        item = state.get("items", {}).get(item_id)
        if not isinstance(item, dict):
            return {"ok": False, "run_id": run_id, "error": f"unknown item {item_id}"}
        if item.get("status") not in ("approved", "integrating"):
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": f"item must be approved, not {item.get('status')}",
            }
        integration = str(state["integration_worktree"])
        if not clean_repo(integration):
            git(integration, "merge", "--abort")
            if not clean_repo(integration):
                return {
                    "ok": False,
                    "run_id": run_id,
                    "error": "integration worktree is not clean",
                }
        merge_target = str(item.get("head") or item["branch"])
        proc = git(
            integration,
            "merge",
            "--no-ff",
            merge_target,
            "-m",
            f"feat(auto-plan): integrate {item_id}",
        )
        if proc.returncode != 0:
            git(integration, "merge", "--abort")
            item.update({"status": "blocked", "block_reason": "merge-conflict"})
            save_state(run_id, state)
            return {
                "ok": False,
                "run_id": run_id,
                "item_id": item_id,
                "error": "merge-conflict",
            }
        head = git_value(integration, "rev-parse", "HEAD")
        item.update({"status": "integrated", "integrated_head": head})
        state["integration_head"] = head
        save_state(run_id, state)
        return {
            "ok": True,
            "run_id": run_id,
            "item_id": item_id,
            "status": "integrated",
            "branch": item["branch"],
            "integration_head": head,
        }


def cmd_finalize_items(args: Any) -> dict[str, Any]:
    run_id = args.run_id
    with scheduler_lock(run_id):
        state = load_state(run_id)
        if not state:
            return {
                "ok": False,
                "run_id": run_id,
                "error": "item scheduler is not initialized",
            }
        cwd = str(state["cwd"])
        current = git_value(cwd, "rev-parse", "HEAD")
        target = str(state.get("integration_head") or "")
        if state.get("status") == "finalized" or (
            current and target and current == target and clean_repo(cwd)
        ):
            state["status"] = "finalized"
            state["final_head"] = current
            save_state(run_id, state)
            return {
                "ok": True,
                "run_id": run_id,
                "status": "finalized",
                "head": current,
                "cleanup_errors": state.get("cleanup_errors") or [],
            }
        unfinished = [
            item_id
            for item_id, item in state["items"].items()
            if item.get("status") != "integrated"
        ]
        if unfinished:
            return {
                "ok": False,
                "run_id": run_id,
                "error": f"items not integrated: {', '.join(unfinished)}",
            }
        if not clean_repo(cwd):
            return {
                "ok": False,
                "run_id": run_id,
                "error": "consumer checkout must remain clean",
            }
        branch_now = git_value(cwd, "symbolic-ref", "--short", "HEAD")
        expected_branch = state.get("consumer_branch")
        if expected_branch and branch_now != expected_branch:
            return {
                "ok": False,
                "run_id": run_id,
                "error": (
                    f"consumer is on branch {branch_now!r}, "
                    f"not recorded branch {expected_branch!r}"
                ),
            }
        if current != state.get("base_sha"):
            return {
                "ok": False,
                "run_id": run_id,
                "error": "consumer HEAD moved since items-init",
            }
        target = str(state.get("integration_head") or "")
        proc = git(cwd, "merge", "--ff-only", target)
        if proc.returncode != 0:
            return {
                "ok": False,
                "run_id": run_id,
                "error": (proc.stderr or proc.stdout or "fast-forward failed").strip(),
            }
        state["status"] = "finalized"
        state["final_head"] = git_value(cwd, "rev-parse", "HEAD")
        cleanup_errors: list[str] = []
        for item in state["items"].values():
            worktree = str(item.get("worktree") or "")
            branch = str(item.get("branch") or "")
            if worktree:
                removed = git(cwd, "worktree", "remove", "--force", worktree)
                if removed.returncode != 0:
                    cleanup_errors.append(f"worktree:{item.get('id')}")
            if branch:
                git(cwd, "branch", "-D", branch)
        integration = str(state.get("integration_worktree") or "")
        if integration:
            removed = git(cwd, "worktree", "remove", "--force", integration)
            if removed.returncode != 0:
                cleanup_errors.append("worktree:integration")
        integration_branch = str(state.get("integration_branch") or "")
        if integration_branch:
            git(cwd, "branch", "-D", integration_branch)
        git(cwd, "worktree", "prune")
        state["cleanup_errors"] = cleanup_errors
        save_state(run_id, state)
        return {
            "ok": True,
            "run_id": run_id,
            "status": "finalized",
            "head": state["final_head"],
            "cleanup_errors": cleanup_errors,
        }
