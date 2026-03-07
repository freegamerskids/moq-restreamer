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
	/** Optional request headers (e.g. Referer) for playlist and segment fetches. */
	headers?: Record<string, string>;
	/** Force video codec type when init cannot be parsed; "hevc" uses hvcC default. */
	videoCodec?: "avc" | "hevc";
}

export interface RunnerContext {
	stream: StreamEntry;
	cenc: ClearKey | null;
}

export interface ClearKey {
	keyId: Uint8Array;
	key: Uint8Array;
}

/** Ref so the transcode pipeline can publish embedded audio when the client subscribes to audio/0. */
export interface MuxedAudioTrackRef {
	current: Moq.Track | null;
}

/** Segment URLs for video transcode; demuxer fetches and opens these. */
export interface SegmentUrlBatch {
	initUrl?: string;
	segmentUrls: string[];
}

export interface RunnerConfig {
	name: string;
	streamName: string;
	/** Used to decide whether to transcode to HEVC (video) or relay raw (audio). */
	kind: StreamKind;
	cenc: ClearKey | null;
	pollMs: number;
	nextSegments: () => Promise<Uint8Array[]>;
	/** When set, video runner uses URLs and transcode fetches before opening demuxer. */
	nextSegmentUrls?: () => Promise<SegmentUrlBatch>;
	/** Request headers for segment URL fetches (e.g. Referer). */
	headers?: Record<string, string>;
	/** MIME codec string for catalog (e.g. avc1.42E01E, hev1.1.6.L93.B0). */
	codec?: string;
	/** Hex-encoded avcC or hvcC for video; required for WebCodecs VideoDecoder. */
	codecDescription?: string;
	/** When set, this config is the audio side of a muxed stream; only set ref, do not start a runner. */
	isMuxedAudioOnly?: boolean;
	/** Shared with video runner: transcode publishes embedded audio here when set. */
	audioTrackRef?: MuxedAudioTrackRef;
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
