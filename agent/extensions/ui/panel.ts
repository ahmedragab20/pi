import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { singleLine, SPINNER_INTERVAL_MS, type UiTheme } from "./presentation.ts";

export const PANEL_OVERLAY = {
	overlay: true,
	overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 },
} as const;

export type PanelKeys = Partial<Pick<KeybindingsManager, "getKeys" | "matches">>;
type KeyAction = Parameters<KeybindingsManager["getKeys"]>[0];
export interface PanelHost {
	terminal: { rows: number };
	requestRender(): void;
}

export function keyLabel(keys: PanelKeys, action: KeyAction, fallback: string): string {
	const configured = keys.getKeys?.(action);
	return configured ? configured.join("/") || "unbound" : fallback;
}

export function keyMatches(keys: PanelKeys, data: string, action: KeyAction, fallback: string): boolean {
	return keys.matches ? keys.matches(data, action) : matchesKey(data, fallback as Parameters<typeof matchesKey>[1]);
}

export function panelHeight(rows: number): number {
	return Math.max(1, Math.floor(Math.max(1, rows) * 0.8));
}

export function panelBodyHeight(rows: number): number {
	return Math.max(1, panelHeight(rows) - 3);
}

/** All framing is bounded, even below the normal minimum useful terminal size. */
export function framePanel(
	width: number, rows: number, theme: UiTheme, title: string, body: string[], hint: string,
): string[] {
	const w = Math.max(0, width);
	const height = panelHeight(rows);
	if (w < 4 || height < 4) {
		return [...body.slice(0, Math.max(0, height - 1)), theme.fg("dim", hint)]
			.slice(0, height).map((line) => truncateToWidth(line, w));
	}
	const inner = w - 2;
	const row = (text: string) => theme.fg("borderMuted", "│") +
		truncateToWidth(text, inner, "…", true) + theme.fg("borderMuted", "│");
	const titleText = truncateToWidth(` ${singleLine(title)} `, Math.max(0, inner - 2));
	const titleRule = "─".repeat(Math.max(0, inner - visibleWidth(titleText) - 1));
	return [
		theme.fg("borderMuted", "┌─") + theme.fg("accent", theme.bold(titleText)) + theme.fg("borderMuted", `${titleRule}┐`),
		...body.slice(0, height - 3).map((line) => row(` ${line}`)),
		row(theme.fg("dim", ` ${hint}`)),
		theme.fg("borderMuted", `└${"─".repeat(inner)}┘`),
	].map((line) => truncateToWidth(line, w));
}

/** Read-only details panel: never reads or writes editor text. */
export class ScrollPanel {
	private scroll = 0;
	private page = 1;
	private lineCount = 0;
	private animation: ReturnType<typeof setInterval> | undefined;

	constructor(private options: {
		title: string;
		tui: PanelHost;
		theme: UiTheme;
		keys: PanelKeys;
		body: (width: number, theme: UiTheme) => string[];
		onClose: () => void;
		animate?: boolean;
	}) {
		if (options.animate) {
			this.animation = setInterval(() => options.tui.requestRender(), SPINNER_INTERVAL_MS);
			this.animation.unref?.();
		}
	}

	handleInput(data: string): void {
		const { keys, onClose, tui } = this.options;
		if (matchesKey(data, "escape") || keyMatches(keys, data, "tui.select.cancel", "ctrl+c")) {
			this.dispose();
			onClose();
			return;
		}
		if (keyMatches(keys, data, "tui.select.up", "up")) this.scroll--;
		else if (keyMatches(keys, data, "tui.select.down", "down")) this.scroll++;
		else if (keyMatches(keys, data, "tui.select.pageUp", "pageUp")) this.scroll -= this.page;
		else if (keyMatches(keys, data, "tui.select.pageDown", "pageDown")) this.scroll += this.page;
		else if (matchesKey(data, "home")) this.scroll = 0;
		else if (matchesKey(data, "end")) this.scroll = this.lineCount;
		else return;
		this.scroll = Math.max(0, Math.min(this.scroll, this.lineCount - this.page));
		tui.requestRender();
	}

	render(width: number): string[] {
		const { theme, tui, keys, body, title } = this.options;
		const inner = Math.max(1, width - 3);
		const lines = body(inner, theme).flatMap((line) => wrapTextWithAnsi(line, inner));
		this.lineCount = lines.length;
		this.page = panelBodyHeight(tui.terminal.rows);
		this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.page));
		const visible = lines.slice(this.scroll, this.scroll + this.page);
		const range = lines.length > this.page ? `${this.scroll + 1}–${Math.min(lines.length, this.scroll + this.page)}/${lines.length} · ` : "";
		const cancel = keyLabel(keys, "tui.select.cancel", "esc");
		const close = cancel.includes("escape") || cancel === "esc" ? cancel : `esc/${cancel}`;
		const scrollKeys = `${keyLabel(keys, "tui.select.up", "↑")}/${keyLabel(keys, "tui.select.down", "↓")}`;
		return framePanel(width, tui.terminal.rows, theme, title, visible, `${range}${close} close · ${scrollKeys} scroll`);
	}

	dispose(): void {
		if (this.animation) clearInterval(this.animation);
		this.animation = undefined;
	}

	invalidate(): void {}
}
