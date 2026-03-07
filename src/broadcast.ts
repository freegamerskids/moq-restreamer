import { setTimeout as sleep } from "node:timers/promises";

import * as Moq from "@moq/lite";

import { serveCatalog } from "./catalog.js";
import {
	broadcastPath,
	parseCenc,
	relayUrl,
	sanitize,
	streamsFile,
} from "./config.js";
import { buildDashRunnerConfigs } from "./dash.js";
import { fetchText } from "./fetch.js";
import { buildHlsRunnerConfigs } from "./hls.js";
import { CATALOG_TRACK, type Runner, type StreamBroadcast, type StreamEntry } from "./types.js";
import { Encoder } from "./video/encoder.js";
import { framesFromSegments, SegmentQueue } from "./video/transcode.js";

export { streamsFile, relayUrl, broadcastPath };

export async function buildStreamBroadcasts(
	entries: StreamEntry[],
): Promise<StreamBroadcast[]> {
	const result: StreamBroadcast[] = [];
	for (const stream of entries) {
		const cenc = parseCenc(stream.cenc);
		const context = { stream, cenc };

		let configs;
		if (/\.m3u8(\?|$)/i.test(stream.url) || stream.url.toLowerCase().includes("m3u8")) {
			configs = await buildHlsRunnerConfigs(context);
		} else if (/\.mpd(\?|$)/i.test(stream.url) || stream.url.toLowerCase().includes("mpd")) {
			configs = await buildDashRunnerConfigs(context);
		} else {
			const probe = await fetchText(stream.url, { headers: stream.headers });
			if (probe.includes("<MPD")) {
				configs = await buildDashRunnerConfigs(context);
			} else if (probe.includes("#EXTM3U")) {
				configs = await buildHlsRunnerConfigs(context);
			} else {
				throw new Error(
					`Unable to detect playlist type for ${stream.name} (${stream.url})`,
				);
			}
		}
		const configMap = new Map<string, (typeof configs)[0]>();
		for (const config of configs) {
			configMap.set(config.name, config);
		}
		const path = Moq.Path.from(broadcastPath, sanitize(stream.name));
		result.push({ streamName: stream.name, path, configMap });
	}
	return result;
}

export async function runBroadcastLoop(
	broadcast: Moq.Broadcast,
	sb: StreamBroadcast,
): Promise<void> {
	for (;;) {
		const request = await broadcast.requested();
		if (request === undefined) break;
		if (request.track.name === CATALOG_TRACK) {
			serveCatalog(request.track, sb.configMap);
			continue;
		}
		const config = sb.configMap.get(request.track.name);
		if (config) {
			if (config.isMuxedAudioOnly && config.audioTrackRef) {
				config.audioTrackRef.current = request.track;
				continue;
			}
			void runRunner({ ...config, track: request.track });
		} else {
			request.track.close(new Error(`Unknown track: ${request.track.name}`));
		}
	}
}

async function runRunner(runner: Runner): Promise<void> {
	if (runner.kind === "video") {
		await runVideoTranscodeRunner(runner);
		return;
	}
	while (true) {
		try {
			const payloads = await runner.nextSegments();
			for (const payload of payloads) {
				publishToTrack(runner.track, payload);
			}
			await sleep(payloads.length === 0 ? runner.pollMs : 100);
		} catch (error) {
			console.error(`[${runner.streamName}] ${runner.name}:`, error);
			await sleep(Math.max(1000, runner.pollMs * 2));
		}
	}
}

async function runVideoTranscodeRunner(runner: Runner): Promise<void> {
	const queue = new SegmentQueue();
	const useUrls = typeof runner.nextSegmentUrls === "function";

	if (useUrls && runner.nextSegmentUrls) {
		const batch = await runner.nextSegmentUrls();
		if (batch.initUrl) queue.push(batch.initUrl);
		for (const url of batch.segmentUrls) queue.push(url);
	} else {
		const firstBatch = await runner.nextSegments();
		for (const payload of firstBatch) queue.push(payload);
	}

	const encoder = new Encoder({
		outputCodec: "h264",
		codec: runner.codec,
		width: 1920,
		height: 1080,
		framerate: 30,
		keyframeInterval: 1000,
	});
	void encoder.serve(
		runner.track,
		framesFromSegments(queue, runner.cenc, {
			scaleWidth: 1920,
			scaleHeight: 1080,
			audioTrackRef: runner.audioTrackRef ?? undefined,
			fetchOptions: runner.headers ? { headers: runner.headers } : undefined,
		}),
	);
	while (true) {
		try {
			if (useUrls && runner.nextSegmentUrls) {
				const batch = await runner.nextSegmentUrls();
				for (const url of batch.segmentUrls) queue.push(url);
				await sleep(batch.segmentUrls.length === 0 ? runner.pollMs : 100);
			} else {
				const payloads = await runner.nextSegments();
				for (const payload of payloads) queue.push(payload);
				await sleep(payloads.length === 0 ? runner.pollMs : 100);
			}
		} catch (error) {
			console.error(`[${runner.streamName}] ${runner.name}:`, error);
			await sleep(Math.max(1000, runner.pollMs * 2));
		}
	}
}

function publishToTrack(track: Moq.Track, data: Uint8Array): void {
	const group = track.appendGroup();
	group.writeFrame(data);
	group.close();
}
