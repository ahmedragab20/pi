import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

type ChildOptions = {
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	maxOutputBytes?: number;
	killGraceMs?: number;
	onFailure?: (stderr: string) => void;
};

/** Bounded child execution. Rejection is prompt; termination tracks exit, not
 * ChildProcess.killed (which only says a signal was successfully sent). */
export function runChild(
	command: string,
	args: string[],
	options: ChildOptions,
	spawnProcess: typeof spawn = spawn,
): Promise<string> {
	if (options.signal?.aborted) return Promise.reject(new Error("Child aborted"));
	return new Promise((resolve, reject) => {
		const proc = spawnProcess(command, args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		let exited = false;
		let stopping = false;
		let bytes = 0;
		const stdout: string[] = [];
		const stderr: string[] = [];
		const decoder = new StringDecoder("utf8");
		const errorDecoder = new StringDecoder("utf8");
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve((stdout.join("") + decoder.end()).trim());
		};
		const stop = (error: Error) => {
			if (stopping || settled) return;
			stopping = true;
			finish(error);
			if (!exited) {
				proc.kill("SIGTERM");
				escalation = setTimeout(() => {
					if (!exited) proc.kill("SIGKILL");
				}, options.killGraceMs ?? 3_000);
			}
			proc.stdout?.destroy();
			proc.stderr?.destroy();
		};
		const onAbort = () => stop(new Error("Child aborted"));
		const output = (chunk: Buffer, isStdout: boolean) => {
			if (settled) return;
			bytes += chunk.length;
			if (bytes > (options.maxOutputBytes ?? 1024 * 1024)) {
				stop(new Error("Child output exceeded byte limit"));
				return;
			}
			if (isStdout) stdout.push(decoder.write(chunk));
			else stderr.push(errorDecoder.write(chunk));
		};
		proc.stdout?.on("data", (chunk: Buffer) => output(chunk, true));
		proc.stderr?.on("data", (chunk: Buffer) => output(chunk, false));
		proc.on("exit", () => {
			exited = true;
			clearTimeout(escalation);
		});
		proc.on("close", (code) => {
			exited = true;
			clearTimeout(escalation);
			if (code !== 0 && !settled) {
				try {
					options.onFailure?.(stderr.join("") + errorDecoder.end());
				} catch {
					// Classification must not prevent process cleanup or settlement.
				}
			}
			finish(
				code === 0
					? undefined
					: new Error(`Child exited with code ${code ?? "signal"}`),
			);
		});
		proc.on("error", () => {
			exited = true;
			clearTimeout(escalation);
			finish(new Error("Child process could not start"));
		});
		timeout = setTimeout(
			() => stop(new Error(`Child timed out after ${options.timeoutMs}ms`)),
			options.timeoutMs,
		);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}
