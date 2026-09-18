import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

// Command text is untrusted terminal content, not ANSI or Markdown. Make control
// characters visible so they cannot hide text or overwrite the approval controls.
function displayCommand(text: string): string {
	return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (char) =>
		char === "\t" ? "    " : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
}

export class CommandConfirm implements Component {
	private offset = 0;
	private pageSize = 1;
	private lines: string[] = [];
	private cachedWidth = 0;
	private approve = false;
	private reviewVisible = false;
	private closed = false;
	private readonly text: string;

	constructor(
		command: string,
		hits: string[],
		private readonly tui: Pick<TUI, "terminal" | "requestRender">,
		private readonly theme: Pick<Theme, "fg" | "bold">,
		private readonly done: (approved: boolean) => void,
	) {
		this.text = `Detected: ${hits.join(", ")}\n\n${displayCommand(command)}`;
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
		this.reviewVisible = width >= 44 && height >= 10;
		if (!this.reviewVisible) {
			this.approve = false;
			return ["Run risky command?", "Enlarge terminal to review.", "Esc / Ctrl+C: cancel"]
				.slice(0, height).map((line) => truncateToWidth(line, width));
		}

		const innerWidth = width - 2;
		if (this.cachedWidth !== innerWidth) {
			this.lines = wrapTextWithAnsi(this.text, innerWidth);
			this.cachedWidth = innerWidth;
		}
		// Reserve the title, borders, position indicator, choices, and hints.
		this.pageSize = height - 8;
		this.offset = Math.max(0, Math.min(this.offset, this.lines.length - this.pageSize));
		const end = Math.min(this.lines.length, this.offset + this.pageSize);
		const row = (text: string) => ` ${truncateToWidth(text, innerWidth)}`;
		const border = this.theme.fg("border", "─".repeat(width));
		const choice = (label: string, selected: boolean) => selected
			? this.theme.fg("accent", this.theme.bold(`[ ${label} ]`)) : `  ${label}  `;
		return [
			border,
			row(this.theme.fg("warning", this.theme.bold("Run risky command?"))),
			...this.lines.slice(this.offset, end).map(row),
			row(this.theme.fg("muted", `Lines ${this.offset + 1}-${end} of ${this.lines.length}`)),
			row(`${choice("No", !this.approve)}   ${choice("Yes", this.approve)}`),
			row(this.theme.fg("muted", "↑↓ scroll · PgUp/PgDn page · Home/End")),
			row(this.theme.fg("muted", "Tab/←→ choose · Enter confirm")),
			row(this.theme.fg("muted", "Esc / Ctrl+C cancel")),
			border,
		];
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.closed = true;
			this.done(false);
			return;
		}
		if (!this.reviewVisible) return;
		if (matchesKey(data, "enter")) {
			this.closed = true;
			this.done(this.approve);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.approve = !this.approve;
		else if (matchesKey(data, "left")) this.approve = false;
		else if (matchesKey(data, "right")) this.approve = true;
		else if (matchesKey(data, "up")) this.offset--;
		else if (matchesKey(data, "down")) this.offset++;
		else if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
		else if (matchesKey(data, "pageDown")) this.offset += this.pageSize;
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = this.lines.length;
		else return;
		this.offset = Math.max(0, Math.min(this.offset, this.lines.length - this.pageSize));
		this.tui.requestRender();
	}
}

export async function confirmRiskyCommand(ctx: ExtensionContext, command: string, hits: string[]): Promise<boolean> {
	if (ctx.mode !== "tui") {
		return ctx.ui.confirm("Run risky command?", `${command}\n\n⚠️  Detected: ${hits.join(", ")}`);
	}
	const approved = await ctx.ui.custom<boolean>(
		(tui, theme, _keybindings, done) => new CommandConfirm(command, hits, tui, theme, done),
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } },
	);
	return approved === true;
}
