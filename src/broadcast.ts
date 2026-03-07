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
			const probe = await fetchText(stream.url);
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
			void runRunner({ ...config, track: request.track });
		} else {
			request.track.close(new Error(`Unknown track: ${request.track.name}`));
		}
	}
}

async function runRunner(runner: Runner): Promise<void> {
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

function publishToTrack(track: Moq.Track, data: Uint8Array): void {
	const group = track.appendGroup();
	group.writeFrame(data);
	group.close();
}
