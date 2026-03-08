import * as Catalog from "@moq/hang/catalog";
import * as Moq from "@moq/lite";

import { AVC_CODEC_STRING } from "./init-segment.js";
import type { RunnerConfig } from "./types.js";

/**
 * Serve catalog.json using @moq/hang catalog spec so clients can discover tracks.
 * Video tracks use H.264 with SPS/PPS inlined before each keyframe (no description in catalog).
 */
export function serveCatalog(
	track: Moq.Track,
	configMap: Map<string, RunnerConfig>,
): void {
	const videoRenditions: Record<
		string,
		{ codec: string; container: { kind: "legacy" }; description?: string }
	> = {};
	const audioRenditions: Record<
		string,
		{ codec: string; container: { kind: "legacy" }; sampleRate: number; numberOfChannels: number }
	> = {};
	const legacyContainer = { kind: "legacy" as const };
	for (const [trackName, config] of configMap.entries()) {
		if (trackName.startsWith("video/")) {
			videoRenditions[trackName] = {
				codec: config.codec ?? AVC_CODEC_STRING,
				...(config.codecDescription && { description: config.codecDescription }),
				container: legacyContainer,
			};
		} else if (trackName.startsWith("audio/")) {
			audioRenditions[trackName] = {
				codec: config.codec ?? "opus",
				container: legacyContainer,
				sampleRate: 48000,
				numberOfChannels: 2,
			};
		}
	}
	const catalog: {
		video?: { renditions: typeof videoRenditions };
		audio?: { renditions: typeof audioRenditions };
	} = {};
	if (Object.keys(videoRenditions).length > 0) {
		catalog.video = { renditions: videoRenditions };
	}
	if (Object.keys(audioRenditions).length > 0) {
		catalog.audio = { renditions: audioRenditions };
	}
	const encoded = Catalog.encode(catalog as Catalog.Root);
	track.writeFrame(encoded);
}
