/**
 * Transcode pipeline: fMP4 segments → demux → decode → [scale] → frames for encoding.
 * Uses node-av Demuxer (init+segment buffer) and Decoder; CENC decryption via Demuxer options.
 * Optional scale to fixed size to keep encoder MB rate within H.264 level limits.
 */

import { Decoder } from "node-av/api";
import { Demuxer } from "node-av/api";
import { FilterAPI } from "node-av/api";
import type { Frame } from "node-av";

import { getCencDemuxerOptions } from "../cenc.js";
import { fetchBytes } from "../fetch.js";
import type { ClearKey, MuxedAudioTrackRef } from "../types.js";

export interface TranscodeOptions {
	/** Scale output to this width (avoids libx264 MB rate over level limit). */
	scaleWidth?: number;
	/** Scale output to this height. */
	scaleHeight?: number;
	/** When set, embedded audio from demuxed segments is published here (raw packets). */
	audioTrackRef?: MuxedAudioTrackRef | null;
	/** Request headers when fetching segment URLs (used when queue yields strings). */
	fetchOptions?: { headers?: Record<string, string> };
}

/** Queue item: URL (string) or pre-fetched bytes. When string, transcode fetches before opening demuxer. */
export type SegmentQueueItem = string | Uint8Array;

/** Async queue of segment URLs or payloads (init first, then media segments). */
export class SegmentQueue {
	#items: SegmentQueueItem[] = [];
	#wait: ((value: IteratorResult<SegmentQueueItem, void>) => void) | null = null;

	push(payload: SegmentQueueItem): void {
		if (this.#wait) {
			const w = this.#wait;
			this.#wait = null;
			w({ value: payload, done: false });
		} else {
			this.#items.push(payload);
		}
	}

	async next(): Promise<IteratorResult<SegmentQueueItem, void>> {
		if (this.#items.length > 0) {
			const value = this.#items.shift()!;
			return { value, done: false };
		}
		return new Promise<IteratorResult<SegmentQueueItem, void>>((resolve) => {
			this.#wait = resolve;
		});
	}

	[Symbol.asyncIterator](): AsyncIterator<SegmentQueueItem, void, undefined> {
		return this;
	}
}

/** True if payload looks like an fMP4 init segment (ftyp box at offset 4). */
function isInitSegment(payload: Uint8Array): boolean {
	if (payload.length < 8) return false;
	return (
		payload[4] === 0x66 && payload[5] === 0x74 && payload[6] === 0x79 && payload[7] === 0x70
	);
}

/**
 * Yields decoded video frames from a queue of fMP4 payloads.
 * First payload is used as init only when it contains ftyp; otherwise it is skipped (no demux of bare segments).
 * For each following payload we open demuxer on (init+segment), decode video packets, optionally scale, yield frames.
 * When cenc is set, node-av decrypts CENC (AES-128 CTR) via decryption_key option.
 * When options.audioTrackRef is set and segments contain audio, raw audio packets are published to ref.current.
 * Never yields null (encoder runs until track closes).
 */
async function toBytes(
	item: SegmentQueueItem,
	fetchOpts?: { headers?: Record<string, string> },
): Promise<Uint8Array> {
	if (typeof item === "string") {
		return fetchBytes(item, fetchOpts);
	}
	return item;
}

export async function* framesFromSegments(
	queue: SegmentQueue,
	cenc: ClearKey | null,
	options?: TranscodeOptions,
): AsyncGenerator<Frame, void, undefined> {
	const first = await queue.next();
	if (first.done || !first.value) return;
	const firstPayload = await toBytes(first.value, options?.fetchOptions);
	const demuxerOpts = getCencDemuxerOptions(cenc);
	const scaleW = options?.scaleWidth;
	const scaleH = options?.scaleHeight;
	const audioTrackRef = options?.audioTrackRef;
	const fetchOpts = options?.fetchOptions;
	const scaleFilterRef: { current: ReturnType<typeof FilterAPI.create> | null } = {
		current: null,
	};

	let initBuffer: Buffer | null = null;
	if (isInitSegment(firstPayload)) {
		initBuffer = Buffer.from(firstPayload);
	}
	// When first payload is not init (e.g. no EXT-X-MAP), open it as standalone once.
	if (!initBuffer) {
		yield* drainSegment(Buffer.from(firstPayload), demuxerOpts);
	}

	function publishAudioPacket(data: Uint8Array): void {
		const track = audioTrackRef?.current;
		if (!track || data.length === 0) return;
		try {
			const group = track.appendGroup();
			group.writeFrame(data);
			group.close();
		} catch {
			// track may be closed
		}
	}

	async function* drainSegment(
		segmentBuffer: Buffer,
		opts: ReturnType<typeof getCencDemuxerOptions>,
	): AsyncGenerator<Frame, void, undefined> {
		let demuxer: Awaited<ReturnType<typeof Demuxer.open>>;
		try {
			demuxer = await Demuxer.open(segmentBuffer, {
				options: {
					t: 1
				},
				...opts
			});
		} catch {
			return;
		}
		try {
			const audioStream = demuxer.audio();
			if (audioStream && audioTrackRef) {
				for await (const pkt of demuxer.packets(audioStream.index)) {
					if (pkt?.data && pkt.data.length > 0) {
						publishAudioPacket(new Uint8Array(pkt.data));
					}
					pkt?.free();
				}
			}

			const videoStream = demuxer.video();
			if (!videoStream) return;
			const decoder = await Decoder.create(videoStream);
			try {
				async function* packetsThenNull(
					dmx: Awaited<ReturnType<typeof Demuxer.open>>,
					streamIndex: number,
				): AsyncGenerator<import("node-av").Packet | null> {
					for await (const pkt of dmx.packets(streamIndex)) {
						yield pkt;
						if (pkt) pkt.free();
					}
					yield null;
				}
				for await (const frame of decoder.frames(
					packetsThenNull(demuxer, videoStream.index),
				)) {
					if (frame === null) continue;
					if (scaleW != null && scaleH != null && scaleW > 0 && scaleH > 0) {
						if (!scaleFilterRef.current) {
							scaleFilterRef.current = FilterAPI.create(
								`scale=${scaleW}:${scaleH}`,
								{ allowReinit: true },
							);
						}
						try {
							await scaleFilterRef.current.process(frame);
							frame.free();
							let out: Frame | null;
							while ((out = (await scaleFilterRef.current.receive()) as Frame | null) != null) {
								if (typeof out === "object" && "width" in out) yield out;
								else break;
							}
						} catch {
							frame.free();
						}
					} else {
						yield frame;
					}
				}
			} finally {
				decoder[Symbol.dispose]?.() ?? (decoder as { close?: () => void }).close?.();
			}
		} finally {
			await demuxer.close();
		}
	}

	for await (const segmentItem of queue) {
		if (!initBuffer) continue;
		const segmentBytes = await toBytes(segmentItem, fetchOpts);
		const segmentBuffer = Buffer.from(segmentBytes);
		const buffer = Buffer.concat([initBuffer, segmentBuffer]);
		yield* drainSegment(buffer, demuxerOpts);
	}
}
