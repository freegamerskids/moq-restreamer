/**
 * Video encoder using webcodecs-node (aptum) WebCodecs API, mirroring the moq publish encoder pattern.
 * Encodes VideoFrames to H.264/HEVC and writes to a Moq track via @moq/hang Container.Legacy.Producer.
 *
 * @see https://github.com/moq-dev/moq/blob/main/js/publish/src/video/encoder.ts
 * @see https://github.com/aptumfr/webcodecs-node
 */

import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import * as Moq from "@moq/lite";
import {
	VideoEncoder as WebCodecsVideoEncoder,
	type VideoFrame,
	type EncodedVideoChunk,
} from "webcodecs-node";

export interface EncoderConfig {
	/** Output codec: 'h264' (avc1) or 'hevc' (hev1). Default 'hevc'. */
	outputCodec?: "h264" | "hevc";
	/** Video codec string for catalog (e.g. 'avc1.42E01E', 'hev1.1.6.L93.B0'). */
	codec?: string;
	/** Width in pixels. */
	width: number;
	/** Height in pixels. */
	height: number;
	/** Frame rate (e.g. 30). */
	framerate?: number;
	/** Target bitrate in bps. */
	bitrate?: number | string;
	/** Keyframe interval in milliseconds (default 1000). */
	keyframeInterval?: number;
	/** Max bitrate for VBR. */
	maxBitrate?: number;
}

const DEFAULT_FRAMERATE = 30;
const DEFAULT_KEYFRAME_INTERVAL_MS = 1000;
const DEFAULT_BITRATE = 6_000_000;

/** Max frames to allow in the encoder queue before applying backpressure. */
const ENCODER_QUEUE_BACKPRESSURE = 24;

/**
 * Wait for the encoder to have queue space before encoding more frames.
 * Prevents QuotaExceededError when the source produces frames faster than the encoder drains.
 */
function waitForQueueSpace(
	encoder: WebCodecsVideoEncoder,
	maxPending: number,
): Promise<void> {
	if (encoder.encodeQueueSize < maxPending) return Promise.resolve();
	return new Promise((resolve) => {
		const onDequeue = () => {
			encoder.removeEventListener("dequeue", onDequeue);
			if (encoder.encodeQueueSize < maxPending) {
				resolve();
			} else {
				waitForQueueSpace(encoder, maxPending).then(resolve);
			}
		};
		encoder.addEventListener("dequeue", onDequeue);
	});
}

/**
 * Encoder that consumes WebCodecs VideoFrame objects and writes encoded H.264/HEVC to a Moq track
 * using the legacy container (timestamp + payload per frame).
 */
export class Encoder {
	#config: EncoderConfig;
	#encoder: WebCodecsVideoEncoder | null = null;
	#closed = false;

	readonly catalog = new (class {
		constructor(private encoder: Encoder) {}
		get(): Catalog.VideoConfig | undefined {
			const c = this.encoder.#config;
			if (!c) return undefined;
			const codec = c.codec ?? (c.outputCodec === "h264" ? "avc1.42E01E" : "hev1.1.6.L93.B0");
			return {
				codec,
				container: { kind: "legacy" },
				codedWidth: Catalog.u53(c.width),
				codedHeight: Catalog.u53(c.height),
				framerate: c.framerate ?? DEFAULT_FRAMERATE,
				bitrate: Catalog.u53(typeof c.bitrate === "number" ? c.bitrate : DEFAULT_BITRATE),
				optimizeForLatency: true,
			};
		}
	})(this);

	constructor(config: EncoderConfig) {
		this.#config = {
			framerate: config.framerate ?? DEFAULT_FRAMERATE,
			keyframeInterval: config.keyframeInterval ?? DEFAULT_KEYFRAME_INTERVAL_MS,
			bitrate: config.bitrate ?? DEFAULT_BITRATE,
			...config,
		};
	}

	/**
	 * Serve a Moq track by encoding frames from the given async iterable.
	 * Frames are WebCodecs VideoFrame instances (e.g. from framesFromSegments).
	 * Pass null to flush and stop.
	 */
	async serve(track: Moq.Track, frames: AsyncIterable<VideoFrame | null>): Promise<void> {
		const producer = new Container.Legacy.Producer(track);
		let producerClosed = false;
		const framerate = this.#config.framerate ?? DEFAULT_FRAMERATE;
		const keyframeIntervalMs = this.#config.keyframeInterval ?? DEFAULT_KEYFRAME_INTERVAL_MS;
		const intervalMicro = keyframeIntervalMs * 1000;
		const bitrate =
			typeof this.#config.bitrate === "number"
				? this.#config.bitrate
				: (Number(this.#config.bitrate) || DEFAULT_BITRATE);

		const useHevc = (this.#config.outputCodec ?? "hevc") === "hevc";
		const codec = useHevc ? "hev1.1.6.L93.B0" : "avc1.42001E";

		const encoder = new WebCodecsVideoEncoder({
			output: (chunk: EncodedVideoChunk, _metadata?: unknown) => {
				if (producerClosed) return;
				try {
					const data = new Uint8Array(chunk.byteLength);
					chunk.copyTo(data);
					const timestampMicro = chunk.timestamp as Moq.Time.Micro;
					producer.encode(data, timestampMicro, chunk.type === "key");
				} catch (err) {
					producerClosed = true;
					producer.close(err instanceof Error ? err : new Error(String(err)));
				}
			},
			error: (e: Error) => {
				if (producerClosed) return;
				producerClosed = true;
				console.error("[encoder] WebCodecs error:", e);
				producer.close(e instanceof Error ? e : new Error(String(e)));
				this.#closed = true;
				this.#encoder?.close();
			},
		});
		this.#encoder = encoder;

		encoder.configure({
			codec,
			width: this.#config.width,
			height: this.#config.height,
			bitrate,
			...(this.#config.maxBitrate != null && { bitrateMode: "variable" }),
			hardwareAcceleration: "prefer-hardware",
			latencyMode: "realtime",
		});

		try {
			let firstFrame = true;
			for await (const frame of frames) {
				if (this.#closed) break;
				if (frame === null) {
					await encoder.flush();
					break;
				}
				await waitForQueueSpace(encoder, ENCODER_QUEUE_BACKPRESSURE);
				const keyFrame =
					firstFrame ||
					intervalMicro <= 0 ||
					Math.floor(frame.timestamp / intervalMicro) * intervalMicro === frame.timestamp;
				firstFrame = false;
				encoder.encode(frame, { keyFrame });
				frame.close();
			}
		} catch (err) {
			producer.close(err instanceof Error ? err : new Error(String(err)));
		} finally {
			encoder.close();
			this.#encoder = null;
			producer.close();
		}
	}

	close(): void {
		this.#closed = true;
		this.#encoder?.close();
		this.#encoder = null;
	}
}
