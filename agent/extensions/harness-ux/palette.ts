/**
 * Command palette — fuzzy overlay for jumping to sessions, commands, tasks,
 * models, and messages in the current branch.
 *
 * Typed query filters items with pi-tui's fuzzyFilter; enter selects, esc cancels.
 */
import {
	decodePrintableKey,
	fuzzyFilter,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { bottomBorder, fit, midBorder, topBorder } from "./ui.ts";

export interface PaletteItem {
	value: string;
	label: string;
	description?: string;
	action: () => void | Promise<void>;
}

function printableChar(data: string): string | null {
	const decoded = decodePrintableKey(data);
	if (decoded) return decoded;
	// Plain-terminal fallback: a single non-control character.
	if (data.length > 0 && !data.startsWith("\x1b") && !data.startsWith("\x00")) {
		const cp = data.codePointAt(0)!;
		if (cp >= 0x20 && cp !== 0x7f) return data;
	}
	return null;
}

export class PaletteComponent {
	private query = "";
	private selectList: SelectList;
	private maxVisible = 14;

	constructor(
		private theme: any,
		private allItems: PaletteItem[],
		private onSelect: (item: PaletteItem) => void,
		private onCancel: () => void,
		private requestRender: () => void,
	) {
		this.selectList = this.buildList(this.allItems);
	}

	private buildList(items: PaletteItem[]): SelectList {
		const selectItems: SelectItem[] = items.map((it) => ({
			value: it.value,
			label: it.label,
			description: it.description,
		}));

		const sel = new SelectList(selectItems, this.maxVisible, {
			selectedPrefix: (t) => this.theme.fg("accent", t),
			selectedText: (t) => this.theme.fg("accent", t),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
			noMatch: (t) => this.theme.fg("warning", t),
		});

		sel.onSelect = (item) => {
			const found = this.allItems.find((it) => it.value === item.value);
			if (found) this.onSelect(found);
		};
		sel.onCancel = () => this.onCancel();
		return sel;
	}

	private applyFilter() {
		const filtered = this.query.trim()
			? fuzzyFilter(
					this.allItems,
					this.query,
					(it) => `${it.label} ${it.description ?? ""}`,
				)
			: this.allItems;
		this.selectList = this.buildList(filtered);
		this.requestRender();
	}

	handleInput(data: string) {
		if (matchesKey(data, Key.backspace)) {
			this.query = this.query.slice(0, -1);
			this.applyFilter();
			return;
		}
		const ch = printableChar(data);
		if (ch !== null) {
			this.query += ch;
			this.applyFilter();
			return;
		}
		this.selectList.handleInput(data);
		this.requestRender();
	}

	invalidate() {
		this.selectList.invalidate();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		lines.push(topBorder(theme, width));
		lines.push(
			fit(` ${theme.fg("accent", "> ")}${theme.fg("text", this.query)}`, width),
		);
		lines.push(midBorder(theme, width));

		const innerWidth = Math.max(1, width - 2);
		for (const l of this.selectList.render(innerWidth)) {
			lines.push(fit(` ${l}`, width));
		}

		lines.push(bottomBorder(theme, width));
		return lines;
	}
}
