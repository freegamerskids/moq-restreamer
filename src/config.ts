import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ClearKey, StreamEntry } from "./types.js";

const env = process.env;

export const relayUrl = new URL(env.MOQ_RELAY_URL ?? "https://cdn.moq.dev/anon");
export const broadcastPath = env.MOQ_BROADCAST_PATH ?? "livetv-restream";
export const streamsFile = path.resolve(env.STREAMS_JSON_PATH ?? "./streams.json");
export const defaultPollMs = Number(env.RESTREAM_POLL_MS ?? 1000);
export const seenUrlLimit = Number.isFinite(Number(env.SEEN_URL_LIMIT ?? 1024))
	? Number(env.SEEN_URL_LIMIT ?? 1024)
	: 1024;

/** Default target duration when playlist has no EXT-X-TARGETDURATION (ms). */
export const hlsTargetMs = Number(env.HLS_TARGET_MS ?? 2000);
/** Max new segments to fetch per poll (1 = push ~1 segment at a time to the relay, not 60s batches). */
export const maxSegmentsPerPoll = Number(env.RESTREAM_MAX_SEGMENTS_PER_POLL ?? 1);

export function sanitize(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9._-]+/gi, "-");
}

export function parseCenc(raw?: string): ClearKey | null {
	if (!raw) return null;
	const [keyIdHex, keyHex] = raw.split(":");
	if (!keyIdHex || !keyHex) return null;
	if (!/^[0-9a-fA-F]{32}$/.test(keyIdHex) || !/^[0-9a-fA-F]{32}$/.test(keyHex)) {
		return null;
	}
	return {
		keyId: hexToBytes(keyIdHex),
		key: hexToBytes(keyHex),
	};
}

export function hexToBytes(hex: string): Uint8Array {
	const normalized = hex.toLowerCase();
	const out = new Uint8Array(normalized.length / 2);
	for (let i = 0; i < out.length; i += 1) {
		out[i] = Number.parseInt(normalized.substring(i * 2, i * 2 + 2), 16);
	}
	return out;
}

export async function loadStreamList(filePath: string): Promise<StreamEntry[]> {
	const text = await readFile(filePath, "utf8");
	const streams = JSON.parse(text) as StreamEntry[];
	if (!Array.isArray(streams)) {
		throw new Error(`Expected JSON array in ${filePath}`);
	}
	return streams;
}
