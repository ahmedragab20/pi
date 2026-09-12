#!/usr/bin/env bash
set -Eeuo pipefail

readonly RELEASE_SOURCE="git:github.com/ahmedragab20/pi-subagents@fork-v0.19.0-inspector.1"
readonly RELEASE_SHA="0a52869d54f0addab8e37402fcc9c2a7d8a58a05"
readonly OLD_SOURCE="npm:@tintinweb/pi-subagents"
readonly EXPECTED_REMOTE="https://github.com/ahmedragab20/pi-subagents"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
CLONE_DIR="$AGENT_DIR/git/github.com/ahmedragab20/pi-subagents"
SETTINGS_FILE="$AGENT_DIR/settings.json"
THINKING_FILE="$AGENT_DIR/extensions/process/agent-thinking.ts"
WORKER_FILE="$AGENT_DIR/extensions/worker-model.ts"
NPM_MANIFEST="$AGENT_DIR/npm/package.json"
NPM_LOCK="$AGENT_DIR/npm/package-lock.json"
OLD_PACKAGE_DIR="$AGENT_DIR/npm/node_modules/@tintinweb/pi-subagents"
PI_BIN="$(command -v pi || true)"
MODE="${1:-run}"
stage="preflight"
safe_to_start="yes"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

on_error() {
  local code="$1" line="$2"
  printf '\nMigration failed during %s (line %s, exit %s).\n' "$stage" "$line" "$code" >&2
  if [[ "$safe_to_start" == "yes" ]]; then
    printf 'The old registration/imports were not intentionally changed; fix the reported error and rerun.\n' >&2
  else
    printf 'Do not start pi yet: rerun this script after fixing the reported error so it can finish validation.\n' >&2
    printf 'Inspect package registration with: PI_CODING_AGENT_DIR=%q pi list\n' "$AGENT_DIR" >&2
  fi
  exit "$code"
}
trap 'on_error "$?" "$LINENO"' ERR

[[ "$MODE" == "run" || "$MODE" == "--check" ]] || fail "usage: bash ${BASH_SOURCE[0]} [--check]"
[[ -n "$PI_BIN" ]] || fail "pi was not found on PATH"
[[ -f "$SETTINGS_FILE" ]] || fail "missing settings file: $SETTINGS_FILE"
[[ -f "$THINKING_FILE" && -f "$WORKER_FILE" ]] || fail "expected routing extension files are missing"
[[ -f "$NPM_MANIFEST" && -f "$NPM_LOCK" ]] || fail "expected npm manifest/lock are missing"

registration_state() {
  python3 - "$SETTINGS_FILE" "$OLD_SOURCE" "$RELEASE_SOURCE" <<'PY'
import json
import sys

path, old_expected, git_expected = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
packages = data.get("packages", [])
if not isinstance(packages, list):
    raise SystemExit("settings packages must be an array")
sources = []
for entry in packages:
    source = entry if isinstance(entry, str) else entry.get("source") if isinstance(entry, dict) else None
    if not isinstance(source, str):
        raise SystemExit("settings contains a package entry without a string source")
    sources.append(source)
old_related = [s for s in sources if s == old_expected or s.startswith(old_expected + "@")]
git_identity = "git:github.com/ahmedragab20/pi-subagents"
git_related = [s for s in sources if s == git_identity or s.startswith(git_identity + "@")]
if old_related not in ([], [old_expected]):
    raise SystemExit("unexpected or duplicate @tintinweb/pi-subagents source in settings")
if git_related not in ([], [git_expected]):
    raise SystemExit("unexpected or duplicate ahmedragab20/pi-subagents source in settings")
if not old_related and not git_related:
    raise SystemExit("neither the expected old source nor the pinned fork is registered")
print(f"old={len(old_related)} git={len(git_related)}")
PY
}

routing_imports() {
  local action="$1"
  python3 - "$action" "$AGENT_DIR" "$THINKING_FILE" "$WORKER_FILE" <<'PY'
import os
from pathlib import Path
import sys
import tempfile

action, agent_name, thinking_name, worker_name = sys.argv[1:]
agent_dir = Path(agent_name)
specs = {
    Path(thinking_name): [
        ("../../npm/node_modules/@tintinweb/pi-subagents/dist/custom-agents.js", "../../git/github.com/ahmedragab20/pi-subagents/dist/custom-agents.js"),
        ("../../npm/node_modules/@tintinweb/pi-subagents/dist/model-resolver.js", "../../git/github.com/ahmedragab20/pi-subagents/dist/model-resolver.js"),
    ],
    Path(worker_name): [
        ("../npm/node_modules/@tintinweb/pi-subagents/dist/custom-agents.js", "../git/github.com/ahmedragab20/pi-subagents/dist/custom-agents.js"),
    ],
}
ready = 0
migrated = 0
for path, replacements in specs.items():
    text = path.read_text(encoding="utf-8")
    updated = text
    for old, new in replacements:
        old_count = text.count(old)
        new_count = text.count(new)
        if old_count + new_count != 1:
            raise SystemExit(f"unexpected routing import state in {path}: expected exactly one old or new occurrence")
        resolved = (path.parent / new).resolve(strict=False)
        expected = agent_dir / "git/github.com/ahmedragab20/pi-subagents/dist" / Path(new).name
        if resolved != expected:
            raise SystemExit(f"routing import does not resolve to the managed fork: {path}")
        if old_count:
            ready += 1
            updated = updated.replace(old, new)
        else:
            migrated += 1
    if action == "apply" and updated != text:
        mode = path.stat().st_mode & 0o777
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.migration.", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(updated)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, mode)
            os.replace(temporary, path)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
print(f"routing imports: {ready} ready, {migrated} already migrated")
PY
}

verify_clone() {
  [[ -d "$CLONE_DIR/.git" ]] || fail "managed fork clone is missing: $CLONE_DIR"
  [[ "$(git -C "$CLONE_DIR" rev-parse HEAD)" == "$RELEASE_SHA" ]] || fail "managed fork HEAD is not $RELEASE_SHA"
  [[ "$(git -C "$CLONE_DIR" remote get-url origin)" == "$EXPECTED_REMOTE" ]] || fail "managed fork origin is unexpected"
  [[ -z "$(git -C "$CLONE_DIR" status --porcelain)" ]] || fail "managed fork clone is not clean"
  for file in \
    LICENSE \
    src/index.ts \
    dist/custom-agents.js \
    dist/model-resolver.js \
    dist/ui/conversation-model.js \
    dist/ui/conversation-viewer.js; do
    [[ -f "$CLONE_DIR/$file" ]] || fail "managed fork is missing $file"
  done
  grep -F 'pi.registerCommand("agents"' "$CLONE_DIR/src/index.ts" >/dev/null || fail "fork does not register /agents"
}

validate_final_state() {
  [[ "$(registration_state)" == "old=0 git=1" ]] || fail "final package registration is not exactly the pinned fork"
  [[ ! -e "$OLD_PACKAGE_DIR" ]] || fail "old npm package directory still exists"
  python3 - "$NPM_MANIFEST" "$NPM_LOCK" <<'PY'
import json
import sys
manifest_path, lock_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
for section in ("dependencies", "devDependencies", "optionalDependencies"):
    if "@tintinweb/pi-subagents" in manifest.get(section, {}):
        raise SystemExit("old package remains in npm manifest")
with open(lock_path, encoding="utf-8") as handle:
    lock = handle.read()
if "node_modules/@tintinweb/pi-subagents" in lock:
    raise SystemExit("old package remains in npm lockfile")
PY
  local imports
  imports="$(routing_imports check)"
  [[ "$imports" == "routing imports: 0 ready, 3 already migrated" ]] || fail "routing imports are not fully migrated"
  verify_clone
}

state="$(registration_state)"
routing_state="$(routing_imports check)"
printf '%s\n' "$routing_state"
python3 - "$state" "$routing_state" "$NPM_MANIFEST" "$NPM_LOCK" "$OLD_PACKAGE_DIR" <<'PY'
import json
from pathlib import Path
import sys

state, routing_state, manifest_name, lock_name, package_name = sys.argv[1:]
with open(manifest_name, encoding="utf-8") as handle:
    manifest = json.load(handle)
manifest_has_old = any("@tintinweb/pi-subagents" in manifest.get(section, {}) for section in ("dependencies", "devDependencies", "optionalDependencies"))
with open(lock_name, encoding="utf-8") as handle:
    lock_has_old = "node_modules/@tintinweb/pi-subagents" in handle.read()
package_exists = Path(package_name).exists()
npm_state = (manifest_has_old, lock_has_old, package_exists)
old_registered = state.startswith("old=1")
git_registered = state.endswith("git=1")
imports_migrated = routing_state == "routing imports: 0 ready, 3 already migrated"
normal = old_registered and npm_state == (True, True, True)
complete = not old_registered and npm_state == (False, False, False)
recoverable_remove = old_registered and git_registered and imports_migrated and npm_state == (False, False, False)
if not (normal or complete or recoverable_remove):
    raise SystemExit("npm manifest, lock, package directory, and settings registration are inconsistent")
PY
if [[ -d "$CLONE_DIR/.git" ]]; then
  verify_clone
elif [[ "$state" == *"git=1"* ]]; then
  fail "settings registers the fork but its managed clone is missing"
fi

if [[ "$MODE" == "--check" ]]; then
  printf 'Preflight OK: %s; no files or settings changed.\n' "$state"
  exit 0
fi

printf 'This migration must run only after every pi session and subagent using pi-subagents has exited.\n'
printf 'It authorizes pi cleanup/reset only inside the managed fork clone and old npm package.\n'
printf 'Type CLOSED to confirm all affected pi processes are stopped: '
read -r confirmation </dev/tty
[[ "$confirmation" == "CLOSED" ]] || fail "confirmation not received"

stage="install pinned fork"
safe_to_start="no"
PI_CODING_AGENT_DIR="$AGENT_DIR" "$PI_BIN" install "$RELEASE_SOURCE"
verify_clone

stage="repoint routing imports"
safe_to_start="no"
routing_imports apply

stage="smoke-load fork and routing extensions"
PI_CODING_AGENT_DIR="$AGENT_DIR" "$PI_BIN" --no-extensions -e "$CLONE_DIR/src/index.ts" --help >/dev/null
PI_CODING_AGENT_DIR="$AGENT_DIR" "$PI_BIN" --no-extensions -e "$WORKER_FILE" --help >/dev/null

if [[ "$state" == *"old=1"* ]]; then
  stage="remove old npm registration"
  PI_CODING_AGENT_DIR="$AGENT_DIR" "$PI_BIN" remove "$OLD_SOURCE"
fi

stage="final validation"
validate_final_state
safe_to_start="yes"
printf 'Migration complete. Restart pi and open one transcript from /agents; if FleetView is enabled, verify that entry point too.\n'
