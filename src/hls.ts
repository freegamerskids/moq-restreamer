import {
	defaultPollMs,
	hlsTargetMs,
	seenUrlLimit,
} from "./config.js";
import { decryptIfNeeded } from "./cenc.js";
import { fetchBytes, fetchText } from "./fetch.js";
import { parseAvcCFromInitSegment } from "./init-segment.js";
import type {
	ParsedM3u8Media,
	RunnerConfig,
	RunnerContext,
	M3u8Master,
} from "./types.js";
import { createBoundedSeen, parseAttributeLine, sanitizePlaylistUri } from "./util.js";

export function isHlsMasterPlaylist(text: string): boolean {
	return text.includes("#EXT-X-STREAM-INF") || text.includes("#EXT-X-MEDIA");
}

export function parseM3u8Media(text: string, baseUrl: URL): ParsedM3u8Media {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	let targetDurationMs = hlsTargetMs;
	let initUrl: string | undefined;
	const segmentUrls: string[] = [];

	for (const line of lines) {
		if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			const value = Number(line.substring(line.indexOf(":") + 1));
			if (Number.isFinite(value)) targetDurationMs = value * 1000;
			continue;
		}
		if (line.startsWith("#EXT-X-MAP:")) {
			const attrs = parseAttributeLine(line.substring(line.indexOf(":") + 1));
			if (attrs.URI) initUrl = sanitizePlaylistUri(attrs.URI);
			continue;
		}
		if (line.startsWith("#")) continue;
		segmentUrls.push(new URL(line, baseUrl).toString());
	}

	return { targetDurationMs, initUrl, segmentUrls };
}

export function parseHlsMaster(text: string, baseUrl: URL): M3u8Master {
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	const videoTracks: Array<{ url: string; pollMs?: number }> = [];
	const audioTracks = new Map<string, { url: string; pollMs?: number }>();

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line?.startsWith("#")) continue;
		if (line.startsWith("#EXT-X-STREAM-INF:")) {
			const attrs = parseAttributeLine(line.substring(line.indexOf(":") + 1));
			let nextUrl = "";
			for (let j = i + 1; j < lines.length; j += 1) {
				const next = lines[j];
				if (!next || next.length === 0) continue;
				if (next.startsWith("#")) continue;
				nextUrl = next;
				i = j;
				break;
			}
			if (nextUrl) {
				videoTracks.push({
					url: new URL(nextUrl, baseUrl).toString(),
				});
			}
			continue;
		}
		if (line.startsWith("#EXT-X-MEDIA:")) {
			const attrs = parseAttributeLine(line.substring(line.indexOf(":") + 1));
			if (attrs.TYPE === "AUDIO" && attrs.URI) {
				audioTracks.set(attrs.GROUP_ID || attrs.NAME || attrs.URI, {
					url: new URL(attrs.URI, baseUrl).toString(),
				});
			}
		}
	}

	return {
		videoTracks,
		audioTracks: [...audioTracks.values()],
	};
}

export async function readPlaylistSegments(
	context: RunnerContext,
	parsed: ParsedM3u8Media,
	state: {
		seen: ReturnType<typeof createBoundedSeen>;
		initEmitted: boolean;
	},
	base: URL,
): Promise<Uint8Array[]> {
	const toBytes = async (url: string) => {
		const fetched = await fetchBytes(url);
		return context.cenc ? await decryptIfNeeded(fetched, context.cenc) : fetched;
	};

	const payloads: Uint8Array[] = [];
	const init = parsed.initUrl && !state.initEmitted ? parsed.initUrl : undefined;
	if (init) {
		const initUrl = new URL(init, base).toString();
		if (!state.seen.has(initUrl)) {
			payloads.push(await toBytes(initUrl));
			state.seen.add(initUrl);
		}
		state.initEmitted = true;
	}

	for (const relative of parsed.segmentUrls) {
		const absolute = new URL(relative, base).toString();
		if (state.seen.has(absolute)) continue;
		state.seen.add(absolute);
		payloads.push(await toBytes(absolute));
	}

	return payloads;
}

export async function buildHlsRunnerConfigs(context: RunnerContext): Promise<RunnerConfig[]> {
	const raw = await fetchText(context.stream.url);
	const playlistUrl = new URL(context.stream.url);
	const configs: RunnerConfig[] = [];
	if (!isHlsMasterPlaylist(raw)) {
		const state = {
			seen: createBoundedSeen(seenUrlLimit),
			initEmitted: false,
		};
		const pollMs = defaultPollMs;
		let codecDescription: string | undefined;
		const parsed = parseM3u8Media(raw, playlistUrl);
		if (parsed.initUrl) {
			const initUrl = new URL(parsed.initUrl, playlistUrl).toString();
			try {
				const bytes = await fetchBytes(initUrl);
				const rawInit = context.cenc ? await decryptIfNeeded(bytes, context.cenc) : bytes;
				codecDescription = parseAvcCFromInitSegment(rawInit);
			} catch {
				// optional
			}
		}
		configs.push({
			streamName: context.stream.name,
			name: "video/0",
			cenc: context.cenc,
			pollMs,
			codecDescription,
			nextSegments: async () => {
				const current = await fetchText(context.stream.url);
				const p = parseM3u8Media(current, playlistUrl);
				return readPlaylistSegments(context, p, state, playlistUrl);
			},
		});
		return configs;
	}

	const master = parseHlsMaster(raw, playlistUrl);
	let videoIndex = 0;
	let audioIndex = 0;

	if (master.videoTracks.length === 0) {
		const state = {
			seen: createBoundedSeen(seenUrlLimit),
			initEmitted: false,
		};
		const pollMs = defaultPollMs;
		let codecDescription: string | undefined;
		try {
			const parsed = parseM3u8Media(raw, playlistUrl);
			if (parsed.initUrl) {
				const initUrl = new URL(parsed.initUrl, playlistUrl).toString();
				const bytes = await fetchBytes(initUrl);
				const rawInit = context.cenc ? await decryptIfNeeded(bytes, context.cenc) : bytes;
				codecDescription = parseAvcCFromInitSegment(rawInit);
			}
		} catch {
			// optional
		}
		configs.push({
			streamName: context.stream.name,
			name: "video/0",
			cenc: context.cenc,
			pollMs,
			codecDescription,
			nextSegments: async () => {
				const current = await fetchText(context.stream.url);
				const p = parseM3u8Media(current, playlistUrl);
				return readPlaylistSegments(context, p, state, playlistUrl);
			},
		});
		videoIndex = 1;
	}

	for (const trackUrl of master.videoTracks) {
		const name = `video/${videoIndex++}`;
		const state = {
			seen: createBoundedSeen(seenUrlLimit),
			initEmitted: false,
		};
		const pollMs = Number(trackUrl.pollMs ?? defaultPollMs);
		let codecDescription: string | undefined;
		try {
			const variantRaw = await fetchText(trackUrl.url);
			const variantParsed = parseM3u8Media(variantRaw, new URL(trackUrl.url));
			if (variantParsed.initUrl) {
				const initUrl = new URL(variantParsed.initUrl, trackUrl.url).toString();
				const bytes = await fetchBytes(initUrl);
				const rawInit = context.cenc ? await decryptIfNeeded(bytes, context.cenc) : bytes;
				codecDescription = parseAvcCFromInitSegment(rawInit);
			}
		} catch {
			// optional
		}
		configs.push({
			streamName: context.stream.name,
			name,
			cenc: context.cenc,
			pollMs,
			codecDescription,
			nextSegments: async () => {
				const parsed = parseM3u8Media(await fetchText(trackUrl.url), new URL(trackUrl.url));
				return readPlaylistSegments(context, parsed, state, new URL(trackUrl.url));
			},
		});
	}

	for (const audioTrack of master.audioTracks) {
		const name = `audio/${audioIndex++}`;
		const state = {
			seen: createBoundedSeen(seenUrlLimit),
			initEmitted: false,
		};
		const pollMs = Number(audioTrack.pollMs ?? defaultPollMs);
		configs.push({
			streamName: context.stream.name,
			name,
			cenc: context.cenc,
			pollMs,
			nextSegments: async () => {
				const parsed = parseM3u8Media(
					await fetchText(audioTrack.url),
					new URL(audioTrack.url),
				);
				return readPlaylistSegments(context, parsed, state, new URL(audioTrack.url));
			},
		});
	}

	return configs;
}
