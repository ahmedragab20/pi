#!/usr/bin/env python3
"""Bounded real-Pi PTY checks, with an empty agent HOME and synthetic data only.

Run from any directory: python3 agent/tests/ui-terminal-smoke.py
Artifacts are kept under agent/tmp/ui-smoke-*; no live session or credentials load.
"""
from pathlib import Path
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "agent/tmp"
BASE.mkdir(parents=True, exist_ok=True)
ARTIFACTS = Path(tempfile.mkdtemp(prefix="ui-smoke-", dir=BASE))
AGENT = ARTIFACTS / "home/.pi/agent"
AGENT.mkdir(parents=True)
(AGENT / "settings.json").write_text(json.dumps({
    "quietStartup": True, "hideThinkingBlock": True, "tuiMode": "fullscreen",
    "piVim": {"clipboardMirror": "never", "exCommand": {"copyInputToClipboard": False}},
}))
CLI = ROOT / "agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
assert CLI.is_file(), f"Installed Pi CLI not found: {CLI}"
master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
env = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "HOME": str(ARTIFACTS / "home"), "TMPDIR": str(ARTIFACTS),
    "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_US.UTF-8",
    "PI_CODING_AGENT_DIR": str(AGENT), "PI_OFFLINE": "1", "PI_TELEMETRY": "0",
    "PI_SKIP_VERSION_CHECK": "1",
}
proc = subprocess.Popen([
    shutil.which("node") or "node", str(CLI), "--offline", "--no-session", "--no-approve",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-tools",
    "--extension", str(ROOT / "agent/tests/fixtures/ui-smoke.ts"),
    "--extension", str(ROOT / "agent/npm/node_modules/pi-vim/index.ts"),
    "--theme", str(ROOT / "agent/themes/rose-pine.json"), "--use-theme", "rose-pine",
], cwd=ARTIFACTS, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
raw = bytearray()
checks = []
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][AB012]")


def wait_for(text, after=0, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        visible = ANSI.sub("", bytes(raw[after:]).decode("utf-8", "replace"))
        if text in visible:
            checks.append(text)
            return
        if proc.poll() is not None:
            raise AssertionError(f"Pi exited ({proc.returncode}) before {text!r}")
        ready, _, _ = select.select([master], [], [], max(0, min(0.25, deadline - time.monotonic())))
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b""
            raw.extend(chunk)
    raise AssertionError(f"Timed out waiting for {text!r}; inspect {ARTIFACTS / 'terminal.ansi'}")


def send(value):
    mark = len(raw)
    os.write(master, value.encode() if isinstance(value, str) else value)
    return mark


def close_panel():
    mark = send(b"\x1b")
    wait_for("UI_SMOKE_DIALOG_CLOSED", mark)


def resize(rows, cols):
    mark = len(raw)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(proc.pid, signal.SIGWINCH)
    return mark


def wait_exit(timeout=10):
    deadline = time.monotonic() + timeout
    while proc.poll() is None and time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                raw.extend(os.read(master, 65536))
            except OSError:
                pass
    return proc.poll() is not None


try:
    wait_for("UI_SMOKE_READY")
    mark = send("/ui-smoke-activity start\r")
    wait_for("⠋ SYNTHETIC_WORK", mark)
    wait_for("⠙ SYNTHETIC_WORK", len(raw))
    mark = send("/ui-smoke-activity stop\r")
    wait_for("UI_SMOKE_ACTIVITY_STOPPED", mark)
    mark = send("/ui preview\r")
    wait_for("Synthetic examples only", mark)
    wait_for("┌─ UI preview", mark)
    wait_for("⠋ Reading file", mark)
    wait_for("⠙ Reading file", len(raw))
    mark = resize(16, 40)
    wait_for("UI preview", mark)
    mark = send(b"\x1b[F")
    wait_for("-file.ts", mark)  # The filename wraps at this deliberately narrow width.
    close_panel()
    resize(24, 80)
    mark = send("/todos\r")
    wait_for("Tasks", mark)
    mark = send(b"\x1b[F")
    wait_for("END-30", mark)
    close_panel()
    mark = send("/ui-smoke-card\r")
    wait_for("SYNTHETIC_CARD_SUMMARY", mark)
    mark = send(b"\x0f")
    wait_for("SYNTHETIC_CARD_DETAILS_VISIBLE", mark)
    send("PRESERVED_DRAFT")
    mark = send(b"\x1b[19~")  # F8 opens a real custom panel over an unfinished draft.
    wait_for("SYNTHETIC_INPUT_DIALOG", mark)
    close_panel()
    mark = send(b"\x1b[20~")  # F9 checks the editor after closing the panel.
    wait_for("EDITOR_DRAFT_OK", mark)
    mark = send(b"\x1b")
    wait_for("VIM_NORMAL", mark)
    mark = send("i")
    wait_for("VIM_INSERT", mark)
    send(b"\x03")  # Clear only the synthetic draft.
    mark = send(b"\x1b[18~")  # F7 pastes synthetic multiline text through the real editor.
    wait_for("[paste #1 +12 lines]", mark)  # Pi's native paste API owns this chip label.
    mark = send("\r")
    wait_for("PASTE_EXPANSION_OK", mark)  # The fixture consumes input; no model can run.
    send(b"\x04")
    assert wait_exit(), "Pi did not exit after the empty-editor exit key"
    assert proc.returncode == 0, f"Pi exited {proc.returncode}"
    print(f"PASS: {len(checks)} PTY conditions (Braille animation, square borders, preview, resize, scroll, expansion, dialogs, draft preservation, Vim, paste chips, exit)")
finally:
    # Save evidence even if graceful shutdown fails. Drain the PTY during exit so
    # Pi cannot block while flushing its final screen/transcript.
    (ARTIFACTS / "terminal.ansi").write_bytes(raw)
    (ARTIFACTS / "checks.json").write_text(json.dumps(checks, indent=2))
    if proc.poll() is None:
        os.write(master, b"\x1b\x03\x03")
        if not wait_exit(3):
            proc.terminate()  # Graceful SIGTERM to this test's own child; never force-kill.
            wait_exit(5)
    os.close(master)
    (ARTIFACTS / "terminal.ansi").write_bytes(raw)
    print(f"Artifacts: {ARTIFACTS.relative_to(ROOT)}")
    if proc.poll() is None:
        raise RuntimeError(f"Sandbox child {proc.pid} has not exited; no force-kill attempted")
