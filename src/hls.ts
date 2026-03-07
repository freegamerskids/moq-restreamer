import {
	defaultPollMs,
	hlsTargetMs,
	maxSegmentsPerPoll,
	seenUrlLimit,
} from "./config.js";
import { decryptIfNeeded } from "./cenc.js";
import { fetchBytes, fetchText } from "./fetch.js";
import { AVC_CODEC_STRING, getDefaultAvcCDescription } from "./init-segment.js";
import type {
	MuxedAudioTrackRef,
	ParsedM3u8Media,
	RunnerConfig,
	RunnerContext,
	SegmentUrlBatch,
	M3u8Master,
	StreamKind,
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
	kind: StreamKind,
): Promise<Uint8Array[]> {
	const fetchOpts = { headers: context.stream.headers };
	const toBytes = async (url: string) => {
		const fetched = await fetchBytes(url, fetchOpts);
		if (kind === "video") return fetched;
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

	let added = 0;
	for (const relative of parsed.segmentUrls) {
		if (added >= maxSegmentsPerPoll) break;
		const absolute = new URL(relative, base).toString();
		if (state.seen.has(absolute)) continue;
		state.seen.add(absolute);
		payloads.push(await toBytes(absolute));
		added += 1;
	}

	return payloads;
}

/** Returns segment URLs only (no fetch); for video transcode so demuxer can open URLs. */
export async function readPlaylistSegmentUrls(
	parsed: ParsedM3u8Media,
	state: { seen: ReturnType<typeof createBoundedSeen>; initEmitted: boolean },
	base: URL,
): Promise<SegmentUrlBatch> {
	const segmentUrls: string[] = [];
	let initUrl: string | undefined;
	if (parsed.initUrl && !state.initEmitted) {
		initUrl = new URL(parsed.initUrl, base).toString();
		if (!state.seen.has(initUrl)) state.seen.add(initUrl);
		state.initEmitted = true;
	}
	let added = 0;
	for (const relative of parsed.segmentUrls) {
		if (added >= maxSegmentsPerPoll) break;
		const absolute = new URL(relative, base).toString();
		if (state.seen.has(absolute)) continue;
		state.seen.add(absolute);
		segmentUrls.push(absolute);
		added += 1;
	}
	return { initUrl, segmentUrls };
}

export async function buildHlsRunnerConfigs(context: RunnerContext): Promise<RunnerConfig[]> {
	const fetchOpts = { headers: context.stream.headers };
	const raw = await fetchText(context.stream.url, fetchOpts);
	const playlistUrl = new URL(context.stream.url);
	const configs: RunnerConfig[] = [];
	if (!isHlsMasterPlaylist(raw)) {
		const state = {
			seen: createBoundedSeen(seenUrlLimit),
			initEmitted: false,
		};
		const pollMs = defaultPollMs;
		const parsed = parseM3u8Media(raw, playlistUrl);
		const audioTrackRef: MuxedAudioTrackRef = { current: null };
		const nextSegments = async () => {
			const current = await fetchText(context.stream.url, fetchOpts);
			const p = parseM3u8Media(current, playlistUrl);
			return readPlaylistSegments(context, p, state, playlistUrl, "video");
		};
		const nextSegmentUrls = async (): Promise<SegmentUrlBatch> => {
			const current = await fetchText(context.stream.url, fetchOpts);
			const p = parseM3u8Media(current, playlistUrl);
			return readPlaylistSegmentUrls(p, state, playlistUrl);
		};
		configs.push({
			streamName: context.stream.name,
			name: "video/0",
			kind: "video",
			cenc: context.cenc,
			pollMs,
			codec: AVC_CODEC_STRING,
			codecDescription: getDefaultAvcCDescription(),
			nextSegments,
			nextSegmentUrls,
			headers: context.stream.headers,
			audioTrackRef,
		});
		configs.push({
			streamName: context.stream.name,
			name: "audio/0",
			kind: "audio",
			cenc: context.cenc,
			pollMs,
			nextSegments,
			codec: "mp4a.40.2",
			isMuxedAudioOnly: true,
			audioTrackRef,
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
		configs.push({
			streamName: context.stream.name,
			name: "video/0",
			kind: "video",
			cenc: context.cenc,
			pollMs,
			codec: AVC_CODEC_STRING,
			codecDescription: getDefaultAvcCDescription(),
			nextSegments: async () => {
				const current = await fetchText(context.stream.url, fetchOpts);
				const p = parseM3u8Media(current, playlistUrl);
				return readPlaylistSegments(context, p, state, playlistUrl, "video");
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
		configs.push({
			streamName: context.stream.name,
			name,
			kind: "video",
			cenc: context.cenc,
			pollMs,
			codec: AVC_CODEC_STRING,
			codecDescription: getDefaultAvcCDescription(),
			nextSegments: async () => {
				const parsed = parseM3u8Media(
					await fetchText(trackUrl.url, fetchOpts),
					new URL(trackUrl.url),
				);
				return readPlaylistSegments(context, parsed, state, new URL(trackUrl.url), "video");
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
			kind: "audio",
			cenc: context.cenc,
			pollMs,
			nextSegments: async () => {
				const parsed = parseM3u8Media(
					await fetchText(audioTrack.url, fetchOpts),
					new URL(audioTrack.url),
				);
				return readPlaylistSegments(context, parsed, state, new URL(audioTrack.url), "audio");
			},
		});
	}

	return configs;
}
