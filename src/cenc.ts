import type { ClearKey, CencSampleInfo, MoofSencInfo } from "./types.js";

/** 16-byte key as 32-char hex for FFmpeg mov demuxer decryption_key option. */
function keyToHex(key: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < key.length; i++) hex += key[i]!.toString(16).padStart(2, "0");
	return hex;
}

/**
 * Options for node-av Demuxer.open() to decrypt CENC (AES-128 CTR) with FFmpeg.
 * Pass as second argument: Demuxer.open(buffer, getCencDemuxerOptions(cenc)).
 */
export function getCencDemuxerOptions(cenc: ClearKey | null): { options: { decryption_key: string } } | undefined {
	if (!cenc || cenc.key.length !== 16) return undefined;
	return { options: { decryption_key: keyToHex(cenc.key) } };
}

export async function decryptIfNeeded(data: Uint8Array, cenc: ClearKey): Promise<Uint8Array> {
	try {
		const mp4 = new Uint8Array(data);
		const parsed = parseMoofAndCencInfo(mp4);
		if (!parsed) return mp4;
		return await decryptCencData(mp4, parsed, cenc.key);
	} catch {
		return data;
	}
}

function parseMoofAndCencInfo(payload: Uint8Array): MoofSencInfo | null {
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	let offset = 0;
	let moofStart = -1;
	let moofSize = 0;
	let mdatStart = -1;
	let trunSampleSizes: number[] | undefined;
	let trunDataOffset: number | undefined;
	let senc: CencSampleInfo[] | undefined;

	const read = (p: number, size: number): string => {
		let value = "";
		for (let i = 0; i < size; i++) value += String.fromCharCode(payload[p + i]!);
		return value;
	};
	const nextBox = (start: number): [number, number, string] => {
		if (start + 8 > payload.length) return [-1, -1, ""];
		const size = view.getUint32(start, false);
		const type = read(start + 4, 4);
		const header = 8;
		const boxSize = size === 1 ? Number(view.getBigUint64(start + 8, false)) : size;
		const total = boxSize >= 0 && Number.isFinite(boxSize) ? boxSize : 0;
		return [start + header, start + total, type];
	};

	while (offset < payload.length) {
		const [contentStart, end, type] = nextBox(offset);
		if (end <= offset || end > payload.length) break;
		const bodyOffset = contentStart;
		if (type === "moof") {
			moofStart = offset;
			moofSize = end - offset;
			let cursor = bodyOffset;
			const moofEnd = end;
			while (cursor < moofEnd) {
				const [innerContent, innerEnd, innerType] = nextBox(cursor);
				if (innerEnd <= cursor || innerEnd > moofEnd) break;
				if (innerType === "traf") {
					let trafCursor = innerContent;
					while (trafCursor < innerEnd) {
						const [bContent, bEnd, bType] = nextBox(trafCursor);
						if (bEnd <= trafCursor || bEnd > innerEnd) break;
						if (bType === "trun") {
							const [sampleSizes, dataOffset] = parseTrunBox(payload, bContent, bEnd);
							trunSampleSizes = sampleSizes;
							trunDataOffset = dataOffset;
						}
						if (bType === "senc") {
							senc = parseSencBox(payload, bContent, bEnd);
						}
						trafCursor = bEnd;
					}
				}
				cursor = innerEnd;
			}
		}
		if (type === "mdat") {
			mdatStart = contentStart;
		}
		offset = end;
	}

	if (moofStart === -1 || mdatStart === -1 || !trunSampleSizes || !senc) return null;
	return { moofStart, moofSize, mdatStart, trunSampleSizes, trunDataOffset, senc };
}

function parseTrunBox(payload: Uint8Array, start: number, end: number): [number[], number] {
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const versionAndFlags = view.getUint32(start, false);
	const sampleCount = view.getUint32(start + 4, false);
	const flags = versionAndFlags & 0x00ffffff;
	let cursor = start + 8;
	let dataOffset = 0;
	if (flags & 0x000001) {
		dataOffset = view.getInt32(cursor, false);
		cursor += 4;
	}
	if (flags & 0x000100) cursor += 4;
	if (flags & 0x000200) cursor += 4;
	if (flags & 0x000400) cursor += 4;
	if (flags & 0x000800) cursor += 4;

	const sampleSizes: number[] = [];
	for (let i = 0; i < sampleCount && cursor + 4 <= end; i += 1) {
		if (flags & 0x000200) {
			sampleSizes.push(view.getUint32(cursor, false));
			cursor += 4;
		} else {
			sampleSizes.push(0);
		}
	}
	return [sampleSizes, dataOffset];
}

function parseSencBox(payload: Uint8Array, start: number, end: number): CencSampleInfo[] | undefined {
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const versionAndFlags = view.getUint32(start, false);
	const flags = versionAndFlags & 0xff;
	const sampleCount = view.getUint32(start + 4, false);
	let cursor = start + 8;
	const entries: CencSampleInfo[] = [];

	for (let i = 0; i < sampleCount && cursor + 16 <= end; i += 1) {
		const iv = payload.slice(cursor, cursor + 16);
		cursor += 16;
		let clearSamples = 0;
		let subsamples: { clear: number; encrypted: number }[] = [];
		if (flags & 0x1) {
			if (cursor + 2 > end) break;
			clearSamples = view.getUint16(cursor, false);
			cursor += 2;
			for (let j = 0; j < clearSamples && cursor + 6 <= end; j += 1) {
				const clear = view.getUint16(cursor, false);
				const encrypted = view.getUint32(cursor + 2, false);
				cursor += 6;
				subsamples.push({ clear, encrypted });
			}
		}
		entries.push({ iv, subsamples });
	}
	return entries;
}

async function decryptCencData(
	payload: Uint8Array,
	info: MoofSencInfo,
	key: Uint8Array,
): Promise<Uint8Array> {
	if (!info.senc || !info.trunSampleSizes || info.trunSampleSizes.length === 0) return payload;
	const baseOffset = info.mdatStart + Math.max(0, info.trunDataOffset || 0);
	const sampleSizes = info.trunSampleSizes;
	const sampleOffsets: number[] = [];
	let running = baseOffset;
	for (const size of sampleSizes) {
		sampleOffsets.push(running);
		running += size;
	}

	if (sampleOffsets.length === 0 || sampleOffsets[sampleOffsets.length - 1]! > payload.length) {
		return payload;
	}

	const importedKey = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["decrypt"]);
	for (let s = 0; s < sampleOffsets.length && s < info.senc.length; s += 1) {
		const sampleStart = sampleOffsets[s]!;
		const size = sampleSizes[s] ?? 0;
		if (size <= 0 || sampleStart + size > payload.length) continue;

		const sampleInfo = info.senc[s]!;
		let cursor = sampleStart;
		let clearOffset = 0;
		const subsamples =
			sampleInfo.subsamples.length > 0 ? sampleInfo.subsamples : [{ clear: 0, encrypted: size }];

		for (const sub of subsamples) {
			cursor += sub.clear;
			clearOffset += sub.clear;
			if (sub.encrypted <= 0) continue;
			const limit = Math.min(payload.length, cursor + sub.encrypted);
			const encrypted = payload.slice(cursor, limit);
			const counter = incrementCounter(sampleInfo.iv, Math.floor(clearOffset / 16));
			const decrypted = new Uint8Array(
				await crypto.subtle.decrypt(
					{ name: "AES-CTR", counter, length: 64 },
					importedKey,
					encrypted,
				),
			);
			payload.set(decrypted, cursor);
			cursor += encrypted.length;
			clearOffset += encrypted.length;
		}
	}
	return payload;
}

function incrementCounter(iv: Uint8Array, increment: number): Uint8Array {
	const counter = new Uint8Array(iv);
	if (increment <= 0) return counter;

	const view = new DataView(counter.buffer, counter.byteOffset, counter.byteLength);
	const upper = view.getBigUint64(0, false);
	const lower = view.getBigUint64(8, false);
	const nextLower = lower + BigInt(increment);
	const lowerMask = (1n << 64n) - 1n;
	const nextUpper = upper + (nextLower >> 64n);

	view.setBigUint64(0, nextUpper, false);
	view.setBigUint64(8, nextLower & lowerMask, false);
	return counter;
}
