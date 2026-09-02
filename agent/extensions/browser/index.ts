import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
const PLAYWRIGHT_CHROME = join(
  homedir(),
  "Library",
  "Caches",
  "ms-playwright",
  "chromium-1234",
  "chrome-mac-arm64",
  "Google Chrome for Testing.app",
  "Contents",
  "MacOS",
  "Google Chrome for Testing",
);

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

const mutatingActions = new Set([
  "click",
  "dblclick",
  "type",
  "fill",
  "press",
  "select",
  "check",
  "uncheck",
  "drag",
  "upload",
]);

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
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n\n[output truncated; narrow the request]`;
}

async function confirmConsequential(
  ctx: ExtensionContext,
  action: string,
  args: string[],
  consequential: boolean,
): Promise<void> {
  if (!consequential) return;
  if (!mutatingActions.has(action)) {
    throw new Error(
      `consequential=true is only valid for an interactive action, not ${action}`,
    );
  }
  if (!ctx.hasUI)
    throw new Error(
      "Consequential browser actions require interactive user confirmation",
    );
  const ok = await ctx.ui.confirm(
    "Allow browser action?",
    `${action} ${args.join(" ")}\n\nThis was marked consequential (submit, purchase, message, upload, login, or data change).`,
  );
  if (!ok) throw new Error("Browser action blocked by user");
}

export default function browserExtension(pi: ExtensionAPI) {
  let fallbackBrowser: import("playwright").Browser | undefined;
  let fallbackPage: import("playwright").Page | undefined;

  async function page() {
    if (!fallbackBrowser) {
      const { chromium } = await import("playwright");
      fallbackBrowser = await chromium.launch({
        headless: true,
        executablePath: PLAYWRIGHT_CHROME,
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
      "Primary browser automation tool backed by agent-browser. Prefer snapshot then @ref interactions; use read for text-heavy pages and screenshots only when visual evidence matters. args are the CLI arguments after the action. Mark consequential=true before any submit, purchase, message, upload, login, or external data change so the user must confirm. JavaScript eval and AI chat are intentionally unavailable. Sessions persist across calls.",
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
      const session = params.session ?? "pi";
      const args = params.args ?? [];
      validateSession(session);
      await confirmConsequential(
        ctx,
        params.action,
        args,
        params.consequential ?? false,
      );
      await mkdir(SCREENSHOT_DIR, { recursive: true });

      const commandArgs = ["--session", session, params.action, ...args];
      if (params.action === "screenshot" && args.length === 0) {
        commandArgs.push(join(SCREENSHOT_DIR, `${session}-${Date.now()}.png`));
      }

      try {
        const { stdout, stderr } = await execFileAsync(
          AGENT_BROWSER_BIN,
          commandArgs,
          {
            timeout: boundedTimeout(params.timeoutMs),
            maxBuffer: 2 * 1024 * 1024,
            signal,
            env: { ...process.env, NO_COLOR: "1" },
          },
        );
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
          [failure.message, failure.stdout, failure.stderr]
            .filter(Boolean)
            .join("\n"),
        );
        return {
          content: [
            {
              type: "text",
              text: `${detail}\n\nUse browser_playwright only if agent-browser itself is unavailable or incompatible with the page.`,
            },
          ],
          details: { backend: "agent-browser", session },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "browser_playwright",
    label: "Browser (Playwright fallback)",
    description:
      "Fallback browser tool. Use only when the primary browser tool is unavailable or incompatible. Prefer DOM text over screenshots. Mark consequential=true before submit, purchase, message, upload, login, or external data change.",
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await confirmConsequential(
        ctx,
        params.action,
        [params.target, params.value].filter(Boolean) as string[],
        params.consequential ?? false,
      );
      try {
        if (params.action === "close") {
          await fallbackBrowser?.close();
          fallbackBrowser = undefined;
          fallbackPage = undefined;
          return {
            content: [
              { type: "text", text: "Closed Playwright fallback browser" },
            ],
            details: { backend: "playwright" },
          };
        }

        const currentPage = await page();
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
            await mkdir(SCREENSHOT_DIR, { recursive: true });
            const path =
              params.target ??
              join(SCREENSHOT_DIR, `playwright-${Date.now()}.png`);
            await currentPage.screenshot({ path, fullPage: true });
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
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          details: { backend: "playwright" },
          isError: true,
        };
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await fallbackBrowser?.close().catch(() => undefined);
  });
}
