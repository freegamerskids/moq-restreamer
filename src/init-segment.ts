/** Convert bytes to hex string */
export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
	}
	return hex;
}

/**
 * Extract avcC (AVC decoder config) from an fMP4/MP4 init segment.
 * Returns hex-encoded bytes for catalog description (WebCodecs VideoDecoderConfig).
 * The slice is the avcC box payload only (no box header), as required by the decoder.
 */
export function parseAvcCFromInitSegment(initSegment: Uint8Array): string | undefined {
	const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
	const readType = (p: number): string => {
		let s = "";
		for (let i = 0; i < 4; i++) s += String.fromCharCode(initSegment[p + i]!);
		return s;
	};
	const nextBox = (start: number): [number, number, string] => {
		if (start + 8 > initSegment.length) return [-1, -1, ""];
		const size = view.getUint32(start, false);
		const type = readType(start + 4);
		const boxSize = size === 1 ? Number(view.getBigUint64(start + 8, false)) : size;
		const header = size === 1 ? 16 : 8;
		const end = boxSize > 0 && Number.isFinite(boxSize) ? start + boxSize : start + header;
		return [start + header, end, type];
	};
	const findBox = (start: number, end: number, want: string): [number, number] | null => {
		let pos = start;
		while (pos + 8 <= end) {
			const [contentStart, boxEnd, type] = nextBox(pos);
			if (boxEnd <= pos || boxEnd > end) break;
			if (type === want) return [contentStart, boxEnd];
			pos = boxEnd;
		}
		return null;
	};
	const findAvcCInSampleEntry = (entryStart: number, entryEnd: number): Uint8Array | undefined => {
		// VisualSampleEntry fixed part after box header: 6+2+16+2+2+4+4+4+2+32+2+2 = 78 bytes
		const fixed = 78;
		let pos = entryStart + fixed;
		while (pos + 8 <= entryEnd) {
			const [contentStart, boxEnd, type] = nextBox(pos);
			if (boxEnd <= pos || boxEnd > entryEnd) break;
			if (type === "avcC") {
				return initSegment.slice(contentStart, boxEnd);
			}
			pos = boxEnd;
		}
		return undefined;
	};

	const moov = findBox(0, initSegment.length, "moov");
	if (!moov) return undefined;
	const trak = findBox(moov[0], moov[1], "trak");
	if (!trak) return undefined;
	const mdia = findBox(trak[0], trak[1], "mdia");
	if (!mdia) return undefined;
	const minf = findBox(mdia[0], mdia[1], "minf");
	if (!minf) return undefined;
	const stbl = findBox(minf[0], minf[1], "stbl");
	if (!stbl) return undefined;
	const stsd = findBox(stbl[0], stbl[1], "stsd");
	if (!stsd) return undefined;
	let pos = stsd[0] + 8;
	while (pos + 8 <= stsd[1]) {
		const [contentStart, boxEnd, type] = nextBox(pos);
		if (boxEnd <= pos || boxEnd > stsd[1]) break;
		if (type === "avc1" || type === "avc3") {
			const avcC = findAvcCInSampleEntry(contentStart, boxEnd);
			if (avcC && avcC.length > 0) return bytesToHex(avcC);
		}
		pos = boxEnd;
	}
	return undefined;
}
