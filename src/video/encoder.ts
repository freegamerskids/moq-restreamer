/**
 * Node.js video encoder using node-av, mirroring the moq publish encoder pattern.
 * Encodes raw frames to H.264 and writes to a Moq track via @moq/hang Container.Legacy.Producer.
 *
 * @see https://github.com/moq-dev/moq/blob/main/js/publish/src/video/encoder.ts
 */

import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import * as Moq from "@moq/lite";
import type { Frame } from "node-av";
import type { Packet } from "node-av";
import { Encoder as NodeAVEncoder } from "node-av/api";
import { FF_ENCODER_LIBX264 } from "node-av/constants";

export interface EncoderConfig {
	/** Video codec (e.g. 'avc1.42E01E'). Encoder uses libx264. */
	codec?: string;
	/** Width in pixels. */
	width: number;
	/** Height in pixels. */
	height: number;
	/** Frame rate (e.g. 30). */
	framerate?: number;
	/** Target bitrate in bps. */
	bitrate?: number | string;
	/** Keyframe interval in milliseconds (default 2000). */
	keyframeInterval?: number;
	/** Max bitrate for VBR. */
	maxBitrate?: number;
}

const DEFAULT_FRAMERATE = 30;
const DEFAULT_KEYFRAME_INTERVAL_MS = 2000;
const DEFAULT_BITRATE = 2_500_000;

/**
 * Encoder that consumes node-av Frame objects and writes encoded H.264 to a Moq track
 * using the legacy container (timestamp + payload per frame).
 */
export class Encoder {
	#config: EncoderConfig;
	#encoder: NodeAVEncoder | null = null;
	#closed = false;

	readonly catalog = new (class {
		constructor(private encoder: Encoder) {}
		get(): Catalog.VideoConfig | undefined {
			const c = this.encoder.#config;
			if (!c) return undefined;
			return {
				codec: c.codec ?? "avc1.42E01E",
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
	 * Frames are node-av Frame instances (e.g. from Decoder.frames()).
	 * Pass null to flush and stop.
	 */
	async serve(track: Moq.Track, frames: AsyncIterable<Frame | null>): Promise<void> {
		const producer = new Container.Legacy.Producer(track);
		const framerate = this.#config.framerate ?? DEFAULT_FRAMERATE;
		const gopSize = Math.max(
			1,
			Math.round(
				(framerate * (this.#config.keyframeInterval ?? DEFAULT_KEYFRAME_INTERVAL_MS)) / 1000,
			),
		);
		const bitrate =
			typeof this.#config.bitrate === "string"
				? this.#config.bitrate
				: String(this.#config.bitrate ?? DEFAULT_BITRATE);

		try {
			this.#encoder = await NodeAVEncoder.create(FF_ENCODER_LIBX264, {
				bitrate,
				gopSize,
				...(this.#config.maxBitrate != null && { maxRate: this.#config.maxBitrate }),
				options: {
					preset: "veryfast",
					tune: "zerolatency",
				},
			});
		} catch (err) {
			producer.close(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		const keyframeIntervalMs = this.#config.keyframeInterval ?? DEFAULT_KEYFRAME_INTERVAL_MS;
		const intervalMicro = keyframeIntervalMs * 1000;
		const lastKeyframeRef = { value: undefined as number | undefined };

		try {
			for await (const frame of frames) {
				if (this.#closed) break;
				if (frame === null) {
					await this.#encoder.flush();
					for await (const pkt of this.#encoder.flushPackets()) {
						this.#writePacket(producer, pkt, framerate, intervalMicro, lastKeyframeRef);
						pkt.free();
					}
					break;
				}
				const packets = await this.#encoder.encodeAll(frame);
				frame.free();
				for (const pkt of packets) {
					this.#writePacket(producer, pkt, framerate, intervalMicro, lastKeyframeRef);
					pkt.free();
				}
			}
		} catch (err) {
			producer.close(err instanceof Error ? err : new Error(String(err)));
		} finally {
			this.#encoder?.close();
			this.#encoder = null;
			producer.close();
		}
	}

	#writePacket(
		producer: Container.Legacy.Producer,
		pkt: Packet,
		framerate: number,
		intervalMicro: number,
		lastKeyframeRef: { value: number | undefined },
	): void {
		const data = pkt.data;
		if (!data || data.length === 0) return;
		const pts = Number(pkt.pts);
		const timestampMicro = Math.round((pts * 1e6) / framerate) as Moq.Time.Micro;
		// Force a keyframe if this is the first frame (no group yet), or GOP elapsed.
		const keyFrame =
			lastKeyframeRef.value === undefined ||
			lastKeyframeRef.value + intervalMicro <= timestampMicro;
		if (keyFrame && pkt.isKeyframe) {
			lastKeyframeRef.value = timestampMicro;
		}
		producer.encode(new Uint8Array(data), timestampMicro, pkt.isKeyframe);
	}

	close(): void {
		this.#closed = true;
		this.#encoder?.close();
		this.#encoder = null;
	}
}
