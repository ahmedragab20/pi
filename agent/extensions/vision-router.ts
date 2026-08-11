/**
 * vision-router.ts — port of opencode's `image-router` plugin for pi.
 *
 * Primary leads on this harness (default: deepseek-v4-flash) have NO native
 * vision. When the user pastes an image (Ctrl+V) and the active model cannot
 * see images, this extension:
 *
 *   1. decodes the pasted image(s) to `~/.pi/agent/vision/`
 *   2. auto-runs a vision-capable model in a child pi process
 *      (opencode-go/gpt-5.6-luna, fallback opencode/mimo-v2.5-free)
 *   3. transforms the user input to inject a `[VISION DESCRIPTION]` block and
 *      strips the raw image parts from the lead's message
 *
 * The lead keeps full tool access and can still `task` the `vision` agent
 * (which can `read` the saved image file) if the description is missing or
 * wrong. Vision child processes are lean: no extensions/skills/templates,
 * no tools, no session.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ImageContent } from "@earendil-works/pi-coding-agent";

const VISION_DIR = path.join(os.homedir(), ".pi", "agent", "vision");
const PRIMARY_MODEL = "opencode-go/gpt-5.6-luna";
const FALLBACK_MODEL = "opencode/mimo-v2.5-free";
const VISION_TIMEOUT_MS = 90_000;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function modelSupportsImages(model: { input?: string[] } | undefined): boolean {
  return !!model && Array.isArray(model.input) && model.input.includes("image");
}

function decodeBase64(data: string): Buffer {
  return Buffer.from(data, "base64");
}

async function saveImage(image: ImageContent, index: number): Promise<{ filePath: string; mimeType: string }> {
  const ext = MIME_TO_EXT[image.mimeType] || "bin";
  const filePath = path.join(VISION_DIR, `paste-${Date.now()}-${index}.${ext}`);
  fs.mkdirSync(VISION_DIR, { recursive: true });
  fs.writeFileSync(filePath, decodeBase64(image.data));
  return { filePath, mimeType: image.mimeType };
}

function runChild(
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`vision child timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `exit code ${code}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        proc.kill("SIGKILL");
        reject(new Error("vision aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 3000);
        },
        { once: true },
      );
    }
  });
}

async function describeImages(
  cwd: string,
  files: { filePath: string; mimeType: string }[],
  userText: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; model: string } | null> {
  const markers = files.map((f) => `- ${path.basename(f.filePath)} (${f.mimeType}) at ${f.filePath}`).join("\n");
  const prompt = [
    "Describe the pasted image(s) in structured markdown for the lead agent. The image files are attached to this message — look at them directly.",
    "Only use the read tool if you cannot see an attachment; then read the absolute paths from the markers.",
    "Return only the description. No preamble about being a vision agent.",
    "",
    "Markers:",
    markers,
  ].join("\n");

  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    const args = [
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-tools",
      "--model",
      model,
      ...files.map((f) => `@${f.filePath}`),
      prompt,
    ];
    try {
      const text = await runChild(args, cwd, VISION_TIMEOUT_MS, signal);
      if (text && !/VISION_FALLBACK_NEEDED/i.test(text)) {
        return { text, model };
      }
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      console.error(`[vision-router] ${model} failed: ${summary}`);
    }
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const images = event.images;
    if (!images || images.length === 0) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (modelSupportsImages(ctx.model)) return { action: "continue" };

    const userText = event.text;
    const files = await Promise.all(images.map((img, i) => saveImage(img, i)));

    let result: { text: string; model: string } | null = null;
    let error: string | undefined;
    try {
      result = await describeImages(ctx.cwd, files, userText, ctx.signal);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const markers = files.map((f) => `[IMAGE DETECTED: ${path.basename(f.filePath)} (${f.mimeType}) at ${f.filePath}]`).join(" ");
    const paths = files.map((f) => f.filePath).join(", ");

    let newText: string;
    if (result?.text) {
      newText = [
        `[VISION DESCRIPTION from ${result.model}:\n${result.text}]`,
        "",
        userText,
        "",
        `[SYSTEM: vision-router already ran the vision agent and injected the description above. Prefer it for your answer. You retain full tool access — do not re-run vision unless the description is missing or clearly wrong. Image files are at: ${paths}]`,
      ].join("\n");
    } else {
      newText = [
        `${userText} ${markers}`.trim(),
        "",
        `[SYSTEM: Pasted image(s) were decoded to ${VISION_DIR}. Vision auto-delegation failed: ${error ?? "unknown error"}. Your FIRST tool call MUST be task with agent \`vision\` passing every image path (${paths}). If it returns VISION_FALLBACK_NEEDED, retry once with \`vision-free\`. You retain full tool access.]`,
      ].join("\n");
    }

    return { action: "transform", text: newText, images: [] };
  });
}
