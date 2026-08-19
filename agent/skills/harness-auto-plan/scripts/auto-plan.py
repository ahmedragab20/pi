#!/usr/bin/env python3
"""Herdr+pi glue for the opt-in /auto-plan reviewer loop.

Subcommands print JSON. Drive herdr from here — do not copy-paste CLI by hand.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parents[1]
AGENT_HOME = Path(__file__).resolve().parents[3]
SETTINGS_PATH = AGENT_HOME / "settings.json"
MODELS_JSON = AGENT_HOME / "models.json"
MODELS_STORE = AGENT_HOME / "models-store.json"
REVIEWER_SYSTEM = SKILL_DIR / "reviewer-system.md"
SKILL_MD = SKILL_DIR / "SKILL.md"

VERDICT_REGEX = r"AUTO_PLAN_VERDICT (LGTM|BLOCKED)"

IMPLEMENTER_NEXT_HELP = {
    "init": "No run yet. Call init, then continue.",
    "explore-or-plan": "Explore if needed, then draft/submit the plan. Do not implement or spawn a reviewer.",
    "await-plan": "Plan already submitted. Await that plan id. Do not submit a new plan or spawn a reviewer.",
    "implement": "Plan is approved. Implement it now. Do not re-plan. Do not spawn a reviewer until implementation is done and the consumer tree has a reviewable diff.",
    "spawn-reviewer": "Implementation is done and there is a reviewable diff. spawn-reviewer (idempotent), then wait-verdict.",
    "wait-verdict": "Reviewer is in flight. wait-verdict. Do not spawn another reviewer.",
    "report": "Verdict already recorded. Report it. Do not continue the loop.",
}

REVIEWER_NEXT_HELP = {
    "already-done": "Verdict already recorded. Re-print AUTO_PLAN_VERDICT + LGTM./BLOCKED only if it is not on screen.",
    "first-review": "No findings yet. Review the diff against the approved plan and write findings.md.",
    "worker": "Open findings remain. Agent worker to address every Status: open, then re-verify.",
    "re-verify": "No open findings on disk. Re-read the files; then LGTM or write new opens.",
}


def die(message: str, code: int = 1) -> None:
    print(json.dumps({"ok": False, "error": message}, indent=2))
    raise SystemExit(code)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2))


def load_json(path: Path) -> Any:
    if not path.is_file():
        return None
    return json.loads(path.read_text())


def herdr(*args: str, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["herdr", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def herdr_json(*args: str) -> dict[str, Any]:
    proc = herdr(*args)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip() or f"herdr {' '.join(args)} failed"
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
        die("HERDR_ENV is not 1. /auto-plan needs herdr. Use /implement + /review instead.")
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
    path.write_text(json.dumps(meta, indent=2) + "\n")


def write_status(run_id: str, **fields: Any) -> dict[str, Any]:
    path = run_dir(run_id) / "status.json"
    current = load_json(path)
    status = current if isinstance(current, dict) else {}
    status.update(fields)
    path.write_text(json.dumps(status, indent=2) + "\n")
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


def git_reviewable(cwd: str | None, base_sha: str | None) -> dict[str, Any]:
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
    if base_sha:
        out["reviewable"] = bool(out["dirty"] or out["head_moved"] or diff_vs_base)
        out["reason"] = "diff vs base" if out["reviewable"] else "no diff vs base_sha"
    else:
        out["reviewable"] = bool(out["dirty"] or out["ahead"] > 0)
        out["reason"] = (
            "dirty or ahead of upstream" if out["reviewable"] else "clean tree, no base_sha"
        )
    return out


def count_open_findings(text: str) -> int:
    """Count issues whose Status field is currently open."""
    n = 0
    for raw in text.splitlines():
        lower = raw.strip().lower()
        if "status" not in lower:
            continue
        # `- **Status**: open` or `**Status:** open`
        if "**status**:" in lower:
            value = lower.split("**status**:", 1)[-1].strip().lstrip(":").strip()
        elif "status:" in lower:
            value = lower.split("status:", 1)[-1].strip()
        else:
            continue
        token = value.split()[0] if value else ""
        if token == "open":
            n += 1
    return n


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
    pane = (data.get("result") or {}).get("pane") or data.get("pane") or {}
    return {
        "id": pane_id,
        "alive": True,
        "agent": pane.get("agent"),
        "agent_status": pane.get("agent_status"),
        "cwd": pane.get("cwd") or pane.get("foreground_cwd"),
    }


def pane_verdict(pane_id: str | None) -> str | None:
    if not pane_id or os.environ.get("HERDR_ENV") != "1":
        return None
    proc = herdr(
        "pane",
        "read",
        str(pane_id),
        "--source",
        "recent-unwrapped",
        "--lines",
        "80",
    )
    if proc.returncode != 0:
        return None
    return parse_verdict_from_text(proc.stdout or "")


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

    reviewer_pane = meta.get("reviewer_pane")
    reviewer = pane_info(reviewer_pane)
    screen_verdict = pane_verdict(reviewer_pane) if reviewer.get("alive") else None
    stored_verdict = status.get("verdict")
    if stored_verdict not in ("LGTM", "BLOCKED"):
        stored_verdict = None
    verdict = screen_verdict or stored_verdict
    base_sha = meta.get("base_sha") if isinstance(meta.get("base_sha"), str) else None
    git = git_reviewable(str(meta.get("cwd") or ""), base_sha)
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

    if verdict:
        implementer_next = "report"
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

    phase = status.get("phase") or implementer_next
    implementer_help = IMPLEMENTER_NEXT_HELP[implementer_next]
    if implementer_next == "implement" and files["implementer_summary"] and not reviewable:
        implementer_help = (
            "implementer-summary.md exists but the consumer tree has no reviewable diff. "
            "Implement the approved plan first. Do not spawn a reviewer."
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
        "pi_present": bool(pi_present),
        "mtime": run_mtime(directory),
        "meta": {
            "implementer_pane": meta.get("implementer_pane"),
            "reviewer_pane": reviewer_pane,
            "thinking": meta.get("thinking"),
            "provider": meta.get("provider"),
            "model": meta.get("model"),
            "base_sha": base_sha,
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
    found.sort(key=lambda s: float(s.get("mtime") or 0), reverse=True)
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
    provider = provider or settings.get("defaultProvider")
    model = model or settings.get("defaultModel")
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

    if not args.new:
        existing = pick_run(cwd, None, task=task or None)
        if existing and existing.get("implementer_next") != "report":
            run_id = str(existing["run_id"])
            directory = run_dir(run_id)
            if task and not nonempty(directory / "task.md"):
                (directory / "task.md").write_text(task + "\n")
            snap = inspect_run(run_id)
            emit({**snap, "resumed": True, "created": False})
            return

    run_id = uuid.uuid4().hex[:8]
    directory = run_dir(run_id)
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)

    (directory / "task.md").write_text(task + ("\n" if task else ""))
    (directory / "cwd.txt").write_text(cwd + "\n")

    meta = {
        "run_id": run_id,
        "cwd": cwd,
        "implementer_pane": os.environ.get("HERDR_PANE_ID"),
        "reviewer_pane": None,
        "thinking": None,
        "provider": None,
        "model": None,
        "base_sha": git_head_sha(cwd),
    }
    write_meta(run_id, meta)
    write_status(run_id, phase="planning", round=0, verdict=None)
    snap = inspect_run(run_id)
    emit({**snap, "resumed": False, "created": True})


def cmd_thinking(args: argparse.Namespace) -> None:
    emit({"ok": True, **thinking_level(args.provider, args.model)})


def expand_reviewer_system(run_id: str) -> Path:
    directory = run_dir(run_id)
    template = REVIEWER_SYSTEM.read_text()
    body = (
        template.replace("{{RUN_ID}}", run_id)
        .replace("{{RUN_DIR}}", str(directory))
        .replace("{{SKILL_MD}}", str(SKILL_MD))
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
    run_id = args.run_id
    snap = inspect_run(run_id)
    if not snap.get("ok"):
        die(str(snap.get("error") or f"missing run {run_id}"))
    if snap.get("implementer_next") == "report":
        emit({**snap, "spawned": False, "reason": "verdict already recorded"})
        return
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
    existing_pane = args.pane or meta.get("reviewer_pane")
    existing = pane_info(existing_pane)
    resume = bool(snap.get("files", {}).get("findings")) or snap.get("reviewer_next") != "first-review"
    prompt = reviewer_prompt(run_id, resume=resume)
    agent_name = f"review-{run_id}"

    def record_pane(pane_id: str) -> None:
        meta.update(
            {
                "implementer_pane": self_pane,
                "reviewer_pane": pane_id,
                "thinking": thinking,
                "provider": provider,
                "model": model,
            }
        )
        write_meta(run_id, meta)
        write_status(run_id, phase="reviewing")

    if (
        not args.dry_run
        and existing.get("alive")
        and existing.get("agent") == "pi"
        and existing.get("agent_status") == "working"
    ):
        record_pane(str(existing_pane))
        emit(
            {
                "ok": True,
                "run_id": run_id,
                "pane_id": existing_pane,
                "resumed": True,
                "spawned": False,
                "action": "wait-verdict",
                "thinking": thinking,
                **{k: snap[k] for k in ("implementer_next", "reviewer_next") if k in snap},
            }
        )
        return

    if not args.dry_run and existing.get("alive") and existing.get("agent") == "pi":
        # Idle/done/blocked pi: resume prompt, do not split a second reviewer.
        prompt_proc = herdr("agent", "prompt", str(existing_pane), prompt)
        if prompt_proc.returncode != 0:
            die(
                (prompt_proc.stderr or prompt_proc.stdout or "herdr agent prompt failed").strip()
                + f" (pane={existing_pane})"
            )
        record_pane(str(existing_pane))
        emit(
            {
                "ok": True,
                "run_id": run_id,
                "pane_id": existing_pane,
                "resumed": True,
                "spawned": False,
                "action": "wait-verdict",
                "thinking": thinking,
                "prompted": True,
            }
        )
        return

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
        "prompt": ["agent", "prompt", "{pane_id}", prompt],
        "rename": ["pane", "rename", "{pane_id}", f"review:{run_id}"],
    }

    if args.dry_run:
        emit(
            {
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
        )
        return

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

    start_cmd = [a.replace("{pane_id}", pane_id) if a == "{pane_id}" else a for a in start_args]
    start_proc = herdr(*start_cmd)
    if start_proc.returncode != 0:
        meta.update(
            {
                "implementer_pane": self_pane,
                "reviewer_pane": pane_id,
                "thinking": thinking,
                "provider": provider,
                "model": model,
            }
        )
        write_meta(run_id, meta)
        err = (start_proc.stderr or start_proc.stdout or "herdr agent start failed").strip()
        die(f"split ok pane={pane_id}; agent start failed: {err}. Retry: spawn-reviewer --run-id {run_id} --pane {pane_id}")

    try:
        start = json.loads(start_proc.stdout or "{}")
    except json.JSONDecodeError:
        start = {"stdout": start_proc.stdout}

    rename = herdr("pane", "rename", pane_id, f"review:{run_id}")
    prompt_proc = herdr("agent", "prompt", pane_id, prompt)
    if prompt_proc.returncode != 0:
        meta.update(
            {
                "implementer_pane": self_pane,
                "reviewer_pane": pane_id,
                "thinking": thinking,
                "provider": provider,
                "model": model,
            }
        )
        write_meta(run_id, meta)
        die(
            (prompt_proc.stderr or prompt_proc.stdout or "herdr agent prompt failed").strip()
            + f" (pane={pane_id})"
        )

    meta.update(
        {
            "implementer_pane": self_pane,
            "reviewer_pane": pane_id,
            "thinking": thinking,
            "provider": provider,
            "model": model,
        }
    )
    write_meta(run_id, meta)
    write_status(run_id, phase="reviewing", verdict=None)

    emit(
        {
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
            "rename_ok": rename.returncode == 0,
        }
    )


def parse_verdict_from_text(text: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("AUTO_PLAN_VERDICT "):
            token = stripped.split()[1] if len(stripped.split()) > 1 else ""
            if token in ("LGTM", "BLOCKED"):
                return token
    if "AUTO_PLAN_VERDICT LGTM" in text:
        return "LGTM"
    if "AUTO_PLAN_VERDICT BLOCKED" in text:
        return "BLOCKED"
    return None


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
    require_herdr()
    run_id = args.run_id
    snap = inspect_run(run_id)
    if snap.get("verdict") in ("LGTM", "BLOCKED"):
        emit(
            {
                "ok": True,
                "run_id": run_id,
                "pane_id": (snap.get("reviewer") or {}).get("id"),
                "verdict": snap["verdict"],
                "already_done": True,
            }
        )
        return
    meta = read_meta(run_id)
    pane_id = args.pane or meta.get("reviewer_pane")
    if not pane_id:
        die("no reviewer pane on this run — spawn-reviewer first")

    wait_args = [
        "pane",
        "wait-output",
        str(pane_id),
        "--regex",
        VERDICT_REGEX,
        "--source",
        "recent-unwrapped",
    ]
    if args.timeout_ms is not None:
        wait_args.extend(["--timeout", str(args.timeout_ms)])

    proc = herdr(*wait_args)
    if proc.returncode != 0:
        write_status(run_id, phase="timeout", verdict="timeout")
        die(
            (proc.stderr or proc.stdout or "wait-output timed out or failed").strip(),
            code=1,
        )

    read = herdr(
        "pane",
        "read",
        str(pane_id),
        "--source",
        "recent-unwrapped",
        "--lines",
        "80",
    )
    snapshot = read.stdout or ""
    verdict = parse_verdict_from_text(snapshot) or parse_verdict_from_text(proc.stdout or "")
    if verdict is None:
        die("wait matched but could not parse AUTO_PLAN_VERDICT from pane output")

    write_status(run_id, phase="lgtm" if verdict == "LGTM" else "blocked", verdict=verdict)
    emit(
        {
            "ok": True,
            "run_id": run_id,
            "pane_id": pane_id,
            "verdict": verdict,
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Opt-in /auto-plan herdr glue")
    sub = parser.add_subparsers(dest="cmd", required=True)

    init = sub.add_parser("init")
    init.add_argument("--cwd")
    init.add_argument("--task", default="")
    init.add_argument("--task-file")
    init.add_argument("--new", action="store_true", help="Force a new run even if one is in progress for this cwd")
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
    wait.set_defaults(func=cmd_wait_verdict)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
