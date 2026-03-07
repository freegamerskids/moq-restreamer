import type * as Moq from "@moq/lite";

/** Catalog track name per @moq/hang / moq publish broadcast convention */
export const CATALOG_TRACK = "catalog.json";

/** Per-stream broadcast: one broadcast per stream, path = broadcastPath/streamName */
export interface StreamBroadcast {
	streamName: string;
	path: Moq.Path.Valid;
	configMap: Map<string, RunnerConfig>;
}

export type StreamKind = "video" | "audio";

export interface StreamEntry {
	name: string;
	url: string;
	cenc?: string;
}

export interface RunnerContext {
	stream: StreamEntry;
	cenc: ClearKey | null;
}

export interface ClearKey {
	keyId: Uint8Array;
	key: Uint8Array;
}

export interface RunnerConfig {
	name: string;
	streamName: string;
	cenc: ClearKey | null;
	pollMs: number;
	nextSegments: () => Promise<Uint8Array[]>;
	/** Hex-encoded avcC (AVC decoder config) for video tracks; required for WebCodecs VideoDecoder */
	codecDescription?: string;
}

export interface Runner extends RunnerConfig {
	track: Moq.Track;
}

export interface CencSubSample {
	clear: number;
	encrypted: number;
}

export interface CencSampleInfo {
	iv: Uint8Array;
	subsamples: CencSubSample[];
}

export interface ParsedAttributes {
	[key: string]: string;
}

export interface BoundedSeen {
	has: (value: string) => boolean;
	add: (value: string) => void;
}

export interface M3u8Master {
	videoTracks: Array<{ url: string; pollMs?: number }>;
	audioTracks: Array<{ url: string; pollMs?: number }>;
}

export interface ParsedM3u8Media {
	targetDurationMs: number;
	initUrl?: string;
	segmentUrls: string[];
}

export interface DashTrackDescriptor {
	id: string;
	kind: StreamKind;
	trackName: string;
	representationId: string;
	manifestUrl: string;
	manifestBase: string;
	mode: "template" | "list";
	template: {
		media: string;
		initialization?: string;
		startNumber: number;
		endNumber?: number;
	};
	segmentUrls: string[];
}

export interface DashSegmentTemplate {
	media?: string;
	initialization?: string;
	startNumber?: string;
	endNumber?: string;
}

export interface MoofSencInfo {
	moofStart: number;
	moofSize: number;
	senc?: CencSampleInfo[];
	trunSampleSizes?: number[];
	trunDataOffset?: number;
	mdatStart: number;
}
