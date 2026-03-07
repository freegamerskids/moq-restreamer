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
