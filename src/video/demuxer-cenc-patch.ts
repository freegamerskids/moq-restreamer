/**
 * Hooks webcodecs-node's Demuxer.open() so that when an instance has _demuxerOptions
 * (e.g. from getCencDemuxerOptions), we pass them to node-av's Demuxer.open(path, options),
 * enabling CENC decryption in libav instead of JS.
 *
 * Apply once at load: import "./demuxer-cenc-patch.js"
 * Then set demuxer._demuxerOptions = getCencDemuxerOptions(cenc) before demuxer.open().
 */

import { Demuxer as NodeAvDemuxer } from "node-av";
import { Demuxer as WebCodecsDemuxer } from "webcodecs-node/containers";

interface DemuxerInstance {
	path: string;
	demuxer: unknown;
	_demuxerOptions?: { options: { decryption_key: string } };
}

const originalNodeAvOpen = NodeAvDemuxer.open.bind(NodeAvDemuxer);
const originalWebCodecsOpen = WebCodecsDemuxer.prototype.open;

let openInstanceRef: DemuxerInstance | null = null;

(NodeAvDemuxer as { open: typeof NodeAvDemuxer.open }).open = function (
	path: string | Buffer,
	options?: Parameters<typeof NodeAvDemuxer.open>[1],
): ReturnType<typeof NodeAvDemuxer.open> {
	const opts = openInstanceRef?._demuxerOptions ?? options;
	return originalNodeAvOpen(path, opts);
};

WebCodecsDemuxer.prototype.open = function (
	this: DemuxerInstance,
	timeout?: number,
): ReturnType<typeof originalWebCodecsOpen> {
	openInstanceRef = this;
	try {
		return originalWebCodecsOpen.call(this, timeout);
	} finally {
		openInstanceRef = null;
	}
};
