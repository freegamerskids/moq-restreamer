import type { BoundedSeen, ParsedAttributes } from "./types.js";

export function parseAttributeLine(text: string): ParsedAttributes {
	const attrs: ParsedAttributes = {};
	const regex = /([A-Za-z0-9._:-]+)\s*=\s*(?:"([^"]*)"|([^",\s]+))/g;
	let match = regex.exec(text);
	while (match !== null) {
		attrs[match[1]!] = match[2] ?? match[3] ?? "";
		match = regex.exec(text);
	}
	return attrs;
}

export function sanitizePlaylistUri(uri: string): string {
	return uri.replace(/^\"|\"$/g, "");
}

/** Parse DASH/HLS frame rate string (e.g. "25", "30000/1001") to a number. */
export function parseFrameRate(value: string | undefined): number | undefined {
	if (!value || !value.trim()) return undefined;
	const s = value.trim();
	const frac = s.split("/").map((x) => Number(x.trim()));
	if (frac.length === 2 && Number.isFinite(frac[0]) && Number.isFinite(frac[1]) && frac[1] !== 0) {
		return frac[0]! / frac[1]!;
	}
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

/** Parse resolution string "WIDTHxHEIGHT" to { width, height }. */
export function parseResolution(value: string | undefined): { width: number; height: number } | undefined {
	if (!value || !value.trim()) return undefined;
	const parts = value.trim().split("x").map((x) => Number(x.trim()));
	if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
		return { width: parts[0]!, height: parts[1]! };
	}
	return undefined;
}

export function createBoundedSeen(limit: number): BoundedSeen {
	const maxEntries = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1024;
	const seen = new Set<string>();
	const order: string[] = [];
	const trim = () => {
		while (order.length > maxEntries) {
			const oldest = order.shift();
			if (oldest === undefined) break;
			seen.delete(oldest);
		}
	};

	return {
		has(value: string): boolean {
			return seen.has(value);
		},
		add(value: string): void {
			if (seen.has(value)) return;
			seen.add(value);
			order.push(value);
			trim();
		},
	};
}
