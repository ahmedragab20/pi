#!/usr/bin/env python3
"""Opt-in pi reviewer panes. Stdlib only; never prunes artifacts or force-closes panes."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

AGENT = Path(__file__).resolve().parents[1]
ROOT = AGENT / "tmp" / "review-pane"
MODEL = "openai-codex/gpt-6-astra"


def run_dir(run_id):
    if not re.fullmatch(r"[a-f0-9]{32}", run_id):
        raise ValueError("invalid run ID")
    path = ROOT / run_id
    if path.is_symlink() or path.resolve().parent != ROOT.resolve():
        raise ValueError("unsafe run directory")
    return path


def save(path, value):
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.replace(path)


def parse_json(text):
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError("invalid JSON in review metadata or Herdr response") from None
    if not isinstance(value, dict):
        raise ValueError("review metadata and Herdr responses must be JSON objects")
    return value


def load(run_id):
    return parse_json((run_dir(run_id) / "meta.json").read_text())


def command(argv, cwd=None, allowed_codes=(0,)):
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=75)
    if result.returncode not in allowed_codes:
        # Don't copy arbitrary subprocess output (which could contain secrets).
        raise RuntimeError(f"{argv[0]} {argv[1]} failed (exit {result.returncode})")
    return result.stdout


def herdr(*args):
    payload = parse_json(command(["herdr", *args]))
    return payload.get("result", payload)


def caller():
    pane = os.environ.get("HERDR_PANE_ID")
    if os.environ.get("HERDR_ENV") != "1" or not pane:
        raise RuntimeError("requires a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID)")
    return pane


def authorize(meta, role):
    if caller() != meta[role]:
        raise RuntimeError(f"only the recorded {role} may perform this action")


def scope_args(scope):
    if scope == "":
        return []
    if scope == "--staged":
        return ["--cached"]
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_./~^@{}+-]*", scope):
        raise ValueError("scope must be empty, --staged, or a revision/range (no arbitrary flags)")
    return [scope]


def git(cwd, *args):
    base = ["git", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false",
            "-c", f"core.hooksPath={os.devnull}"]
    if args and args[0] in {"diff", "ls-files"}:
        # Read names only: never expose configured commands or other config values.
        keys = command([*base, "config", "--null", "--name-only", "--get-regexp",
                        r"^filter\..*\.(clean|process|smudge|required)$"], cwd, allowed_codes=(0, 1))
        drivers = sorted({key.rsplit(".", 1)[0] for key in keys.split("\0") if key})
        for driver in drivers:
            # Disabling diff/textconv does not disable worktree conversion filters.
            for operation in ("clean", "process", "smudge"):
                base.extend(["-c", f"{driver}.{operation}="])
            base.extend(["-c", f"{driver}.required=false"])
    return command([*base, *args], cwd)


def safe_path(cwd, path):
    candidate = Path(cwd) / path
    parts = Path(path).parts
    base = candidate.name.lower()
    if candidate.is_dir():
        raise ValueError("patch requests require an exact file path, not a directory")
    if (not path or Path(path).is_absolute() or ".." in parts
            or not candidate.resolve().is_relative_to(Path(cwd).resolve())
            or any(p.lower() in {".git", ".ssh"} for p in parts)
            or base in {"auth.json", "credentials.json", "id_rsa", "id_ed25519", ".netrc", ".npmrc"}
            or base == ".env" or base.startswith(".env.")
            or re.search(r"\.(pem|p12|key|pfx)$", base)):
        raise ValueError("protected or out-of-workspace path")
    return path


def changed_paths(cwd, variants, include_untracked):
    records = []
    for variant in variants:
        output = git(cwd, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "-l0",
                     "--name-status", "-z", *variant, "--")
        fields = output.split("\0")
        if fields[-1] != "":
            raise ValueError("incomplete Git name/status output")
        fields.pop()
        position = 0
        while position < len(fields):
            status = fields[position]
            count = 2 if status.startswith(("R", "C")) else 1
            paths = fields[position + 1:position + 1 + count]
            if not re.fullmatch(r"[ACDMRTUXB][0-9]*", status) or len(paths) != count or not all(paths):
                raise ValueError("invalid Git name/status record")
            records.append(paths)
            position += count + 1
    if include_untracked:
        records.extend([path] for path in git(cwd, "ls-files", "--others", "--exclude-standard", "-z").split("\0") if path)
    names, excluded = set(), set()
    for paths in records:
        names.update(paths)
        try:
            for path in paths:
                safe_path(cwd, path)
        except ValueError:
            # A rename cannot hide a protected origin behind an ordinary destination.
            excluded.update(paths)
    # A denial from any comparison wins over an approval from another one.
    return sorted(names - excluded), len(excluded)


def diff(meta, path=None, offset=0, limit=200):
    if offset < 0 or not 1 <= limit <= 300:
        raise ValueError("offset must be nonnegative; limit must be 1..300")
    scope = scope_args(meta["scope"])
    cwd = meta["cwd"]
    variants = [scope] if scope else [[], ["--cached"]]
    if path is not None:
        safe_path(cwd, path)
    paths, excluded = changed_paths(cwd, variants, include_untracked=not scope)
    if path is None:
        lines = paths
    else:
        if path not in paths:
            raise ValueError("patch requests require an exact approved changed-file path")
        lines = []
        for variant in variants:
            patch = git(cwd, "diff", "--no-ext-diff", "--no-textconv", "--unified=3", *variant, "--", path)
            if patch:
                lines.extend([f"--- {' '.join(variant) or 'unstaged'} ---", *patch.splitlines()])
        if not lines:
            lines = ["No tracked patch. If this is an untracked file, inspect it with read."]
    page, size, cursor, clipped = [], 0, offset, False
    for line in lines[offset:offset + limit]:
        encoded = line.encode("utf-8")
        needed = len(encoded) + (1 if page else 0)
        if size + needed > 24000:
            if not page:
                # An individually oversized line cannot fit: report the coverage gap.
                page.append(encoded[:24000].decode("utf-8", errors="ignore"))
                cursor += 1
                clipped = True
            break
        page.append(line)
        size += needed
        cursor += 1
    return {"text": "\n".join(page), "truncated_bytes": clipped,
            "next_offset": cursor if cursor < len(lines) else None,
            "total_lines": len(lines), "excluded_paths": excluded,
            "scope": meta["scope"] or "working-tree"}


def spawn(args):
    coordinator = caller()
    previous = load(args.prev_run_id) if args.prev_run_id else None
    if previous:
        authorize(previous, "coordinator_pane")
        verdict_path = run_dir(args.prev_run_id) / "verdict.json"
        if not verdict_path.exists() or parse_json(verdict_path.read_text())["verdict"] != "BLOCKED":
            raise ValueError("only a completed BLOCKED review can start another round")
        if args.cwd or args.scope is not None or args.max_rounds is not None:
            raise ValueError("later rounds inherit scope, cwd and cap; omit their flags")
        cwd, scope = previous["cwd"], previous["scope"]
        cap, round_number = previous["max_rounds"], previous["round"] + 1
    else:
        cwd = git(str(Path(args.cwd or os.getcwd()).resolve()), "rev-parse", "--show-toplevel").strip()
        scope, cap, round_number = args.scope or "", args.max_rounds or 8, 1
        if args.max_rounds is not None and args.max_rounds < 1:
            raise ValueError("max rounds must be positive")
    scope_args(scope)
    if round_number > cap:
        raise ValueError("round cap reached; report unresolved findings to the user")
    meta = {"run_id": uuid.uuid4().hex, "cwd": cwd, "scope": scope, "model": MODEL,
            "thinking": "max", "fast": True, "round": round_number, "max_rounds": cap,
            "prev_run_id": args.prev_run_id, "coordinator_pane": coordinator,
            "reviewer_pane": None, "state": "spawning"}
    if not diff(meta)["total_lines"]:
        raise ValueError("no reviewable changes in this scope")
    rd = run_dir(meta["run_id"])
    rd.mkdir(parents=True)
    meta["reviewer_name"] = "review-" + meta["run_id"][:16]
    save(rd / "meta.json", meta)
    try:
        pane = herdr("pane", "split", coordinator, "--direction", args.direction,
                     "--no-focus", "--cwd", cwd)["pane"]["pane_id"]
        meta["reviewer_pane"] = pane
        save(rd / "meta.json", meta)
        flags = ["--model", MODEL, "--thinking", "max", "--no-extensions",
                 "--extension", str(AGENT / "extensions" / "security-gate.ts"),
                 "--extension", str(AGENT / "extensions" / "review-pane" / "tools.ts"),
                 "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files",
                 "--no-approve", "--no-session", "--tools", "read,grep,find,ls,review_diff,review_record",
                 "--review-pane-run", str(rd / "meta.json"),
                 "--append-system-prompt", str(AGENT / "scripts" / "reviewer-system.md")]
        herdr("agent", "start", meta["reviewer_name"], "--kind", "pi", "--pane", pane,
              "--timeout", "60000", "--", *flags)
        # Persist before submission: a very fast reviewer must not be overwritten.
        meta["state"] = "reviewing"
        save(rd / "meta.json", meta)
        herdr("agent", "prompt", pane,
              f"Review run {meta['run_id']}. Use review_diff to discover its scope. Follow the reviewer instructions and record with review_record.")
    except Exception:
        meta = load(meta["run_id"])
        if not (rd / "verdict.json").exists():
            meta["state"] = "failed"
            save(rd / "meta.json", meta)
        raise RuntimeError(f"review startup failed; retained run {meta['run_id']}, pane {meta['reviewer_pane']}. Inspect status; do not blindly retry.") from None
    return {**meta, "next": "End your turn. Do not wait or poll; REVIEW_RECORDED will wake the lead."}


def record(args):
    meta = load(args.run_id)
    authorize(meta, "reviewer_pane")
    if not args.findings.strip():
        raise ValueError("findings must include coverage and evidence")
    rd = run_dir(args.run_id)
    with (rd / ".record.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        verdict_path = rd / "verdict.json"
        if verdict_path.exists():
            return {**parse_json(verdict_path.read_text()), "already_recorded": True}
        # Verdict is authoritative and contains its report, avoiding partial pairs.
        verdict = {"run_id": args.run_id, "verdict": args.verdict, "findings": args.findings}
        save(verdict_path, verdict)
        meta["state"] = "reviewed"
        save(rd / "meta.json", meta)
    try:
        herdr("agent", "prompt", meta["coordinator_pane"],
              f"REVIEW_RECORDED {args.run_id} {args.verdict}. Run: python3 {Path(__file__).resolve()} pickup --run-id {args.run_id}")
        notified = True
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired):
        notified = False
    return {"run_id": args.run_id, "verdict": args.verdict, "notified": notified}


def pickup(args):
    meta = load(args.run_id)
    authorize(meta, "coordinator_pane")
    path = run_dir(args.run_id) / "verdict.json"
    if not path.exists():
        return {**meta, "disposition": "pending"}
    # Keep the pane and all artifacts: no accidental close of a reused/busy pane.
    return {**meta, **parse_json(path.read_text()), "disposition": "done",
            "next": "Adjudicate each finding. Pane retained; close it only after checking ownership and idle state."}


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="action", required=True)
    start = sub.add_parser("spawn")
    start.add_argument("--scope")
    start.add_argument("--cwd")
    start.add_argument("--prev-run-id")
    start.add_argument("--max-rounds", type=int)
    start.add_argument("--direction", choices=["right", "down"], default="right")
    for name in ["record", "pickup", "status", "diff"]:
        p = sub.add_parser(name)
        p.add_argument("--run-id", required=True)
        if name == "record":
            p.add_argument("--verdict", required=True, choices=["LGTM", "BLOCKED"])
            p.add_argument("--findings", required=True)
        if name == "diff":
            p.add_argument("--path")
            p.add_argument("--offset", type=int, default=0)
            p.add_argument("--limit", type=int, default=200)
    sub.add_parser("list")
    return root


def main():
    args = parser().parse_args()
    try:
        if args.action == "spawn":
            result = spawn(args)
        elif args.action == "record":
            result = record(args)
        elif args.action == "pickup":
            result = pickup(args)
        elif args.action == "diff":
            meta = load(args.run_id)
            authorize(meta, "reviewer_pane")
            result = diff(meta, args.path, args.offset, args.limit)
        elif args.action == "status":
            meta = load(args.run_id)
            authorize(meta, "coordinator_pane")
            result = meta
        else:
            coordinator = caller()
            result = []
            if ROOT.exists():
                for path in sorted(ROOT.iterdir()):
                    if path.is_dir() and not path.is_symlink() and (path / "meta.json").is_file():
                        meta = load(path.name)
                        if meta["coordinator_pane"] == coordinator:
                            result.append(meta)
        print(json.dumps(result, indent=2))
    except (ValueError, RuntimeError, OSError, KeyError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"error": str(error)}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
