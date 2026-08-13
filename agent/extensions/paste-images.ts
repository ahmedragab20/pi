/**
 * Session-scoped pasted-image registry.
 *
 * Ctrl+V writes a temp file and inserts the path; paste-chips turns that into
 * `[Image #N]`. The registry MUST survive submit — resetting on `input` made
 * `[Image #2]` a dead chip, so vision-router never saw a new file and the lead
 * reused the first image path still sitting in the session.
 *
 * Bytes are copied into ~/.pi/agent/vision at paste time (hash in the filename)
 * so later submits do not depend on /tmp/pi-clipboard-* still existing.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@earendil-works/pi-coding-agent";

export const VISION_DIR = path.join(os.homedir(), ".pi", "agent", "vision");
export const IMAGE_CHIP = /\[Image #(\d+)(?: · [^\]]+)?\]/g;
export const PASTED_MARKER = /\[pasted image #(\d+): ([^\]]+?) → ([^\]]+)\]/g;

const MIME_TO_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

export type SavedPaste = {
	id: number;
	filePath: string;
	mimeType: string;
	hash: string;
	base64: string;
	bytes: number;
	name: string;
};

const byId = new Map<number, SavedPaste>();
let seq = 0;
let fileSeq = 0;

export function resetPasteRegistry(): void {
	byId.clear();
	seq = 0;
	fileSeq = 0;
}

export function nextImageId(): number {
	seq += 1;
	return seq;
}

export function getPaste(id: number): SavedPaste | undefined {
	return byId.get(id);
}

export function registerPaste(paste: SavedPaste): void {
	byId.set(paste.id, paste);
}

export function chipLabel(paste: SavedPaste): string {
	return `[Image #${paste.id} · ${paste.hash.slice(0, 8)}]`;
}

export function pastedMarker(paste: SavedPaste): string {
	return `[pasted image #${paste.id}: ${paste.name} → ${paste.filePath}]`;
}

export function mimeForPath(filePath: string): string {
	return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "image/png";
}

export function sniffMime(buf: Buffer): string | undefined {
	if (
		buf.length >= 8 &&
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47
	) {
		return "image/png";
	}
	if (
		buf.length >= 3 &&
		buf[0] === 0xff &&
		buf[1] === 0xd8 &&
		buf[2] === 0xff
	) {
		return "image/jpeg";
	}
	if (buf.length >= 6) {
		const gif = buf.subarray(0, 6).toString("ascii");
		if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
	}
	if (
		buf.length >= 12 &&
		buf.subarray(0, 4).toString("ascii") === "RIFF" &&
		buf.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

export function extForMime(mimeType: string): string {
	return MIME_TO_EXT[mimeType] || "bin";
}

export function hashBytes(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

export function persistBytes(
	buf: Buffer,
	mimeType: string,
): Omit<SavedPaste, "id"> {
	const mime = sniffMime(buf) || mimeType;
	const hash = hashBytes(buf);
	const ext = extForMime(mime);
	fileSeq += 1;
	const name = `paste-${hash.slice(0, 12)}-${Date.now()}-${fileSeq}.${ext}`;
	const filePath = path.join(VISION_DIR, name);
	fs.mkdirSync(VISION_DIR, { recursive: true });
	fs.writeFileSync(filePath, buf);
	return {
		filePath,
		mimeType: mime,
		hash,
		base64: buf.toString("base64"),
		bytes: buf.length,
		name,
	};
}

export function persistImageFile(
	srcPath: string,
): Omit<SavedPaste, "id"> | null {
	try {
		const resolved = srcPath.startsWith("~/")
			? path.join(os.homedir(), srcPath.slice(2))
			: srcPath;
		if (!fs.existsSync(resolved)) return null;
		const buf = fs.readFileSync(resolved);
		if (buf.length === 0) return null;
		return persistBytes(buf, mimeForPath(resolved));
	} catch {
		return null;
	}
}

export function persistImageContent(
	image: ImageContent,
): Omit<SavedPaste, "id"> {
	const buf = Buffer.from(image.data, "base64");
	return persistBytes(buf, image.mimeType || "image/png");
}

export function toImageContent(
	paste: Pick<SavedPaste, "base64" | "mimeType">,
): ImageContent {
	return { type: "image", data: paste.base64, mimeType: paste.mimeType };
}

export function parsePastedMarkers(text: string): SavedPaste[] {
	const out: SavedPaste[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(new RegExp(PASTED_MARKER.source, "g"))) {
		const filePath = m[3]?.trim();
		if (!filePath || seen.has(filePath)) continue;
		seen.add(filePath);
		const id = Number(m[1]);
		const existing = byId.get(id);
		if (existing && existing.filePath === filePath) {
			out.push(existing);
			continue;
		}
		try {
			if (!fs.existsSync(filePath)) continue;
			const buf = fs.readFileSync(filePath);
			out.push({
				id: Number.isFinite(id) ? id : 0,
				filePath,
				mimeType: mimeForPath(filePath),
				hash: hashBytes(buf),
				base64: buf.toString("base64"),
				bytes: buf.length,
				name: path.basename(filePath),
			});
		} catch {
			/* skip unreadable */
		}
	}
	return out;
}

export function chipIdsIn(text: string): number[] {
	const ids: number[] = [];
	for (const m of text.matchAll(new RegExp(IMAGE_CHIP.source, "g"))) {
		const id = Number(m[1]);
		if (Number.isFinite(id)) ids.push(id);
	}
	return ids;
}

/** Files from this submit only — chips/markers in `text`, never the whole registry. */
export function filesForTurn(
	text: string,
	images?: ImageContent[],
): SavedPaste[] {
	const out: SavedPaste[] = [];
	const seen = new Set<string>();
	const add = (paste: SavedPaste | undefined) => {
		if (!paste?.filePath || seen.has(paste.filePath) || seen.has(paste.hash))
			return;
		seen.add(paste.filePath);
		seen.add(paste.hash);
		out.push(paste);
	};
	for (const id of chipIdsIn(text)) add(getPaste(id));
	for (const paste of parsePastedMarkers(text)) add(paste);
	if (out.length === 0) {
		const IMAGE_PATH =
			/(?:^|\s)((?:\/|~\/)[^\s]+?\.(?:png|jpe?g|gif|webp|bmp))\b/gi;
		for (const match of text.matchAll(IMAGE_PATH)) {
			const persisted = persistImageFile(match[1]);
			if (persisted) add({ id: nextImageId(), ...persisted });
		}
	}
	if (out.length === 0 && images?.length) {
		for (const image of images) add({ id: 0, ...persistImageContent(image) });
	}
	return out;
}

export default function pasteImagesLib() {
	// Shared module discovered as `extensions/*.ts`; not a real extension.
}

export function pruneOldPastes(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
	try {
		if (!fs.existsSync(VISION_DIR)) return;
		const now = Date.now();
		for (const name of fs.readdirSync(VISION_DIR)) {
			if (!name.startsWith("paste-")) continue;
			const filePath = path.join(VISION_DIR, name);
			const st = fs.statSync(filePath);
			if (now - st.mtimeMs > maxAgeMs) fs.unlinkSync(filePath);
		}
	} catch {
		/* ignore */
	}
}
