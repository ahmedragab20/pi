import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import {
  type ConfirmMode,
  isLocalUrl,
  needsBrowserConfirmation,
  validateBrowserArgs,
  validateBrowserPath,
} from "./policy.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 48_000;
const MAX_BATCH_STEPS = 20;
const SESSION_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const AGENT_BROWSER_BIN = join(
  import.meta.dirname,
  "node_modules",
  ".bin",
  "agent-browser",
);
const SCREENSHOT_DIR = join(homedir(), ".pi", "agent", "browser-artifacts");
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const agentBrowserActions = [
  "open",
  "read",
  "snapshot",
  "click",
  "dblclick",
  "focus",
  "type",
  "fill",
  "press",
  "hover",
  "select",
  "check",
  "uncheck",
  "scroll",
  "scrollintoview",
  "drag",
  "upload",
  "screenshot",
  "pdf",
  "get",
  "find",
  "wait",
  "back",
  "forward",
  "reload",
  "tabs",
  "close",
  "console",
  "errors",
  "network",
  "diff",
  "set",
] as const;

type Image = { type: "image"; data: string; mimeType: string };

interface Step {
  action: string;
  args: string[];
  interactive: boolean;
  openUrl?: string;
  /** File to chmod after the command, when it was written. */
  outputPath?: string;
  /** Attach outputPath inline: always for screenshots, only on mismatch for diffs. */
  inline?: "always" | "mismatch";
}

/**
 * A screenshot returned as a bare path is invisible to the model, so attach the
 * pixels alongside it. The session normalizes and resizes tool-result images
 * before they enter history (`images.autoResize`, on by default), so the only
 * guard needed here is a cap on what we read and base64 into memory. Any
 * failure degrades to the text path rather than failing the action.
 */
async function inlineScreenshot(path: string): Promise<Image | undefined> {
  const mimeType = IMAGE_MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mimeType) return undefined;
  try {
    const { size } = await stat(path);
    if (size > MAX_INLINE_IMAGE_BYTES) return undefined;
    const data = await readFile(path);
    return { type: "image", data: data.toString("base64"), mimeType };
  } catch {
    return undefined;
  }
}

function boundedTimeout(value?: number): number {
  return Math.min(Math.max(value ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
}

function validateSession(session: string): void {
  if (!SESSION_PATTERN.test(session)) {
    throw new Error(
      "session must contain only letters, numbers, _ or - and be at most 64 characters",
    );
  }
}

function trimOutput(value: string): string {
  if (Buffer.byteLength(value) <= MAX_OUTPUT_BYTES) return value;
  const prefix = new StringDecoder("utf8").write(
    Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES),
  );
  return `${prefix}\n\n[output truncated; narrow the request]`;
}

function preview(step: Step): string {
  const { action, args } = step;
  if (action === "fill" || action === "type")
    return `${action} ${args[0] ?? ""} [text hidden]`;
  if (action === "find") {
    const positional = validateBrowserArgs(action, args).positional;
    const nested = positional[0] === "nth" ? 3 : 2;
    let text = `find ${positional.slice(0, nested + 1).join(" ")}`;
    const name = args.indexOf("--name");
    if (name >= 0) text += ` --name ${args[name + 1]}`;
    return text;
  }
  return `${action} ${args.join(" ")}`.trim();
}

function prepareStep(
  action: string,
  rawArgs: string[],
  session: string,
  cwd: string,
  readOnly: boolean,
): Step {
  if (!(agentBrowserActions as readonly string[]).includes(action))
    throw new Error(`Unsupported browser action: ${action}`);
  const args = [...rawArgs];
  const policy = validateBrowserArgs(action, args);
  if (readOnly && policy.interactive)
    throw new Error(
      "Clicking, typing, and uploads are lead-only; this browser tool is read-only",
    );
  const step: Step = { action, args, interactive: policy.interactive };
  if ((action === "open" || action === "read") && policy.positional[0])
    step.openUrl = policy.positional[0];

  if (action === "screenshot" || action === "pdf") {
    const extension = action === "pdf" ? "pdf" : "png";
    const raw =
      policy.positional[0] ??
      join(SCREENSHOT_DIR, `${session}-${randomUUID()}.${extension}`);
    const outputPath = validateBrowserPath(raw, cwd, SCREENSHOT_DIR, true);
    if (
      !(action === "pdf" ? /\.pdf$/i : /\.(png|jpe?g|webp)$/i).test(outputPath)
    ) {
      throw new Error(
        "Browser output path must have the matching image or PDF extension",
      );
    }
    if (policy.positional[0]) args[args.indexOf(raw)] = outputPath;
    else args.push(outputPath);
    step.outputPath = outputPath;
    if (action === "screenshot") step.inline = "always";
  }
  if (action === "upload") {
    for (let i = 1; i < args.length; i++) {
      args[i] = validateBrowserPath(args[i], cwd, SCREENSHOT_DIR, false);
    }
  }
  if (action === "diff") {
    const baseline = args.indexOf("--baseline");
    if (baseline >= 0)
      args[baseline + 1] = validateBrowserPath(
        args[baseline + 1],
        cwd,
        SCREENSHOT_DIR,
        false,
      );
    if (policy.positional[0] === "screenshot") {
      const output = args.indexOf("-o");
      const outputPath = validateBrowserPath(
        output >= 0
          ? args[output + 1]
          : join(SCREENSHOT_DIR, `${session}-diff-${randomUUID()}.png`),
        cwd,
        SCREENSHOT_DIR,
        true,
      );
      if (!/\.png$/i.test(outputPath))
        throw new Error("diff output path must be a .png file");
      if (output >= 0) args[output + 1] = outputPath;
      else args.push("-o", outputPath);
      step.outputPath = outputPath;
      step.inline = "mismatch";
    }
  }
  return step;
}

/**
 * The browser extension, parameterized so a worker can load a verify-only copy
 * (`browser_verify`, a distinct name so both can coexist in one loader pass):
 * navigation, snapshots, screenshots, and diffs, but no clicks, typing, or
 * uploads, and no confirmation prompts it could never answer.
 */
export function createBrowserExtension(options: { readOnly: boolean }) {
  const { readOnly } = options;
  return function browserExtension(pi: ExtensionAPI) {
    let mode: ConfirmMode = "default";
    const sessionPrefix = randomUUID().slice(0, 8);
    const sessions = new Set<string>();
    const browserEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("AGENT_BROWSER_"),
        ),
      ),
      NO_COLOR: "1",
      // Nonce-marked page content, so injected text cannot pose as tool output.
      AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
    };

    function run(
      browserSession: string,
      commandArgs: string[],
      timeout: number,
      signal?: AbortSignal,
    ) {
      return execFileAsync(
        AGENT_BROWSER_BIN,
        ["--session", browserSession, ...commandArgs],
        {
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          signal,
          env: browserEnv,
          cwd: SCREENSHOT_DIR,
        },
      );
    }

    /** Resolve locality only when a prompt could depend on it. */
    async function isLocalTarget(
      browserSession: string,
      steps: Step[],
      signal?: AbortSignal,
    ): Promise<boolean> {
      if (!steps.every((step) => !step.openUrl || isLocalUrl(step.openUrl)))
        return false;
      if (steps[0].openUrl) return true;
      try {
        const { stdout } = await run(
          browserSession,
          ["get", "url"],
          10_000,
          signal,
        );
        return isLocalUrl(stdout.trim());
      } catch {
        return false;
      }
    }

    async function confirm(
      ctx: ExtensionContext,
      browserSession: string,
      steps: Step[],
      consequential: boolean,
      signal?: AbortSignal,
    ): Promise<void> {
      const interactive = steps.some((step) => step.interactive);
      const upload = steps.some((step) => step.action === "upload");
      if (!interactive && !consequential) return;
      if (mode === "default" && !consequential && !upload) return;
      const local =
        mode === "default" &&
        (await isLocalTarget(browserSession, steps, signal));
      if (
        !needsBrowserConfirmation({
          mode,
          interactive,
          upload,
          consequential,
          local,
        })
      )
        return;
      if (signal?.aborted) throw new Error("Browser action aborted");
      if (!ctx.hasUI)
        throw new Error(
          "This browser action needs interactive user confirmation",
        );
      const shown = interactive
        ? steps.filter((step) => step.interactive)
        : steps;
      const ok = await ctx.ui.confirm(
        "Allow browser action?",
        `${shown.map(preview).join("\n")}\n\nThis can submit, upload, log in, or change external data. Approve?`,
        { signal },
      );
      if (!ok) throw new Error("Browser action blocked by user");
    }

    pi.registerTool({
      name: readOnly ? "browser_verify" : "agent_browser",
      label: readOnly ? "Browser Verify" : "Agent Browser",
      description: readOnly
        ? "Read-only headless browser checks via agent-browser: open, snapshot (-i -c; --delta prints only changes), read, get, wait, scroll, screenshot (inline image; --if-changed skips unchanged), console, errors, network requests, diff snapshot, diff screenshot --baseline <png>, set viewport|device|media. action=batch runs steps in one call and stops at the first failure. Clicking, typing, and uploads are unavailable. Absolute HTTP(S) URLs only; screenshots go to the workspace or browser-artifacts."
        : "Headless browser via agent-browser. Cheapest loop: open, snapshot -i -c, act on @refs, snapshot --delta (prints only what changed). read for text pages; screenshot only when pixels matter (inline image; --if-changed skips unchanged, --annotate labels refs). Verify with console, errors, network requests, diff snapshot, diff screenshot --baseline <png>; set viewport|device|media for responsive checks. action=batch runs steps in one call and stops at the first failure. Clicks and typing run without prompts. Set consequential=true for real side effects (submit, buy, send, log in, delete, publish): the user confirms unless the page is a local dev server. Uploads to non-local pages always confirm. No JavaScript eval, cookies/state, or global CLI flags. Sessions persist for this pi session; close when done.",
      parameters: Type.Object({
        action: Type.Union(
          [...agentBrowserActions, "batch"].map((value) => Type.Literal(value)),
        ),
        args: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Arguments after the action, e.g. ['@e2'] or ['@e3', 'text']",
          }),
        ),
        steps: Type.Optional(
          Type.Array(
            Type.Object({
              action: Type.String(),
              args: Type.Optional(Type.Array(Type.String())),
            }),
            {
              maxItems: MAX_BATCH_STEPS,
              description: "For action=batch: actions run in order",
            },
          ),
        ),
        session: Type.Optional(
          Type.String({
            description: "Isolated browser session name; default: pi",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            minimum: 1000,
            maximum: MAX_TIMEOUT_MS,
            description: "Per action",
          }),
        ),
        ...(readOnly
          ? {}
          : {
              consequential: Type.Optional(
                Type.Boolean({
                  description:
                    "True when this call has a real-world side effect; asks the user unless the page is local",
                }),
              ),
            }),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("Browser action aborted");
        const session = params.session ?? "pi";
        validateSession(session);
        const requested =
          params.action === "batch"
            ? (params.steps ?? [])
            : [{ action: params.action, args: params.args }];
        if (params.action === "batch" && params.args?.length)
          throw new Error("batch takes steps, not args");
        if (!requested.length) throw new Error("batch requires steps");
        if (requested.length > MAX_BATCH_STEPS)
          throw new Error(`batch allows at most ${MAX_BATCH_STEPS} steps`);
        const steps = requested.map((step) =>
          prepareStep(
            step.action,
            step.args ?? [],
            session,
            ctx.cwd,
            readOnly,
          ),
        );

        const browserSession = `${sessionPrefix}-${session}`;
        const consequential =
          !readOnly &&
          (params as { consequential?: boolean }).consequential === true;
        await confirm(ctx, browserSession, steps, consequential, signal);
        if (signal?.aborted) throw new Error("Browser action aborted");
        await mkdir(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
        sessions.add(browserSession);

        const timeout = boundedTimeout(params.timeoutMs);
        const texts: string[] = [];
        const images: Image[] = [];
        const label = (index: number) =>
          steps.length > 1 ? `[${index + 1}] ${preview(steps[index])}\n` : "";
        for (const [index, step] of steps.entries()) {
          try {
            const { stdout, stderr } = await run(
              browserSession,
              [step.action, ...step.args],
              timeout,
              signal,
            );
            const text = [stdout, stderr].filter(Boolean).join("\n").trim();
            if (step.action === "close") sessions.delete(browserSession);
            texts.push(`${label(index)}${text || "OK"}`);
            if (!step.outputPath) continue;
            const written = await chmod(step.outputPath, 0o600).then(
              () => true,
              () => false,
            );
            if (
              written &&
              (step.inline === "always" ||
                (step.inline === "mismatch" && !/Images match/.test(text)))
            ) {
              const image = await inlineScreenshot(step.outputPath);
              if (image) images.push(image);
            }
          } catch (error) {
            const failure = error as Error & {
              stdout?: string;
              stderr?: string;
            };
            throw new Error(
              trimOutput(
                [
                  ...texts,
                  `${label(index)}Browser command failed or was cancelled`,
                  failure.stdout,
                  failure.stderr,
                  steps.length > 1 && index < steps.length - 1
                    ? `Skipped ${steps.length - index - 1} remaining step(s).`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
              ),
            );
          }
        }
        return {
          content: [
            { type: "text", text: trimOutput(texts.join("\n\n")) },
            ...images,
          ],
          details: { backend: "agent-browser", session, readOnly },
        };
      },
    });

    if (!readOnly) {
      pi.registerCommand("browser-confirm", {
        description:
          "Browser prompts: `strict` asks before every click/type; `default` asks only for side effects on non-local pages",
        handler: async (args, ctx) => {
          if (!ctx.hasUI) return;
          const next = args.trim().toLowerCase();
          if (next === "strict" || next === "default") mode = next;
          else if (next)
            return ctx.ui.notify("Use /browser-confirm strict|default", "error");
          ctx.ui.notify(`browser confirmations: ${mode}`, "info");
        },
      });
    }

    pi.on("session_shutdown", async () => {
      await Promise.all(
        [...sessions].map((session) =>
          run(session, ["close"], 5_000).catch(() => undefined),
        ),
      );
      sessions.clear();
    });
  };
}

export default createBrowserExtension({ readOnly: false });
