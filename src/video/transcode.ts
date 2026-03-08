/**
 * Transcode pipeline: fMP4 segments → demux → decode → [scale] → frames for encoding.
 * Uses webcodecs-node (aptum) Demuxer + VideoDecoder; CENC decryption in JS before demux.
 * Optional scale to fixed size via webcodecs-node createCanvas.
 *
 * @see https://github.com/aptumfr/webcodecs-node
 */

import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
	createCanvas,
	VideoDecoder,
	VideoFrame,
	type EncodedAudioChunk,
	type EncodedVideoChunk,
} from "webcodecs-node";
import { Demuxer } from "webcodecs-node/containers";

import { decryptIfNeeded, getCencDemuxerOptions } from "../cenc.js";
import "./demuxer-cenc-patch.js";
import { fetchBytes } from "../fetch.js";
import {
	bytesToHex,
	getVideoCodecFromInitSegment,
	hexToBytes,
} from "../init-segment.js";
import type { ClearKey, MuxedAudioTrackRef } from "../types.js";

export interface TranscodeOptions {
	/** Scale output to this width (avoids encoder MB rate over level limit). */
	scaleWidth?: number;
	/** Scale output to this height. */
	scaleHeight?: number;
	/** When set, embedded audio from demuxed segments is published here (raw encoded packets). */
	audioTrackRef?: MuxedAudioTrackRef | null;
	/** Request headers when fetching segment URLs (used when queue yields strings). */
	fetchOptions?: { headers?: Record<string, string> };
	/** Called when video config (codec + description) is known from the first decoded segment; use to push description into catalog renditions. */
	onVideoConfig?: (config: { codec: string; descriptionHex?: string }) => void;
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

async function toBytes(
	item: SegmentQueueItem,
	fetchOpts?: { headers?: Record<string, string> },
): Promise<Uint8Array> {
	if (typeof item === "string") {
		return fetchBytes(item, fetchOpts);
	}
	return item;
}

function copyChunkData(chunk: EncodedAudioChunk): Uint8Array {
	const buf = new Uint8Array(chunk.byteLength);
	chunk.copyTo(buf);
	return buf;
}

/** Max chunks to allow in the decoder queue before applying backpressure. */
const DECODER_QUEUE_BACKPRESSURE = 24;

/**
 * Wait for the decoder to have queue space before decoding more chunks.
 * Prevents QuotaExceededError when demuxer produces chunks faster than the decoder drains.
 */
function waitForDecoderQueueSpace(
	decoder: VideoDecoder,
	maxPending: number,
): Promise<void> {
	if (decoder.decodeQueueSize < maxPending) return Promise.resolve();
	return new Promise((resolve) => {
		const onDequeue = () => {
			decoder.removeEventListener("dequeue", onDequeue);
			if (decoder.decodeQueueSize < maxPending) {
				resolve();
			} else {
				waitForDecoderQueueSpace(decoder, maxPending).then(resolve);
			}
		};
		decoder.addEventListener("dequeue", onDequeue);
	});
}

/** Scale a VideoFrame to target dimensions using canvas (RGBA path). */
async function scaleFrame(
	frame: VideoFrame,
	targetWidth: number,
	targetHeight: number,
): Promise<VideoFrame> {
	const w = frame.codedWidth;
	const h = frame.codedHeight;
	const timestamp = frame.timestamp;
	const duration = frame.duration ?? undefined;
	const size = frame.allocationSize({ format: "RGBA" });
	const buf = new Uint8Array(size);
	await frame.copyTo(buf, { format: "RGBA" });
	frame.close();

	const small = createCanvas({width: w, height: h});
	const smallCtx = small.getContext("2d");
	const imageData = smallCtx.createImageData(w, h);
	imageData.data.set(buf.subarray(0, w * h * 4));
	smallCtx.putImageData(imageData, 0, 0);

	const out = createCanvas({width: targetWidth, height: targetHeight});
	const outCtx = out.getContext("2d");
	outCtx.drawImage(small, 0, 0, w, h, 0, 0, targetWidth, targetHeight);

	return new VideoFrame(out, { timestamp, duration });
}

function tempPath(): string {
	return join(tmpdir(), `moq-seg-${randomBytes(8).toString("hex")}.mp4`);
}

/**
 * Yields decoded video frames from a queue of fMP4 payloads.
 * Uses webcodecs-node Demuxer (file-based); writes init+segment to a temp file per segment.
 * When cenc is set, we decrypt in JS (decryptIfNeeded) before demux.
 * When options.audioTrackRef is set, raw encoded audio chunks are published to ref.current.
 */
export async function* framesFromSegments(
	queue: SegmentQueue,
	cenc: ClearKey | null,
	options?: TranscodeOptions,
): AsyncGenerator<VideoFrame, void, undefined> {
	const first = await queue.next();
	if (first.done || !first.value) return;
	const firstPayload = await toBytes(first.value, options?.fetchOptions);
	const scaleW = options?.scaleWidth;
	const scaleH = options?.scaleHeight;
	const audioTrackRef = options?.audioTrackRef;
	const fetchOpts = options?.fetchOptions;

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

	let initBuffer: Uint8Array | null = null;
	if (isInitSegment(firstPayload)) {
		initBuffer = firstPayload;
	} else {
		yield* drainSegment(firstPayload, cenc, publishAudioPacket, scaleW, scaleH);
	}

	async function* drainSegment(
		segmentBuffer: Uint8Array,
		clearKey: ClearKey | null,
		publishAudio: (data: Uint8Array) => void,
		scaleWidth: number | undefined,
		scaleHeight: number | undefined,
	): AsyncGenerator<VideoFrame, void, undefined> {
		const useLibavCenc = clearKey ? getCencDemuxerOptions(clearKey) : undefined;
		let buffer = segmentBuffer;
		if (clearKey && !useLibavCenc) {
			buffer = decryptIfNeeded(buffer, clearKey);
		}
		const path = tempPath();
		try {
			await writeFile(path, buffer);
		} catch (e) {
			console.error("[transcode] Failed to write temp segment:", e);
			return;
		}
		try {
			const demuxer = new Demuxer({ path });
			if (useLibavCenc) {
				(demuxer as { _demuxerOptions?: typeof useLibavCenc })._demuxerOptions = useLibavCenc;
			}
			await demuxer.open();
			const videoConfig = demuxer.videoConfig;
			if (!videoConfig) {
				await demuxer.close();
				return;
			}
			// AVC/HEVC require description (avcC/hvcC). Use demuxer's or parse from init in buffer.
			const codec = videoConfig.codec;
			const needsDescription =
				codec.startsWith("avc1") ||
				codec.startsWith("avc3") ||
				codec.startsWith("hvc1") ||
				codec.startsWith("hev1");
			let description: ArrayBuffer | ArrayBufferView | undefined = videoConfig.description;
			if (needsDescription && !description) {
				const parsed = getVideoCodecFromInitSegment(buffer);
				if (parsed.codecDescription) {
					description = hexToBytes(parsed.codecDescription);
				}
			}
			const descriptionHex =
				description !== undefined
					? bytesToHex(
							description instanceof ArrayBuffer
								? new Uint8Array(description)
								: new Uint8Array(
										description.buffer,
										description.byteOffset,
										description.byteLength,
									),
						)
					: undefined;
			options?.onVideoConfig?.({ codec, descriptionHex });
			const frames: VideoFrame[] = [];
			const videoDecoder = new VideoDecoder({
				output: (frame: VideoFrame) => frames.push(frame),
				error: (e: Error) => console.error("[transcode] VideoDecoder error:", e),
			});
			videoDecoder.configure({
				codec: videoConfig.codec,
				codedWidth: videoConfig.codedWidth,
				codedHeight: videoConfig.codedHeight,
				...(description && { description }),
			});
			let needKeyframe = true;
			for await (const chunk of demuxer.videoChunks()) {
				const enc = chunk as EncodedVideoChunk;
				if (needKeyframe && enc.type !== "key") continue;
				needKeyframe = false;
				await waitForDecoderQueueSpace(videoDecoder, DECODER_QUEUE_BACKPRESSURE);
				videoDecoder.decode(enc);
			}
			await videoDecoder.flush();
			videoDecoder.close();

			// Publish audio if demuxer exposes audioChunks
			const audioChunks = (demuxer as { audioChunks?: () => AsyncIterable<EncodedAudioChunk> })
				.audioChunks;
			if (typeof audioChunks === "function") {
				for await (const chunk of audioChunks.call(demuxer)) {
					publishAudio(copyChunkData(chunk));
				}
			}
			await demuxer.close();

			for (const frame of frames) {
				if (frame.closed) continue;
				if (
					scaleWidth != null &&
					scaleHeight != null &&
					scaleWidth > 0 &&
					scaleHeight > 0 &&
					(frame.codedWidth !== scaleWidth || frame.codedHeight !== scaleHeight)
				) {
					const scaled = await scaleFrame(frame, scaleWidth, scaleHeight);
					yield scaled;
				} else {
					yield frame;
				}
			}
		} finally {
			await unlink(path).catch(() => {});
		}
	}

	for await (const segmentItem of queue) {
		if (!initBuffer) continue;
		const segmentBytes = await toBytes(segmentItem, fetchOpts);
		const buffer = new Uint8Array(initBuffer.length + segmentBytes.length);
		buffer.set(initBuffer);
		buffer.set(segmentBytes, initBuffer.length);
		yield* drainSegment(buffer, cenc, publishAudioPacket, scaleW, scaleH);
	}
}
