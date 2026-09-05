import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import {
  isInteractiveAction,
  validateBrowserArgs,
  validateBrowserPath,
  validateUrl,
} from "./policy.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 48_000;
const SESSION_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const AGENT_BROWSER_BIN = join(
  import.meta.dirname,
  "node_modules",
  ".bin",
  "agent-browser",
);
const SCREENSHOT_DIR = join(homedir(), ".pi", "agent", "browser-artifacts");

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
] as const;

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

async function confirmConsequential(
  ctx: ExtensionContext,
  action: string,
  args: string[],
  consequential: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Browser action aborted");
  if (!consequential) return;
  if (!ctx.hasUI)
    throw new Error(
      "Consequential browser actions require interactive user confirmation",
    );
  let preview = args.join(" ");
  if (action === "fill" || action === "type")
    preview = `${args[0] ?? ""} [text hidden]`;
  if (action === "find") {
    const positional = validateBrowserArgs(action, args).positional;
    const index = positional[0] === "nth" ? 3 : 2;
    preview = positional.slice(0, index + 1).join(" ");
    const name = args.indexOf("--name");
    if (name >= 0) preview += ` --name ${args[name + 1]}`;
  }
  const ok = await ctx.ui.confirm(
    "Allow browser action?",
    `${action} ${preview}\n\nThis action can submit, upload, log in, or change external data. Approve this individual action?`,
    { signal },
  );
  if (!ok) throw new Error("Browser action blocked by user");
}

export default function browserExtension(pi: ExtensionAPI) {
  let fallbackBrowser: import("playwright").Browser | undefined;
  let fallbackPage: import("playwright").Page | undefined;
  let fallbackBusy = false;
  const sessionPrefix = randomUUID().slice(0, 8);
  const sessions = new Set<string>();
  const browserEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AGENT_BROWSER_"),
    ),
  );

  async function closeFallback() {
    const browser = fallbackBrowser;
    fallbackBrowser = undefined;
    fallbackPage = undefined;
    await browser?.close().catch(() => undefined);
  }

  async function page() {
    if (!fallbackBrowser) {
      const { chromium } = await import("playwright");
      fallbackBrowser = await chromium.launch({
        headless: true,
      });
    }
    if (!fallbackPage || fallbackPage.isClosed()) {
      const context = await fallbackBrowser.newContext();
      fallbackPage = await context.newPage();
    }
    return fallbackPage;
  }

  pi.registerTool({
    name: "agent_browser",
    label: "Agent Browser",
    description:
      "Primary browser automation tool backed by agent-browser. Prefer snapshot then @ref interactions; use read for text-heavy pages and screenshots only when visual evidence matters. args are a validated subset of CLI arguments; use absolute HTTP(S) URLs. Interactive mutations always require confirmation, including find actions, even if consequential=false. Set consequential=true to request confirmation for any additional action. JavaScript, global CLI overrides, and AI chat are unavailable. Sessions persist across calls within this pi session.",
    parameters: Type.Object({
      action: Type.Union(
        agentBrowserActions.map((value) => Type.Literal(value)),
      ),
      args: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Arguments after the action, e.g. ['@e2'] or ['@e3', 'text']",
        }),
      ),
      session: Type.Optional(
        Type.String({
          description: "Isolated browser session name; default: pi",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ minimum: 1000, maximum: MAX_TIMEOUT_MS }),
      ),
      consequential: Type.Optional(
        Type.Boolean({
          description:
            "Require user confirmation for an externally consequential interaction",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Browser action aborted");
      const session = params.session ?? "pi";
      const args = [...(params.args ?? [])];
      validateSession(session);
      const policy = validateBrowserArgs(params.action, args);
      let outputPath: string | undefined;
      if (params.action === "screenshot" || params.action === "pdf") {
        const extension = params.action === "pdf" ? "pdf" : "png";
        const raw =
          policy.positional[0] ??
          join(SCREENSHOT_DIR, `${session}-${randomUUID()}.${extension}`);
        outputPath = validateBrowserPath(raw, ctx.cwd, SCREENSHOT_DIR, true);
        if (
          !(params.action === "pdf" ? /\.pdf$/i : /\.(png|jpe?g|webp)$/i).test(
            outputPath,
          )
        ) {
          throw new Error(
            "Browser output path must have the matching image or PDF extension",
          );
        }
        if (policy.positional[0]) args[args.indexOf(raw)] = outputPath;
        else args.push(outputPath);
      }
      if (params.action === "upload") {
        for (let i = 1; i < args.length; i++) {
          args[i] = validateBrowserPath(
            args[i],
            ctx.cwd,
            SCREENSHOT_DIR,
            false,
          );
        }
      }
      await confirmConsequential(
        ctx,
        params.action,
        args,
        policy.needsConfirmation || params.consequential === true,
        signal,
      );
      if (signal?.aborted) throw new Error("Browser action aborted");
      await mkdir(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });

      const browserSession = `${sessionPrefix}-${session}`;
      sessions.add(browserSession);
      const commandArgs = ["--session", browserSession, params.action, ...args];

      try {
        const { stdout, stderr } = await execFileAsync(
          AGENT_BROWSER_BIN,
          commandArgs,
          {
            timeout: boundedTimeout(params.timeoutMs),
            maxBuffer: 2 * 1024 * 1024,
            signal,
            env: { ...browserEnv, NO_COLOR: "1" },
            cwd: SCREENSHOT_DIR,
          },
        );
        if (outputPath) await chmod(outputPath, 0o600);
        if (params.action === "close") sessions.delete(browserSession);
        const text = trimOutput(
          [stdout, stderr].filter(Boolean).join("\n").trim() || "OK",
        );
        return {
          content: [{ type: "text", text }],
          details: { backend: "agent-browser", session },
        };
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        const detail = trimOutput(
          [
            "Browser command failed or was cancelled",
            failure.stdout,
            failure.stderr,
          ]
            .filter(Boolean)
            .join("\n"),
        );
        throw new Error(
          `${detail}\n\nUse browser_playwright only if agent-browser itself is unavailable or incompatible with the page.`,
        );
      }
    },
  });

  pi.registerTool({
    name: "browser_playwright",
    label: "Browser (Playwright fallback)",
    description:
      "Fallback browser tool. Use only when the primary browser tool is unavailable or incompatible. Prefer DOM text over screenshots. Interactive mutations always require confirmation; consequential=false cannot bypass it. Use absolute HTTP(S) URLs. Set consequential=true for additional confirmation.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("open"),
        Type.Literal("click"),
        Type.Literal("fill"),
        Type.Literal("type"),
        Type.Literal("press"),
        Type.Literal("text"),
        Type.Literal("snapshot"),
        Type.Literal("screenshot"),
        Type.Literal("close"),
      ]),
      target: Type.Optional(
        Type.String({
          description: "URL for open, or CSS/text selector for element actions",
        }),
      ),
      value: Type.Optional(
        Type.String({ description: "Text or key for fill, type, or press" }),
      ),
      consequential: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Browser action aborted");
      if (fallbackBusy)
        throw new Error(
          "Playwright fallback already has an action in progress",
        );
      if (params.action === "open") validateUrl(params.target ?? "");
      if (params.action === "screenshot" && params.target) {
        params.target = validateBrowserPath(
          params.target,
          ctx.cwd,
          SCREENSHOT_DIR,
          true,
        );
        if (!/\.(png|jpe?g|webp)$/i.test(params.target))
          throw new Error("Screenshot requires an image extension");
      }
      await confirmConsequential(
        ctx,
        params.action,
        [params.target, params.value].filter(Boolean) as string[],
        isInteractiveAction(params.action) || params.consequential === true,
        signal,
      );
      if (signal?.aborted) throw new Error("Browser action aborted");
      if (fallbackBusy)
        throw new Error(
          "Playwright fallback already has an action in progress",
        );
      fallbackBusy = true;
      const onAbort = () => {
        void closeFallback();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (params.action === "close") {
          await closeFallback();
          return {
            content: [
              { type: "text", text: "Closed Playwright fallback browser" },
            ],
            details: { backend: "playwright" },
          };
        }

        const currentPage = await page();
        if (signal?.aborted) throw new Error("Browser action aborted");
        let text: string;
        switch (params.action) {
          case "open":
            if (!params.target) throw new Error("open requires target URL");
            await currentPage.goto(params.target, {
              waitUntil: "domcontentloaded",
              timeout: DEFAULT_TIMEOUT_MS,
            });
            text = `Opened ${currentPage.url()}\n${await currentPage.title()}`;
            break;
          case "click":
            if (!params.target)
              throw new Error("click requires target selector");
            await currentPage.locator(params.target).click();
            text = "Clicked";
            break;
          case "fill":
          case "type":
            if (!params.target || params.value === undefined)
              throw new Error(`${params.action} requires target and value`);
            if (params.action === "fill")
              await currentPage.locator(params.target).fill(params.value);
            else
              await currentPage
                .locator(params.target)
                .pressSequentially(params.value);
            text = params.action === "fill" ? "Filled" : "Typed";
            break;
          case "press":
            if (!params.target || !params.value)
              throw new Error("press requires target and value");
            await currentPage.locator(params.target).press(params.value);
            text = `Pressed ${params.value}`;
            break;
          case "text":
            text = trimOutput(
              await currentPage.locator(params.target ?? "body").innerText(),
            );
            break;
          case "snapshot":
            text = trimOutput(
              await currentPage.locator(params.target ?? "body").ariaSnapshot(),
            );
            break;
          case "screenshot": {
            await mkdir(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
            const path =
              params.target ??
              join(SCREENSHOT_DIR, `playwright-${Date.now()}.png`);
            await currentPage.screenshot({ path, fullPage: true });
            await chmod(path, 0o600);
            text = path;
            break;
          }
          default:
            throw new Error(`Unsupported action: ${params.action}`);
        }
        return {
          content: [{ type: "text", text }],
          details: { backend: "playwright", url: currentPage.url() },
        };
      } catch {
        throw new Error(
          signal?.aborted
            ? "Browser action aborted"
            : "Playwright action failed; check page state and installed browser",
        );
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) await closeFallback();
        fallbackBusy = false;
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await closeFallback();
    await Promise.all(
      [...sessions].map((session) =>
        execFileAsync(AGENT_BROWSER_BIN, ["--session", session, "close"], {
          timeout: 5_000,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: browserEnv,
          cwd: SCREENSHOT_DIR,
        }).catch(() => undefined),
      ),
    );
    sessions.clear();
  });
}
