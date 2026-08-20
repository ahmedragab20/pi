/**
 * Security Gate Extension
 *
 * Pre-execution safety gate for commands and file writes.
 *  - tool_call (bash): intercepts commands before they run, confirms a denylist of
 *    risky commands, and auto-blocks in non-interactive modes (no UI to prompt).
 *  - tool_call (write/edit): blocks writes to protected paths (secrets, creds).
 *  - user_bash: applies the same command gate to `!` / `!!` shell commands.
 *
 * Placement: ~/.pi/agent/extensions/security-gate.ts (auto-discovered; /reload to hot-reload)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Risky command denylist: pattern + human label for the confirmation prompt.
const RULES: { pattern: RegExp; label: string }[] = [
  { pattern: /\bsudo\b/i, label: "privilege escalation (sudo)" },
  {
    pattern: /\brm\s+(-[^\s]*[rf][^\s]*|--recursive|--force)\b/i,
    label: "rm with -r/-f/--recursive/--force",
  },
  {
    pattern: /\b(?:chmod|chown)\b[^\n]*(?:\b777\b|-R(?:f)?\b)/i,
    label: "chmod/chown with 777 or -R",
  },
  {
    pattern: /\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
    label: "download piped into shell (curl|sh)",
  },
  {
    pattern:
      /\bgit\s+(?:push\b[^\n]*\b(?:--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*[fdx])/i,
    label: "destructive git (push --force / reset --hard / clean -f)",
  },
  {
    pattern:
      /\b(?:mkfs(?:\.\w+)?|fdisk|parted|shutdown|reboot|halt|poweroff)\b/i,
    label: "disk/system-destructive operation",
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\//i,
    label: "dd writing to a device (/dev/...)",
  },
  {
    pattern: /\b(?:pkill|killall)\b|\bkill\s+-9\b/i,
    label: "force-kill processes",
  },
];

// Paths never written/edited without review. Substring match for well-known paths,
// suffix match for credential file extensions.
const PROTECTED_PATHS = [
  ".env",
  ".git/",
  "node_modules/",
  "/etc/passwd",
  "/etc/shadow",
  ".ssh/",
  "id_rsa",
  "id_ed25519",
];
const PROTECTED_EXTS = /\.(pem|p12|key|pfx)$/i;

function commandHits(command: string): string[] {
  const hits: string[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(command)) hits.push(rule.label);
  }
  return hits;
}

function isProtectedPath(path: string): boolean {
  if (PROTECTED_EXTS.test(path)) return true;
  return PROTECTED_PATHS.some((p) => path.includes(p));
}

export default function (pi: ExtensionAPI) {
  // Command + file-write gate for the agent's own tools.
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      const hits = commandHits(command);
      if (hits.length === 0) return undefined;

      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Blocked risky command (no UI to confirm): ${hits.join(", ")}`,
        };
      }

      const ok = await ctx.ui.confirm(
        "Run risky command?",
        `${command}\n\n⚠️  Detected: ${hits.join(", ")}`,
      );
      if (!ok) return { block: true, reason: "Blocked by user" };
      return undefined;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input as { path?: string }).path ?? "";
      if (isProtectedPath(path)) {
        if (ctx.hasUI)
          ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
        return { block: true, reason: `Path "${path}" is protected` };
      }
      return undefined;
    }

    return undefined;
  });

  // Same gate for the user's `!` / `!!` shell commands.
  pi.on("user_bash", async (event, ctx) => {
    const hits = commandHits(event.command);
    if (hits.length === 0) return undefined;

    if (!ctx.hasUI) {
      return {
        result: {
          output: `Blocked risky command (no UI to confirm): ${hits.join(", ")}`,
          exitCode: 126,
          cancelled: true,
          truncated: false,
        },
      };
    }

    const ok = await ctx.ui.confirm(
      "Run risky command?",
      `${event.command}\n\n⚠️  Detected: ${hits.join(", ")}`,
    );
    if (!ok) {
      return {
        result: {
          output: "Blocked by user",
          exitCode: 126,
          cancelled: true,
          truncated: false,
        },
      };
    }
    return undefined;
  });
}
